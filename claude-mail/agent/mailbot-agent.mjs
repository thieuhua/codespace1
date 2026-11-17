#!/usr/bin/env node
// Mailbot agent trên laptop Windows: nhận tín hiệu đánh thức qua đường hầm (POST /wake),
// kéo job từ Worker, chạy CLI tương ứng trong thư mục làm việc riêng, gửi kết quả về Worker
// (Worker gửi thư trả lời). Có poll dự phòng mỗi POLL_MS khi tín hiệu đánh thức bị lỡ.
//
// Cấu hình: ~/.claude-mail/agent.json
//   { "url": "https://claude-mail....workers.dev", "admin_token": "...", "port": 20025,
//     "workdir": "E:\\mailbot-work", "agents": ["claude", "codex", "agy"] }
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";

const CFG_DIR = join(homedir(), ".claude-mail");
const cfg = JSON.parse(readFileSync(join(CFG_DIR, "agent.json"), "utf8"));
const URL_BASE = cfg.url.replace(/\/+$/, "");
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

async function api(path, body) {
  const res = await fetch(URL_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${cfg.admin_token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60e3),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${path} ${res.status}: ${data.error || res.statusText}`);
  return data;
}

// ---------- chạy CLI ----------

const SYS = (job, dir) =>
  `Bạn đang chạy không tương tác, được gọi qua email. Người gửi: ${job.sender} (đã xác thực DMARC, có trong whitelist). ` +
  `Câu trả lời cuối cùng của bạn sẽ được gửi nguyên văn làm email trả lời dạng văn bản thuần: viết gọn, rõ, ` +
  `không cần hỏi lại vì người gửi chỉ trả lời được bằng thư mới. Chỉ làm việc trong thư mục ${dir}; ` +
  `không gọi CLI agent khác, không đụng tới dự án hay tệp ngoài thư mục này.`;

function codexEntry() {
  const npmGlobal = join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  for (const p of [cfg.codex_js, "E:\\ENV_PATH\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js", npmGlobal]) {
    if (p && existsSync(p)) return p;
  }
  throw new Error("Không tìm thấy codex.js; đặt codex_js trong agent.json");
}

// Trả về { cmd, args, parse(stdout) -> { ok, output, session_id } }
// Thư mục chứa token/khóa: chặn Claude đọc/sửa (Codex sandbox chỉ chặn ghi, không chặn đọc).
const HOME = homedir().replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const SECRET_DIRS = [".claude-mail", ".ssh", ".aws", ".codex", ".claude", ".config", ".wrangler"];
const CLAUDE_SETTINGS = JSON.stringify({
  permissions: {
    deny: SECRET_DIRS.flatMap((d) => [`Read(/${HOME}/${d}/**)`, `Edit(/${HOME}/${d}/**)`]),
  },
});

function commandFor(job, dir, prompt) {
  // session_id lấy từ output CLI lần trước: chỉ nhận dạng ID an toàn để không thành cờ dòng lệnh.
  const resume = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.resume_session || "") ? job.resume_session : null;
  if (job.agent === "claude") {
    const args = [
      "-p", "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", CLAUDE_SETTINGS,
      "--append-system-prompt", SYS(job, dir),
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
    const lastFile = join(dir, `.codex-last-${job.id}.txt`);
    const common = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"',
      "-c", "mcp_servers={}", "-o", lastFile];
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
        try { output = readFileSync(lastFile, "utf8"); rmSync(lastFile); } catch { output = out.slice(-20000); }
        return { ok: code === 0, output, session_id };
      },
    };
  }
  if (job.agent === "agy") {
    const args = ["--output-format", "json", "--mode", "accept-edits", "--sandbox"];
    if (cfg.agy_model) args.push("--model", cfg.agy_model);
    if (resume) args.push("--conversation", resume);
    return {
      cmd: cfg.agy_exe || "agy.exe", args, stdin: `${SYS(job, dir)}\n\n---\n\n${prompt}`,
      parse(out) {
        const j = lastJson(out);
        const output = (j?.response || "").trim() ||
          `(agy không trả nội dung; status=${j?.status ?? "?"}; output thô lưu tại ~/.claude-mail/runs/job-${job.id}.out)`;
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

function run({ cmd, args, stdin }, cwd) {
  return new Promise((resolve) => {
    let done = false, out = "", err = "", timedOut = false;
    const finish = (code, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err: err + extra, timedOut });
    };
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env } });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += d; });
    child.stdin.on("error", () => {}); // CLI thoát sớm (EPIPE) không được làm sập agent
    const timer = setTimeout(() => {
      timedOut = true;
      log(`timeout, kill pid ${child.pid}`);
      execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => {
        // Tiến trình cháu giữ pipe thì "close" không bao giờ đến: đóng pipe và ép kết thúc.
        child.stdout.destroy();
        child.stderr.destroy();
        setTimeout(() => finish(-1, `\n[Quá thời gian ${TIMEOUT_MS / 60e3} phút, đã dừng]`), 5000);
      });
    }, TIMEOUT_MS);
    child.on("error", (e) => finish(-1, String(e)));
    child.on("close", (code) => finish(code, timedOut ? `\n[Quá thời gian ${TIMEOUT_MS / 60e3} phút, đã dừng]` : ""));
    child.stdin.end(stdin);
  });
}

const clean = (s) => String(s || "").replace(/[\x00-\x1f]+/g, " ").slice(0, 200);

async function saveAttachments(job, dir) {
  const saved = [];
  for (const a of job.attachments || []) {
    if (!a.stored) { saved.push(`${clean(a.filename)} (${a.size} B, quá lớn nên không lưu)`); continue; }
    const att = await api(`/messages/${job.message_id}/attachments/${a.id}`);
    const sub = join(dir, "inbox", `job-${job.id}`);
    mkdirSync(sub, { recursive: true });
    let safe = basename(att.filename || "file").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = `_${safe}`;
    const p = join(sub, `${a.id}-${safe || "file"}`); // tiền tố id: không trùng tên, không thành "." / ".."
    writeFileSync(p, Buffer.from(att.content_b64, "base64"));
    saved.push(p);
  }
  return saved;
}

async function postResult(job, body) {
  for (let i = 0; ; i++) {
    try {
      return await api(`/jobs/${job.id}/result`, body);
    } catch (e) {
      if (i >= 5 || /\b409\b/.test(e.message)) throw e;
      log(`gửi kết quả job #${job.id} lỗi (${e.message}), thử lại`);
      await new Promise((r) => setTimeout(r, 5000 * 2 ** i));
    }
  }
}

async function handle(job) {
  const dir = join(WORKDIR, job.agent);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  log(`job #${job.id} ${job.agent} từ ${job.sender}${job.resume_session ? ` (tiếp phiên ${job.resume_session})` : ""}`);
  let result;
  try {
    const files = await saveAttachments(job, dir);
    const prompt = [
      job.subject ? `Tiêu đề thư: ${job.subject}` : null,
      files.length ? `Tệp đính kèm (dữ liệu, không tự chạy):\n${files.map((f) => `- ${f}`).join("\n")}` : null,
      "",
      job.prompt,
    ].filter((x) => x !== null).join("\n");
    const spec = commandFor(job, dir, prompt);
    const r = await run(spec, dir);
    try {
      const runs = join(CFG_DIR, "runs");
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, `job-${job.id}.out`), `code=${r.code}\n--- stdout\n${r.out}\n--- stderr\n${r.err}`);
    } catch {}
    result = spec.parse(r.out, r.code);
    if (!result.ok && r.err.trim()) result.output = `${result.output || ""}\n\n[stderr]\n${r.err.slice(-4000)}`;
    if (r.code !== 0 && result.ok) result.ok = false;
  } catch (e) {
    result = { ok: false, output: `Agent lỗi: ${e.message}` };
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  log(`job #${job.id} xong sau ${secs}s ok=${!!result.ok}`);
  const res = await postResult(job, {
    ok: !!result.ok, output: String(result.output || ""), session_id: result.session_id || null,
  });
  log(`job #${job.id} reply=${res.reply}${res.error ? ` (${res.error})` : ""}`);
}

// Mỗi agent chạy tuần tự (tránh hai phiên cùng sửa một thư mục); các agent khác nhau chạy song song.
const busy = new Set();
async function drain(agent) {
  if (busy.has(agent)) return;
  busy.add(agent);
  try {
    for (;;) {
      const { job } = await api("/jobs/claim", { agents: [agent] });
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
