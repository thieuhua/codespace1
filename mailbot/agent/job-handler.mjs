import { prepareWorktree } from './worktrees.mjs';
import { prepareTaskDirectory, recordTaskUse } from './task-files.mjs';
import { prepareOutbox } from './outbox.mjs';
import { buildRunPrompt } from './run-prompt.mjs';
import { finalizeFiles } from './job-finalize.mjs';

// Keep execution/locking/submission testable without loading live agent config.
export function createJobExecutor({ workdir, projects, domain, getState, saveAttachments, commandFor, run, saveOutput, log = () => {} }) {
  return async job => {
    let dir, worktree;
    const t0 = Date.now();
    log(`job #${job.id} ${job.agent} từ ${job.sender}${job.resume_session ? ` (tiếp phiên ${job.resume_session})` : ''}`);
    let result, execution, outbox;
    try {
      if (job.project) {
        worktree = await prepareWorktree(workdir, projects, job);
        dir = worktree.path;
      } else {
        dir = prepareTaskDirectory(workdir, job.agent, job.task_id);
        recordTaskUse(workdir, job);
      }
      outbox = prepareOutbox(dir, job.id);
      const files = await saveAttachments(job, dir);
      const prompt = buildRunPrompt(job, { dir, outbox: outbox.path, files });
      const spec = await commandFor(job, dir, prompt);
      const r = await run(spec, dir, job);
      execution = r;
      try { saveOutput(job, r); } catch (e) { log(`output run #${job.id}: ${e.message}`); }
      result = spec.parse(r.out, r.code);
      result.cancelled = r.cancelled;
      result.timedOut = r.timedOut;
      if (!result.ok && r.err.trim()) result.output = `${result.output || ''}\n\n[stderr]\n${r.err.slice(-4000)}`;
      if (r.code !== 0 && result.ok) result.ok = false;
    } catch (e) {
      result = { ok: false, output: `Agent lỗi: ${e.message}`, cancelled: execution?.cancelled, timedOut: execution?.timedOut };
    }
    // Recheck after CLI, before any worktree commit or attachment/session release.
    try {
      const state = await getState(job.id);
      if (state.cancel_requested || state.status !== 'running') result.cancelled = true;
    } catch (e) { result.cancelled = true; result.output += `\n[Không xác minh được trạng thái run: ${e.message}]`; }
    const { attachments, notes, gitReport } = finalizeFiles({ result, outbox, worktree, dir, job,
      domain: job.mail_domain || domain, executed: !!execution });
    const tail = gitReport.slice(0, 40000) + (notes.length ? `\n\n[Gửi tệp]\n${notes.join('\n').slice(0, 10000)}` : '');
    result.output = String(result.output || '').slice(0, 200000 - tail.length) + tail;
    log(`job #${job.id} xong sau ${Math.round((Date.now() - t0) / 1000)}s ok=${!!result.ok}`);
    return { ok: !!result.ok, output: String(result.output || ''), session_id: result.session_id || null,
      cancelled: !!result.cancelled, attachments, finalize_note: tail };
  };
}

export function createJobHandler({ acquire, execute, postResult, log = () => {} }) {
  return async job => {
    let unlock;
    try { unlock = await acquire(job); }
    catch (e) {
      await postResult(job, { ok: false, output: `Không lấy được khóa cwd: ${e.message}`, session_id: null, attachments: [] });
      return;
    }
    let body;
    try { body = await execute(job); }
    catch (e) { body = { ok: false, output: `Agent lỗi finalize: ${e.message}`, session_id: null, attachments: [] }; }
    finally {
      try { await unlock(); }
      catch (e) { log(`unlock run #${job.id}: ${e.message}`); }
    }
    // Worker can schedule the next run before this response/retry returns.
    const res = await postResult(job, body);
    log(`run #${job.id} status=${res.task_status || (res.ignored ? 'ignored' : 'accepted')}${res.error ? ` (${res.error})` : ''}`);
  };
}
