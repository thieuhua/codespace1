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
| Email Routing | MX `route1/2/3.mx.cloudflare.net`; catch-all → Worker `mailbot` (Worker tự từ chối địa chỉ không hợp lệ) |
| Worker | [`worker/src/`](worker/src/) (`index.js` định tuyến, `mailbot.js` whitelist/job, `send.js` gửi thư); [`worker/wrangler.toml`](worker/wrangler.toml) |
| D1 | Database `mailbot`; schema `worker/schema.sql` + `worker/schema-v2.sql` + `worker/schema-v3.sql` + `worker/schema-v4.sql` |
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
  ngoài chuỗi ngoặc kép sau khi bỏ comment, yêu cầu mệnh đề `dmarc=pass` có `header.from=domain` hoặc `header.from="domain"`
  trùng domain của From. Thư phải có **đúng một** header `From:` chuẩn: `addr` hoặc `Tên hiển thị <addr>`;
  tên có thể được bọc bằng ngoặc kép (không escape/ngoặc kép bên trong), tên không bọc cấm `<>(),;"\\@`.
  Không chấp nhận comment hay dấu phẩy; địa chỉ bắt được phải khớp hoàn toàn `mail.from.address` khi chuyển chữ thường.
  DMARC chỉ chứng minh domain; phần trước `@` dựa vào nhà cung cấp (Gmail không cho gửi bằng địa chỉ của người khác).
- `codex@`/`agy@` và mọi địa chỉ `+tag` từ chối thư không hợp lệ ngay ở SMTP. Địa chỉ ngoài agent/domain cũng bị từ chối. `claude@` không tag vẫn là inbox công khai: thư lạ chỉ vào inbox, không thành job.
- `API_TOKEN` (MCP) chỉ thấy envelope đúng `claude@<MAIL_DOMAIN>` (không phân biệt hoa thường); thư `+tag`, `codex@`/`agy@` chỉ `ADMIN_TOKEN` xem được.
  Không xóa được thư đang có job chờ/chạy.
- **Chuỗi thư = phiên**: trả lời thư của bot thì CLI tiếp tục đúng phiên cũ (`claude --resume`, `codex exec resume`,
  `agy --conversation`); thư mới thì phiên mới. Phần trích dẫn thư cũ được cắt khỏi prompt.
- **Phiên** gắn theo người gửi (`<người gửi>|<Message-ID gốc>`), và theo cả Message-ID thư trả lời của bot
  (client chỉ gửi `In-Reply-To` vẫn nối đúng). Chỉ lưu phiên của job thành công; `session_id` phải khớp regex ID
  `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`.
- **Quyền của CLI**: mỗi agent chạy trong `E:\mailbot-work\<agent>`:
  `claude -p --restricted --permission-mode acceptEdits --permission-prompts none`, chỉ MCP job tools theo phiên, cấm `Read`/`Edit` các thư mục `~/.mailbot`, `~/.ssh`,
  `~/.aws`, `~/.codex`, `~/.claude`…; shell chỉ được tự chạy theo allowlist bên dưới;
  `codex exec` sandbox `workspace-write`, tắt plugins và từng MCP kế thừa rồi chỉ cấp MCP job tools — sandbox này **không chặn đọc** ngoài thư mục,
  nên Codex về lý thuyết đọc được token trong `~/.mailbot`; `agy --mode accept-edits --sandbox`.
  Tệp đính kèm lưu vào `inbox/job-<id>/<id>-<tên>`. Output thô mỗi lần chạy: `~/.mailbot/runs/job-<id>.out`.
- Giới hạn: 20 lượt/giờ/người gửi, dùng chung cho job và thư trả lệnh (vượt thì job `rate_limited`, lệnh không trả thư); mỗi job tối đa 20 phút;
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
không trả thư lệnh nếu đã chạm ngân sách chung 20 lượt/giờ. Lượt trả lệnh được giữ nguyên tử trong `command_receipts`, không tạo job.
Tiêu đề trả lệnh rỗng dùng `[status]`/`[cancel]`/`[help]`, không chép lại lệnh đầu vào; MIME có `Auto-Submitted: auto-replied`
và `X-Auto-Response-Suppress: All`. Thư lệnh có Auto-Submitted khác `no` không được trả tự động.
Agent kiểm tra yêu cầu hủy mỗi 15 giây (request timeout 5 giây), dừng cây tiến trình bằng `taskkill /T /F`.
Job hủy/timeout không commit, không gửi tệp dở dang và không lưu phiên; vẫn dọn inbox/outbox của job.
Running đã yêu cầu hủy quá 30 phút chuyển sang `cancelled`, không claim lại. Hủy qua email xóa ngay job token hash.

Để **gửi tệp trong thư trả lời**, yêu cầu CLI ghi tệp vào `<cwd>/outbox/job-<id>/`; đường dẫn cụ thể nằm trong prompt mỗi job,
kể cả khi resume. Chỉ nhận tệp thường ở cấp 1, không symlink/junction/hardlink, tối đa 10 tệp và tổng 2 MB (`2 × 1024 × 1024` byte).
Tệp vượt giới hạn hoặc không an toàn bị bỏ, kèm ghi chú cuối thư. Agent đọc xong dọn thư mục job; Worker gửi MIME multipart,
chỉ lưu `{filename, size}` vào `jobs.outbox_json`, không lưu nội dung tệp đầu ra vào D1.
Agent gửi `{filename, mime_type, b64_lines}`: base64 đã cắt dòng 76 bằng CRLF, không có CRLF cuối.
Worker quét tuyến tính một lần; mảng kết quả bất biến được đánh dấu nội bộ bằng WeakSet để MIME tái sử dụng,
không chấp nhận cờ JSON để bỏ qua validate và không cắt dòng tệp lần nữa. Agent/Worker mới phải được nâng cấp cùng đợt.

Claude mặc định chỉ cho shell với `git status`, `git diff`, `git log`, `git show` qua các mẫu
`Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`.
Các mẫu deny chặn `--no-index`, `--output`, `--ext-diff`, `-c `, `core.*` và tên từng thư mục trong `SECRET_DIRS`;
các deny Read/Edit vẫn được giữ; chỉ cấp MCP job tools của lần claim hiện tại.
Test runner **không bật mặc định**. Chỉ thêm khi chủ máy chủ động cấu hình
`projects.<tag>.claude_allowed_tools`, ví dụ `["Bash(npm test:*)"]`.
**Bật test runner tương đương cho chạy mã tùy ý ngoài kiểm soát Read/Edit.** Job có project chạy trong worktree;
job không project vẫn dùng thư mục riêng của agent.

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
Đợt B dùng nguyên schema v3 đã migrate, không thêm cột hoặc schema v4.

### Nâng cấp đợt C

Database đã có v3: chủ máy áp dụng **schema-v4.sql trước khi chạy Worker mới**:

```powershell
cd worker
npx wrangler d1 execute mailbot --remote --file=schema-v4.sql
```

V4 chỉ thêm bảng/index `command_receipts`, dùng `IF NOT EXISTS` nên chạy lại an toàn. Không chạy lại v3.
Các schema và lệnh triển khai ở đây là hướng dẫn để chủ máy tự chạy; đợt C chỉ kiểm thử offline.

## Dự án thật qua +tag (T1)

Bật **catch-all Email Routing → Worker mailbot** để nhận `claude+demo@xuanthieu.site`,
`codex+demo@xuanthieu.site`, `agy+demo@xuanthieu.site`. Tag gồm 1–32 chữ thường/số/dấu `-`.
`+tag` luôn cần DMARC + whitelist đúng agent. Chỉ `claude@` không tag là inbox công khai.

Thêm `projects` vào `~/.mailbot/agent.json` (giữ các trường đang có):

```json
{
  "projects": {
    "demo": {
      "repo": "E:\\projects\\demo",
      "claude_allowed_tools": ["Bash(npm test:*)"]
    }
  }
}
```

Không bật test runner nếu không tin mã trong repo; cho phép runner tương đương thực thi mã tùy ý.
Tag chưa cấu hình làm job failed, không chạy CLI. Repo phải có HEAD, non-bare và không dùng
`core.worktree` chung bất thường; trường hợp đó cần chủ máy chuẩn bị cấu hình riêng trước.

Worktree ở `<workdir>/worktrees/<tag>/<agent>-<h>`, nhánh `mailbot/<tag>/<agent>-<h>`;
`h` là 12 hex đầu SHA-256 của thread_key. Cùng thread + agent dùng lại worktree; thư trả lời không tag
kế thừa project. Message-ID do bot gửi được quy về thread gốc để không đổi worktree khi reply.
Thư kết quả/notify gửi từ `<agent>+<tag>@domain`. Agent tạo worktree trước inbox/outbox,
khóa theo agent và đường dẫn worktree (khóa thư mục tồn tại qua crash trong `worktree-state/`).
Nếu crash để lại `.lock`, chủ máy xác nhận không còn job chạy rồi tự gỡ khóa.

State nằm ngoài worktree, tại `<workdir>/worktree-state/<tag>/`. Claude bị deny Read/Edit `**/.git`, `**/.git/**`
và `worktree-state/**`. Cờ `--restricted` (đã đối chiếu `claude --help` cục bộ) giới hạn file tools trong cwd,
bỏ settings user/project/local; `--permission-prompts none` từ chối mọi yêu cầu cần duyệt.
`--tools Read,Glob,Grep,Edit,Write,Bash` chỉ khôi phục shell Bash để áp dụng allowlist Git/runner đã cấu hình.
Máy chạy phải có Claude hỗ trợ các cờ này; chưa thử hành vi với model thật.
Mọi Git do chương trình agent/admin gọi đều tắt hooks, fsmonitor, SSH, attributesFile (`NUL`) và ký commit.
Sau CLI, `.git` phải còn nguyên nội dung, nhánh đúng, `rev-parse --show-toplevel` khớp worktree;
`<gitdir>/config.worktree` và common config phải khớp snapshot trước CLI. Khác thì từ chối commit, báo trong thư.
Agent tự `add -A` + commit `--no-verify` dưới tên mailbot,
không push; thư kèm nhánh, đường dẫn, `git diff --stat <baseSha>..HEAD`.
Prompt cấm CLI tự commit/checkout/branch. Codex workspace-write có thể không ghi được gitdir ngoài cwd;
agent phụ trách commit. Các đường dẫn inbox/outbox bị chuyển hướng sẽ bị từ chối.

`/inbox/`, `/outbox/`, `/.codex-last-*` được thêm vào `<gitdir worktree>/info/exclude`.
**Điều chỉnh so với thiết kế:** Git mặc định dùng exclude của common gitdir, không đọc tệp riêng này.
Agent bật `extensions.worktreeConfig=true` trong repo và đặt `core.excludesFile` riêng cho worktree
trỏ tới tệp trên; không sửa `.gitignore` nguồn. `git add` còn dùng pathspec exclude không phân biệt hoa thường,
chặn dữ liệu trao đổi trước khi tạo blob dù `.gitignore` bị phủ định. Nếu phát hiện inbox/outbox/output Codex
trong index trước hoặc sau add, agent bỏ stage bằng `git reset --mixed HEAD` và từ chối commit.
Inbox của job được dọn sau CLI. `config` có bất kỳ `filter.` nào (kể cả Git LFS toàn cục) hoặc `.gitattributes`
thay đổi so với baseSha (gồm tệp untracked bị ignore) đều khiến job không commit; chủ máy tự xem và xử lý nhánh.
Chỉ dùng repo/config Git đáng tin; đây không phải môi trường cách ly thực thi mã hoàn chỉnh.

State đợt B thiếu snapshot `config.worktree` sẽ bị từ chối tái sử dụng. Chủ máy cần kiểm tra state/config,
prune worktree sạch đã merge hoặc chuẩn bị lại worktree bằng quy trình quản trị tin cậy; không tự tin cấu hình cũ.
Khóa repo nằm tại `<workdir>/worktree-state/repo-locks/<sha256-real-repo>.lock`, dùng chung giữa các tag trỏ cùng repo,
bọc prepare và prune, thử lại 25 ms/lần trong khoảng 2 giây. Khóa này được thả trước CLI; khóa worktree vẫn giữ tới sau commit.
Nếu crash để lại khóa repo, chỉ chủ máy gỡ sau khi xác nhận không còn tiến trình sử dụng repo.

```powershell
node agent/mailbot-admin.mjs worktrees
node agent/mailbot-admin.mjs prune demo
```

`prune` chỉ xóa worktree sạch, đúng nhánh và nhánh đã merge vào **HEAD hiện tại của repo nguồn**;
sau đó `git worktree remove` + `git branch -d`. Worktree bẩn, nhánh chưa merge, bị sửa `.git` hoặc đang khóa được giữ lại.

## Job tools: gửi cập nhật và giao việc (T8)

`mcp/job-tools.mjs` là server stdio theo job, chỉ có `notify_sender {subject, body}` và
`delegate_to_agent {agent, prompt}`. Claude/Codex được cấp tự động khi chạy job; agy không được cấp vì
không có cấu hình MCP theo phiên tương đương trong thiết kế này. CLI không nhận job token trong env;
chỉ cấu hình MCP của đúng server chứa `MAILBOT_URL` + `MAILBOT_JOB_TOKEN`.
Codex luôn thêm `--disable plugins`; agent đọc `node <codex.js> --disable plugins mcp list --json`,
thêm `-c mcp_servers.<tên>.enabled=false` cho **từng** server (quote TOML key khi cần) và kiểm tra lại danh sách phải toàn disabled.
Danh sách đã kiểm được cache 10 phút theo codex entry; lỗi đọc/xác minh làm job failed. `-c mcp_servers={}` không xóa map kế thừa.
Sau các cờ disable, agent mới bật và cấu hình command/args/env cho `mailbot-job` (đường dẫn `/`).
Tệp `.codex-last-<id>.txt` chỉ được đọc/xóa sau kiểm tra đường dẫn, lstat/fstat, tệp thường, nlink=1 và cùng inode;
link hoặc tệp bị thay thế làm job failed, không lấy nội dung làm câu trả lời.

Đợt C đã thử `agy --settings <json-file> mcp list` không gọi model: các khóa `mcpServers`, `mcp`, `disabledMcpServers`
đều báo `unknown setting`; `agy mcp list --settings` cũng không hỗ trợ. Chưa chứng minh được cơ chế cô lập theo phiên.
Vì vậy **trước mỗi job agy**, agent chạy `agy mcp list`; server enabled ngoài `agent.json` → `agy_allowed_global_mcp`
(mặc định `[]`) làm job failed trước CLI. Lỗi lệnh/định dạng không hiểu cũng từ chối chạy.
Chủ máy có thể chạy `agy mcp disable agent_mailbox` (và các server khác được liệt kê) để tắt global,
hoặc chủ động cho phép theo tên, ví dụ `"agy_allowed_global_mcp": ["agent_mailbox"]`.
Cho phép nghĩa là job email có quyền dùng server đó; không cho phép MCP admin/orchestrator có token điều phối.
Mailbot không tự sửa cấu hình agy. Chỉ cấp job tools cho Claude/Codex.

Claim sinh token 32 byte ngẫu nhiên, D1 chỉ lưu SHA-256; reclaim đổi token, finish/hủy làm token hết hiệu lực.
Token chỉ dùng `X-Job-Token` cho `POST /job-api/notify` và `POST /job-api/delegate`, không thay thế admin/reader.
Notify luôn gửi về người gửi gốc, tối đa 3 lần/job. Hạn mức được giữ nguyên tử trước khi gửi;
lỗi gửi vẫn tiêu một lượt, tránh retry tạo bão thư. Message-ID được lưu cùng `references_hdr`, rồi finish
khôi phục mapping threads (không thêm cột). Đây là cách dùng cột sẵn có thay cho cột/JSON mới.

Delegate chỉ tới agent khác trong `claude/codex/agy`, người gửi phải được whitelist cho agent đích.
Chỉ cha depth 0 được giao việc; tối đa 2 con, tổng cây tối đa 3 job. Batch D1 kiểm tra running/token,
whitelist, đếm nguyên tử, tổng cây và rate limit cùng giao dịch. Con kế thừa project, người nhận kết quả
và có thread riêng `sender|<delegate-ID@mailbot>`, `message_id=0`; gọi wake như job thường.
Không tự tạo chuỗi delegate nhiều cấp. Hủy một job không tự hủy các job con độc lập.

## MCP điều phối riêng

`mcp/orchestrator.mjs` có `list_jobs`, `get_job`, `submit_job`, `cancel_job`, `allowlist_list`;
**không có tool đọc inbox**. `get_job` trả prompt/output/trạng thái và `outbox_json` metadata,
không lưu/tải lại nội dung outbox từ D1. `submit_job {agent, prompt, project?, wait_seconds?}`
luôn dùng owner cấu hình làm `reply_to`; Worker kiểm whitelist và giới hạn 20 job/giờ của owner.
`wait_seconds` từ 0 đến 50 giây để tránh timeout MCP mặc định; hết chờ trả trạng thái hiện tại,
sau đó dùng `get_job`. Đây là giới hạn bổ sung cho tham số chưa có cận trong thiết kế.

Chủ máy tự tạo `~/.mailbot/orchestrator.json`:

```json
{
  "url": "https://mailbot.thieupro666.workers.dev",
  "admin_token": "<ADMIN_TOKEN>",
  "owner": "<địa chỉ owner đã xác minh trong Email Routing và whitelist>"
}
```

**Không bật orchestrator trong cùng phiên đọc thư lạ nếu không cần.** MCP điều phối có quyền admin;
nội dung thư không tin cậy không được trở thành chỉ dẫn submit/cancel. Không đưa admin token vào repo,
worktree hay cấu hình job tools. Server đọc inbox `mcp/server.mjs` vẫn độc lập và chỉ dùng reader token.
Đặc biệt với agy: đăng ký MCP là cấu hình client, CLI mailbot không có bộ lọc MCP theo phiên tương đương
Claude/Codex. Môi trường agy chạy email phải không kế thừa orchestrator/admin MCP; dùng cấu hình/tài khoản
chạy tách riêng hoặc tắt server điều phối trước khi chạy mailbot agy. Mailbot không tự sửa cấu hình global đó.

Đăng ký riêng (thay `<abs>` bằng đường dẫn workspace, chỉ là hướng dẫn, chưa đăng ký trên máy):

```powershell
claude mcp add -s user mailbot-orchestrator -- node "<abs>\mailbot\mcp\orchestrator.mjs"
agy mcp add --type stdio mailbot-orchestrator node "<abs>\mailbot\mcp\orchestrator.mjs"
```

Codex: thêm vào cấu hình MCP của client:

```toml
[mcp_servers.mailbot-orchestrator]
command = "node"
args = ["<abs>/mailbot/mcp/orchestrator.mjs"]
```

API admin mới: `POST /jobs {agent,prompt,project?,reply_to}`, `GET /jobs/:id`,
`POST /jobs/:id/cancel`; `GET /jobs` và `GET /allowlist` giữ nguyên quyền admin.
Worker chỉ nhận địa chỉ `reply_to` đã whitelist cho agent; MCP luôn cố định owner, không cho tool caller chọn lại.

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
3. Với database mới, chạy `npm run schema` (áp dụng lần lượt `schema.sql`, `schema-v2.sql`, `schema-v3.sql`, `schema-v4.sql` trên D1 remote một lần; xác nhận khi Wrangler hỏi), rồi `npx wrangler deploy`.
4. Tạo token ngẫu nhiên; chạy `npx wrangler secret put API_TOKEN`, nhập token và ghi cùng token vào cấu hình MCP ở trên.
5. Bật Email Routing; cấu hình catch-all tới Worker mailbot trong Cloudflare Dashboard để nhận +tag. Luật literal sau chỉ đủ cho inbox không tag:

```powershell
npx wrangler email routing enable xuanthieu.site
npx wrangler email routing rules create xuanthieu.site --name "mailbot inbox" --match-type literal --match-field to --match-value claude@xuanthieu.site --action-type worker --action-value mailbot
```

6. Đăng ký MCP cho client tương ứng theo mục trên.

## Thử cục bộ

Trong `worker/`, với database local mới, chạy bốn schema một lần:

```powershell
npx wrangler d1 execute mailbot --local --file=schema.sql
npx wrangler d1 execute mailbot --local --file=schema-v2.sql
npx wrangler d1 execute mailbot --local --file=schema-v3.sql
npx wrangler d1 execute mailbot --local --file=schema-v4.sql
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
Trong `worker/`, `agent/` và `mcp/`, chạy `npm test` (script `node --test`, không gọi mạng).
Test worker dùng hàm từ `src/`, PostalMime và SQLite memory (`node:sqlite`, Node 26), không dùng D1 thật;
test agent tạo tệp trong thư mục tạm hệ thống, thử hardlink, symlink, giới hạn tệp và dọn outbox. Symlink thiếu quyền thì skip.
Nếu sandbox Windows chặn test runner tạo tiến trình con (`spawn EPERM`), chạy `node --test --test-isolation=none`.
Trong `worker/`, kiểm tra bundle bằng `npx wrangler deploy --dry-run --outdir "$env:TEMP\mb-dry"` (cần dependency đã cài; không deploy).
Hướng dẫn tiếp quản mã nguồn và các bất biến bảo mật: [`AGENTS.md`](AGENTS.md).

Đợt C, 2026-11-18, offline: `node --check` qua **32 tệp JS/MJS**, JSON package hợp lệ và
`git diff --check -- mailbot` qua. `npm test` mặc định ở cả ba package lỗi **spawn EPERM** trong test runner;
`npm test -- --test-isolation=none` qua **worker 34/34, agent 29/29, MCP 3/3**, không skip.
Lượt kiểm cuối đặt TEMP/TMP vào `.test-tmp` của từng package; các lượt đầu dùng TEMP mặc định do fixture có sẵn.
Ba thư mục `agent/.test-tmp`, `worker/.test-tmp`, `mcp/.test-tmp` còn cache biên dịch Node:
automatic approval review từ chối dọn bằng Remove-Item với `blocked by policy`, kể cả đường dẫn cố định đã xác minh trong mailbot.
Chủ máy tự xóa ba thư mục cache này trước commit; không đưa chúng vào Git.
Git test dùng config rỗng riêng để không phụ thuộc filter Git LFS của máy; production vẫn từ chối mọi `filter.`.
Tamper `.git`/config và toplevel được kiểm tại ranh giới đọc/chạy Git vì sandbox bảo vệ metadata Git;
worktree/add/commit/prune, pathspec và kiểm blob chưa được tạo dùng Git thật trong repo test.

Benchmark chuỗi 2 MB: validate một lần + tái sử dụng kết quả, 40 lần/batch, 5 batch, CPU trung vị **3.125 ms/lượt**;
batch CPU 4.675 / 3.125 / 3.125 / 3.125 / 3.525 ms, dưới mục tiêu 5 ms.
Không bao gồm JSON, dựng toàn bộ MIME, I/O/gửi thư; chưa đo trên Cloudflare Free.
Không chạy model CLI, gửi email, gọi mạng, deploy, migrate D1 hay sửa cấu hình/credential thật.
`agy --help`, `agy mcp --help`, `agy mcp list --help`, `agy mcp list` và thử settings chỉ đọc cục bộ, không gọi model.
`claude --help` xác nhận restricted giới hạn file tools/các nguồn settings; test C2 kiểm tra args dựng ra,
chưa chạy CLI/model để chứng minh runtime permission enforcement.

| Review | Sửa và kiểm thử hồi quy |
| --- | --- |
| 1 | From khớp toàn bộ và A-R quote: `worker/test/jobs.test.mjs` → C1 |
| 2 | Deny Git/state; snapshot config/toplevel, filter và attributes: `agent/test/security-c.test.mjs` + `worktrees.test.mjs` → C2 |
| 3 | Output Codex chặn link/đổi tệp: `agent/test/security-c.test.mjs` → C3 |
| 4 | Exclude icase trước tạo blob, reset index cấm, dọn inbox: `agent/test/worktrees.test.mjs` + `security-c.test.mjs` → C4 |
| 5 + A/B | Codex disable từng server/cache/xác minh; agy fail-closed/allowlist: `agent/test/security-c.test.mjs` → C5/A, C5/B |
| 6 | b64_lines validate tuyến tính một lần, MIME roundtrip và benchmark: `worker/test/mime.test.mjs` → C6; `agent/test/outbox.test.mjs` |
| 7 | Hủy/timeout bỏ commit và attachment, dọn dữ liệu/thả khóa: `agent/test/security-c.test.mjs` → C7 |
| 8 | Ngân sách lệnh nguyên tử, chống auto-reply, revoke token: `worker/test/jobs.test.mjs` + `features-b.test.mjs` → C8 |
| 9 | Khóa repo canonical, retry và prepare/prune: `agent/test/worktrees.test.mjs` → C9 |
| 10 | Giữ threads khi rate limit; References root trước notify; reply submit/delegate lần 2 giữ phiên/project/worktree: `worker/test/features-b.test.mjs` → C10 |

Đợt B, 2026-11-18, offline: `node --check` qua 28 tệp (gồm test); `git diff --check` qua.
`npm test` mặc định ở worker/agent/mcp đều bị sandbox chặn tạo pipe với `spawn EPERM`.
`npm test -- --test-isolation=none`: worker **24/24**, agent **16/16**, MCP **3/3**, không skip.
Test worker chạy SQL thật trên SQLite memory với adapter D1 có batch transaction; test MCP dùng transport
in-memory và fetch giả, không đọc cấu hình thật. Test Git dùng repo trong `%TEMP%`, chuyển stdout/stderr
sang file descriptor vì pipe Node bị sandbox chặn; tạo/reuse worktree, exclude, hook pre/post-commit
và post-checkout bị vô hiệu, prune nhánh sạch đã merge đều được kiểm thực tế.
Sandbox chặn sửa vật lý `.git` ngay trong repo tạm (`EPERM`), nên test phát hiện marker bị sửa giả lập
nội dung đọc tại ranh giới filesystem và xác nhận không commit. Wrangler dry-run cũng bị `spawn EPERM`
trong launcher, chưa kiểm tra được bundle. Chưa chạy CLI model, email thật, D1 Cloudflare hay deploy;
chưa đăng ký MCP hoặc đọc/sửa cấu hình/credential trong `~/.mailbot`.

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
