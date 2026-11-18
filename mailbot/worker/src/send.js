// Workers Free: người nhận phải là địa chỉ đã xác minh trong Email Routing.
import { EmailMessage } from "cloudflare:email";
import { buildMail } from "./mime.js";
import { captureQaMail, isQaRecipient } from "./qa-outbox.js";

export async function sendMail(env, mail, reservation) {
  const raw = buildMail(mail);
  if (isQaRecipient(env, mail.to)) {
    await captureQaMail(env, mail, raw, reservation);
    return;
  }
  await env.EMAIL.send(new EmailMessage(mail.from, mail.to, raw));
}

export async function sendReply(env, job, text, messageId, attachments = []) {
  const subject = String(job.subject || "").replace(/[\r\n]+/g, " ").trim();
  return sendMail(env, {
    from: `${job.agent}${job.project ? '+' + job.project : ''}@${env.MAIL_DOMAIN || "xuanthieu.site"}`, to: job.reply_to || job.sender,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || "(no subject)"}`,
    text, inReplyTo: job.rfc_message_id, references: job.references_hdr, messageId, attachments, jobId: job.id,
  });
}
