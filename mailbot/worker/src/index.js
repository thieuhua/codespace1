// Email Worker: nhận thư từ Cloudflare Email Routing, lưu vào D1 (inbox của claude@),
// và biến thư từ người trong whitelist gửi tới claude@/codex@/agy@ thành job chạy CLI trên laptop.
import PostalMime from "postal-mime";
import { agentFor, rejectRecipient, readerScope, senderAuth, isAllowed, wakeAgent, AGENTS } from "./mailbot.js";
import { receiveTaskMail, claimRun, finishRun, runForToken, runTool, submitTask, cancelTask, getTask, cronTick, liveMessages } from './tasks.js';
import { sendMail } from "./send.js";

const MAX_RAW = 20 * 1024 * 1024; // từ chối thư lớn hơn 20 MB
const MAX_BODY = 256 * 1024; // cắt text/html mỗi phần ở 256 K ký tự
const MAX_ATTACH = 1024 * 1024; // lưu nội dung đính kèm <= 1 MB, lớn hơn chỉ giữ metadata
const MAX_ATTACH_TOTAL = 1400 * 1024; // tổng nội dung đính kèm/thư (giới hạn hàng D1 ~2 MB)
const KEEP = 1000; // giữ tối đa 1000 thư mới nhất

export default {
  async email(message, env, ctx) {
    if (message.rawSize > MAX_RAW) {
      message.setReject("Message too large");
      return;
    }
    const target = agentFor(message.to, env.MAIL_DOMAIN || 'xuanthieu.site');
    if (!target) { message.setReject('Unknown recipient'); return; }
    const { agent, tag } = target;
    const raw = await new Response(message.raw).arrayBuffer();
    const mail = await PostalMime.parse(raw);

    let allowed = false;
    let auth = { ok: false, reason: "không phải địa chỉ agent" };
    if (agent) {
      auth = senderAuth(mail);
      allowed = auth.ok && (await isAllowed(env, auth.address, agent));
    }
    // claude@ vẫn là hộp thư công khai; codex@/agy@ chỉ nhận thư từ whitelist.
    if (rejectRecipient(target, allowed)) {
      console.log(`reject ${message.from} -> ${message.to}: ${auth.ok ? "không trong whitelist" : auth.reason}`);
      message.setReject("Sender not allowed");
      return;
    }

    const msgId = await storeMessage(env, message, mail);
    if (allowed) {
      const task = await receiveTaskMail(env, { msgId, agent, tag, sender: auth.address, mail }, sendMail);
      console.log(`${task.id ? `task #${task.id}` : 'command'} ${agent}: ${task.status}`);
      if (task.status === 'active' || task.status === 'command') ctx.waitUntil(wakeAgent(env));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === 'run-api') {
        const run = await runForToken(env, request.headers.get('X-Run-Token'));
        if (!run) return json({ error: 'invalid run token' }, 401);
        if (request.method !== 'POST' || parts.length !== 2) return json({ error: 'not found' }, 404);
        const body = await request.json();
        const result = await runTool(env, run, parts[1], body, sendMail);
        if (result.task_id) await wakeAgent(env);
        return json(result, result.code || 200);
      }
      const role = await roleOf(request, env);
      if (!role) return json({ error: "unauthorized" }, 401);
      if (parts[0] === "messages") return await messagesApi(request, env, url, parts, role);
      if (role !== "admin") return json({ error: "forbidden" }, 403);
      if (parts[0] === 'runs') return await runsApi(request, env, parts);
      if (parts[0] === 'tasks') return await tasksApi(request, env, url, parts);
      if (parts[0] === "allowlist") return await allowlistApi(request, env, parts);
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => { await cronTick(env, sendMail); await wakeAgent(env); })());
  },
};

async function storeMessage(env, message, mail) {
  const header = (name) => message.headers.get(name) || "";
  const res = await env.DB.prepare(
    `INSERT INTO messages (received_at, envelope_from, envelope_to, from_addr, from_name,
       to_json, cc_json, reply_to, subject, date, message_id, in_reply_to, text, html,
       auth_results, raw_size)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
  )
    .bind(
      new Date().toISOString(),
      message.from,
      message.to,
      mail.from?.address || "",
      mail.from?.name || "",
      JSON.stringify(mail.to || []),
      JSON.stringify(mail.cc || []),
      (mail.replyTo || []).map((a) => a.address).join(", "),
      cut(mail.subject || "", 1000),
      mail.date || "",
      mail.messageId || "",
      mail.inReplyTo || "",
      cut(mail.text || "", MAX_BODY),
      cut(mail.html || "", MAX_BODY),
      cut(header("authentication-results") || header("arc-authentication-results"), 2000),
      message.rawSize
    )
    .run();
  const msgId = res.meta.last_row_id;

  let budget = MAX_ATTACH_TOTAL;
  const stmts = [];
  for (const att of mail.attachments || []) {
    const bytes = toBytes(att.content);
    const keep = bytes.length <= MAX_ATTACH && bytes.length <= budget;
    if (keep) budget -= bytes.length;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO attachments (message_id, filename, mime_type, size, content_b64)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(msgId, cut(att.filename || "unnamed", 255), att.mimeType || "", bytes.length,
        keep ? b64(bytes) : null)
    );
  }
  // Dọn thư cũ, trừ thư còn job đang chờ/chạy.
  const live = `(${liveMessages})`;
  stmts.push(
    env.DB.prepare(`DELETE FROM attachments WHERE message_id <= ?1 AND message_id NOT IN ${live}`).bind(msgId - KEEP),
    env.DB.prepare(`DELETE FROM messages WHERE id <= ?1 AND id NOT IN ${live}`).bind(msgId - KEEP)
  );
  await env.DB.batch(stmts);
  return msgId;
}

// Token đọc inbox (MCP) chỉ thấy thư gửi claude@; thư gửi codex@/agy@ chỉ admin xem được.
async function messagesApi(request, env, url, parts, role) {
  const scope = role === "admin" ? "1 = 1" : readerScope(env.MAIL_DOMAIN || 'xuanthieu.site');
  if (parts.length >= 2) {
    const visible = await env.DB.prepare(`SELECT 1 FROM messages WHERE id = ?1 AND ${scope}`)
      .bind(int(parts[1], -1)).first();
    if (!visible) return json({ error: "not found" }, 404);
  }
  if (parts.length === 1 && request.method === "GET") {
    const unread = url.searchParams.get("unread") === "1";
    const after = int(url.searchParams.get("after_id"), 0);
    const limit = Math.min(int(url.searchParams.get("limit"), 20), 100);
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.received_at, m.from_addr, m.from_name, m.envelope_from, m.envelope_to,
         m.subject, m.is_read, m.raw_size, substr(m.text, 1, 200) AS preview,
         (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments
       FROM messages m
       WHERE m.id > ?1 AND (?2 = 0 OR m.is_read = 0) AND ${scope.replaceAll("envelope_to", "m.envelope_to")}
       ORDER BY m.id DESC LIMIT ?3`
    ).bind(after, unread ? 1 : 0, limit).all();
    return json({ messages: results });
  }

  const id = int(parts[1], -1);
  if (id < 0) return json({ error: "bad id" }, 400);

  if (parts.length === 2 && request.method === "GET") {
    const msg = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?1`).bind(id).first();
    if (!msg) return json({ error: "not found" }, 404);
    const { results } = await env.DB.prepare(
      `SELECT id, filename, mime_type, size, content_b64 IS NOT NULL AS stored
       FROM attachments WHERE message_id = ?1 ORDER BY id`
    ).bind(id).all();
    return json({ message: msg, attachments: results });
  }
  if (parts.length === 2 && request.method === "DELETE") {
    const live = await env.DB.prepare(
      `SELECT 1 FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE e.message_id=?1 AND (e.run_id IS NULL OR r.status IN ('pending','running'))`
    ).bind(id).first();
    if (live) return json({ error: 'thư có event chưa xử lý hoặc run chờ/chạy' }, 409);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE message_id = ?1 AND message_id NOT IN (${liveMessages})`).bind(id),
      env.DB.prepare(`DELETE FROM messages WHERE id = ?1 AND id NOT IN (${liveMessages})`).bind(id),
    ]);
    return json({ ok: true });
  }
  if (parts.length === 3 && parts[2] === "read" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    await env.DB.prepare(`UPDATE messages SET is_read = ?2 WHERE id = ?1`)
      .bind(id, body.read === false ? 0 : 1).run();
    return json({ ok: true });
  }
  if (parts.length === 4 && parts[2] === "attachments" && request.method === "GET") {
    const att = await env.DB.prepare(
      `SELECT filename, mime_type, content_b64 FROM attachments WHERE id = ?1 AND message_id = ?2`
    ).bind(int(parts[3], -1), id).first();
    if (!att) return json({ error: "not found" }, 404);
    if (att.content_b64 === null) return json({ error: "attachment too large, not stored" }, 410);
    return json(att);
  }
  return json({ error: "not found" }, 404);
}

async function runsApi(request, env, parts) {
  if (parts.length===2 && parts[1]==='claim' && request.method==='POST') {
    const body=await request.json();
    return json({run:await claimRun(env,body.agents)});
  }
  const id=Number(parts[1]);
  if(!Number.isSafeInteger(id)||id<1) return json({error:'bad id'},400);
  if(parts.length===3 && parts[2]==='state' && request.method==='GET') {
    const run=await env.DB.prepare('SELECT id,status,cancel_requested FROM runs WHERE id=?1').bind(id).first();
    return run?json(run):json({error:'not found'},404);
  }
  if(parts.length===3 && parts[2]==='result' && request.method==='POST') {
    const result=await finishRun(env,id,await request.json(),sendMail);
    if(result.ok) await wakeAgent(env);
    return json(result,result.code||200);
  }
  return json({error:'not found'},404);
}

async function tasksApi(request, env, url, parts) {
  if(parts.length===1 && request.method==='POST') {
    const result=await submitTask(env,await request.json());
    if(result.task) await wakeAgent(env);
    return json(result,result.code||200);
  }
  if(parts.length===3 && parts[2]==='retention' && request.method==='GET') {
    const task=await env.DB.prepare('SELECT id,agent,project,status,finished_at FROM tasks WHERE id=?1').bind(int(parts[1],-1)).first();
    return task?json({task}):json({error:'not found'},404);
  }
  const owner=url.searchParams.get('owner');
  if(!owner) return json({error:'owner required'},400);
  if(parts.length===1 && request.method==='GET') {
    const {results}=await env.DB.prepare('SELECT id,root_id,parent_id,agent,owner,project,title,status,wait_json,run_count,created_at,updated_at FROM tasks WHERE owner=?1 ORDER BY id DESC LIMIT ?2')
      .bind(owner,Math.min(int(url.searchParams.get('limit'),20),100)).all();
    return json({tasks:results});
  }
  const id=Number(parts[1]);
  if(!Number.isSafeInteger(id)||id<1) return json({error:'bad id'},400);
  const result=parts.length===2&&request.method==='GET'?await getTask(env,id,owner):
    parts.length===3&&parts[2]==='cancel'&&request.method==='POST'?await cancelTask(env,id,owner):{error:'not found',code:404};
  return json(result,result.code||200);
}

async function allowlistApi(request, env, parts) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM allowlist ORDER BY address, agent`).all();
    return json({ allowlist: results });
  }
  const body = await request.json().catch(() => ({}));
  const address = String(body.address || "").trim().toLowerCase();
  const agent = String(body.agent || "*").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return json({ error: "địa chỉ không hợp lệ" }, 400);
  if (agent !== "*" && !AGENTS.includes(agent)) return json({ error: `agent phải là * hoặc ${AGENTS.join("/")}` }, 400);
  if (request.method === "POST") {
    await env.DB.prepare(`INSERT OR IGNORE INTO allowlist (address, agent, added_at) VALUES (?1, ?2, ?3)`)
      .bind(address, agent, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (request.method === "DELETE") {
    await env.DB.prepare(`DELETE FROM allowlist WHERE address = ?1 AND agent = ?2`).bind(address, agent).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

// "admin" = ADMIN_TOKEN (agent trên laptop, quản lý whitelist); "reader" = API_TOKEN (MCP đọc inbox).
async function roleOf(request, env) {
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (env.ADMIN_TOKEN && (await sameSecret(got, env.ADMIN_TOKEN))) return "admin";
  if (env.API_TOKEN && (await sameSecret(got, env.API_TOKEN))) return "reader";
  return null;
}

async function sameSecret(got, token) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(got)),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  // Fixed-size digests; Cloudflare exposes timingSafeEqual, Node tests use this fallback.
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  return new Uint8Array(a).reduce((v, byte, i) => v | (byte ^ new Uint8Array(b)[i]), 0) === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function int(v, d) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s;
}

function toBytes(content) {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
