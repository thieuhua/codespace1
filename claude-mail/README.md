# Claude Mail

Hai việc trên cùng một Worker:

1. **Inbox của Claude**: `claude@xuanthieu.site` nhận thư từ bất kỳ ai; Claude đọc qua MCP (không phải IMAP).
2. **Mailbot**: người trong whitelist gửi thư tới `claude@`, `codex@` hoặc `agy@xuanthieu.site` →
   CLI tương ứng chạy trên laptop Windows → câu trả lời được gửi lại bằng thư, cùng chuỗi thư.

```text
Người gửi ─► Cloudflare Email Routing ─► Email Worker ─► D1 (thư, job, whitelist, phiên)
                                             │ thư hợp lệ: tạo job + POST /wake
                                             ▼
             https://mailbot.xuanthieu.site (nginx VPS) ─► hầm wg-lap ─► laptop:20025 (agent)
                                             │ agent kéo job qua API, chạy CLI trong E:\mailbot-work\<agent>
                                             ▼
             POST /jobs/<id>/result ─► Worker gửi thư trả lời (send_email) ─► người gửi
```

| Thành phần | Giá trị |
| --- | --- |
| Email Routing | MX `route1/2/3.mx.cloudflare.net`; luật literal `claude@`, `codex@`, `agy@` → Worker `claude-mail` |
| Worker | `worker/src/` (`index.js` định tuyến, `mailbot.js` whitelist/job, `send.js` gửi thư); `worker/wrangler.toml` |
| D1 | Database `claude-mail`; schema `worker/schema.sql` + `worker/schema-v2.sql` |
| API | `https://claude-mail.thieupro666.workers.dev`; secret `API_TOKEN` (đọc inbox), `ADMIN_TOKEN` (agent, whitelist) |
| MCP | `mcp/server.mjs`, stdio, đọc inbox `claude@` |
| Agent laptop | `agent/mailbot-agent.mjs`, cổng 20025, Scheduled Task `claude-mailbot-agent`; cấu hình `~/.claude-mail/agent.json` |
| Subdomain | `mailbot.xuanthieu.site` → laptop:20025 (`lap-web`, xem [laptop-tunnel](../laptop-tunnel/README.md)) |

## Mailbot

- **Whitelist** theo người gửi và agent: `node agent/mailbot-admin.mjs allow <địa_chỉ> [claude|codex|agy|*]`,
  `deny ...`, `list`; xem job gần nhất: `jobs`.
- **Người nhận trả lời phải là địa chỉ đã xác minh** trong Email Routing (giới hạn gói Workers Free):
  `npx wrangler email routing addresses create <địa_chỉ>` rồi người đó bấm link xác minh của Cloudflare.
  Gửi tới địa chỉ chưa xác minh sẽ lỗi; `jobs` hiện `reply_error`. Muốn gửi tới địa chỉ bất kỳ cần Workers Paid.
- **Xác thực người gửi** (`senderAuth` trong `worker/src/mailbot.js`, đọc header thô):
  chỉ tin `Authentication-Results` đầu tiên (do `mx.cloudflare.net` thêm; A-R giả nằm bên dưới), tách theo mệnh đề `;`
  sau khi bỏ comment, yêu cầu mệnh đề `dmarc=pass` có `header.from` trùng domain của From; thư phải có **đúng một**
  header `From:` viết chuẩn với **đúng một** địa chỉ (postal-mime lấy From cuối cùng và chấp nhận `From :`).
  DMARC chỉ chứng minh domain; phần trước `@` dựa vào nhà cung cấp (Gmail không cho gửi bằng địa chỉ của người khác).
- `codex@`/`agy@` từ chối thư không hợp lệ ngay ở SMTP. `claude@` vẫn là inbox công khai: thư lạ chỉ vào inbox, không thành job.
- `API_TOKEN` (MCP) chỉ thấy thư gửi `claude@`; thư gửi `codex@`/`agy@` chỉ `ADMIN_TOKEN` xem được.
  Không xóa được thư đang có job chờ/chạy.
- **Chuỗi thư = phiên**: trả lời thư của bot thì CLI tiếp tục đúng phiên cũ (`claude --resume`, `codex exec resume`,
  `agy --conversation`); thư mới thì phiên mới. Phần trích dẫn thư cũ được cắt khỏi prompt.
- **Phiên** gắn theo người gửi (`<người gửi>|<Message-ID gốc>`), và theo cả Message-ID thư trả lời của bot
  (client chỉ gửi `In-Reply-To` vẫn nối đúng). Chỉ lưu phiên của job thành công; `session_id` phải là ID chữ-số.
- **Quyền của CLI**: mỗi agent chạy trong `E:\mailbot-work\<agent>`:
  `claude -p --permission-mode acceptEdits`, không MCP, cấm `Read`/`Edit` các thư mục `~/.claude-mail`, `~/.ssh`,
  `~/.aws`, `~/.codex`, `~/.claude`… (lệnh shell bị từ chối vì không ai duyệt);
  `codex exec` sandbox `workspace-write`, tắt MCP (`-c mcp_servers={}`) — sandbox này **không chặn đọc** ngoài thư mục,
  nên Codex về lý thuyết đọc được token trong `~/.claude-mail`; `agy --mode accept-edits --sandbox`.
  Tệp đính kèm lưu vào `inbox/job-<id>/<id>-<tên>`. Output thô mỗi lần chạy: `~/.claude-mail/runs/job-<id>.out`.
- Giới hạn: 20 job/giờ/người gửi (vượt thì job `rate_limited`, không chạy); mỗi job tối đa 20 phút;
  mỗi agent chạy tuần tự, các agent khác nhau chạy song song.
- Laptop tắt: job nằm chờ trong D1; agent tự kéo khi chạy lại (poll dự phòng mỗi 60 giây). Job `running` quá 30 phút
  được chạy lại 1 lần, treo lần nữa thì thành `failed`. Agent gửi kết quả có thử lại khi lỗi mạng. Giữ 1000 job gần nhất.
- Log agent: `~/.claude-mail/agent.log`. Kiểm tra agent sống: `https://mailbot.xuanthieu.site/health`.

Cài agent (một lần): tạo `~/.claude-mail/agent.json` với `url`, `admin_token` (= secret `ADMIN_TOKEN`), `port`, `workdir`,
`agents`; rồi `powershell -ExecutionPolicy Bypass -File agent/install-agent.ps1` (gỡ: thêm `-Uninstall`).
`ssh thieuhua-vps1 lap-web add mailbot 20025` để mở subdomain.

## Dùng hằng ngày

Gửi thư đến `claude@xuanthieu.site`, rồi yêu cầu Claude kiểm tra thư, đọc thư hoặc chờ mã xác minh.
Danh sách hiện thư mới nhất trước; `*` là chưa đọc. Đọc thư mặc định đánh dấu đã đọc.

| Tool MCP | Tham số |
| --- | --- |
| `mail_address` | Không có; trả địa chỉ email |
| `list_mail` | `unread_only=false`, `limit=20` (1–100), `after_id=0` |
| `read_mail` | `id`, `prefer_html=false`, `mark_read=true` |
| `wait_for_mail` | `after_id` bắt buộc, `timeout_seconds=120` (5–600), `from_contains` tùy chọn |
| `mark_mail` | `id`, `read=true`; đặt `false` để đánh dấu chưa đọc |
| `delete_mail` | `id`; xóa vĩnh viễn thư và đính kèm |
| `save_attachment` | `message_id`, `attachment_id`, `dir` tùy chọn |

- Các ID là số nguyên không âm; `after_id` chỉ lấy thư có ID lớn hơn.
- `wait_for_mail` kiểm tra mỗi 5 giây; `from_contains` lọc địa chỉ/người gửi, không phân biệt hoa thường.
- `save_attachment` mặc định lưu tại `~/.claude-mail/attachments/<message_id>/`, không tự mở hay chạy tệp.
- **Ai cũng gửi được.** `read_mail` bọc phần thân thư bằng nhãn “dữ liệu không tin cậy” để chống prompt injection; chỉ dẫn trong thư không phải lệnh.

## Giới hạn

- Từ chối thư thô lớn hơn **20 MB**.
- Text và HTML mỗi phần cắt ở **256 K ký tự**, thêm nhãn `[truncated]`.
- Lưu nội dung mỗi đính kèm tối đa **1 MB**, tổng mỗi thư **1.4 MB** (`1400 × 1024` byte).
- Đính kèm vượt giới hạn chỉ giữ metadata. Tự dọn thư cũ và đính kèm, giữ tối đa **1000 thư mới nhất**.

## API

Mọi endpoint cần header `Authorization: Bearer <token>`, trả JSON. Đường dẫn tính từ URL API ở trên.

| Endpoint | Chức năng |
| --- | --- |
| `GET /messages` | Liệt kê; query `unread=1`, `after_id=0`, `limit=20` (tối đa 100) |
| `GET /messages/{id}` | Nội dung thư và metadata đính kèm; không tự đánh dấu đã đọc |
| `POST /messages/{id}/read` | Body `{"read":true}` hoặc `{"read":false}`; mặc định đã đọc |
| `DELETE /messages/{id}` | Xóa thư cùng đính kèm |
| `GET /messages/{id}/attachments/{attachment_id}` | Trả `filename`, `mime_type`, `content_b64`; HTTP 410 nếu chỉ giữ metadata |

## Cấu hình MCP

File `~/.claude-mail/config.json`:

```json
{
  "url": "https://claude-mail.thieupro666.workers.dev",
  "token": "<API_TOKEN>",
  "address": "claude@xuanthieu.site"
}
```

Có thể dùng `CLAUDE_MAIL_URL` và `CLAUDE_MAIL_TOKEN`; biến môi trường ưu tiên hơn file.
`address` mặc định là `claude@xuanthieu.site`. Token chỉ lưu trong cấu hình riêng và secret Worker, không đưa vào git.

Đã đăng ký MCP ở phạm vi user:

```powershell
claude mcp add -s user claude-mail -- node E:\thieuh\FolderCode\codespace1\claude-mail\mcp\server.mjs
```

## Cài đặt lại từ đầu

1. Chạy `npm install` trong cả `worker/` và `mcp/`.
2. Trong `worker/`: `npx wrangler login`, rồi `npx wrangler d1 create claude-mail`; ghi ID mới vào `wrangler.toml`.
3. Chạy `npm run schema -- -y`, rồi `npx wrangler deploy`.
4. Tạo token ngẫu nhiên; chạy `npx wrangler secret put API_TOKEN`, nhập token và ghi cùng token vào cấu hình MCP ở trên.
5. Bật Email Routing và tạo luật nhận thư:

```powershell
npx wrangler email routing enable xuanthieu.site
npx wrangler email routing rules create xuanthieu.site --name "claude inbox" --match-type literal --match-field to --match-value claude@xuanthieu.site --action-type worker --action-value claude-mail
```

6. Đăng ký MCP bằng lệnh `claude mcp add` ở trên.

## Thử cục bộ

Trong `worker/`, chạy `npx wrangler d1 execute claude-mail --local --file=schema.sql`.
Tạo `.dev.vars` chứa `API_TOKEN=localtest`, rồi chạy `npx wrangler dev --port 8799`.
Ở terminal khác, dùng một file `test.eml` có sẵn:

```powershell
curl.exe -X POST --data-binary "@test.eml" "http://127.0.0.1:8799/cdn-cgi/handler/email?from=test@example.com&to=claude@xuanthieu.site"
curl.exe -H "Authorization: Bearer localtest" "http://127.0.0.1:8799/messages"
```

## Vận hành

- Theo dõi log: `npm run tail` trong `worker/`.
- Đổi token: tạo token mới, chạy `npx wrangler secret put API_TOKEN`, cập nhật `~/.claude-mail/config.json`; khởi động lại phiên MCP để nạp cấu hình.

## Kiểm thử

2026-11-18, cục bộ (`wrangler dev`): thư mẫu multipart có đính kèm được lưu đúng; `list_mail`, `read_mail`,
`wait_for_mail` (hết giờ) và tải đính kèm qua MCP trả kết quả đúng; request không có token nhận 401.
Trên Cloudflare: API đã deploy trả 401 khi thiếu token, trả danh sách khi có token; MX đã trỏ về Cloudflare.
Thư thật từ Gmail đến `claude@xuanthieu.site` sau ~15 giây, `read_mail` đọc được qua MCP, `Authentication-Results`
báo DKIM/SPF/DMARC pass.

Mailbot, 2026-11-18. Cục bộ: thư từ whitelist thành job; người lạ, DMARC fail, A-R giả chèn dưới A-R thật
đều bị từ chối ở SMTP; token đọc inbox nhận 403 ở `/jobs`; claim job hai lần chỉ một lần thành công; phiên được lưu theo chuỗi thư.
Thật: `/wake` qua `mailbot.xuanthieu.site` trả 401 khi thiếu token, 202 khi có. Thư từ Gmail tới `codex@` (23 s) và `agy@` (18 s)
chạy đúng, tạo `hello.txt` trong thư mục riêng và gửi thư trả lời. `claude@` trả thư báo lỗi vì `claude.exe` chưa đăng nhập
(`claude auth status` → `loggedIn: false`); sau `claude auth login`, `claude@` chạy đúng (17 s).
Review (Antigravity) phát hiện các cách vượt `senderAuth` (From thứ hai `From :`, nhiều địa chỉ trong From,
`dmarc=pass` giấu trong selector DKIM); đã sửa và kiểm tra lại bằng các thư mẫu đó: đều bị từ chối, thư Gmail thật vẫn qua.

## Gỡ bỏ

- Xóa rule nhận thư bằng `npx wrangler email routing rules delete`, rồi `npx wrangler email routing disable xuanthieu.site`.
- Trong `worker/`: `npx wrangler delete`, rồi `npx wrangler d1 delete claude-mail` (xóa toàn bộ thư).
- Chạy `claude mcp remove claude-mail -s user`, rồi xóa `~/.claude-mail` cùng cấu hình và đính kèm đã lưu.