// Workers Free: người nhận phải là địa chỉ đã xác minh trong Email Routing.
import { EmailMessage } from "cloudflare:email";
import { buildMail } from "./mime.js";

export async function sendMail(env, mail) {
  await env.EMAIL.send(new EmailMessage(mail.from, mail.to, buildMail(mail)));
}

export async function sendReply(env, job, text, messageId, attachments = []) {
  const subject = String(job.subject || "").replace(/[\r\n]+/g, " ").trim();
  return sendMail(env, {
    from: `${job.agent}@${env.MAIL_DOMAIN || "xuanthieu.site"}`, to: job.sender,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || "(no subject)"}`,
    text, inReplyTo: job.rfc_message_id, references: job.references_hdr, messageId, attachments, jobId: job.id,
  });
}
