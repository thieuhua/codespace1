import { spawn, execFile } from 'node:child_process';
import { cliEnv } from './run-mcp.mjs';

const MAX_OUT = 4 * 1024 * 1024;

// Dependencies are injectable so cancellation/timeouts can be tested offline,
// without launching a model CLI. Every invocation owns its child and timers.
export function createCliRunner({ getState, timeoutMs, log = () => {}, spawnProcess = spawn,
  killProcess = (pid, callback) => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, callback),
  setTimer = setTimeout, clearTimer = clearTimeout, cancelMs = 15000, killGraceMs = 5000 }) {
  return function run({ cmd, args, stdin }, cwd, job) {
    return new Promise((resolve) => {
      let done = false, stopping = false, out = '', err = '', timedOut = false, cancelled = false;
      let timer, cancelTimer, killTimer;
      const suffix = () => cancelled ? '\n[Đã hủy run]' : timedOut ? `\n[Quá thời gian ${timeoutMs / 60e3} phút, đã dừng]` : '';
      const finish = (code, extra = '') => {
        if (done) return;
        done = true;
        clearTimer(timer); clearTimer(cancelTimer); clearTimer(killTimer);
        resolve({ code, out, err: err + extra + suffix(), timedOut, cancelled });
      };
      const child = spawnProcess(cmd, args, { cwd, windowsHide: true, env: cliEnv() });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { if (out.length < MAX_OUT) out += d; });
      child.stderr.on('data', d => { if (err.length < MAX_OUT) err += d; });
      child.stdin.on('error', () => {});
      const stop = () => {
        if (done || stopping || !child.pid) return;
        stopping = true;
        log(`stop run #${job.id} pid ${child.pid}, cancelled=${cancelled}`);
        killProcess(child.pid, () => {
          if (done) return;
          child.stdout.destroy(); child.stderr.destroy();
          killTimer = setTimer(() => finish(-1), killGraceMs);
        });
      };
      timer = setTimer(() => { timedOut = true; stop(); }, timeoutMs);
      const checkCancel = async () => {
        try {
          const state = await getState(job.id);
          if (!done && (state.cancel_requested || state.status !== 'running')) { cancelled = true; stop(); }
        } catch (e) { if (!done) log(`state run #${job.id}: ${e.message}`); }
        finally { if (!done && !stopping) cancelTimer = setTimer(checkCancel, cancelMs); }
      };
      cancelTimer = setTimer(checkCancel, cancelMs);
      child.on('error', e => finish(-1, String(e)));
      child.on('close', code => finish(code));
      child.stdin.end(stdin);
    });
  };
}
