# Kiến trúc xử lý: Task → Run → Event

Đặc tả đợt D, giai đoạn 1 + 2 + 3. Tích hợp 12 mục archreview và các điểm còn liên quan của joinreview. Quyết định trực tiếp trong brief đợt D thay phần reclaim, reply giữa lượt, project do spawn chọn và cancel bằng event. Các bất biến bảo mật tại [AGENTS.md](../AGENTS.md) vẫn áp dụng.

## Phạm vi

Worker lập lịch, D1 giữ trạng thái, executor chuẩn bị cwd → chạy CLI → finalize worktree/outbox → nộp kết quả. MCP run có token riêng; reader inbox và orchestrator tách biệt. Không chuyển dữ liệu jobs/threads cũ; chỉ giữ bảng để tra cứu. `/jobs`, `/job-api`, MCP mailbot-job không còn phục vụ. Các hàm/test legacy còn trong source, không được router mới gọi.

Giai đoạn 1 + 2 triển khai schema v5, email/task, scheduler, executor run, reply/spawn/await/notify, completeTask, cancel cây, cron lost/TTL/rate-limit/retention. Giai đoạn 3 triển khai executor song song theo run: mặc định tối đa 3 run tổng, 2 run/agent; chỉ claim khi có chỗ, không giữ hàng đợi run đã claim trên laptop. Giai đoạn 4 mới ask_user, timer, send_event; ask_user hiện trả chưa hỗ trợ, không giả thành công.

## Schema và chỉ mục

`worker/schema-v5.sql` chạy MỘT LẦN sau v4; chạy lại lỗi CREATE TABLE. Không chạy lại v3. Database mới: schema.sql → v2 → v3 → v4 → v5.

| Bảng | Trường chính |
| --- | --- |
| tasks | id; creation_key UNIQUE; root_id (gốc tự trỏ id); parent_id; spawn_run_id; depth 0..2; agent/owner/project/title; status active/waiting/done/failed/cancelled; deliver email/parent; session_id; options_json; wait_json/wait_until; rfc_message_id/references_hdr; run_count/max_runs; child_count/tree_count/mail_count/lost_count; result; completion_key; created/updated/expires/finished_at |
| runs | id/task_id; schedule_key UNIQUE; status pending/running/done/failed/cancelled; created/claimed/finished_at; token_hash/cancel_requested; output/session_id; outcome_json/outbox_json; result_hash/finish_key; notify_count; boundary |
| events | id/task_id; kind start/mail/child_result/run_lost (timer dự phòng); message_id (messages.id); rfc_message_id; payload_json; dedupe_key UNIQUE; run_id NULL khi chưa tiêu thụ; created_at |
| outbound_mails | task_id/run_id; dedupe_key/message_id UNIQUE; kind reply/notify/terminal; status pending/sending/sent/error; text/subject/in_reply_to/references_hdr; outbox_json metadata; send_key/error; created/sent_at |

Chỉ mục: unique một phần runs(task_id) WHERE pending/running; queue(status,id), stale(status,claimed_at), budget(created_at,task_id), token_hash unique khi khác NULL. Events: (task_id,run_id,id), (message_id,run_id), (rfc_message_id,task_id). Tasks: owner/id, root, parent/spawn_run, RFC, status/expires_at, status/wait_until. Outbound: task/id, status/id.

AFTER INSERT trigger đặt root_id cho gốc, tăng child_count của cha và tree_count của gốc sau khi tạo con thành công; outbound trigger tăng mail_count. Guard nằm trong INSERT cùng batch, không kiểm JS rồi tăng bộ đếm riêng. Foreign key cascade và batch xóa cây; không xóa bảng lịch sử jobs/threads.

## Ngân sách

| Giới hạn | Giá trị |
| --- | --- |
| Lượt/task | 8; done mở lại: max_runs = run_count + 8 |
| Độ sâu/con trực tiếp/tổng cây | 2 / 3 / 8, tính cả gốc |
| Notify/run; thư/root | 3; 15 (lỗi gửi vẫn tiêu quota) |
| CLI timeout; run_lost | 20 phút; 30 phút sau claim |
| Task TTL | 24 giờ, done mở lại cấp 24 giờ mới |
| Owner | 30 runs + command_receipts/giờ, gồm mọi con |
| Root còn sống/owner | 30 |

Tạo gốc/spawn giữ chỗ first run trong cùng batch; hết ngân sách giờ → 429, không tạo task/event/run, không tăng counter. Continuation đã nhận việc giữ event NULL và active/waiting; cron vét lại khi cửa sổ giờ trống. Không đánh rơi thư tổng hợp vì quota. Hết run budget → completeTask(failed), con vẫn phát child_result. Không có task status rate_limited: đó là kết quả admission; task đã được nhận mà chưa chạy vẫn chờ cron/TTL.

## Nhận thư và lệnh

1. Giữ senderAuth: chỉ Authentication-Results đầu của mx.cloudflare.net; DMARC pass, header.from đúng domain; đúng một From chuẩn và khớp PostalMime. Whitelist theo agent đích, kể cả +tag. Chỉ claude không tag nhận công khai; thư lạ chỉ vào inbox.
2. Sau xác thực chặn mọi Auto-Submitted khác no, X-Auto-Response-Suppress khác none/no, cả thư thường/lệnh; không event hay auto-reply.
3. Parse lệnh đầu subject sau Re/Fwd/Fw/Tr. /status, /cancel, help không tạo task; receipt giữ quota trước gửi. Cancel vẫn hiệu lực nếu hết quota trả thư. /cancel không ID hủy mọi task active/waiting của owner trên mọi agent, không suy diễn theo thread. /cancel=ID hủy subtree đúng owner. Status liệt kê 20 task gần nhất, gồm waiting/wait_json.
4. /new luôn tạo task/session/cwd mới. Không /new: ưu tiên In-Reply-To rồi References mới → cũ, dedupe tối đa 30 candidate; mỗi candidate tìm root đúng owner + agent qua task RFC, event RFC hoặc outbound Message-ID. Không cho người khác/agent khác/task con dùng alias để nối phiên.
5. +tag khác project → task mới với tag mới. Không tag → kế thừa project khi reply đúng task. failed/cancelled hoặc task còn sống hết TTL → task mới; done mở lại cùng task/session với 8 lượt/24 giờ mới. Gốc đã dùng 15 thư → task mới để còn trả lời được. /new dùng project của envelope, không ngầm kế thừa thread cũ.
6. Gốc mới: batch task + start(message_id, subject/text) + first run + gán event + run_count=1. Nối tiếp: batch mở lại/update options + mail event, rồi schedule. /model và /effort cập nhật task; new không lưu sang lượt resume.

Attachment gắn messages.id trong event. Claim trả metadata kèm message_id; executor tải qua API messages admin. Retention/DELETE bảo vệ messages và attachments có event run_id NULL hoặc run pending/running, kiểm lại ngay trong DELETE để tránh đua.

## Scheduler nguyên tử

schedule(task_id) dùng batch D1 và schedule_key UUID riêng mỗi lời gọi:

1. INSERT run SELECT task với guard SQL: active/waiting, TTL còn, run_count < max_runs, có event NULL, không live run, còn quota owner. Waiting thức khi có mail/run_lost; all thỏa khi mọi con terminal; any thỏa khi có child_result chưa giao thuộc tập IDs.
2. Gán event chỉ vào run tìm bởi schedule_key vừa tạo. INSERT 0 hàng thì không key để gán. Không dùng last_insert_rowid sau INSERT 0 hàng; không gán vào live run sẵn có. Tối đa 128 event cũ nhất/run; phần còn lại giữ NULL cho lượt sau.
3. Cập nhật task active/xóa wait/tăng run_count chỉ khi key tồn tại. Unique live-run index là chốt cuối. Run/event/task được commit trước claim.
4. Cùng batch, completionBatch xử lý hết ngân sách nếu không live run; con kết thúc thì schedule cha sau commit.

Event tới lúc run running giữ NULL. finish cập nhật run + session + wait + task cùng batch, chỉ done khi không event NULL và không chờ con. Sau commit luôn schedule(task), schedule(cha). Không mất mail giữa lượt, không claim session cũ, không tạo run rỗng. Con hoàn tất sớm vẫn đánh thức cha sau finish.

## API và quyền

| Endpoint | Hợp đồng |
| --- | --- |
| POST /tasks | ADMIN_TOKEN; {agent,prompt,project?,owner}; whitelist; tạo gốc + start + first run |
| GET /tasks?owner=...&limit=... | ADMIN_TOKEN, owner bắt buộc; limit <=100 |
| GET /tasks/:id?owner=... | ADMIN_TOKEN, owner khớp; task + timeline events/runs/outbound, không token_hash |
| POST /tasks/:id/cancel?owner=... | ADMIN_TOKEN, cancel subtree đồng bộ |
| GET /tasks/:id/retention | ADMIN_TOKEN; chỉ metadata project/status/finished_at cho executor GC |
| POST /runs/claim | ADMIN_TOKEN; {agents:[...]}; UPDATE pending→running RETURNING nguyên tử, không reclaim |
| GET /runs/:id/state | ADMIN_TOKEN; status/cancel_requested |
| POST /runs/:id/result | ADMIN_TOKEN; {ok,output,session_id,cancelled,attachments,finalize_note}; 2 pha idempotent |
| POST /run-api/{reply,spawn,await,notify,ask_user} | X-Run-Token; running + task sống + không cancel; ask_user hiện 501 |

Token ngẫu nhiên 32 byte; D1 chỉ SHA-256. Chỉ nằm trong MCP config env, không CLI env. Token run không thay thế reader/admin. API_TOKEN vẫn chỉ đọc envelope exact claude@domain, không +tag và không tasks/runs/allowlist.

## Tool và outcome

outcome ban đầu `{spawned:[],notifications:[]}`, thêm reply_text/wait/finalize_note. SQL json_set/json_insert cập nhật nguyên tử để tool đồng thời không ghi đè lẫn nhau.

- reply(text): không files/path, lần cuối thắng. Chỉ ghi outcome; không gửi giữa lượt. Không reply thì stdout là reply. Khi có reply riêng, vẫn ghép báo cáo finalize. Lượt chờ hoặc còn event chưa xử lý không gửi email; chỉ root done gửi thư tổng hợp cuối.
- spawn(agent,prompt): không project, khác agent cha, whitelist owner theo đích. SQL kế thừa owner/project/root, depth+1, spawn_run_id. Guard token/running/trạng thái cha và gốc/direct/tree/depth/rate trong batch tạo con + start + first run + ghi spawned. Agent ông có thể xuất hiện lại ở cháu nhưng luôn cwd khác task.
- await(ids,mode=all): 1..3 ID duy nhất, chỉ con trực tiếp chưa có child_result.run_id khác NULL. Từ chối tập chứa ID đã giao (kể cả prompt hiện tại), ID lạ, mình/cha. all chờ mọi con terminal, any chờ ít nhất một result chưa giao. Lần hợp lệ cuối thắng, áp dụng lúc finish.
- Auto-await chỉ con spawn trong run hiện tại, kể cả con đã xong sớm. Không ép cha chờ con cũ sau await(any). Cha done/failed hủy mọi hậu duệ còn sống, revoke token ngay.
- notify(text): root-only, text <=64000, giữ quota/outbound trước send, ghi ID vào outcome; 3/run và 15/root, không attachment.
- ask_user giai đoạn 4: root-only; reply_text=question, wait(user), mail sau finalize; sau đó từ chối spawn/await, reply không được xóa wait(user). Con thiếu thông tin kết thúc với câu hỏi dạng kết quả. Đợt D luôn trả chưa hỗ trợ.

Con không gửi email. Prompt yêu cầu kết quả văn bản, không hứa gửi outbox. Nếu vẫn tạo tệp, executor validate rồi run/child_result chỉ lưu tên/kích thước; kết quả ghi chú metadata-only. Bytes không chuyển cha, không vào D1. Chia sẻ binary giữa task cần kho artifact riêng ở đợt sau; không mở quyền đọc fs cho MCP.

## completeTask, cancel và finishRun

Mọi terminal đi qua completeTask hoặc completionBatch cùng lớp, kể cả CLI lỗi, TTL, hết budget, lost lần 2, cancel và root done. Một batch:

1. Đổi task sống → terminal, xóa wait; completion_key UUID giới hạn tập vừa đổi, chỉ done giữ session hợp lệ.
2. Recursive CTE hủy hậu duệ sống, cùng completion_key.
3. Mọi run pending/running trong tập → cancelled, cancel_requested=1, token_hash=NULL. Executor poll 15s (timeout 5s), taskkill /T /F; kết quả lost/cancel muộn không được finalize.
4. INSERT OR IGNORE child_result cho từng con, dedupe child:<task_id>; status/agent/text/outbox metadata. Text tối đa 4000 ký tự để JSON <=32768 ngay cả ký tự điều khiển escape 6 lần. Full output giữ trong runs.output.
5. Root failed/cancelled giữ terminal outbound trước send. Sau commit schedule cha, kể cả con lỗi qua cron/hủy riêng; cancel cây không tạo run cho cha đã cancelled.

finishRun pha 1: chỉ run running + chưa cancel + task sống nhận kết quả. Batch lưu run terminal/token NULL/output/result_hash/outbox metadata/session khi ok; tính wait bằng outcome SQL hoặc auto-await; cập nhật task/session; terminal builder nếu cần; tạo outbound reply duy nhất reply:run:<id> khi root done. Không cửa sổ schedule giữa run và task/session. Nếu cancel/lost thắng, nộp muộn trả ignored, không session/tệp.

Pha 2: luôn schedule task/cha, độc lập gửi thư. Retry phải khớp hash kết quả và metadata outbox; bỏ pha 1, không tăng quota lần nữa. Message-ID ổn định <mailbot-run-ID@domain>. UPDATE pending/error → sending với send_key giành quyền gửi; sent không gửi lại. Send lỗi ghi error; executor retry mang lại bytes attachment, cron chỉ retry text không attachment.

D1 và EMAIL.send không có giao dịch chung hay idempotency key phía nhà cung cấp. Chết sau gửi trước ghi sent, hoặc sau giữ sending trước gửi, để lại sending: không tự gửi lại; chủ máy đối chiếu email/log rồi xử lý. Không thể cam kết exactly-once delivery trong cửa sổ này. Send ném lỗi cũng có thể không rõ thư đã phát; retry error ưu tiên khả năng gửi lại với cùng Message-ID, không bảo đảm provider dedupe. Test chứng minh idempotency D1, retry đồng thời/tuần tự và lỗi giả trước gửi; không chứng minh exactly-once của email thật.

## Executor và giới hạn dữ liệu

- `agent/run-pool.mjs` điều phối run độc lập, nhận claim/execute qua injection. `agent.json`: `max_parallel` mặc định 3, `max_per_agent` mặc định 2; thiếu dùng mặc định, giá trị không phải số nguyên dương an toàn dùng mặc định và ghi log tên trường. Một vòng lấp chỗ single-flight, round-robin từng agent còn chỗ; giữ chỗ đồng bộ tổng/per-agent TRƯỚC await claim. Claim nguyên tử hiện có nhận `[agent]`; không đổi Worker/schema và không claim cho agent đầy.
- `/wake`, poll dự phòng và finally của mỗi run đều yêu cầu lấp chỗ; gộp wake đang xử lý và giữ tín hiệu tới trong khi claim. Lỗi claim trả chỗ đã giữ, ghi log, retry backoff 1s → 2s → ... tối đa 30s; wake/poll/run kết thúc không bỏ qua backoff. Claim thành công (kể cả rỗng) reset chuỗi lỗi. Run đã claim chạy ngay, chỗ được giữ tới khi execute/nộp kết quả kết thúc; lỗi từng run được bắt riêng và luôn trả chỗ. Claim mất response sau khi Worker đã nhận vẫn thuộc recovery run_lost, không reclaim ID.
- `agent/cli-runner.mjs` giữ child, cờ cancel/timeout và mọi timer trong từng invocation; cancel poll 15s, request state timeout 5s, CLI timeout mặc định 20 phút. Dừng đúng PID/cây của run đó; callback state muộn không hủy hoặc tạo timer sau khi run đã kết thúc. `/health` giữ text `ok ` rồi JSON số run đang xử lý theo từng agent, ví dụ `ok {"claude":2,"codex":1,"agy":0}`; không tính reservation claim chưa có run.
- Cwd `<workdir>/<agent>/task-<task_id>` kiểm directory thực, không junction/symlink. Worktree theo `(tag,agent,task_id)`, path worktrees/<tag>/<agent>-task-ID, branch mailbot/<tag>/<agent>-task-ID; không dùng root/session. Prune đọc được state hash thread lịch sử nhưng executor mới không dùng lại.
- Task thường dùng khóa mkdir nguyên tử `task-state/locks/<agent>-task-ID.lock`, worktree giữ khóa hiện có trong worktree-state. Lấy khóa trước khi chuẩn bị/đọc/dọn exchange; trùng đường dẫn fail run, không đợi trên laptop và không dọn dữ liệu của run giữ khóa. Khóa xuyên CLI + finalize, nhả trong finally trước POST result (Worker có thể schedule lượt sau trước response); semaphore vẫn giữ tới hết POST/retry. Retention dùng cùng khóa task, không xóa cwd đang dùng. Khóa canonical repo prepare/prune hiện có vẫn retry ngắn và không giữ qua CLI. Không tự phá khóa cũ sau crash; chủ máy đối chiếu trước xử lý.
- Inbox `inbox/run-ID/message_id-attachment_id-name`, outbox `outbox/run-ID`; dọn mọi run. Giữ lstat/fstat/realpath/nlink=1, 10 tệp/2 MiB, b64_lines CRLF/76; Worker validate tuyến tính một lần, WeakSet không nhận cờ JSON để bỏ validate.
- Claude restricted/permission-prompts none, deny SECRET_DIRS/Git metadata, shell allowlist, mặc định model opus. Codex disable plugins và từng MCP kế thừa + xác minh disabled trước bật mailbot-run. Agy fail-closed inventory, không MCP run, stdout làm reply; vẫn spawn làm con. Không sửa global config.
- Codex kiểm kê + xác minh isolation single-flight theo `(entry,cwd)`, chỉ cache kết quả đã xác minh trong 10 phút, không cache lỗi; không chia sẻ project-local settings giữa cwd. Agy chỉ chia sẻ inventory đang chạy theo `(entry,cwd)`, mỗi caller kiểm allowlist riêng; không cache kết quả/lỗi qua lượt sau. Log chung append đồng bộ mỗi dòng; `runs/` mkdir recursive, output riêng `run-ID.out` tạo độc quyền `wx`, trùng ID không ghi đè và ghi log lỗi.
- Kiểm state sau CLI trước finalize. Hủy/timeout/lỗi/không xác minh state: không commit/session/attachments. Verify worktree trước đọc outbox; commit không hook/filter/gitattributes lạ, giữ khóa xuyên CLI+commit. Kiểm hậu kỳ thất bại xóa attachments đã đọc.
- Boundary ngẫu nhiên mỗi run; loại boundary trùng trong dữ liệu. Subject, filename, mail/child_result đều trong block không tin cậy; system/tool/cwd ở ngoài. Đây là giảm injection, không bảo đảm model miễn nhiễm.
- Claim cắt ngay trong SQL bằng window SUM: tổng event payload <=150000 ký tự, <=128 event/run, có truncated. Không lấy chuỗi lớn vào JS rồi mới cắt. Email text <=64000; full stdout ở log executor/runs.output (giới hạn 200000).

## Cron và retention

`wrangler.toml` khai báo `* * * * *`; index export scheduled. Mỗi tick tối đa 1 lost, 1 TTL, 2 task queue, 1 outbound text và 1 cây retention. Chọn thấp hơn ví dụ 5 của review để chừa D1 subrequests/CPU cho cascade/schedule cha; chưa đo Cloudflare Free.

Lost: không reclaim ID. Batch đánh run quá 30 phút failed, xóa token/cancel_requested=1, thêm run_lost dedupe lost:run_id chứa outcome đã ghi (spawn/notify/reply/wait), tăng lost_count. Lần đầu schedule run ID mới, tính budget; lần 2 liên tiếp hoặc hết run budget → completeTask(failed). Run được nộp bình thường reset chuỗi lost. Recovery phải xem outcome để tránh lặp tool; không replay event start/mail cũ. Session bị xóa khi lost vì chưa chắc trạng thái CLI; operator có thể xem timeline đầy đủ nếu cần khôi phục prompt. Executor cũ nộp muộn ignored.

TTL dùng completeTask(failed), revoke cây, ghi child_result/outbound TRƯỚC send. Queue sweep cứu continuation bị rate-limit; pending run không reclaim. Cron wake executor sau cập nhật. Timer/wait_until có schema/index nhưng chưa bật trước giai đoạn 4.

D1 giữ 1000 root mới nhất; mỗi tick xóa <=1 cây terminal cũ hơn 7 ngày, không con sống/outbound chưa sent, theo batch outbound/events/runs/tasks. Giữ sending/error để điều tra. Dọn command_receipts quá một giờ.

Executor ghi task-state ngoài cwd. Mỗi giờ khi agent rảnh, xét <=1 thư mục task thường quá 7 ngày; chỉ xóa khi API xác nhận terminal đủ 7 ngày, không project/link, đường dẫn đúng workdir. Mở lại cập nhật last_used. Không chắc/404/link → giữ cho chủ máy. Worktree chỉ prune sạch/đã merge/không khóa/không force. Nếu D1 đã xóa trước laptop online, thư mục có thể còn và cần đối chiếu thủ công.

## Giai đoạn 4

ask_user chỉ root, outcome và thư sau finalize. send_event orchestrator luôn gắn owner cấu hình, Worker kiểm owner khớp + parent_id NULL + giữ quota 30/giờ; không backchannel cha/con. Timer có giới hạn seconds/TTL, cron tạo event dedupe và schedule sau cập nhật. Không endpoint/tool giả thành công.

## Đối chiếu review

| Mục | Giải pháp |
| --- | --- |
| arch 1 | schedule_key, unique live-run, batch, event/session race test |
| arch 2–3 | spawn không project; MCP không fs; reply deferred; notify/ask root-only; agy không MCP |
| arch 4; join 1,4,5 | terminal builder, early child, mọi lỗi/hủy/TTL, await đã giao, auto-await current run, cancel cây |
| arch 5 | task cwd/worktree; test hai task cùng root/agent |
| arch 6; join 7 | owner/agent/root/RFC precedence, new/tag/reopen/options/session; auto-mail suppression |
| arch 7 | cancel đồng bộ cả waiting/token toàn cây, không ID theo owner |
| arch 8; join 2,3 | SQL admission + first-run reservation/counters trong transaction; cron retry continuation |
| arch 9; join 9 | bounded cron, SQL text caps, JSON child cap, email cap, b64 WeakSet |
| arch 10 | finish 2 pha, outbound reservation; lost ID mới thay reclaim theo brief |
| arch 11; join 6 | random boundary, subject/filename trong block, injection test |
| arch 12; join 8,10 | event message_id, bảo vệ inbox, tool precedence, fixed owner, retention/cron, con text+metadata |

Test dùng node:test, node:sqlite, D1 batch transaction, MCP in-memory/fetch giả, không mạng. Luồng kéo búa bao: gốc spawn Codex + agy, await, hai con xong sớm, một run tổng hợp, đúng một email. Test legacy giữ senderAuth/MIME/CLI/worktree; không thay test task mới. Dry-run chỉ kiểm bundle; chưa chứng minh CLI model, email/D1/cron thật hoặc CPU 10 ms.
