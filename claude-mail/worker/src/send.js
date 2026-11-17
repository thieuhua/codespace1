// Gửi thư trả lời cho job qua binding send_email của Email Routing.
// Gói Workers Free: chỉ gửi được tới địa chỉ đã xác minh (Email Routing → Destination addresses),
// nên mỗi người trong whitelist phải xác minh địa chỉ một lần.
import { EmailMessage } from "cloudflare:email";

export async function sendReply(env, job, text, messageId) {
  const domain = env.MAIL_DOMAIN || "xuanthieu.site";
  const from = `${job.agent}@${domain}`;
  // Giá trị lấy từ thư đến: bỏ CR/LF để không chèn được header mới.
  const one = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();
  const ids = (s) => one(s).match(/<[^<>\s]+>/g) || [];
  const subjectIn = one(job.subject).slice(0, 200);
  const subject = /^re:/i.test(subjectIn) ? subjectIn : `Re: ${subjectIn || "(no subject)"}`;
  const inReplyTo = ids(job.rfc_message_id)[0];
  // References: giữ ID gốc + tối đa 9 ID gần nhất, mỗi ID một dòng (folding) để không vượt 998 ký tự/dòng.
  const all = [...new Set([...ids(job.references_hdr), ...ids(job.rfc_message_id)])];
  const refs = all.length > 10 ? [all[0], ...all.slice(-9)] : all;
  if (!/^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(job.sender)) throw new Error("địa chỉ người nhận không hợp lệ");
  const headers = [
    `From: ${job.agent} <${from}>`,
    `To: <${job.sender}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId || `<mailbot-${job.id}-${crypto.randomUUID()}@${domain}>`}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    refs.length ? `References: ${refs.join("\r\n ")}` : null,
    `X-Mailbot-Job: ${job.id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const raw = headers.join("\r\n") + "\r\n\r\n" + wrap76(b64utf8(text)) + "\r\n";
  await env.EMAIL.send(new EmailMessage(from, job.sender, raw));
}

function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function wrap76(s) {
  return s.match(/.{1,76}/g)?.join("\r\n") || "";
}

// RFC 2047 (kể cả tiêu đề ASCII dài, để luôn fold được); mỗi encoded-word <= 75 ký tự.
function encodeWord(s) {
  if (/^[\x20-\x7e]{0,70}$/.test(s)) return s;
  const parts = [];
  let chunk = "";
  for (const ch of s) {
    if (new TextEncoder().encode(chunk + ch).length > 45) { parts.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) parts.push(chunk);
  return parts.map((p) => `=?UTF-8?B?${b64utf8(p)}?=`).join("\r\n ");
}
