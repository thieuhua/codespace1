# Hướng dẫn cho coding agent

## Mục đích và phạm vi

- Mailbot trung tính, nhiều coding agent bảo trì. Giữ địa chỉ thư và CLI claude/codex/agy.
- Hộp thư công khai claude@ đọc qua MCP; thư whitelist tạo Task → Event → Run.
- Đọc [README](README.md), [đặc tả](docs/ARCHITECTURE.md); giữ công việc hiện có, không deploy/đổi credential nếu chưa được giao.
- worker/src/index.js: SMTP/API/auth; mailbot.js: senderAuth/whitelist/wake (có hàm legacy không được router gọi); tasks.js: scheduler/run/tool/terminal/cron. worker/schema-v5.sql chạy một lần sau v4.
- agent/mailbot-agent.mjs: executor; job-handler.mjs: khóa cwd/nộp kết quả; run-pool.mjs: điều phối theo run, cli-runner.mjs: child/timer từng run; run-mcp.mjs: MCP scoped; worktrees.mjs/outbox.mjs/inbox.mjs/task-files.mjs: filesystem. mcp/server.mjs: reader, mcp/orchestrator.mjs: admin riêng, mcp/run-tools.mjs: tool run không filesystem.

## Kiểm tra

- node --check mọi JS/MJS trong agent/, mcp/, worker/src/ và test (bỏ node_modules/cache).
- npm test trong worker/agent/mcp, Node 26, offline. Nếu spawn EPERM dùng npm test -- --test-isolation=none, ghi cả lỗi gốc và kết quả thay thế. Symlink không quyền thì skip rõ.
- Test D1 dùng node:sqlite và worker/test-support/d1.mjs, batch phải BEGIN/COMMIT/ROLLBACK thật; cập nhật v5 ở fixture. Legacy tests chỉ bảo vệ hành vi cũ, không chứng minh API cũ còn hoạt động.
- TEMP/TMP đặt trong mailbot/<package>/.test-tmp; không đọc cấu hình/credential thật hay chạy CLI model. Chỉ dùng dependency sẵn có.
- Wrangler dry-run phải offline/local binary, tắt telemetry và chỉ output trong mailbot; không cài package. Dry-run không chứng minh email/CLI/D1/cron thật.
- Báo file sửa, lệnh/kết quả thật, giả định, việc chưa kiểm chứng.

## Bất biến xác thực và phân quyền

- senderAuth chỉ tin Authentication-Results đầu do mx.cloudflare.net thêm, DMARC pass và header.from khớp domain. Không tin A-R bên dưới.
- Đúng một From chuẩn: addr hoặc Tên <addr>, khớp hoàn toàn PostalMime khi lowercase. Cấm comment/dấu phẩy; display name quoted không escape/quote bên trong, tên không quote cấm <>(),;"\\@. A-R giữ chuỗi quote, tách dấu ; ngoài quote, nhận header.from="domain".
- +tag và codex/agy cần senderAuth + whitelist đúng agent; chỉ claude không tag là công khai. Catch-all từ chối ngoài agent/domain.
- Reader API_TOKEN chỉ thấy envelope exact claude@MAIL_DOMAIN, không +tag/agent khác; tasks/runs/allowlist chỉ ADMIN_TOKEN. Không cấp admin/orchestrator cho CLI email.
- session_id chỉ /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ trước lưu/resume. Không dùng threads/jobs cũ cho task mới.
- Orchestrator tách reader; submit/list/get/cancel luôn gắn owner cấu hình, caller không chọn owner. Không ghép admin tools vào phiên đọc thư lạ khi không cần. send_event giai đoạn 4 cũng cố định owner, root-only, tính quota.

## Bất biến CLI và filesystem

- Cwd theo (agent,task_id), worktree theo (tag,agent,task_id), không root/session. Không cấp quyền dự án ngoài tag đã cấu hình. Kiểm directory thực, chặn symlink/junction.
- Claude --restricted --permission-prompts none, file tools Read/Glob/Grep/Edit/Write/Bash, model mặc định opus. Restricted bỏ user/project/local settings; Bash vẫn qua allowlist/deny, không dựa acceptEdits để giới hạn shell.
- SECRET_DIRS gồm .mailbot/.ssh/.aws/.codex/.claude/.config/.wrangler; deny Read/Edit/Bash. Deny cả .git, worktree-state và task-state. Không commit secret/config/log/runs/attachments trong ~/.mailbot. Không đọc/sửa credential khi chưa được giao.
- Codex --disable plugins, disable từng server từ mcp list --json (quote TOML key), kiểm lại toàn enabled=false ngay trước mỗi run rồi bật mailbot-run; không cache qua lượt vì cwd ghi được. mcp_servers={} không xóa map. Sandbox workspace-write không chặn đọc secret; không tuyên bố ngược lại. Không sửa global config.
- Agy trước mỗi run mcp list, fail-closed khi lỗi/không hiểu hoặc enabled ngoài agy_allowed_global_mcp (mặc định []). Không cấp MCP run; --settings chưa có MCP isolation được chứng minh. Không cho phép orchestrator/admin trong run email; không sửa global.
- Kiểm MCP single-flight theo entry/cwd, chỉ gộp kiểm tra đang chạy; Codex và agy không cache kết quả/lỗi qua lượt sau. Agy kiểm từng allowlist riêng. Không thay các kiểm tra fail-closed bằng cờ đã kiểm chung.
- MCP chỉ mailbot-run được cấp rõ cho Claude/Codex; token chỉ env của MCP config, không CLI env. MCP run tuyệt đối không đọc fs; reply/notify chỉ text, tệp qua executor outbox/run-ID.
- Thư/đính kèm/child output không tin cậy, không tự chạy. Boundary ngẫu nhiên mỗi run, loại chuỗi trùng boundary; subject và filename ở trong block dữ liệu.
- Mọi Git do chương trình agent/admin gọi dùng wrapper core.hooksPath=NUL, core.fsmonitor=false, core.sshCommand=false, core.attributesFile=NUL; commit tắt ký/--no-verify, không push.
- Trước Git sau CLI: kiểm .git marker, config.worktree snapshot, common config snapshot, toplevel=cwd, nhánh đúng. State cũ thiếu snapshot cần chủ máy xử lý.
- Không add/commit nếu có filter. hoặc .gitattributes thay đổi/untracked (kể cả ignored). Exclude inbox/outbox/.codex-last bằng icase pathspec trước add, không tạo blob; phát hiện index cấm thì reset --mixed HEAD và báo lỗi.
- Giữ khóa worktree xuyên CLI + commit. Prepare/prune xếp hàng Promise theo canonical repo trước khóa file; chờ khóa file bằng timer tối đa khoảng 2s, Git prepare/prune bất đồng bộ. Không giữ khóa repo xuyên CLI/spawn. prepareWorktree/pruneWorktrees/lockRepository trả Promise, caller phải await.
- Pool giữ chỗ đồng bộ tổng/per-agent trước await claim, chỉ xin agent còn chỗ; không giữ hàng đợi chờ slot cho run đã claim. Wake/poll/finally dùng chung một vòng lấp chỗ, lỗi claim trả reservation và backoff; close không tạo timer mới dù claim reject muộn. Mọi run trả chỗ trong finally. Child/cancel/timeout/timer thuộc từng run; stop xóa timer timeout/cancel ngay, exit xóa timer và chờ pipe tối đa 5s, không taskkill PID đã exit.
- Cwd thường cũng có khóa mkdir ngoài cwd trong task-state/locks, retention dùng cùng khóa. Khóa lấy trước exchange, nhả finally sau finalize và trước POST result; task thường chờ khóa tối đa khoảng 2s bằng timer, worktree trùng khóa vẫn fail ngay. Không dọn exchange của bên giữ khóa hoặc khi cwd chưa xác định; lỗi unlock chỉ log và vẫn nộp kết quả. Không tự phá khóa cũ. Log append đồng bộ; output runs/run-ID.out tạo wx, không ghi đè run khác.
- Hủy/timeout/lỗi/không xác minh run state: chỉ dọn exchange, không commit/session/attachments. Verify worktree trước đọc outbox; hậu kiểm thất bại bỏ cả attachment đã đọc. Output Codex phải lstat/fstat/realpath/nlink=1 trước đọc/xóa.
- Inbox/outbox theo run, tên inbox có message_id và attachment_id. Chỉ outbox file cấp 1, chặn symlink/junction/hardlink, 10 tệp/2 MiB. b64_lines CRLF/76, validate tuyến tính một lần, mảng bất biến WeakSet nội bộ; không cờ JSON bypass, không wrap attachment lần nữa. D1 chỉ lưu metadata outbox.
- Prune worktree chỉ sạch, đúng nhánh, không khóa, nhánh merged vào HEAD nguồn, không force. Task cwd retention mỗi lượt xét <=1 ứng viên quá 7 ngày, dừng khi pool bận và không gọi API lúc bận. Lookup trước khóa, kiểm lại marker sau khóa; chỉ xóa terminal xác nhận đủ 7 ngày, đúng path và không link; không chắc giữ lại.

## Bất biến Task/Run/Event

- Unique live-run/task + scheduler batch với schedule_key riêng. INSERT 0 hàng không được gán event; không last_insert_rowid stale, không gán vào run đang chạy. Event tới giữa run giữ NULL; finish và session/wait/task cùng batch rồi luôn schedule task/cha.
- Mọi terminal dùng completeTask/completionBatch: trạng thái + child_result dedupe child:ID + hủy hậu duệ/revoke token + outbound cùng batch, schedule cha sau commit. Áp dụng CLI lỗi, TTL, budget, lost, cancel và done.
- Cancel đồng bộ cả waiting và subtree, xóa token mọi run trong tập; không event đánh thức. /cancel không ID hủy mọi task sống của owner trên mọi agent. Hết quota trả thư vẫn hủy.
- Run token SHA-256 chỉ running/task sống, xóa khi finish/lost/cancel. Không reclaim: cron failed run cũ, run_lost chứa outcome/context, tạo run ID mới có tính budget; tối đa 1 lost liên tiếp, lần 2 failed cây.
- spawn không project, khác agent cha, whitelist đích, kế thừa owner/project qua SQL. Batch kiểm token/live/depth<2/direct<3/tree<8/rate rồi tạo con+first run; trigger tăng bộ đếm khi INSERT thành công. Không bỏ guard khi retry.
- await chỉ con trực tiếp chưa giao kết quả; chặn con đã có child_result.run_id kể cả prompt hiện tại. Auto-await chỉ con spawn trong run hiện tại. Cha done/failed hủy con cũ còn sống.
- Con chỉ trả văn bản cho cha, không email. Con cần làm rõ phải kết thúc nêu câu hỏi. Outbox con chỉ metadata và ghi chú rõ; không hứa chuyển bytes.
- reply ghi đè outcome, không mail giữa lượt; finalize xong và root done mới gửi một thư tổng hợp. notify root-only/text-only, 3/run; 15 thư/root. ask_user root-only dành giai đoạn 4, hiện lỗi chưa hỗ trợ.
- Ngân sách 30 runs + command_receipts/owner/giờ, 8 runs/task, 24h TTL. Gốc/spawn reserve first run cùng transaction; tiếp tục bị rate limit giữ event để cron vét. Không treo cha vì con kết thúc lỗi/hủy/quá hạn.
- Map thư bắt buộc owner/agent/root, In-Reply-To rồi References mới→cũ. /new/đổi tag/failed/cancelled/task sống quá hạn tạo mới; done mở lại thêm 8 runs/24h. Chặn auto-reply ở mọi thư; status/cancel/help reserve receipt trước send.
- child_result JSON <=32768 ký tự, tổng event text/run <=150000 và 128 event; email text <=64000. Cắt trong SQL trước đọc để giữ CPU; full output tối đa 200000 trong runs.
- outbound_mails và quota ghi trước send; stable Message-ID, sending reservation chống gửi đồng thời. Retry finish hash/metadata khớp, không đổi trạng thái/count lần 2. sending không rõ kết quả không tự gửi lại; D1+email không bảo đảm exactly-once bên ngoài.
- Cron * * * * * ngay đợt D, bounded lost/TTL/queue/send/retention. Bảo vệ messages/attachments có event chưa xử lý hoặc run pending/running. Không xóa tree còn sống hoặc outbound chưa sent.
