export function isQaRecipient(env, to) {
  const domain = String(to).split('@')[1]?.toLowerCase();
  return !!domain && String(env.QA_SINK_DOMAINS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean).includes(domain);
}

export async function captureQaMail(env, mail, raw, { outboundId = null, sendKey = null } = {}) {
  const captureKey = crypto.randomUUID(), createdAt = new Date().toISOString();
  // Read the actual generated ID, including buildMail's fallback for absent IDs.
  const messageId = /^Message-ID: (.+)\r?$/m.exec(raw)[1].trim();
  const statements = [env.DB.prepare(`INSERT OR IGNORE INTO qa_outbox(capture_key,recipient,subject,message_id,created_at)
    SELECT ?1,?2,?3,?4,?5 WHERE ?6 IS NULL OR EXISTS(
      SELECT 1 FROM outbound_mails WHERE id=?6 AND status='sending' AND send_key=?7)`)
    .bind(captureKey, mail.to, String(mail.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200), messageId, createdAt, outboundId, sendKey)];
  // <=256 Ki UTF-16 units per chunk stays below D1's 2 MiB row/value limit.
  // Keep surrogate pairs intact when slicing UTF-8 text.
  for (let start = 0, part = 0; start < raw.length; part++) {
    let end = Math.min(start + 256 * 1024, raw.length);
    if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1])) end--;
    statements.push(env.DB.prepare(`INSERT INTO qa_outbox_parts(mail_id,part,raw)
      SELECT id,?2,?3 FROM qa_outbox WHERE capture_key=?1`).bind(captureKey, part, raw.slice(start, end)));
    start = end;
  }
  if (outboundId !== null) statements.push(env.DB.prepare(`UPDATE outbound_mails SET status='sent',sent_at=?3
    WHERE id=?1 AND status='sending' AND send_key=?2 AND EXISTS(SELECT 1 FROM qa_outbox WHERE message_id=?4)`)
    .bind(outboundId, sendKey, createdAt, messageId));
  // Capture and task delivery acknowledgement commit together; retries retain the first MIME.
  await env.DB.batch(statements);
}

export async function listQaOutbox(env, after, limit) {
  const { results: mails } = await env.DB.prepare(`SELECT id,recipient AS "to",subject,message_id,created_at
    FROM qa_outbox WHERE id>?1 ORDER BY id LIMIT ?2`).bind(after, limit).all();
  if (!mails.length) return mails;
  const { results: parts } = await env.DB.prepare(`SELECT mail_id,raw FROM qa_outbox_parts
    WHERE mail_id IN (${mails.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY mail_id,part`).bind(...mails.map(m => m.id)).all();
  const chunks = new Map(mails.map(m => [m.id, []]));
  for (const part of parts) chunks.get(part.mail_id).push(part.raw);
  return mails.map(m => ({ ...m, raw: chunks.get(m.id).join('') }));
}
