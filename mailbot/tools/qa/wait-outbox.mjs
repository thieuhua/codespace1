// Dùng: node wait-outbox.mjs <after_id> [timeout_giây] [subject-chứa]
// Chờ thư mới trong QA sink (ADMIN_TOKEN từ ~/.mailbot/agent.json), in ra tóm tắt + phần text.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import PostalMime from '../../worker/node_modules/postal-mime/src/postal-mime.js';
const [after = '0', timeout = '180', needle = ''] = process.argv.slice(2);
const c = JSON.parse(readFileSync(join(homedir(), '.mailbot', 'agent.json'), 'utf8'));
const h = { authorization: `Bearer ${c.admin_token}` };
const end = Date.now() + Number(timeout) * 1000;
while (Date.now() < end) {
  const r = await fetch(`${c.url}/api/qa/outbox?after_id=${after}&limit=20`, { headers: h });
  const { mails = [] } = await r.json();
  const hit = mails.filter((m) => !needle || m.subject.includes(needle));
  if (hit.length) {
    for (const m of hit) {
      const p = await PostalMime.parse(m.raw);
      console.log(`#${m.id} ${m.created_at} to=${m.to}\nsubject: ${m.subject}\nattachments: ${p.attachments.map((a) => a.filename).join(', ') || '-'}\n---\n${(p.text || '').trim().slice(0, 600)}\n`);
    }
    process.exit(0);
  }
  await new Promise((s) => setTimeout(s, 5000));
}
console.log('timeout: không có thư mới');
process.exit(2);
