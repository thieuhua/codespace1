import { AGENTS, isAllowed, tokenHash } from './mailbot.js';

export async function jobForToken(env, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  return env.DB.prepare(`SELECT * FROM jobs WHERE job_token_hash = ?1 AND status = 'running' AND cancel_requested = 0`)
    .bind(await tokenHash(token)).first();
}

const fail = (error, code = 400) => ({ error, code });
const validPrompt = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 200000;
export const publicJob = ({ job_token_hash, ...job }) => job;

export async function submitJob(env, { agent, prompt, project = null, reply_to }) {
  const sender = typeof reply_to === 'string' ? reply_to.trim().toLowerCase() : '';
  if (!AGENTS.includes(agent) || !validPrompt(prompt) ||
      (project !== null && (typeof project !== 'string' || !/^[a-z0-9-]{1,32}$/.test(project))) || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(sender)) return fail('invalid job');
  if (!await isAllowed(env, sender, agent)) return fail('owner not allowed', 403);
  const now = new Date().toISOString(), hour = new Date(Date.now() - 3600e3).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO jobs (message_id, agent, sender, reply_to, subject, prompt, project, thread_key, created_at)
     SELECT 0, ?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE (SELECT COUNT(*) FROM jobs WHERE sender = ?2 AND created_at > ?8 AND status != 'rate_limited') +
       (SELECT COUNT(*) FROM command_receipts WHERE sender = ?2 AND created_at > ?8) < 20
     RETURNING *`
  ).bind(agent, sender, prompt.split('\n')[0].slice(0, 300), prompt, project,
    `${sender}|<submit-${crypto.randomUUID()}@mailbot>`, now, hour).first();
  return row ? { job: publicJob(row) } : fail('rate limit', 429);
}

export async function cancelJob(env, id) {
  const job = await env.DB.prepare(
    `UPDATE jobs SET cancel_requested = 1,
       status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
       finished_at = CASE WHEN status = 'pending' THEN ?2 ELSE finished_at END,
       job_token_hash = NULL
     WHERE id = ?1 AND status IN ('pending','running') RETURNING id, status, cancel_requested`
  ).bind(id, new Date().toISOString()).first();
  return job ? { job } : fail('no active job', 404);
}

export async function notifySender(env, job, { subject, body }, send) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 300 || !validPrompt(body)) return fail('invalid notification');
  const domain = env.MAIL_DOMAIN || 'xuanthieu.site';
  // Reserve quota and durable Message-ID together. Finish recovers aliases from references_hdr.
  const row = await env.DB.prepare(
    `UPDATE jobs SET notify_count = notify_count + 1,
       references_hdr = trim(COALESCE(NULLIF(references_hdr, ''), rfc_message_id, '') || ' ' || '<mailbot-notify-' || id || '-' || (notify_count + 1) || '@' || ?3 || '>')
     WHERE id = ?1 AND status = 'running' AND cancel_requested = 0 AND job_token_hash = ?2 AND notify_count < 3 RETURNING *`
  ).bind(job.id, job.job_token_hash, domain).first();
  if (!row) return fail('notification limit or inactive job', 409);
  const messageId = `<mailbot-notify-${row.id}-${row.notify_count}@${domain}>`;
  await send(env, { from: `${row.agent}${row.project ? '+' + row.project : ''}@${domain}`,
    to: row.reply_to || row.sender, subject, text: body, messageId,
    inReplyTo: row.rfc_message_id, references: row.references_hdr.replace(messageId, '').trim() });
  return { ok: true, message_id: messageId };
}

export async function delegateJob(env, parent, { agent, prompt }) {
  if (!AGENTS.includes(agent) || agent === parent.agent || !validPrompt(prompt)) return fail('invalid delegate');
  if (!await isAllowed(env, parent.sender, agent)) return fail('agent not allowed', 403);
  const now = new Date().toISOString(), hour = new Date(Date.now() - 3600e3).toISOString();
  // D1 batch is a transaction. changes() connects the insert to this reservation;
  // no await/read-modify-write window can oversubscribe quota or tree size.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET delegate_count = delegate_count + 1
       WHERE id = ?1 AND job_token_hash = ?2 AND status = 'running' AND cancel_requested = 0
         AND agent != ?3 AND depth < 1 AND delegate_count < 2
         AND EXISTS (SELECT 1 FROM allowlist WHERE address = jobs.sender AND (agent = '*' OR agent = ?3))
         AND (SELECT COUNT(*) FROM jobs tree WHERE tree.id = COALESCE(jobs.root_id, jobs.id)
              OR tree.root_id = COALESCE(jobs.root_id, jobs.id)) < 3
         AND (SELECT COUNT(*) FROM jobs rate WHERE rate.sender = jobs.sender AND rate.created_at > ?4 AND rate.status != 'rate_limited') +
           (SELECT COUNT(*) FROM command_receipts WHERE sender = jobs.sender AND created_at > ?4) < 20
       RETURNING id`
    ).bind(parent.id, parent.job_token_hash, agent, hour),
    env.DB.prepare(
      `INSERT INTO jobs (message_id, agent, sender, reply_to, subject, prompt, project, parent_id, root_id, depth, thread_key, created_at)
       SELECT 0, ?2, sender, COALESCE(reply_to, sender), ?3, ?4, project, id, COALESCE(root_id, id), depth + 1,
         sender || '|<delegate-pending@mailbot>', ?5 FROM jobs WHERE id = ?1 AND changes() = 1 RETURNING *`
    ).bind(parent.id, agent, `Delegate: ${prompt.split('\n')[0]}`.slice(0, 300), prompt, now),
    env.DB.prepare(
      `UPDATE jobs SET thread_key = sender || '|<delegate-' || id || '@mailbot>'
       WHERE id = last_insert_rowid() AND parent_id = ?1 AND changes() = 1`
    ).bind(parent.id),
  ]);
  const child = results[1].results?.[0];
  if (!child) return fail('delegate limit, rate limit or inactive job', 409);
  child.thread_key = `${child.sender}|<delegate-${child.id}@mailbot>`;
  return { job: publicJob(child) };
}
