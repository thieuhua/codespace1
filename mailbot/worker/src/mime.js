const one = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const ids = (s) => one(s).match(/<[^<>\s]+>/g) || [];
const address = /^[^\s<>@,;"\x00-\x1f\x7f]+@[^\s<>@,;"\x00-\x1f\x7f]+$/;

export function validateAttachments(input = []) {
  if (!Array.isArray(input) || input.length > 10) throw new Error("attachments: tối đa 10 tệp");
  let total = 0;
  return input.map((a) => {
    if (!a || typeof a.b64 !== "string") throw new Error("attachments: base64 không hợp lệ");
    total += a.b64.length;
    if (total > 2.8 * 1024 * 1024) throw new Error("attachments: base64 vượt 2.8 MB");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.b64) || a.b64.length % 4 !== 0) {
      throw new Error("attachments: base64 không hợp lệ");
    }
    if (typeof a.mime_type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime_type)) throw new Error("attachments: MIME không hợp lệ");
    const filename = String(a.filename ?? "").replace(/[\x00-\x1f\x7f-\x9f"\\/]/g, "").slice(0, 150).toWellFormed() || "attachment";
    const size = a.b64.length / 4 * 3 - (a.b64.endsWith("==") ? 2 : a.b64.endsWith("=") ? 1 : 0);
    return { filename, mime_type: a.mime_type, b64: a.b64, size };
  });
}

export function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const wrap76 = (s) => s.match(/.{1,76}/g)?.join("\r\n") || "";

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

export function buildMail({ from, to, subject, text, inReplyTo, references, messageId, attachments = [], jobId },
  { boundary = `mailbot-${crypto.randomUUID()}`, date = new Date() } = {}) {
  if (!address.test(from) || !address.test(to)) throw new Error("địa chỉ thư không hợp lệ");
  const files = validateAttachments(attachments);
  const all = [...new Set([...ids(references), ...ids(inReplyTo)])];
  const refs = all.length > 10 ? [all[0], ...all.slice(-9)] : all;
  const irt = ids(inReplyTo)[0];
  const headers = [
    `From: ${encodeWord(from.split('@')[0])} <${from}>`, `To: <${to}>`, `Subject: ${encodeWord(one(subject).slice(0, 200))}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${ids(messageId)[0] || `<mailbot-${crypto.randomUUID()}@${from.split("@")[1]}>`}`,
    irt ? `In-Reply-To: ${irt}` : null,
    refs.length ? `References: ${refs.join("\r\n ")}` : null,
    Number.isSafeInteger(jobId) ? `X-Mailbot-Job: ${jobId}` : null, "MIME-Version: 1.0",
  ].filter(Boolean);
  const plain = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(b64utf8(String(text ?? "")))].join("\r\n");
  if (!files.length) return headers.join("\r\n") + "\r\n" + plain + "\r\n";
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [plain];
  for (const a of files) {
    const ascii = a.filename.replace(/[^\x20-\x7e]/g, "_");
    const encoded = encodeURIComponent(a.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    parts.push([`Content-Type: ${a.mime_type}`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`, "", wrap76(a.b64)].join("\r\n"));
  }
  return headers.join("\r\n") + "\r\n\r\n" + parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("") + `--${boundary}--\r\n`;
}
