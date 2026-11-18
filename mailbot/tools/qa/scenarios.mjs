// LIVE mail tests; importing this module does not send mail or read credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import PostalMime from '../../worker/node_modules/postal-mime/src/postal-mime.js';
import { parseOptions } from './sign.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const names = ['happy-codex', 'stranger', 'bad-dkim', 'auto-submitted', 'status', 'thread', 'ask-user'];
const owner = 'qa@qa.xuanthieu.site';
const negativeMs = 40_000, pollMs = 2_000;

class Outbox {
  constructor(url, token) {
    this.url = url;
    this.headers = { authorization: `Bearer ${token}` };
    this.cursor = 0;
  }

  async drain(deadline = performance.now() + 30_000, collect = true) {
    const found = [];
    for (;;) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new Error('Hết thời gian đọc/phân trang QA outbox');
      let response;
      try {
        response = await fetch(`${this.url}/api/qa/outbox?after_id=${this.cursor}&limit=100`, {
          headers: this.headers, signal: AbortSignal.timeout(Math.min(5_000, remaining)), redirect: 'error',
        });
      } catch {
        throw new Error('Không truy cập được QA outbox (network/timeout/redirect)');
      }
      if (!response.ok) throw new Error(`QA outbox HTTP ${response.status}`);
      let data;
      try { data = await response.json(); } catch { throw new Error('QA outbox không trả JSON hợp lệ'); }
      if (!Array.isArray(data.mails) || data.mails.length > 100) throw new Error('QA outbox sai schema');
      for (const mail of data.mails) {
        if (!Number.isSafeInteger(mail.id) || mail.id <= this.cursor ||
            !['to', 'subject', 'message_id', 'raw'].every((key) => typeof mail[key] === 'string')) {
          throw new Error('QA outbox sai schema/thứ tự id');
        }
        if (collect) found.push(mail);
        this.cursor = mail.id;
      }
      if (data.mails.length < 100) return found;
    }
  }

  async wait(nonce, recipient, predicate, timeoutMs) {
    const end = performance.now() + timeoutMs;
    for (;;) {
      // Query once more at the deadline for a negative assertion.
      const mails = await this.drain(Math.max(end, performance.now() + 5_000));
      for (const mail of mails) {
        if (!mail.subject.includes(nonce)) continue;
        if (predicate === null) throw new Error(`Có thư ngoài dự kiến, outbox #${mail.id}`);
        if (mail.to.toLowerCase() !== recipient) continue;
        const parsed = await PostalMime.parse(mail.raw);
        assert.equal(parsed.messageId, mail.message_id, 'Message-ID MIME khác metadata');
        assert.match(parsed.subject || '', /^Re:/i, 'Thư trả lời thiếu Re:');
        const hit = { ...mail, text: parsed.text || '', messageId: parsed.messageId };
        if (predicate(hit)) return hit;
      }
      const remaining = end - performance.now();
      if (remaining <= 0) {
        if (predicate === null) return;
        throw new Error(`Hết ${timeoutMs / 1000}s, chưa có thư trả lời đúng yêu cầu`);
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }
}

async function send(to, subject, body, options, expectSenderReject = false) {
  // The admin token belongs only to this process, never the signer/SSH process.
  const { mailFrom = '', ...signOptions } = options;
  const env = { ...process.env, QA_OPTS: JSON.stringify(signOptions), QA_MAIL_FROM: mailFrom, QA_EXPECT_SENDER_REJECT: expectSenderReject ? '1' : '0' };
  delete env.QA_ADMIN_TOKEN;
  await new Promise((done, reject) => {
    const child = spawn('bash', [join(here, 'send.sh'), to, subject, body], {
      cwd: here, env, stdio: 'ignore', windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('send.sh quá 60s; kết quả SMTP chưa xác định, không tự gửi lại'));
    }, 60_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Không khởi chạy được bash/send.sh; cần Git Bash hoặc Linux bash'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error(`send.sh thất bại (exit ${code}); kiểm tra SSH/SMTP và khóa DKIM`));
    });
  });
}

function taskId(mail) {
  const signatures = [...mail.text.matchAll(/^-- task #([1-9]\d*) run #[1-9]\d*\s*$/gm)];
  assert.ok(signatures.length, 'Thư thiếu chữ ký -- task #N run #N');
  return signatures.at(-1)[1];
}

const isResult = (mail) => /^<mailbot-run-\d+@[^<>\s]+>$/.test(mail.messageId);
const happyPrompt = (nonce) => `Đây là QA qua email. Trả lời đúng một dòng: ok-${nonce}. Không dùng notify, không tạo file, không chạy lệnh shell.`;

async function runScenario(name, nonce, { outbox, to, options, replyMs }) {
  const subject = `QA ${name} ${nonce}`;
  await outbox.drain(undefined, false); // Establish the new-mail cursor before SMTP.
  const deliver = (body, overrides = {}, title = subject) => send(to, title, body, { ...options, ...overrides },
    name === 'stranger' || name === 'bad-dkim');
  const wait = (predicate, recipient = owner, timeout = replyMs) => outbox.wait(nonce, recipient, predicate, timeout);
  const negative = (recipient = owner) => wait(null, recipient, negativeMs);
  const happy = async () => {
    await deliver(happyPrompt(nonce));
    const reply = await wait((mail) => isResult(mail) && mail.text.includes(`ok-${nonce}`));
    taskId(reply);
    return reply;
  };

  switch (name) {
    case 'happy-codex':
      await happy();
      break;
    case 'stranger': {
      const stranger = 'qa-stranger@qa.xuanthieu.site';
      await deliver(happyPrompt(nonce), { from: stranger });
      await negative(stranger);
      break;
    }
    case 'bad-dkim': {
      // An ephemeral wrong key, never touching the real DKIM key/config.
      const tmpRoot = join(here, '.test-tmp');
      await mkdir(tmpRoot, { recursive: true });
      const tmp = await mkdtemp(join(tmpRoot, 'bad-dkim-'));
      const keyFile = join(tmp, 'wrong.pem');
      try {
        const { privateKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        await writeFile(keyFile, privateKey, { mode: 0o600, flag: 'wx' });
        // Sai khóa DKIM + envelope ở domain khác (SPF không align) => DMARC fail.
        // Nếu chỉ sai khóa mà gửi từ IP VPS với MAIL FROM qa@qa..., SPF vẫn giúp DMARC pass.
        await deliver(happyPrompt(nonce), { dkimKeyFile: keyFile, mailFrom: 'bounce@xuanthieu.site' });
        await negative();
      } finally {
        // Delete only our key and empty directory, without recursive removal.
        await unlink(keyFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(tmp);
      }
      break;
    }
    case 'auto-submitted':
      await deliver(happyPrompt(nonce), { extraHeaders: { 'Auto-Submitted': 'auto-replied' } });
      await negative();
      break;
    case 'status':
      await deliver('/status', {}, `/status ${subject}`);
      await wait((mail) => /^<mailbot-command-\d+@[^<>\s]+>$/.test(mail.messageId) &&
        (mail.text.trim() === '(không có task)' ||
          /^#\d+ (?:claude|codex|agy) (?:active|waiting|done|failed|cancelled)(?:\s|:)/m.test(mail.text)));
      break;
    case 'thread': {
      const first = await happy();
      await deliver('Nhắc lại mã ok- bạn đã trả lời trong lượt trước, đúng một dòng. Không dùng notify.', {
        inReplyTo: first.messageId, references: first.messageId,
      }, `Re: ${subject}`);
      const second = await wait((mail) => isResult(mail) && mail.messageId !== first.messageId && mail.text.includes(`ok-${nonce}`));
      assert.equal(taskId(second), taskId(first), 'Thư thứ hai chuyển sang task khác');
      break;
    }
    case 'ask-user': {
      await deliver(`Đây là QA kiểm tra công cụ ask_user. Hãy gọi mailbot-run ask_user với question chính xác là "Câu hỏi QA ${nonce}: bạn chọn gì?" rồi kết thúc lượt để chờ email. Không dùng reply/notify/spawn, không hỏi qua stdout. Sau khi nhận email trả lời, dùng reply trả đúng nội dung câu trả lời đó rồi kết thúc; không hỏi tiếp.`);
      const question = await wait((mail) => /^<mailbot-question-\d+@[^<>\s]+>$/.test(mail.messageId) &&
        mail.text.includes(`Câu hỏi QA ${nonce}`));
      const questionTask = taskId(question);
      // Generated only after the question so the initial prompt cannot leak the answer.
      const answer = `answer-${randomBytes(12).toString('hex')}`;
      await deliver(answer, { inReplyTo: question.messageId, references: question.messageId }, `Re: ${subject}`);
      const result = await wait((mail) => isResult(mail) && mail.text.includes(answer));
      assert.equal(taskId(result), questionTask, 'Kết quả ask_user chuyển sang task khác');
      break;
    }
  }
  return nonce;
}

async function main() {
  const selected = process.argv.slice(2);
  if (selected.includes('--help')) {
    console.log(`LIVE: node tools/qa/scenarios.mjs [${names.join(' | ')}]\nKhông có tên: chạy tất cả. Cần QA_ADMIN_TOKEN; xem README mục QA.`);
    return;
  }
  for (const name of selected) assert.ok(names.includes(name), `Kịch bản không tồn tại: ${name}`);
  const url = new URL(process.env.QA_URL || 'https://mailbot.thieupro666.workers.dev');
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'QA_URL cần HTTPS, không chứa credential/query/fragment');
  assert.ok(process.env.QA_ADMIN_TOKEN, 'Thiếu QA_ADMIN_TOKEN trong môi trường (không đọc ~/.mailbot)');
  const to = process.env.QA_TO || 'codex@xuanthieu.site';
  assert.match(to, /^codex@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, 'QA_TO cần địa chỉ codex@domain');
  const options = parseOptions(process.env.QA_OPTS);
  assert.equal(options.from, owner, 'QA_OPTS.from của runner phải là qa@qa.xuanthieu.site');
  assert.ok(!options.skipDkim && !options.inReplyTo && !options.references && !Object.keys(options.extraHeaders).length,
    'Runner chỉ nhận QA_OPTS.dkimKeyFile/from; từng kịch bản tự đặt header');
  const seconds = Number(process.env.QA_REPLY_TIMEOUT_SECONDS || 60);
  assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 90, 'QA_REPLY_TIMEOUT_SECONDS phải nguyên 10..90');
  const context = { outbox: new Outbox(url.href.replace(/\/$/, ''), process.env.QA_ADMIN_TOKEN), to, options, replyMs: seconds * 1000 };
  let failures = 0;
  for (const name of selected.length ? selected : names) {
    const started = performance.now();
    const nonce = randomBytes(12).toString('hex');
    try {
      await runScenario(name, nonce, context);
      console.log(`PASS ${name} nonce=${nonce} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failures++;
      // Never print server response bodies, subprocess output, or configuration.
      console.error(`FAIL ${name} nonce=${nonce}: ${error.message}`);
    }
  }
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`FAIL setup: ${error.message}`);
    process.exitCode = 1;
  });
}
