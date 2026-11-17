# Mailbot

Hai việc trên cùng một Worker:

1. **Inbox công khai cho agent**: `claude@xuanthieu.site` nhận thư từ bất kỳ ai; agent điều phối (Claude Code, Codex, Antigravity...) đọc thư qua MCP (không phải IMAP), dùng được từ bất kỳ MCP client nào.
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
| Email Routing | MX `route1/2/3.mx.cloudflare.net`; luật literal `claude@`, `codex@`, `agy@` → Worker `mailbot` |
| Worker | [`worker/src/`](worker/src/) (`index.js` định tuyến, `mailbot.js` whitelist/job, `send.js` gửi thư); [`worker/wrangler.toml`](worker/wrangler.toml) |
| D1 | Database `mailbot`; schema `worker/schema.sql` + `worker/schema-v2.sql` + `worker/schema-v3.sql` |
| API | `https://mailbot.thieupro666.workers.dev`; secret `API_TOKEN` (đọc inbox), `ADMIN_TOKEN` (agent, whitelist) |
| MCP | [`mcp/server.mjs`](mcp/server.mjs), stdio, đọc inbox `claude@` |
| Agent laptop | [`agent/mailbot-agent.mjs`](agent/mailbot-agent.mjs), quản trị qua [`agent/mailbot-admin.mjs`](agent/mailbot-admin.mjs), cổng 20025, Scheduled Task `mailbot-agent`; cấu hình `~/.mailbot/agent.json` |
| Subdomain | `mailbot.xuanthieu.site` → laptop:20025 (`lap-web`, xem [laptop-tunnel](../laptop-tunnel/README.md)) |

## Chạy CLI theo thư từ whitelist

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
  (client chỉ gửi `In-Reply-To` vẫn nối đúng). Chỉ lưu phiên của job thành công; `session_id` phải khớp regex ID
  `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`.
- **Quyền của CLI**: mỗi agent chạy trong `E:\mailbot-work\<agent>`:
  `claude -p --permission-mode acceptEdits`, không MCP, cấm `Read`/`Edit` các thư mục `~/.mailbot`, `~/.ssh`,
  `~/.aws`, `~/.codex`, `~/.claude`…; shell chỉ được tự chạy theo allowlist bên dưới;
  `codex exec` sandbox `workspace-write`, tắt MCP (`-c mcp_servers={}`) — sandbox này **không chặn đọc** ngoài thư mục,
  nên Codex về lý thuyết đọc được token trong `~/.mailbot`; `agy --mode accept-edits --sandbox`.
  Tệp đính kèm lưu vào `inbox/job-<id>/<id>-<tên>`. Output thô mỗi lần chạy: `~/.mailbot/runs/job-<id>.out`.
- Giới hạn: 20 job/giờ/người gửi (vượt thì job `rate_limited`, không chạy); mỗi job tối đa 20 phút;
  mỗi agent chạy tuần tự, các agent khác nhau chạy song song.
- Laptop tắt: job nằm chờ trong D1; agent tự kéo khi chạy lại (poll dự phòng mỗi 60 giây). Job `running` quá 30 phút
  được chạy lại 1 lần, treo lần nữa thì thành `failed`. Agent gửi kết quả có thử lại khi lỗi mạng. Giữ 1000 job gần nhất.
- Log agent: `~/.mailbot/agent.log`. Kiểm tra agent sống: `https://mailbot.xuanthieu.site/health`.

Cài agent (một lần): tạo `~/.mailbot/agent.json` với `url`, `admin_token` (= secret `ADMIN_TOKEN`), `port`, `workdir`,
`agents`; rồi `powershell -ExecutionPolicy Bypass -File agent/install-agent.ps1` (gỡ: thêm `-Uninstall`).
`ssh thieuhua-vps1 lap-web add mailbot 20025` để mở subdomain.

### Mailbot: lệnh tiêu đề, gửi tệp và shell

Lệnh chỉ được xử lý sau khi DMARC và whitelist của đúng agent đích đã hợp lệ. Đặt các lệnh liên tiếp ở đầu tiêu đề;
bot bỏ tiền tố `Re:`, `Fwd:`, `Fw:`, `Tr:` lặp lại, không phân biệt hoa thường. Phần còn lại là tiêu đề job.
Ví dụ: `Re: /new /model=opus /effort=high Phân tích lỗi`. `/etc/fstab` là tiêu đề thường; lệnh sau chữ thường không được xử lý.

| Lệnh | Hành vi |
| --- | --- |
| `/new` | Bỏ resume; nếu thành công, chuỗi thư dùng phiên mới |
| `/model=<id>` | Chọn model cho lần chạy; thay thế `agy_model` nếu dùng agy |
| `/effort=<low\|medium\|high\|xhigh\|max>` | Chọn effort; Codex đổi `max` thành `xhigh` |
| `/status` | Không tạo job; trả job đang chờ/chạy và 5 job gần nhất của chính người gửi |
| `/cancel` hoặc `/cancel=<id>` | Chỉ hủy job của chính người gửi, trên mọi agent; pending hủy ngay, running yêu cầu dừng |

Mỗi thư chỉ có một lệnh `/status` hoặc `/cancel`, không ghép với các tùy chọn tạo job. Lệnh lạ/sai giá trị trả danh sách lệnh;
không trả trợ giúp nếu người gửi đã chạm giới hạn 20 job/giờ. Agent kiểm tra yêu cầu hủy mỗi 15 giây (request timeout 5 giây),
dừng cây tiến trình bằng `taskkill /T /F`, không lưu phiên của job hủy. Running đã yêu cầu hủy quá 30 phút chuyển sang `cancelled`, không claim lại.

Để **gửi tệp trong thư trả lời**, yêu cầu CLI ghi tệp vào `<cwd>/outbox/job-<id>/`; đường dẫn cụ thể nằm trong prompt mỗi job,
kể cả khi resume. Chỉ nhận tệp thường ở cấp 1, không symlink/junction/hardlink, tối đa 10 tệp và tổng 2 MB (`2 × 1024 × 1024` byte).
Tệp vượt giới hạn hoặc không an toàn bị bỏ, kèm ghi chú cuối thư. Agent đọc xong dọn thư mục job; Worker gửi MIME multipart,
chỉ lưu `{filename, size}` vào `jobs.outbox_json`, không lưu nội dung tệp đầu ra vào D1.

Claude mặc định chỉ cho shell với `git status`, `git diff`, `git log`, `git show` qua các mẫu
`Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`.
Các mẫu deny chặn `--no-index`, `--output`, `--ext-diff`, `-c `, `core.*` và tên từng thư mục trong `SECRET_DIRS`;
các deny Read/Edit và cấu hình tắt MCP vẫn được giữ.
Test runner **không bật mặc định**. Chỉ thêm khi chủ máy chủ động cấu hình
`projects.<tag>.claude_allowed_tools`, ví dụ `["Bash(npm test:*)"]`.
**Bật test runner tương đương cho chạy mã tùy ý ngoài kiểm soát Read/Edit.** Đợt A chưa định tuyến project/tag hay tạo worktree;
cấu hình theo project chỉ được dùng khi job có `project` tương ứng. Email hiện tại vẫn chạy trong thư mục riêng của agent.

Cờ đã đối chiếu cục bộ bằng `claude --help`, `node E:\ENV_PATH\npm-global\node_modules\@openai\codex\bin\codex.js exec --help`,
`agy --help`: các cờ model/effort cần dùng đều có; Codex dùng `-m` và `-c model_reasoning_effort="..."`.
Claude có `--system-prompt-snapshot off` nên agent truyền cờ này. Không gọi model trong bước kiểm cờ.

### Migrate schema v3 một lần

Database đã có v2: chủ máy chạy **đúng một lần**, trước khi chạy Worker/agent phiên bản mới:

```powershell
cd worker
npx wrangler d1 execute mailbot --remote --file=schema-v3.sql
```

SQLite không có `ADD COLUMN IF NOT EXISTS`; chạy lại v3 sẽ lỗi `duplicate column name`. Không dùng `npm run schema`
để nâng cấp database đã có v3. Cài database mới thì `npm run schema` chạy cả ba schema theo thứ tự một lần.
V3 có đủ cột dự phòng T1/T8, `threads.project` và trạng thái `cancelled`; job không xuất phát từ thư dùng `message_id = 0`.
T1, T8 và MCP điều phối chưa được triển khai trong đợt A.

## Dùng hằng ngày

Gửi thư đến `claude@xuanthieu.site`, rồi yêu cầu agent kiểm tra thư, đọc thư hoặc chờ mã xác minh.
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
- `save_attachment` mặc định lưu tại `~/.mailbot/attachments/<message_id>/`, không tự mở hay chạy tệp.
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

File `~/.mailbot/config.json`:

```json
{
  "url": "https://mailbot.thieupro666.workers.dev",
  "token": "<API_TOKEN>",
  "address": "claude@xuanthieu.site"
}
```

Có thể dùng `MAILBOT_URL` và `MAILBOT_TOKEN`; biến môi trường ưu tiên hơn file.
URL mặc định là `https://mailbot.thieupro666.workers.dev`; `address` mặc định là `claude@xuanthieu.site`.
Token chỉ lưu trong cấu hình riêng và secret Worker, không đưa vào git.

### Đăng ký MCP cho các client

Thay `<abs>` bằng đường dẫn tuyệt đối đến workspace chứa `mailbot/`. Chạy một trong các cách sau theo client đang dùng.

**Claude Code** (phạm vi user):

```powershell
claude mcp add -s user mailbot -- node "<abs>\mailbot\mcp\server.mjs"
```

**Codex**: thêm vào `~/.codex/config.toml` (dấu `\` trong chuỗi TOML phải viết thành `\\`, kể cả phần `<abs>`):

```toml
[mcp_servers.mailbot]
command = "node"
args = ["<abs>\\mailbot\\mcp\\server.mjs"]
```

**Antigravity** (cú pháp đã đối chiếu bằng `agy mcp --help` và `agy mcp add --help` cục bộ):

```powershell
agy mcp add --type stdio mailbot node "<abs>\mailbot\mcp\server.mjs"
```

Các lệnh trên chỉ là hướng dẫn đăng ký, không tự thêm cấu hình cho client.

## Cài đặt lại từ đầu

1. Chạy `npm install` trong cả `worker/` và `mcp/`.
2. Trong `worker/`: `npx wrangler login`, rồi `npx wrangler d1 create mailbot`; thay `REPLACE_WITH_D1_ID` bằng ID mới trong `wrangler.toml` (binding vẫn là `DB`).
3. Với database mới, chạy `npm run schema` (áp dụng lần lượt `schema.sql`, `schema-v2.sql`, `schema-v3.sql` trên D1 remote một lần; xác nhận khi Wrangler hỏi), rồi `npx wrangler deploy`.
4. Tạo token ngẫu nhiên; chạy `npx wrangler secret put API_TOKEN`, nhập token và ghi cùng token vào cấu hình MCP ở trên.
5. Bật Email Routing và tạo luật nhận thư:

```powershell
npx wrangler email routing enable xuanthieu.site
npx wrangler email routing rules create xuanthieu.site --name "mailbot inbox" --match-type literal --match-field to --match-value claude@xuanthieu.site --action-type worker --action-value mailbot
```

6. Đăng ký MCP cho client tương ứng theo mục trên.

## Thử cục bộ

Trong `worker/`, với database local mới, chạy ba schema một lần:

```powershell
npx wrangler d1 execute mailbot --local --file=schema.sql
npx wrangler d1 execute mailbot --local --file=schema-v2.sql
npx wrangler d1 execute mailbot --local --file=schema-v3.sql
```

Tạo `.dev.vars` chứa `API_TOKEN=localtest`, rồi chạy `npx wrangler dev --port 8799`.
Ở terminal khác, dùng một file `test.eml` có sẵn:

```powershell
curl.exe -X POST --data-binary "@test.eml" "http://127.0.0.1:8799/cdn-cgi/handler/email?from=test@example.com&to=claude@xuanthieu.site"
curl.exe -H "Authorization: Bearer localtest" "http://127.0.0.1:8799/messages"
```

## Vận hành

- Theo dõi log: `npm run tail` trong `worker/`.
- Đổi token: tạo token mới, chạy `npx wrangler secret put API_TOKEN`, cập nhật `~/.mailbot/config.json`; khởi động lại phiên MCP để nạp cấu hình.

## Kiểm thử

Các kết quả dưới đây được ghi nhận trước lần đổi tên dự án. Chưa kiểm thử lại dịch vụ triển khai tại URL mới hoặc D1 mới.
Kiểm tra mã nguồn bằng `node --check <file>` cho mọi `.mjs`/`.js` trong `agent/`, `mcp/`, `worker/src/`.
Trong cả `worker/` và `agent/`, chạy `npm test` (script `node --test`, không gọi mạng).
Test worker dùng hàm từ `src/`, PostalMime và SQLite memory (`node:sqlite`, Node 26), không dùng D1 thật;
test agent tạo tệp trong thư mục tạm hệ thống, thử hardlink, symlink, giới hạn tệp và dọn outbox. Symlink thiếu quyền thì skip.
Nếu sandbox Windows chặn test runner tạo tiến trình con (`spawn EPERM`), chạy `node --test --test-isolation=none`.
Trong `worker/`, kiểm tra bundle bằng `npx wrangler deploy --dry-run --outdir "$env:TEMP\mb-dry"` (cần dependency đã cài; không deploy).
Hướng dẫn tiếp quản mã nguồn và các bất biến bảo mật: [`AGENTS.md`](AGENTS.md).

Đợt A, 2026-11-18, offline: `node --check` qua 14 tệp; test với `--test-isolation=none` qua 15/15 worker và 10/10 agent, không skip.
`node --test` mặc định và Wrangler dry-run bị sandbox chặn với `spawn EPERM`.
Chưa kiểm chứng send_email thực, dừng cây CLI thực hay CPU trên Cloudflare Free; không deploy hoặc migrate database đang dùng.
Message-ID thư kết quả ổn định theo job để retry sau khi lưu kết quả vẫn nối đúng phiên. Retry dùng output/status đã lưu,
kiểm tra metadata đính kèm trùng khớp và chỉ gửi lại khi job kết thúc nhưng `reply_status IS NULL`.

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
- Trong `worker/`: `npx wrangler delete`, rồi `npx wrangler d1 delete mailbot` (xóa toàn bộ thư).
- Chạy `claude mcp remove mailbot -s user`, rồi xóa `~/.mailbot` cùng cấu hình và đính kèm đã lưu.
