# Mailbot

Hai chức năng trên cùng Worker: inbox công khai `claude@xuanthieu.site` qua MCP reader, và chạy CLI claude/codex/agy theo thư đã xác thực + whitelist. Đợt D chuyển mô hình xử lý sang **Task → Run → Event**: task giữ hội thoại, run là một lượt CLI, event đánh thức lượt tiếp theo. Task con trả kết quả cho cha; người gửi nhận thư tổng hợp cuối.

```text
Email Routing → Worker → D1 tasks/events/runs/outbound_mails
                   │ wake + executor poll 60s
                   ▼
Laptop executor: claim run → cwd/task → CLI → verify Git/outbox → result
                   │                          │
                   └── MCP mailbot-run ────────┘
Worker: finish transaction → schedule cha/task → gửi email đã giữ chỗ
Cron mỗi phút: run_lost, TTL, queue bị rate-limit, outbound text, retention
```

| Thành phần | Điểm vào |
| --- | --- |
| Thiết kế đầy đủ | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [bất biến AGENTS](AGENTS.md) |
| Worker | [index.js](worker/src/index.js): SMTP/API; [tasks.js](worker/src/tasks.js): scheduler/tool/terminal/cron; [mailbot.js](worker/src/mailbot.js): senderAuth/whitelist/wake |
| D1 | [schema-v5.sql](worker/schema-v5.sql), sau schema.sql/v2/v3/v4; giữ jobs/threads cũ để tra cứu |
| Executor | [mailbot-agent.mjs](agent/mailbot-agent.mjs), pool [run-pool.mjs](agent/run-pool.mjs), CLI [cli-runner.mjs](agent/cli-runner.mjs), [mailbot-admin.mjs](agent/mailbot-admin.mjs); Scheduled Task mailbot-agent, cổng 20025 |
| MCP reader | [server.mjs](mcp/server.mjs), token API_TOKEN, chỉ inbox claude không tag |
| MCP điều phối | [orchestrator.mjs](mcp/orchestrator.mjs), ADMIN_TOKEN + owner cố định, không tool đọc inbox |
| MCP run | [run-tools.mjs](mcp/run-tools.mjs), executor tự cấp mỗi run cho Claude/Codex; agy không được cấp |

API Worker: `https://mailbot.thieupro666.workers.dev`. Wake: `https://mailbot.xuanthieu.site/wake` → nginx VPS/hầm laptop → laptop:20025. Đây là cấu hình vận hành hiện có trong source; đợt D chỉ kiểm thử offline, chưa kiểm chứng dịch vụ đang triển khai.

## Nâng cấp đợt D — chủ máy tự làm

1. Dừng Scheduled Task/agent cũ và chờ CLI đang chạy kết thúc; kiểm tra jobs pending/running cũ. Bản mới không chạy tiếp job/phiên cũ: chủ máy tra cứu D1 và gửi lại yêu cầu còn dở. Không xóa bảng jobs/threads.
2. Backup D1 theo quy trình của chủ máy. Database đã v4: chỉ chạy schema-v5.sql MỘT LẦN, trước Worker mới:

```powershell
cd mailbot/worker
npx wrangler d1 execute mailbot --remote --file=schema-v5.sql
```

3. Deploy Worker mới cùng `wrangler.toml` có `[triggers] crons = ["* * * * *"]`; kiểm tra Cron Trigger đã đăng ký. Không chạy lại v3/v5. Database mới hoàn toàn dùng `npm run schema` (schema.sql → v2 → v3 → v4 → v5).
4. Cập nhật executor và thư mục mcp cùng phiên bản, rồi khởi động lại Scheduled Task mailbot-agent. Giữ cấu hình hiện có; thêm `owner` vào agent.json nếu dùng lệnh admin `tasks`. Mặc định Claude model opus vẫn giữ.
5. Reader MCP `mailbot` không đổi tên/entry. Orchestrator vẫn tên mailbot-orchestrator nhưng tools đổi: khởi động lại MCP client để refresh. MCP mailbot-run do executor cấp tự động, không đăng ký global; xóa đăng ký mailbot-job thủ công cũ nếu từng thêm. Không cấp orchestrator/admin cho CLI xử lý email.
6. Chủ máy kiểm end-to-end email thường, +tag, resume, cancel cây, hai con + một thư tổng hợp, cron run_lost/TTL. Offline tests/dry-run không thay bước này.

Không có migrate/deploy/đăng ký MCP hay thay cấu hình/credential thật nào được chạy trong đợt sửa mã này.

## Cấu hình và vận hành

Cấu hình executor do chủ máy quản lý tại `~/.mailbot/agent.json`:

```json
{
  "url": "https://mailbot.thieupro666.workers.dev",
  "admin_token": "<ADMIN_TOKEN>",
  "owner": "owner@example.com",
  "port": 20025,
  "workdir": "E:\\mailbot-work",
  "agents": ["claude", "codex", "agy"],
  "max_parallel": 3,
  "max_per_agent": 2,
  "projects": {
    "demo": {"repo": "E:\\projects\\demo", "claude_allowed_tools": ["Bash(npm test:*)"]}
  }
}
```

Giữ các trường tùy chọn đang dùng: codex_js, claude_exe/agy_exe, claude_model/codex_model/agy_model, timeout_minutes, poll_seconds, agy_allowed_global_mcp. Không bật test runner nếu chưa tin mã repo: runner tương đương chạy mã tùy ý ngoài kiểm soát Read/Edit. Agy inventory không hiểu/lệnh lỗi hoặc MCP enabled ngoài allowlist (mặc định []) làm run failed trước model; không tự sửa global config.

`max_parallel` giới hạn tổng run đang xử lý (mặc định 3); `max_per_agent` giới hạn riêng mỗi agent (mặc định 2). Cả hai cần là số nguyên dương an toàn; bỏ trống dùng mặc định, giá trị sai dùng mặc định và ghi log. Executor giữ chỗ trước claim, chỉ xin từng agent còn chỗ; wake/poll/run kết thúc cùng lấp chỗ, lỗi claim retry backoff 1–30s. Không có hàng đợi run đã claim. Mỗi run có cwd/khóa, timeout và cancel riêng; một run lỗi không dừng các run còn lại. `/health` trả `ok ` kèm JSON số run đang xử lý theo agent, kể cả finalize/nộp kết quả; không tính claim chưa trả về run.

Admin cục bộ (đọc config của chủ máy khi thực sự chạy):

```powershell
node agent/mailbot-admin.mjs allow owner@example.com "*"
node agent/mailbot-admin.mjs deny owner@example.com codex
node agent/mailbot-admin.mjs list
node agent/mailbot-admin.mjs tasks 20
node agent/mailbot-admin.mjs worktrees
node agent/mailbot-admin.mjs prune demo
node agent/mailbot-admin.mjs wake
```

Cài/chạy Scheduled Task: `powershell -ExecutionPolicy Bypass -File agent/install-agent.ps1`; gỡ thêm `-Uninstall`. Health laptop `/health`, log `~/.mailbot/agent.log`, output CLI `~/.mailbot/runs/run-ID.out`. Không commit các tệp đó.

Email Routing giữ luật literal từng claude/codex/agy và từng `<agent>+<tag>@`; catch-all drop. Tag 1–32 chữ thường/số/dấu -. Agent không tag dùng cwd riêng từng task; +tag dùng project đã cấu hình, tag lạ làm run lỗi. Người nhận trên Workers Free phải được xác minh Email Routing; việc xác minh do chủ máy thực hiện.

## Hội thoại và lệnh tiêu đề

Owner phải qua DMARC + From đúng chuẩn + whitelist theo agent đích. Chỉ claude không tag nhận inbox công khai. Auto-Submitted khác no hoặc X-Auto-Response-Suppress khác none/no không chạy task, tránh bão auto-reply.

Reply thư bot hoặc RFC người gửi nối task đúng owner/agent; ưu tiên In-Reply-To rồi References mới → cũ. Task done mở lại cùng session với 8 lượt/24 giờ mới. failed/cancelled, /new, đổi +tag, task đang sống hết TTL hoặc đã hết quota 15 thư tạo task mới. Phiên jobs/threads cũ không nối sang task.

| Lệnh đầu tiêu đề | Hành vi |
| --- | --- |
| /new | Task/session/cwd mới; project theo địa chỉ nhận +tag |
| /model=ID | Model cho task, qua kiểm tra ID CLI an toàn |
| /effort=low\|medium\|high\|xhigh\|max | Effort; Codex max → xhigh |
| /status | 20 task gần nhất của owner, gồm waiting và điều kiện chờ |
| /cancel | Hủy mọi task active/waiting của owner trên mọi agent |
| /cancel=ID | Hủy task đó và mọi hậu duệ, kể cả waiting; chỉ đúng owner |

Các Re/Fwd/Fw/Tr lặp được bỏ. Lệnh phải ở đầu; /etc/fstab vẫn là subject thường. Không ghép status/cancel với tùy chọn tạo task. Lệnh sai trả help, tiêu đề rỗng dùng [status]/[cancel]/[help]. Status/cancel/help giữ command_receipts chung 30 runs/giờ; hết quota không gửi thư lệnh nhưng cancel vẫn hiệu lực. Token của cả cây hủy mất hiệu lực ngay; laptop kiểm mỗi 15s và dừng cây tiến trình.

## Tool cho agent trong run

| Tool mailbot-run | Cách dùng |
| --- | --- |
| reply(text) | Ghi kết quả cuối, lần cuối thắng; chỉ gửi khi finalize an toàn và task gốc done |
| spawn(agent,prompt) | Con ở agent khác, kế thừa owner/project, không có project argument |
| await(ids,mode=all) | Chỉ con trực tiếp chưa giao kết quả, all/any; chờ áp dụng lúc finish |
| notify(text) | Gửi tiến độ ngay, root-only, text-only; 3/run và 15/root |
| ask_user(question) | Khai báo dự phòng, trả chưa hỗ trợ (giai đoạn 4) |

Spawn + await không gửi thư tạm; lượt sau nhận child_result, tổng hợp rồi reply → một email cuối. Không gọi reply thì stdout là kết quả. Auto-await chỉ con spawn trong run hiện tại; cha kết thúc hủy con cũ còn sống. Con thiếu thông tin kết thúc nêu câu hỏi cho cha, không ask_user/notify/email trực tiếp. Agy chỉ một lượt CLI/stdout mỗi run, không MCP; vẫn có thể làm task con.

Tệp trả email root: ghi file thường cấp 1 vào `<cwd>/outbox/run-ID/` được prompt chỉ rõ; <=10 tệp, tổng 2 MiB, không symlink/junction/hardlink. MCP không đọc đường dẫn tệp. Con trả văn bản; nếu vẫn tạo outbox, chỉ metadata tên/kích thước được chuyển cha, không bytes. Attachment mail vào `inbox/run-ID/message_id-attachment_id-name`; executor dọn inbox/outbox mỗi run.

Cwd thường `<workdir>/<agent>/task-ID`; worktree theo `(tag,agent,task_ID)`, không dùng chung giữa cha/cháu cùng agent. Giữ restricted/deny secret, Codex MCP isolation, agy fail-closed, hook-free Git, verify config/marker/toplevel/branch, b64_lines CRLF/76. Hủy/timeout/lỗi hậu kiểm không commit/session/attachment.

## API và MCP điều phối

Mọi API admin dùng Bearer ADMIN_TOKEN; inbox dùng API_TOKEN riêng. Run token chỉ X-Run-Token cho POST /run-api/reply|spawn|await|notify. Không dùng run token gọi admin/reader.

- POST /tasks `{agent,prompt,project?,owner}`; GET /tasks?owner=...&limit=20.
- GET /tasks/ID?owner=... trả task và timeline events/runs/outbound; POST /tasks/ID/cancel?owner=... hủy cây.
- POST /runs/claim `{agents:[...]}` trả `{run}`; GET /runs/ID/state; POST /runs/ID/result cho executor.
- /jobs và /job-api không còn; muốn xem jobs lịch sử dùng SQL D1 do chủ máy quản lý.

Orchestrator `list_tasks`, `get_task`, `submit_task`, `cancel_task`, `allowlist_list`; owner cố định cho mọi thao tác, không nhận owner từ tool caller. submit_task có wait_seconds 0..50; hết chờ trả ID/trạng thái để get_task tiếp. Không có tool đọc inbox hoặc send_event giai đoạn này.

Cấu hình riêng `~/.mailbot/orchestrator.json`: `{ "url":"...", "admin_token":"<ADMIN_TOKEN>", "owner":"owner@example.com" }`. Entry `node <abs>/mailbot/mcp/orchestrator.mjs`. Không bật trong phiên đọc thư lạ nếu không cần.

Reader entry `node <abs>/mailbot/mcp/server.mjs`; cấu hình `~/.mailbot/config.json` `{url,token:<API_TOKEN>,address:"claude@xuanthieu.site"}`, hoặc MAILBOT_URL/MAILBOT_TOKEN. Tools: mail_address, list_mail, read_mail, wait_for_mail, mark_mail, delete_mail, save_attachment. Reader vẫn không thấy +tag/codex/agy; delete từ chối mail đang có event/run cần xử lý. Chủ máy đăng ký MCP theo client; tên reader và orchestrator không đổi.

## Cron, retry và lưu trữ

Cron mỗi phút xử lý giới hạn: 1 run lost, 1 task TTL, 2 task bị kẹt quota, 1 outbound text và 1 cây retention/tick. State/outbound ghi trước gửi. Không reclaim run: quá 30 phút thành failed/revoke token, run_lost chứa outcome tool đã ghi và context giới hạn từ run cũ, run ID mới tính ngân sách; lost liên tiếp lần 2 làm task failed. Task TTL 24h. Giới hạn depth2/direct3/tree8, 8 runs/task, 30 runs+commands/owner/giờ.

finishRun idempotent 2 pha: phase1 batch trạng thái/session/events/outbound; phase2 schedule + gửi bằng reservation. Retry phải cùng nội dung/hash và metadata attachments, Message-ID cố định. Error gửi có thể retry bằng request executor còn bytes; cron chỉ retry text. D1 không lưu bytes outbox nên mất executor request có tệp cần chủ máy khôi phục từ nguồn.

`outbound_mails.status='sending'` nghĩa là kết quả gửi chưa xác định nếu process chết giữa giữ chỗ/send/ghi sent. Không tự retry sending để tránh trùng; chủ máy đối chiếu email/log trước xử lý. D1 và send_email không có transaction chung, không thể bảo đảm exactly-once email trong cửa sổ này. Lỗi send ném ra có thể vẫn đã phát; retry error dùng cùng Message-ID nhưng provider không được giả định dedupe.

D1 giữ 1000 root mới nhất, mỗi tick dọn <=1 cây terminal hơn 7 ngày, không con sống hoặc outbound chưa sent. Task cwd thường được xét GC mỗi giờ (tối đa 1 thư mục mỗi tick), chỉ xóa nếu API xác nhận terminal >7 ngày, đúng path và không link. Mất xác minh/404 giữ lại; D1 đã xóa có thể để thư mục cần đối chiếu thủ công. Worktree chỉ prune sạch/đã merge/không khóa, không force. Full output tối đa 200000 ký tự/run; child_result JSON <=32768, tổng event payload/run <=150000, email text <=64000.

## Kiểm thử offline

Dependency phải có sẵn, Node 26 có node:sqlite. Không cần model/Cloudflare/mạng:

```powershell
cd mailbot/worker
npm test
# Nếu sandbox chặn spawn EPERM:
npm test -- --test-isolation=none
# Tương tự tại ../agent và ../mcp
```

Đặt TEMP/TMP trong `.test-tmp` của từng package trước chạy tests. node --check mọi source/test JS/MJS. Test SQLite thực có transaction, test MCP dùng transport in-memory/fetch giả; test Git dùng repo tạm và wrapper tắt hook, không project thật. Legacy tests vẫn giữ bảo vệ hồi quy, API tests và tasks.test.mjs kiểm mô hình mới.

Wrangler dry-run bằng binary local, tắt telemetry, chỉ ghi outdir trong mailbot. Không gọi npx để tự tải package; nếu launcher bị spawn EPERM thì báo không kiểm bundle. Kết quả kiểm cuối được báo riêng trong bản bàn giao; dry-run/test không chứng minh deploy, CLI model, email thật, cron thật hoặc CPU 10 ms trên Workers Free.

Giai đoạn 3, offline: `node --check` qua 43 JS/MJS. `npm test` mặc định ở cả ba package lỗi `spawn EPERM`; `npm test -- --test-isolation=none` qua worker 82/82, agent 53/53, MCP 3/3, không skip. Worker dùng SQLite với foreign_keys bật và batch transaction thật. Test mới dùng claim/process/timer giả: wake dồn dập, giới hạn tổng/per-agent, agent đầy, lỗi claim/backoff/run, khóa cwd/retention, single-flight MCP, hủy/timeout riêng và callback state muộn. Test kéo búa bao xác nhận đúng một email tổng hợp. Kiểm thử Git có mô phỏng đọc `.git` bị sửa vì sandbox chặn sửa vật lý trong một ca; không chứng minh chống tamper trên máy triển khai.

Wrangler local dry-run đợt D trước đây với home/config/log tạm riêng, telemetry và network bị chặn, dừng tại esbuild `Error: spawn EPERM`; chưa kiểm được bundle, giai đoạn 3 không chạy lại dry-run. Không gọi mạng, CLI model, gửi thư thật, migrate/deploy hay đọc cấu hình/credential người dùng. Song song theo run đã triển khai; ask_user/timer/send_event vẫn dành giai đoạn 4.

Ba thư mục `agent/.test-tmp`, `worker/.test-tmp`, `mcp/.test-tmp` còn cache kiểm thử. Bộ duyệt tự động từ chối lệnh dọn các đường dẫn đã kiểm tra trong mailbot với `blocked by policy`; chủ máy tự dọn, không đưa cache vào commit.
