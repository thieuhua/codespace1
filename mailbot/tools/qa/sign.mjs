// Tạo thư RFC 5322 và ký DKIM (rsa-sha256, relaxed/relaxed). Dùng: node qa-sign.mjs <out.eml> <to> <subject> <body>
import { createHash, createSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [out, to, subject, body] = process.argv.slice(2);
const domain = 'qa.xuanthieu.site', selector = 'mb1', from = `qa@${domain}`;
const key = readFileSync(join(homedir(), '.mailbot', 'qa', 'dkim-mb1.pem'));

const headers = [
  ['From', `QA Sender <${from}>`],
  ['To', to],
  ['Subject', subject],
  ['Date', new Date().toUTCString().replace('GMT', '+0000')],
  ['Message-ID', `<qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${domain}>`],
  ['MIME-Version', '1.0'],
  ['Content-Type', 'text/plain; charset=utf-8'],
  ['Content-Transfer-Encoding', '8bit'],
];

const relaxedBody = (b) => {
  let s = b.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => l.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' ')).join('\r\n');
  s = s.replace(/(\r\n)*$/, '');
  return s ? s + '\r\n' : '';
};
const relaxedHeader = (n, v) => `${n.toLowerCase()}:${v.replace(/\r\n[ \t]+/g, ' ').replace(/[ \t]+/g, ' ').trim()}`;

const bodyText = body.replace(/\\n/g, '\n');
const bh = createHash('sha256').update(relaxedBody(bodyText)).digest('base64');
const signed = ['from', 'to', 'subject', 'date', 'message-id'];
const sigNoB = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; h=${signed.join(':')}; bh=${bh}; b=`;
const toSign = signed.map((n) => relaxedHeader(n, headers.find(([k]) => k.toLowerCase() === n)[1])).join('\r\n')
  + '\r\n' + relaxedHeader('DKIM-Signature', sigNoB);
const b = createSign('RSA-SHA256').update(toSign).sign(key, 'base64');
const sigHeader = `DKIM-Signature: ${sigNoB}${b.replace(/(.{70})/g, '$1\r\n\t')}`;

const eml = [sigHeader, ...headers.map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n' + bodyText.replace(/\r?\n/g, '\r\n') + '\r\n';
writeFileSync(out, eml);
console.log('ok', eml.length, 'bytes');
