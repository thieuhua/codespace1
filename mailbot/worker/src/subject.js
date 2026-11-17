export const COMMAND_HELP = "Lệnh tiêu đề: /new /model=<id> /effort=<low|medium|high|xhigh|max> /status /cancel /cancel=<id>. Đặt lệnh ở đầu tiêu đề, trước phần tiêu đề thường.";

// Chỉ gọi sau senderAuth + whitelist cho agent đích.
export function parseSubject(subject) {
  const rest = String(subject || "").replace(/^(?:(?:re|fwd|fw|tr)\s*:\s*)+/i, "").trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const options = {};
  let action = null, cancelId = null, error = null, i = 0;
  for (; i < tokens.length && /^\/[a-z]+(?:=[A-Za-z0-9][A-Za-z0-9._:-]{0,63})?$/.test(tokens[i]); i++) {
    const [name, value] = tokens[i].split("=");
    if (name === "/new" && value === undefined) options.new = true;
    else if (name === "/model" && value) options.model = value;
    else if (name === "/effort" && /^(low|medium|high|xhigh|max)$/.test(value || "")) options.effort = value;
    else if ((name === "/status" && value === undefined) ||
      (name === "/cancel" && (value === undefined || /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))))) {
      if (action) error = "Chỉ dùng một lệnh /status hoặc /cancel mỗi thư.";
      action = name.slice(1);
      cancelId = value === undefined ? null : Number(value);
    } else error = `Lệnh không hợp lệ: ${tokens[i]}`;
  }
  if (action && Object.keys(options).length) error = "Không ghép /status hoặc /cancel với lệnh tạo job.";
  return { subject: tokens.slice(i).join(" "), options, action, cancelId, error };
}
