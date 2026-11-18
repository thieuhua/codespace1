// Dùng: QA_OPTS='{"from":"qa@qa.xuanthieu.site"}' node sign.mjs <out.eml> <to> <subject> <body>
import { createHash, createSign, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const domain = 'qa.xuanthieu.site', selector = 'mb1';
const address = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const singleLine = (v) => typeof v === 'string' && !/[\x00-\x1f\x7f]/.test(v);
const reserved = new Set(['from', 'to', 'subject', 'date', 'message-id', 'mime-version',
  'content-type', 'content-transfer-encoding', 'dkim-signature', 'in-reply-to', 'references']);

export function parseOptions(json = '{}') {
  const opts = JSON.parse(json);
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new Error('QA_OPTS phải là JSON object');
  const allowed = ['from', 'extraHeaders', 'inReplyTo', 'references', 'dkimKeyFile', 'skipDkim'];
  if (Object.keys(opts).some((k) => !allowed.includes(k))) throw new Error('QA_OPTS có tùy chọn không hỗ trợ');
  const from = opts.from ?? `qa@${domain}`;
  if (typeof from !== 'string' || !address.test(from)) throw new Error('from không hợp lệ');
  for (const k of ['inReplyTo', 'references', 'dkimKeyFile']) {
    if (opts[k] !== undefined && (!singleLine(opts[k]) || !opts[k].trim())) throw new Error(`${k} không hợp lệ`);
  }
  for (const k of ['inReplyTo', 'references']) {
    if (opts[k] !== undefined && !/^<[^<>\s]+>(?: +<[^<>\s]+>)*$/.test(opts[k])) throw new Error(`${k} cần Message-ID dạng <id@domain>`);
  }
  if (opts.skipDkim !== undefined && typeof opts.skipDkim !== 'boolean') throw new Error('skipDkim phải là boolean');
  const extra = opts.extraHeaders ?? {};
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('extraHeaders phải là object');
  const seen = new Set(reserved);
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || seen.has(name.toLowerCase()) || !singleLine(value)) {
      throw new Error('extraHeaders không hợp lệ hoặc trùng header dành riêng');
    }
    seen.add(name.toLowerCase());
  }
  return { ...opts, from, extraHeaders: extra };
}

export function relaxedBody(body) {
  const text = body.replace(/\r?\n/g, '\r\n').split('\r\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' ')).join('\r\n')
    .replace(/(\r\n)*$/, '');
  return text ? text + '\r\n' : '';
}

export const relaxedHeader = (name, value) => `${name.toLowerCase()}:${value
  .replace(/\r\n[ \t]+/g, ' ').replace(/[ \t]+/g, ' ').trim()}`;

// Pure builder: callers/tests inject the key; only the CLI reads a key file.
export function buildMessage({ to, subject, body, options = {}, key }) {
  const opts = parseOptions(JSON.stringify(options));
  if (typeof to !== 'string' || !address.test(to) || !singleLine(subject) || typeof body !== 'string') {
    throw new Error('Cần <out.eml> <to> <subject> <body> hợp lệ');
  }
  const headers = [
    ['From', `QA Sender <${opts.from}>`], ['To', to], ['Subject', subject],
    ['Date', new Date().toUTCString().replace('GMT', '+0000')],
    ['Message-ID', `<qa-${randomUUID()}@${domain}>`],
    ['MIME-Version', '1.0'], ['Content-Type', 'text/plain; charset=utf-8'],
    ['Content-Transfer-Encoding', '8bit'],
    ...(opts.inReplyTo ? [['In-Reply-To', opts.inReplyTo]] : []),
    ...(opts.references ? [['References', opts.references]] : []),
    ...Object.entries(opts.extraHeaders),
  ];
  const bodyText = body.replace(/\\n/g, '\n').replace(/\r?\n/g, '\r\n');
  const lines = headers.map(([name, value]) => `${name}: ${value}`);
  if (!opts.skipDkim) {
    const bh = createHash('sha256').update(relaxedBody(bodyText)).digest('base64');
    const signed = headers.map(([name]) => name.toLowerCase());
    const sigNoB = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; h=${signed.join(':')}; bh=${bh}; b=`;
    const toSign = headers.map(([name, value]) => relaxedHeader(name, value)).join('\r\n')
      + '\r\n' + relaxedHeader('DKIM-Signature', sigNoB);
    const signature = createSign('RSA-SHA256').update(toSign).sign(key, 'base64');
    lines.unshift(`DKIM-Signature: ${sigNoB}${signature.replace(/(.{70})/g, '$1\r\n\t')}`);
  }
  return lines.join('\r\n') + '\r\n\r\n' + bodyText + '\r\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [out, to, subject, body] = process.argv.slice(2);
    if (!out || !to || subject === undefined || body === undefined) throw new Error('Dùng: node sign.mjs <out.eml> <to> <subject> <body>');
    const options = parseOptions(process.env.QA_OPTS);
    const key = options.skipDkim ? undefined : readFileSync(options.dkimKeyFile ?? join(homedir(), '.mailbot', 'qa', 'dkim-mb1.pem'));
    const eml = buildMessage({ to, subject, body, options, key });
    writeFileSync(out, eml);
    console.log('ok', Buffer.byteLength(eml), 'bytes');
  } catch (error) {
    console.error('sign:', error.message);
    process.exitCode = 1;
  }
}
