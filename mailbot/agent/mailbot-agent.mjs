#!/usr/bin/env node
// Mailbot agent trên laptop Windows: nhận tín hiệu đánh thức qua đường hầm (POST /wake),
// kéo job từ Worker, chạy CLI tương ứng trong thư mục làm việc riêng, gửi kết quả về Worker
// (Worker gửi thư trả lời). Có poll dự phòng mỗi POLL_MS khi tín hiệu đánh thức bị lỡ.
//
// Cấu hình: ~/.mailbot/agent.json
//   { "url": "https://mailbot.thieupro666.workers.dev", "admin_token": "...", "port": 20025,
//     "workdir": "E:\\mailbot-work", "agents": ["claude", "codex", "agy"] }
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { claudeSettings, claudeAllowedTools, claudeIsolationArgs, jobOptions, optionArgs } from "./cli-options.mjs";
import { prepareOutbox } from "./outbox.mjs";
import { prepareWorktree, lockWorktree } from './worktrees.mjs';
import { RUN_TOOLS, runMcp, codexMcpArgs, cliEnv } from './run-mcp.mjs';
import { saveInboxAttachment } from './inbox.mjs';
import { readLastOutput } from './cli-output.mjs';
import { codexInventoryCache, inspectCli, verifyAgyMcp } from './mcp-isolation.mjs';
import { finalizeFiles } from './job-finalize.mjs';
import { buildRunPrompt } from './run-prompt.mjs';
import { prepareTaskDirectory, recordTaskUse, pruneTaskDirectories } from './task-files.mjs';

const CFG_DIR = join(homedir(), ".mailbot");
const cfg = JSON.parse(readFileSync(join(CFG_DIR, "agent.json"), "utf8"));
const URL_BASE = (cfg.url || "https://mailbot.thieupro666.workers.dev").replace(/\/+$/, "");
const PORT = cfg.port || 20025;
const WORKDIR = cfg.workdir || "E:\\mailbot-work";
const ENABLED = cfg.agents || ["claude", "codex", "agy"];
const TIMEOUT_MS = (cfg.timeout_minutes || 20) * 60e3;
const POLL_MS = (cfg.poll_seconds || 60) * 1000;
const LOG = join(CFG_DIR, "agent.log");

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch {}
}

async function api(path, body, timeout = 60e3) {
  const res = await fetch(URL_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${cfg.admin_token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${path} ${res.status}: ${data.error || res.statusText}`);
  return data;
}

// ---------- chạy CLI ----------

const SYS = (job, dir) =>
  `Bạn đang chạy không tương tác qua mailbot. Người gửi: ${job.sender} (Worker đã kiểm quyền; thư gốc nếu có đã qua DMARC và whitelist). ` +
  `Câu trả lời cuối cùng của bạn sẽ được gửi nguyên văn làm email trả lời dạng văn bản thuần: viết gọn, rõ, ` +
  `không cần hỏi lại vì người gửi chỉ trả lời được bằng thư mới. Chỉ làm việc trong thư mục ${dir}; ` +
  `không gọi CLI agent khác, không đụng tới dự án hay tệp ngoài thư mục này. ` +
  `Không tự chạy git commit/checkout/branch; agent mailbot sẽ commit sau khi bạn kết thúc.`;

function codexEntry() {
  const npmGlobal = join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  for (const p of [cfg.codex_js, "E:\\ENV_PATH\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js", npmGlobal]) {
    if (p && existsSync(p)) return p;
  }
  throw new Error("Không tìm thấy codex.js; đặt codex_js trong agent.json");
}

// Trả về { cmd, args, parse(stdout) -> { ok, output, session_id } }
// Thư mục chứa token/khóa: chặn Claude đọc/sửa (Codex sandbox chỉ chặn ghi, không chặn đọc).
const CLAUDE_SETTINGS = claudeSettings(homedir(), WORKDIR);
const codexInventory = codexInventoryCache();

async function commandFor(job, dir, prompt) {
  const mcp = runMcp(job, URL_BASE);
  // session_id lấy từ output CLI lần trước: chỉ nhận dạng ID an toàn để không thành cờ dòng lệnh.
  const options = jobOptions(job);
  const resume = !options.new && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.resume_session || "") ? job.resume_session : null;
  if (job.agent === "claude") {
    const args = [
      "-p", "--output-format", "json",
      "--permission-mode", "acceptEdits",
      ...claudeIsolationArgs(),
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: mcp ? { 'mailbot-run': mcp } : {} }),
      "--settings", CLAUDE_SETTINGS,
      "--allowedTools", ...claudeAllowedTools(cfg.projects?.[job.project]), ...(mcp ? RUN_TOOLS : []),
      "--system-prompt-snapshot", "off",
      "--append-system-prompt", SYS(job, dir),
      ...optionArgs(job.agent, options, cfg.claude_model ?? "opus"),
    ];
    if (resume) args.push("--resume", resume);
    return {
      cmd: cfg.claude_exe || "claude.exe", args, stdin: prompt,
      parse(out) {
        const j = lastJson(out);
        return { ok: j && !j.is_error, output: j?.result ?? out, session_id: j?.session_id };
      },
    };
  }
  if (job.agent === "codex") {
    const entry = codexEntry();
    const servers = await codexInventory(entry, dir);
    const lastFile = join(dir, `.codex-last-${job.id}.txt`);
    const common = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"',
      ...codexMcpArgs(mcp, servers), "-o", lastFile, ...optionArgs(job.agent, options, cfg.codex_model)];
    const args = resume
      ? [codexEntry(), "exec", "resume", ...common, resume, "-"]
      : [codexEntry(), "exec", ...common, "-"];
    return {
      cmd: process.execPath, args, stdin: `${SYS(job, dir)}\n\n---\n\n${prompt}`,
      parse(out, code) {
        let session_id = resume;
        for (const line of out.split("\n")) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === "thread.started" && ev.thread_id) session_id = ev.thread_id;
          } catch {}
        }
        let output = "";
        try { output = readLastOutput(lastFile, dir); }
        catch (e) { if (e.code !== 'ENOENT') throw e; output = out.slice(-20000); }
        return { ok: code === 0, output, session_id };
      },
    };
  }
  if (job.agent === "agy") {
    verifyAgyMcp(await inspectCli(cfg.agy_exe || 'agy.exe', ['mcp', 'list'], dir), cfg.agy_allowed_global_mcp);
    const args = ["--output-format", "json", "--mode", "accept-edits", "--sandbox"];
    args.push(...optionArgs(job.agent, options, cfg.agy_model));
    if (resume) args.push("--conversation", resume);
    return {
      cmd: cfg.agy_exe || "agy.exe", args, stdin: `${SYS(job, dir)}\n\n---\n\n${prompt}`,
      parse(out) {
        const j = lastJson(out);
        const output = (j?.response || "").trim() ||
          `(agy không trả nội dung; status=${j?.status ?? "?"}; output thô lưu tại ~/.mailbot/runs/run-${job.id}.out)`;
        return { ok: j?.status === "SUCCESS", output, session_id: j?.conversation_id };
      },
    };
  }
  throw new Error(`agent lạ: ${job.agent}`);
}

function lastJson(out) {
  const t = out.trim();
  try { return JSON.parse(t); } catch {}
  const lines = t.split("\n").reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch {} }
  return null;
}

const MAX_OUT = 4 * 1024 * 1024;

function run({ cmd, args, stdin }, cwd, job) {
  return new Promise((resolve) => {
    let done = false, out = "", err = "", timedOut = false, cancelled = false;
    let cancelTimer, killTimer;
    const finish = (code, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      clearTimeout(killTimer);
      resolve({ code, out, err: err + extra, timedOut, cancelled });
    };
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: cliEnv() });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += d; });
    child.stdin.on("error", () => {}); // CLI thoát sớm (EPIPE) không được làm sập agent
    const stop = () => {
      if (done || !child.pid) return;
      log(`stop pid ${child.pid}, cancelled=${cancelled}`);
      execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => {
        if (done) return;
        // Tiến trình cháu giữ pipe thì "close" không bao giờ đến: đóng pipe và ép kết thúc.
        child.stdout.destroy();
        child.stderr.destroy();
        killTimer = setTimeout(() => finish(-1, cancelled ? "\n[Đã hủy job]" : `\n[Quá thời gian ${TIMEOUT_MS / 60e3} phút, đã dừng]`), 5000);
      });
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT_MS);
    const checkCancel = async () => {
      try {
        const state = await api(`/runs/${job.id}/state`, undefined, 5000);
        if (!done && state.cancel_requested) { cancelled = true; stop(); }
      } catch (e) { if (!done) log(`state job #${job.id}: ${e.message}`); }
      finally { if (!done && !cancelled) cancelTimer = setTimeout(checkCancel, 15000); }
    };
    cancelTimer = setTimeout(checkCancel, 15000);
    child.on("error", (e) => finish(-1, String(e)));
    child.on("close", (code) => finish(code, cancelled ? "\n[Đã hủy job]" : timedOut ? `\n[Quá thời gian ${TIMEOUT_MS / 60e3} phút, đã dừng]` : ""));
    child.stdin.end(stdin);
  });
}

const clean = (s) => String(s || "").replace(/[\x00-\x1f]+/g, " ").slice(0, 200);

async function saveAttachments(job, dir) {
  const saved = [];
  for (const a of job.attachments || []) {
    if (!a.stored) { saved.push(`${clean(a.filename)} (${a.size} B, quá lớn nên không lưu)`); continue; }
    const att = await api(`/messages/${a.message_id}/attachments/${a.id}`);
    saved.push(saveInboxAttachment(dir, job.id, a.id, att, a.message_id));
  }
  return saved;
}

async function postResult(job, body) {
  for (let i = 0; ; i++) {
    try {
      return await api(`/runs/${job.id}/result`, body);
    } catch (e) {
      if (i >= 5 || /\b409\b/.test(e.message)) throw e;
      log(`gửi kết quả job #${job.id} lỗi (${e.message}), thử lại`);
      await new Promise((r) => setTimeout(r, 5000 * 2 ** i));
    }
  }
}

async function handle(job) {
  let dir = join(WORKDIR, job.agent, `task-${job.task_id}`), worktree, unlock;
  const t0 = Date.now();
  log(`job #${job.id} ${job.agent} từ ${job.sender}${job.resume_session ? ` (tiếp phiên ${job.resume_session})` : ""}`);
  let result, execution;
  let outbox;
  try {
    if (job.project) {
      unlock = lockWorktree(WORKDIR, job);
      worktree = prepareWorktree(WORKDIR, cfg.projects, job);
      dir = worktree.path;
    } else {
      dir=prepareTaskDirectory(WORKDIR,job.agent,job.task_id);
      recordTaskUse(WORKDIR,job);
    }
    outbox = prepareOutbox(dir, job.id);
    const files = await saveAttachments(job, dir);
    const prompt = buildRunPrompt(job, {dir,outbox:outbox.path,files});
    const spec = await commandFor(job, dir, prompt);
    const r = await run(spec, dir, job);
    execution = r;
    try {
      const runs = join(CFG_DIR, "runs");
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, `run-${job.id}.out`), `code=${r.code}\n--- stdout\n${r.out}\n--- stderr\n${r.err}`);
    } catch {}
    result = spec.parse(r.out, r.code);
    result.cancelled = r.cancelled;
    result.timedOut = r.timedOut;
    if (!result.ok && r.err.trim()) result.output = `${result.output || ""}\n\n[stderr]\n${r.err.slice(-4000)}`;
    if (r.code !== 0 && result.ok) result.ok = false;
  } catch (e) {
    result = { ok: false, output: `Agent lỗi: ${e.message}`, cancelled: execution?.cancelled, timedOut: execution?.timedOut };
  }
  // Recheck after CLI, before any worktree commit or attachment/session release.
  try {
    const state=await api(`/runs/${job.id}/state`,undefined,5000);
    if(state.cancel_requested || state.status!=='running') result.cancelled=true;
  } catch(e) { result.cancelled=true; result.output+=`\n[Không xác minh được trạng thái run: ${e.message}]`; }
  const { attachments, notes, gitReport } = finalizeFiles({ result, outbox, worktree, dir, job,
    domain: job.mail_domain || cfg.mail_domain || 'xuanthieu.site', unlock, executed: !!execution });
  const tail = gitReport.slice(0, 40000) + (notes.length ? `\n\n[Gửi tệp]\n${notes.join('\n').slice(0, 10000)}` : '');
  result.output = String(result.output || '').slice(0, 200000 - tail.length) + tail;
  const secs = Math.round((Date.now() - t0) / 1000);
  log(`job #${job.id} xong sau ${secs}s ok=${!!result.ok}`);
  const res = await postResult(job, {
    ok: !!result.ok, output: String(result.output || ""), session_id: result.session_id || null,
    cancelled: !!result.cancelled, attachments, finalize_note: tail,
  });
  log(`run #${job.id} status=${res.task_status || (res.ignored ? 'ignored' : 'accepted')}${res.error ? ` (${res.error})` : ""}`);
}

// Mỗi agent chạy tuần tự (tránh hai phiên cùng sửa một thư mục); các agent khác nhau chạy song song.
const busy = new Set();
async function drain(agent) {
  if (busy.has(agent)) return;
  busy.add(agent);
  try {
    for (;;) {
      const { run: job } = await api("/runs/claim", { agents: [agent] });
      if (!job) break;
      await handle(job);
    }
  } catch (e) {
    log(`drain ${agent}: ${e.message}`);
  } finally {
    busy.delete(agent);
  }
}
const drainAll = () => ENABLED.forEach((a) => drain(a));
let pruning=false;
async function pruneOldTasks() {
  if(pruning || busy.size) return;
  pruning=true;
  try { await pruneTaskDirectories(WORKDIR,async(id)=>{ const result=await api(`/tasks/${id}/retention`); return busy.size?null:result.task; }); }
  catch(e) {log(`task retention: ${e.message}`);}
  finally {pruning=false;}
}

// ---------- HTTP: tín hiệu đánh thức qua hầm ----------

const tokenHash = createHash("sha256").update(cfg.admin_token).digest();
function authed(req) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(createHash("sha256").update(got).digest(), tokenHash);
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/wake") {
    if (!authed(req)) { res.writeHead(401).end(); return; }
    res.writeHead(202).end("ok");
    drainAll();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end(`ok ${[...busy].join(",")}`);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "0.0.0.0", () => log(`mailbot agent nghe cổng ${PORT}, agents=${ENABLED.join(",")}, workdir=${WORKDIR}`));

drainAll();
setInterval(drainAll, POLL_MS);
setInterval(pruneOldTasks,3600000);
