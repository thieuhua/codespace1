// Mailbot: thư từ người gửi trong whitelist tới <agent>@domain thành job chạy CLI trên laptop.
import { parseSubject, COMMAND_HELP } from "./subject.js";
import { validateAttachments } from "./mime.js";

export async function tokenHash(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}

export const AGENTS = ["claude", "codex", "agy"];
const RATE_PER_HOUR = 20;
const KEEP_JOBS = 1000;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function agentFor(envelopeTo, domain) {
  const m = String(envelopeTo || "").toLowerCase().match(/^(claude|codex|agy)(?:\+([a-z0-9-]{1,32}))?@([^@\s]+)$/);
  return m && (!domain || m[3] === domain.toLowerCase()) ? { agent: m[1], tag: m[2] || null } : null;
}

export function rejectRecipient(target, allowed) {
  return !target || (!allowed && (target.agent !== 'claude' || !!target.tag));
}

export function readerScope(domain) {
  // Domain is configuration, still quote it as an SQL literal.
  return `envelope_to = 'claude@${domain.replaceAll("'", "''")}' COLLATE NOCASE`;
}

const stripComments = (s) => {
  // Bỏ comment RFC 5322 "(...)" kể cả lồng nhau, và chuỗi trong ngoặc kép.
  let out = "", depth = 0, quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { if (!depth && !quoted) out += s.slice(i, i + 2); i++; continue; }
    if (!depth && c === '"') { quoted = !quoted; out += " "; continue; }
    if (quoted) continue;
    if (c === "(") { depth++; continue; }
    if (c === ")" && depth) { depth--; continue; }
    if (!depth) out += c;
  }
  return out;
};

// Xác thực người gửi dựa trên header thô (mail.headerLines, thứ tự từ trên xuống):
// - Chỉ tin Authentication-Results đầu tiên, phải do mx.cloudflare.net thêm (MTA nhận prepend header;
//   A-R giả do người gửi chèn nằm phía dưới).
// - Mệnh đề "dmarc=pass" phải là một resinfo riêng (tách theo ";"), header.from lấy trong chính mệnh đề đó.
// - Thư phải có đúng một header "From:" viết chuẩn, chứa đúng một địa chỉ (postal-mime lấy From cuối cùng
//   và chấp nhận "From :", nên không tin mail.from khi có nhiều hơn một).
export function senderAuth(mail) {
  const lines = mail.headerLines || [];
  const fromLines = lines.filter((h) => h.key === "from");
  if (fromLines.length !== 1) return { ok: false, reason: `có ${fromLines.length} header From` };
  const fromLine = fromLines[0].line.replace(/\r?\n[ \t]+/g, " ");
  const m = fromLine.match(/^From:(.*)$/is);
  if (!m) return { ok: false, reason: "header From không chuẩn" };
  const fromValue = stripComments(m[1]);
  if ((fromValue.match(/@/g) || []).length !== 1) return { ok: false, reason: "From không phải đúng một địa chỉ" };
  const fromAddr = (mail.from?.address || "").toLowerCase();
  if (!fromAddr || !fromValue.toLowerCase().includes(fromAddr)) return { ok: false, reason: "From không khớp" };
  const domain = fromAddr.split("@")[1] || "";

  const arLine = lines.find((h) => h.key === "authentication-results");
  if (!arLine) return { ok: false, reason: "không có Authentication-Results" };
  const ar = stripComments(arLine.line.replace(/\r?\n[ \t]+/g, " ").replace(/^[^:]*:/, ""));
  const clauses = ar.split(";").map((c) => c.trim());
  if (clauses.shift().toLowerCase() !== "mx.cloudflare.net") return { ok: false, reason: "A-R đầu tiên không phải của Cloudflare" };
  const dmarc = clauses.find((c) => /^dmarc=/i.test(c));
  if (!dmarc || !/^dmarc=pass(\s|$)/i.test(dmarc)) return { ok: false, reason: "DMARC không pass" };
  const hf = dmarc.match(/(?:^|\s)header\.from=([^\s]+)/i);
  if (!hf || hf[1].toLowerCase() !== domain) return { ok: false, reason: "DMARC header.from lệch domain From" };
  return { ok: true, address: fromAddr };
}

export async function isAllowed(env, address, agent) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM allowlist WHERE address = ?1 AND (agent = '*' OR agent = ?2) LIMIT 1`
  ).bind(address, agent).first();
  return !!row;
}

// Bỏ phần trích dẫn thư cũ ở CUỐI thư: dòng giới thiệu ("On ... wrote:", "Vào ... đã viết:", có thể bị gói
// thành 2-3 dòng) cùng khối ">" phía sau, và chữ ký của bot. Dấu ">" giữa thư (trích lỗi, blockquote) được giữ.
export function extractPrompt(text) {
  let lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  // Bỏ khối ">" và dòng trống ở cuối thư.
  let end = lines.length;
  while (end > 0 && (lines[end - 1].startsWith(">") || !lines[end - 1].trim())) end--;
  const hadQuote = lines.slice(end).some((l) => l.startsWith(">"));
  if (!hadQuote) end = lines.length;
  // Tìm dòng giới thiệu trích dẫn ngay trước khối vừa bỏ (gộp tối đa 3 dòng cuối).
  for (let k = 1; hadQuote && k <= 3 && end - k >= 0; k++) {
    const joined = lines.slice(end - k, end).join(" ").replace(/\s+/g, " ").trim();
    if (/^(On|Vào|Le|Am|El)\b.*(wrote|đã viết|a écrit|schrieb|escribió)\s*:$/i.test(joined)) { end -= k; break; }
  }
  lines = lines.slice(0, end);
  // Bỏ chữ ký bot ("-- " rồi "<agent>@ · job #") nếu người gửi dán lại.
  const sig = lines.findIndex((l, i) => l === "-- " && /@ · job #\d+/.test(lines[i + 1] || ""));
  if (sig >= 0) lines = lines.slice(0, sig);
  return lines.join("\n").trim();
}

const msgIds = (s) => String(s || "").match(/<[^<>\s]+>/g) || [];

function threadKey(sender, mail) {
  const root = msgIds(mail.references)[0] || msgIds(mail.inReplyTo)[0] || msgIds(mail.messageId)[0]
    || `<local-${crypto.randomUUID()}>`;
  // Gắn người gửi để người khác biết Message-ID cũng không nối vào phiên của mình được.
  return `${sender}|${root}`;
}

export async function createJob(env, { msgId, agent, tag = null, sender, mail }, sendMail) {
  let key = threadKey(sender, mail);
  let inheritedProject = null;
  // Reply IDs are aliases of the original thread, including for worktree identity.
  const alias = key.slice(sender.length + 1).match(/^<mailbot-(?:job-(\d+)|notify-(\d+)-\d+)@([^>]+)>$/);
  if (alias && alias[3] === (env.MAIL_DOMAIN || 'xuanthieu.site')) {
    const original = await env.DB.prepare(`SELECT thread_key, project FROM jobs WHERE id = ?1 AND sender = ?2 AND agent = ?3`)
      .bind(Number(alias[1] || alias[2]), sender, agent).first();
    if (original) { key = original.thread_key; inheritedProject = original.project; }
  }
  const thread = await env.DB.prepare(`SELECT project FROM threads WHERE thread_key = ?1 AND agent = ?2`)
    .bind(key, agent).first();
  const project = tag || thread?.project || inheritedProject || null;
  const now = new Date();
  const hourAgo = new Date(now - 3600e3).toISOString();
  const { n } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE sender = ?1 AND created_at > ?2 AND status != 'rate_limited'`
  ).bind(sender, hourAgo).first();
  const parsed = parseSubject(mail.subject);
  if (parsed.error || parsed.action) {
    let text;
    if (parsed.error) {
      if (n >= RATE_PER_HOUR) return { status: "command_suppressed" };
      text = `${parsed.error}\n\n${COMMAND_HELP}`;
    } else if (parsed.action === "status") {
      const { results: active } = await env.DB.prepare(
        `SELECT id, agent, status, subject, cancel_requested FROM jobs WHERE sender = ?1 AND status IN ('pending','running') ORDER BY id`
      ).bind(sender).all();
      const { results: recent } = await env.DB.prepare(
        `SELECT id, agent, status, subject, cancel_requested FROM jobs WHERE sender = ?1 ORDER BY id DESC LIMIT 5`
      ).bind(sender).all();
      const lines = (rows) => rows.map((j) => `#${j.id} ${j.agent} ${j.status}${j.cancel_requested ? ' (đã yêu cầu hủy)' : ''}: ${j.subject || ''}`).join("\n") || "(không có)";
      text = `Job đang chờ/chạy:\n${lines(active)}\n\n5 job gần nhất:\n${lines(recent)}`;
    } else {
      const { results } = await env.DB.prepare(
        `UPDATE jobs SET cancel_requested = 1,
           status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'pending' THEN ?1 ELSE finished_at END
         WHERE status IN ('pending','running') AND sender = ?2 AND (?3 IS NULL OR id = ?3)
         RETURNING id, status`
      ).bind(now.toISOString(), sender, parsed.cancelId).all();
      text = results.length ? results.map((j) => `#${j.id}: ${j.status === 'cancelled' ? 'đã hủy' : 'đã yêu cầu dừng'}`).join("\n") : "Không có job phù hợp của bạn đang chờ/chạy.";
    }
    await sendMail(env, {
      from: `${agent}${project ? '+' + project : ''}@${env.MAIL_DOMAIN || "xuanthieu.site"}`, to: sender,
      subject: `Re: ${parsed.subject || mail.subject || '(no subject)'}`, text,
      inReplyTo: mail.messageId, references: mail.references,
    });
    return { status: "command" };
  }
  const status = n >= RATE_PER_HOUR ? "rate_limited" : "pending";
  const prompt = extractPrompt(mail.text || "") || parsed.subject;
  const res = await env.DB.prepare(
    `INSERT INTO jobs (message_id, agent, sender, subject, prompt, rfc_message_id, references_hdr,
       thread_key, status, created_at, options_json, project)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  ).bind(msgId, agent, sender, parsed.subject.slice(0, 300), prompt,
    msgIds(mail.messageId)[0] || "", msgIds(mail.references).join(" "),
    key, status, now.toISOString(), JSON.stringify(parsed.options), project).run();
  const id = res.meta.last_row_id;
  if (project) await env.DB.prepare(
    `INSERT INTO threads (thread_key, agent, session_id, project, updated_at) VALUES (?1, ?2, '', ?3, ?4)
     ON CONFLICT (thread_key, agent) DO UPDATE SET
       session_id = CASE WHEN project IS NOT excluded.project THEN '' ELSE session_id END,
       project = excluded.project, updated_at = excluded.updated_at`
  ).bind(key, agent, project, now.toISOString()).run();
  await env.DB.prepare(`DELETE FROM jobs WHERE id <= ?1 AND status NOT IN ('pending','running')`)
    .bind(id - KEEP_JOBS).run();
  return { id, status };
}

export async function wakeAgent(env) {
  if (!env.WAKE_URL || !env.ADMIN_TOKEN) return;
  try {
    await fetch(env.WAKE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Laptop tắt hoặc hầm đứt: job vẫn nằm trong hàng đợi, agent sẽ tự kéo khi chạy lại.
  }
}

// Lấy một job cho agent. Job "running" quá 30 phút (laptop chết giữa chừng) được chạy lại 1 lần;
// treo lần nữa thì chuyển sang failed để không kẹt mãi.
export async function claimJob(env, agents) {
  const list = agents.filter((a) => AGENTS.includes(a));
  if (!list.length) return null;
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 30 * 60e3).toISOString();
  await env.DB.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?1, session_id = NULL, job_token_hash = NULL
     WHERE status = 'running' AND cancel_requested = 1 AND claimed_at < ?2`
  ).bind(now, stale).run();
  await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', finished_at = ?1, job_token_hash = NULL, output = 'Quá thời gian sau 2 lần chạy'
     WHERE status = 'running' AND cancel_requested = 0 AND claimed_at < ?2 AND attempts >= 2`
  ).bind(now, stale).run();
  const marks = list.map((_, i) => `?${i + 3}`).join(",");
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const hash = await tokenHash(token);
  const hashMark = `?${list.length + 3}`;
  const job = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', claimed_at = ?1, attempts = attempts + 1, job_token_hash = ${hashMark}
     WHERE id = (
       SELECT id FROM jobs
       WHERE agent IN (${marks})
         AND cancel_requested = 0
         AND (status = 'pending' OR (status = 'running' AND claimed_at < ?2 AND attempts < 2))
       ORDER BY id LIMIT 1)
     RETURNING *`
  ).bind(now, stale, ...list, hash).first();
  if (!job) return null;
  const thread = await env.DB.prepare(
    `SELECT session_id, project FROM threads WHERE thread_key = ?1 AND agent = ?2`
  ).bind(job.thread_key, job.agent).first();
  const { results: attachments } = await env.DB.prepare(
    `SELECT id, filename, mime_type, size, content_b64 IS NOT NULL AS stored
     FROM attachments WHERE message_id = ?1 ORDER BY id`
  ).bind(job.message_id).all();
  const options = JSON.parse(job.options_json || "{}");
  const resume = !options.new && (thread?.project || null) === job.project && SESSION_RE.test(thread?.session_id || "") ? thread.session_id : null;
  delete job.job_token_hash;
  return { ...job, job_token: token, mail_domain: env.MAIL_DOMAIN || 'xuanthieu.site', resume_session: resume, attachments };
}

export async function finishJob(env, id, { ok, output, session_id, cancelled, attachments = [] }, send) {
  let job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1`).bind(id).first();
  if (!job) return { error: "not found", code: 404 };
  const retry = ['done', 'failed', 'cancelled'].includes(job.status) && job.reply_status === null;
  if (job.status !== "running" && !retry) return { error: `job đang ở trạng thái ${job.status}` };
  let files;
  try { files = validateAttachments(attachments); }
  catch (err) { return { error: err.message, code: 400 }; }
  const metadata = JSON.stringify(files.map(({ filename, size }) => ({ filename, size })));
  if (retry && metadata !== (job.outbox_json || "[]")) return { error: "attachments không khớp kết quả đã lưu", code: 400 };
  const now = new Date().toISOString();
  const domain = env.MAIL_DOMAIN || "xuanthieu.site";
  // ID ổn định: retry sau khi lưu kết quả vẫn nối đúng threads, không cần lưu nội dung tệp.
  const replyId = `<mailbot-job-${job.id}@${domain}>`;
  if (!retry) {
    const text = String(output || "").slice(0, 200_000);
    const sid = !cancelled && !job.cancel_requested && SESSION_RE.test(session_id || "") ? session_id : null;
    // Kiểm tra cancel_requested tại thời điểm UPDATE để tránh cuộc đua với /cancel.
    const updated = await env.DB.prepare(
      `UPDATE jobs SET status = CASE WHEN cancel_requested = 1 OR ?2 = 1 THEN 'cancelled' WHEN ?3 = 1 THEN 'done' ELSE 'failed' END,
       finished_at = ?4, exit_ok = CASE WHEN cancel_requested = 1 OR ?2 = 1 THEN 0 ELSE ?3 END,
       output = ?5, session_id = CASE WHEN cancel_requested = 1 OR ?2 = 1 THEN NULL ELSE ?6 END,
       outbox_json = ?7, job_token_hash = NULL WHERE id = ?1 AND status = 'running' RETURNING *`
    ).bind(id, cancelled ? 1 : 0, ok ? 1 : 0, now, text, sid, metadata).first();
    if (!updated) return { error: "job không còn running" };
    job = updated;
  }
  // Khôi phục mapping nếu Worker đã chết sau UPDATE kết quả, trước batch threads.
  const sid = job.status === 'done' && SESSION_RE.test(job.session_id || '') ? job.session_id : '';
  const notifyIds = msgIds(job.references_hdr).filter((s) => s.startsWith(`<mailbot-notify-${job.id}-`));
  if (sid || job.project || notifyIds.length) {
    await env.DB.batch([job.thread_key, `${job.sender}|${replyId}`, ...notifyIds.map((s) => `${job.sender}|${s}`)].map((key) => env.DB.prepare(
      `INSERT INTO threads (thread_key, agent, session_id, project, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (thread_key, agent) DO UPDATE SET
       session_id = CASE WHEN excluded.session_id != '' THEN excluded.session_id ELSE threads.session_id END,
       project = excluded.project, updated_at = excluded.updated_at`
    ).bind(key, job.agent, sid, job.project, now)));
  }
  const body = (job.status === 'cancelled' ? `Đã hủy job.\n\n${job.output || ''}` :
    job.status === 'done' ? job.output : `Lỗi khi chạy ${job.agent}:\n\n${job.output || ''}`).trim() || "(không có nội dung trả về)";
  const footer = `\n\n-- \n${job.agent}@ · job #${job.id}${job.session_id ? ` · phiên ${job.session_id}` : ""}\n` +
    "Trả lời thư này để tiếp tục cùng phiên; gửi thư mới để bắt đầu phiên mới.";
  try {
    await send(job, body + footer, replyId, files);
    await env.DB.prepare(`UPDATE jobs SET reply_status = 'sent', reply_error = NULL WHERE id = ?1`).bind(id).run();
    return { ok: true, reply: "sent" };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 1000);
    await env.DB.prepare(`UPDATE jobs SET reply_status = 'error', reply_error = ?2 WHERE id = ?1`).bind(id, msg).run();
    return { ok: true, reply: "error", error: msg };
  }
}
