# Kiến trúc xử lý: Task → Run → Event

Đặc tả đợt D, giai đoạn 1 + 2 + 3 + 4. Tích hợp 12 mục archreview và các điểm còn liên quan của joinreview. Quyết định trực tiếp trong brief đợt D thay phần reclaim, reply giữa lượt, project do spawn chọn và cancel bằng event. Các bất biến bảo mật tại [AGENTS.md](../AGENTS.md) vẫn áp dụng.

## Phạm vi

Worker lập lịch, D1 giữ trạng thái, executor chuẩn bị cwd → chạy CLI → finalize worktree/outbox → nộp kết quả. MCP run có token riêng; reader inbox và orchestrator tách biệt. Không chuyển dữ liệu jobs/threads cũ; chỉ giữ bảng để tra cứu. `/jobs`, `/job-api`, MCP mailbot-job không còn phục vụ. Các hàm/test legacy còn trong source, không được router mới gọi.

Giai đoạn 1 + 2 triển khai schema v5, email/task, scheduler, executor run, reply/spawn/await/notify, completeTask, cancel cây, cron lost/TTL/rate-limit/retention. Giai đoạn 3 triển khai executor song song theo run: mặc định tối đa 3 run tổng, 2 run/agent; chỉ claim khi có chỗ, không giữ hàng đợi run đã claim trên laptop. Giai đoạn 4 triển khai ask_user, await theo giờ và answer_task qua MCP điều phối, schema v6.

## Schema và chỉ mục

`worker/schema-v6.sql` chạy MỘT LẦN sau v5; thêm tasks.question_count và trigger tăng khi INSERT outbound kind=question. Chạy lại lỗi duplicate column. `worker/schema-v7.sql` chạy sau v6, trước Worker có QA sink; thêm qa_outbox/qa_outbox_parts. Không chạy lại migration đã áp dụng. Database mới: schema.sql → v2 → v3 → v4 → v5 → v6 → v7.

| Bảng | Trường chính |
| --- | --- |
| tasks | id; creation_key UNIQUE; root_id (gốc tự trỏ id); parent_id; spawn_run_id; depth 0..2; agent/owner/project/title; status active/waiting/done/failed/cancelled; deliver email/parent; session_id; options_json; wait_json/wait_until; rfc_message_id/references_hdr; run_count/max_runs; child_count/tree_count/mail_count/question_count/lost_count; result; completion_key; created/updated/expires/finished_at |
| runs | id/task_id; schedule_key UNIQUE; status pending/running/done/failed/cancelled; created/claimed/finished_at; token_hash/cancel_requested; output/session_id; outcome_json/outbox_json; result_hash/finish_key; notify_count; boundary |
| events | id/task_id; kind start/mail/child_result/run_lost/timer; message_id (messages.id); rfc_message_id; payload_json; dedupe_key UNIQUE; run_id NULL khi chưa tiêu thụ; created_at |
| outbound_mails | task_id/run_id; dedupe_key/message_id UNIQUE; kind reply/question/notify/terminal; status pending/sending/sent/error; text/subject/in_reply_to/references_hdr; outbox_json metadata; send_key/error; created/sent_at |
| qa_outbox / qa_outbox_parts | QA sink: id tăng dần; capture_key/message_id UNIQUE; recipient/subject/created_at; MIME nguyên vẹn chia phần theo (mail_id,part) để mỗi hàng dưới giới hạn D1 |

Chỉ mục: unique một phần runs(task_id) WHERE pending/running; queue(status,id), stale(status,claimed_at), budget(created_at,task_id), token_hash unique khi khác NULL. Events: (task_id,run_id,id), (message_id,run_id), (rfc_message_id,task_id). Tasks: owner/id, root, parent/spawn_run, RFC, status/expires_at, status/wait_until. Outbound: task/id, status/id.

AFTER INSERT trigger đặt root_id cho gốc, tăng child_count của cha và tree_count của gốc sau khi tạo con thành công; outbound trigger tăng mail_count. Guard nằm trong INSERT cùng batch, không kiểm JS rồi tăng bộ đếm riêng. Foreign key cascade và batch xóa cây; không xóa bảng lịch sử jobs/threads.

## Ngân sách

| Giới hạn | Giá trị |
| --- | --- |
| Lượt/task | 8; done mở lại: max_runs = run_count + 8 |
| Độ sâu/con trực tiếp/tổng cây | 2 / 3 / 8, tính cả gốc |
| Notify/run; thư/root | 3; 15 (lỗi gửi vẫn tiêu quota) |
| Câu hỏi/root; hẹn giờ | 5 câu hỏi đã giữ chỗ thư; 60..86400 giây, không vượt expires_at |
| CLI timeout; run_lost | 20 phút; 30 phút sau claim |
| Task TTL | 24 giờ, done mở lại cấp 24 giờ mới |
| Owner | 30 runs + command_receipts/giờ, gồm mọi con |
| Root còn sống/owner | 30 |

Tạo gốc/spawn giữ chỗ first run trong cùng batch; hết ngân sách giờ → 429, không tạo task/event/run, không tăng counter. Continuation đã nhận việc giữ event NULL và active/waiting; cron vét lại khi cửa sổ giờ trống. Không đánh rơi thư tổng hợp vì quota. Hết run budget → completeTask(failed), con vẫn phát child_result. Không có task status rate_limited: đó là kết quả admission; task đã được nhận mà chưa chạy vẫn chờ cron/TTL.

## Nhận thư và lệnh

1. Giữ senderAuth: chỉ Authentication-Results đầu của mx.cloudflare.net; DMARC pass, header.from đúng domain; đúng một From chuẩn và khớp PostalMime. Whitelist theo agent đích, kể cả +tag. Chỉ claude không tag nhận công khai; thư lạ chỉ vào inbox.
2. Sau xác thực chặn mọi Auto-Submitted khác no, mọi X-Auto-Response-Suppress (kể cả none/no), Precedence bulk/auto_reply/list, cả thư thường/lệnh; không event hay auto-reply. Thư vẫn có thể được lưu trong inbox.
3. Parse lệnh đầu subject sau Re/Fwd/Fw/Tr. /status, /cancel, help không tạo task; receipt giữ quota trước gửi. Cancel vẫn hiệu lực nếu hết quota trả thư. /cancel không ID hủy mọi task active/waiting của owner trên mọi agent, không suy diễn theo thread. /cancel=ID hủy subtree đúng owner. Status liệt kê 20 task gần nhất, gồm waiting/wait_json.
4. /new luôn tạo task/session/cwd mới. Không /new: ưu tiên In-Reply-To rồi References mới → cũ, dedupe tối đa 30 candidate; mỗi candidate tìm root đúng owner + agent qua task RFC, event RFC hoặc outbound Message-ID. Không cho người khác/agent khác/task con dùng alias để nối phiên.
5. +tag khác project → task mới với tag mới. Không tag → kế thừa project khi reply đúng task. failed/cancelled hoặc task còn sống hết TTL → task mới; done mở lại cùng task/session với 8 lượt/24 giờ mới. Gốc đã dùng 15 thư → task mới để còn trả lời được. /new dùng project của envelope, không ngầm kế thừa thread cũ.
6. Gốc mới: batch task + start(message_id, subject/text) + first run + gán event + run_count=1. Nối tiếp: batch mở lại/update options + mail event, rồi schedule. /model và /effort cập nhật task; new không lưu sang lượt resume.

Attachment gắn messages.id trong event. Claim trả metadata kèm message_id; executor tải qua API messages admin. Retention/DELETE bảo vệ messages và attachments có event run_id NULL hoặc run pending/running, kiểm lại ngay trong DELETE để tránh đua.

## Scheduler nguyên tử

schedule(task_id) dùng batch D1 và schedule_key UUID riêng mỗi lời gọi:

1. Batch bỏ timer chưa giao đã lỗi thời (wait_until/điều kiện chờ không còn khớp), rồi INSERT run SELECT task với guard SQL: active/waiting, TTL còn, run_count < max_runs, có event NULL, không live run, còn quota owner. Waiting thức khi có mail/run_lost hoặc timer đến hạn khớp wait_until hiện tại và mode user/timer; all thỏa khi mọi con terminal; any thỏa khi có child_result chưa giao thuộc tập IDs.
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
| POST /tasks/:id/answer?owner=... | ADMIN_TOKEN; {text}; đúng owner, root deliver=email đang waiting mode=user, TTL còn; event mail dedupe và receipt quota cùng batch |
| GET /tasks/:id/retention | ADMIN_TOKEN; chỉ metadata project/status/finished_at cho executor GC |
| POST /runs/claim | ADMIN_TOKEN; {agents:[...]}; UPDATE pending→running RETURNING nguyên tử, không reclaim |
| GET /runs/:id/state | ADMIN_TOKEN; status/cancel_requested |
| POST /runs/:id/result | ADMIN_TOKEN; {ok,output,session_id,cancelled,attachments,finalize_note}; 2 pha idempotent |
| GET /api/qa/outbox?after_id=0&limit=20 | ADMIN_TOKEN; `{mails:[{id,to,subject,message_id,raw,created_at}]}` tăng dần theo id; after_id nguyên không âm, limit nguyên dương tối đa 100; reader/run token không được đọc |
| POST /run-api/{reply,spawn,await,notify,ask_user} | X-Run-Token; running + task sống + không cancel |

Token ngẫu nhiên 32 byte; D1 chỉ SHA-256. Chỉ nằm trong MCP config env, không CLI env. Token run không thay thế reader/admin. API_TOKEN vẫn chỉ đọc envelope exact claude@domain, không +tag và không tasks/runs/allowlist.

## Tool và outcome

outcome ban đầu `{spawned:[],notifications:[]}`, thêm reply_text/wait/finalize_note. SQL json_set/json_insert cập nhật nguyên tử để tool đồng thời không ghi đè lẫn nhau.

- reply(text): không files/path, lần cuối thắng. Chỉ ghi outcome; không gửi giữa lượt. Không reply thì stdout là reply. Khi có reply riêng, vẫn ghép báo cáo finalize. Lượt chờ hoặc còn event chưa xử lý không gửi email; chỉ root done gửi thư tổng hợp cuối.
- spawn(agent,prompt): không project, khác agent cha, whitelist owner theo đích. SQL kế thừa owner/project/root, depth+1, spawn_run_id. Guard token/running/trạng thái cha và gốc/direct/tree/depth/rate trong batch tạo con + start + first run + ghi spawned. Agent ông có thể xuất hiện lại ở cháu nhưng luôn cwd khác task.
- await(ids,mode=all): 1..3 ID duy nhất, chỉ con trực tiếp chưa có child_result.run_id khác NULL. Từ chối tập chứa ID đã giao (kể cả prompt hiện tại), ID lạ, mình/cha. all chờ mọi con terminal, any chờ ít nhất một result chưa giao. Lần hợp lệ cuối thắng, áp dụng lúc finish.
- await({seconds}): biến thể riêng, không kèm ids/mode; seconds nguyên 60..86400, now+seconds <= expires_at, không tự cắt xuống TTL. Ghi outcome.wait={mode:timer,until}; finish thành công đặt tasks.wait_until, trừ khi có mail chưa tiêu thụ như quy tắc bên dưới. Thư owner thức sớm và xóa wait user/timer; wait con còn lại vẫn được giữ như trước.
- Auto-await chỉ con spawn trong run hiện tại, kể cả con đã xong sớm. Không ép cha chờ con cũ sau await(any). Cha done/failed hủy mọi hậu duệ còn sống, revoke token ngay.
- notify(text): root-only, text <=64000, giữ quota/outbound trước send, ghi ID vào outcome; 3/run và 15/root, không attachment.
- ask_user(question,timeout_seconds?): chỉ root deliver=email. Chỉ cập nhật outcome.reply_text và wait={mode:user,run_id,until}. Sau đó spawn/await/reply đều bị từ chối bằng guard SQL, notify vẫn chịu quota và giữ chỗ câu hỏi. Timeout tùy chọn, không có mặc định; nếu có phải nguyên 60..86400, không vượt expires_at. Tool kiểm question_count<5 và còn chỗ câu hỏi + thư kết quả cuối. Hết ngân sách trả lỗi để agent tự kết thúc. Chỉ finish thành công và không có mail chưa tiêu thụ mới giữ outbound question:run:ID, trigger tăng mail_count/question_count nguyên tử; retry không tăng lại. Hủy/lost/timeout/lỗi finalize không tạo thư câu hỏi. Thư câu hỏi chỉ text, có finalize_note, không đính kèm outbox; con thiếu thông tin kết thúc bằng câu hỏi trong kết quả cho cha.

ask_user và await({seconds}) cùng yêu cầu run_count < max_runs; từ chối 409 với lý do rõ nếu run đã spawn con, outcome.wait đã được đặt (kể cả gọi ask_user lần hai), hoặc tasks.wait_json all/any vẫn chứa con trực tiếp còn sống. Các guard nằm ngay trong UPDATE SQL, không dùng outcome snapshot của caller; không ghi đè danh sách chờ con khi tool bị từ chối. await({ids,mode}) vẫn cho phép đổi tập chờ con hợp lệ.

Con không gửi email. Prompt yêu cầu kết quả văn bản, không hứa gửi outbox. Nếu vẫn tạo tệp, executor validate rồi run/child_result chỉ lưu tên/kích thước; kết quả ghi chú metadata-only. Bytes không chuyển cha, không vào D1. Chia sẻ binary giữa task cần kho artifact riêng ở đợt sau; không mở quyền đọc fs cho MCP.

## completeTask, cancel và finishRun

Mọi terminal đi qua completeTask hoặc completionBatch cùng lớp, kể cả CLI lỗi, TTL, hết budget, lost lần 2, cancel và root done. Một batch:

1. Đổi task sống → terminal, xóa wait; completion_key UUID giới hạn tập vừa đổi, chỉ done giữ session hợp lệ.
2. Recursive CTE hủy hậu duệ sống, cùng completion_key.
3. Mọi run pending/running trong tập → cancelled, cancel_requested=1, token_hash=NULL. Executor poll 15s (timeout 5s), taskkill /T /F; kết quả lost/cancel muộn không được finalize.
4. INSERT OR IGNORE child_result cho từng con, dedupe child:<task_id>; status/agent/text/outbox metadata. Text tối đa 4000 ký tự để JSON <=32768 ngay cả ký tự điều khiển escape 6 lần. Full output giữ trong runs.output.
5. Root failed/cancelled giữ terminal outbound trước send. Sau commit schedule cha, kể cả con lỗi qua cron/hủy riêng; cancel cây không tạo run cho cha đã cancelled.

finishRun pha 1: chỉ run running + chưa cancel + task sống còn TTL nhận kết quả. Batch lưu run terminal/token NULL/output/result_hash/outbox metadata/session khi ok; tính wait bằng outcome SQL hoặc auto-await, đặt wait_until từ wait.until; cập nhật task/session; giữ outbound question duy nhất khi waiting user; terminal builder nếu cần; tạo outbound reply duy nhất reply:run:<id> khi root done. Không cửa sổ schedule giữa run và task/session. Nếu cancel/lost/TTL thắng, nộp muộn trả ignored, không session/tệp.

Nếu finish thành công với outcome.wait user/timer và task có event mail run_id NULL, cùng batch D1 bỏ điều kiện chờ đó: không waiting/wait_until, không outbound question, không tăng question_count/mail_count và không terminal/mở lại ngân sách của lượt. outcome.skipped_wait lưu mode và mail_event_id đầu tiên; outcome.wait gốc giữ để tra cứu. Sau commit schedule ngay lượt mới với thư đó khi còn quota owner; hết quota giữ active và mail NULL cho cron, không tạo timer. Retry dựa trên quyết định đã lưu, dù thư đã được tiêu thụ cũng không gửi câu hỏi cũ. Claim chỉ trả skipped_waits từ quyết định D1 gắn với mail mà lượt đó thực sự nhận; executor thêm ghi chú hệ thống ngoài boundary rằng câu hỏi/hẹn giờ đã bị bỏ vì có thư mới, để agent tự quyết định hỏi/hẹn lại. Không tin source/role hay ghi chú giả trong payload mail. Thư đến sau khi task đã waiting vẫn đánh thức bình thường.

Pha 2: luôn schedule task/cha, độc lập gửi thư. Retry phải khớp hash kết quả và metadata outbox; bỏ pha 1, không tăng quota lần nữa. Message-ID ổn định <mailbot-run-ID@domain>. UPDATE pending/error → sending với send_key giành quyền gửi; sent không gửi lại. Lỗi gửi question, terminal và reply thuần text được ghi error và không làm finish trả 500; cron gửi lại outbound đã giữ chỗ. Reply có attachment vẫn báo lỗi để executor retry mang lại bytes, vì D1 không giữ bytes và cron chỉ retry text không attachment.

D1 và EMAIL.send không có giao dịch chung hay idempotency key phía nhà cung cấp. Chết sau gửi trước ghi sent, hoặc sau giữ sending trước gửi, để lại sending: không tự gửi lại; chủ máy đối chiếu email/log rồi xử lý. Không thể cam kết exactly-once delivery trong cửa sổ này. Send ném lỗi cũng có thể không rõ thư đã phát; retry error ưu tiên khả năng gửi lại với cùng Message-ID, không bảo đảm provider dedupe. Test chứng minh idempotency D1, retry đồng thời/tuần tự và lỗi giả trước gửi; không chứng minh exactly-once của email thật.

## QA sink

`send.js` dựng MIME bằng `buildMail` đúng một lần rồi kiểm `QA_SINK_DOMAINS` (mặc định chuỗi rỗng; wrangler đặt `qa.xuanthieu.site`). Domain phân tách bằng phẩy/chấm phẩy/khoảng trắng, so khớp chính xác không phân biệt hoa/thường; không khớp subdomain. Chỉ domain trong danh sách bỏ qua `EMAIL.send`; domain khác giữ luồng gửi cũ. Sink bao phủ mọi caller của send.js, kể cả thư lệnh chỉ có command_receipt.

`deliverOutbound` vẫn giữ chỗ pending/error → sending với send_key trước gửi và truyền reservation cho send.js. Với sink, batch D1 ghi qa_outbox + các phần MIME + sent_at/status=sent, guard đúng id/send_key; lỗi batch rollback cả MIME lẫn sent rồi ghi error theo luồng cũ. Message-ID UNIQUE giữ bản MIME đầu tiên khi retry; phần MIME chỉ được thêm cho capture_key vừa INSERT, không nhân đôi khi concurrent retry. Các phần tối đa 256 Ki ký tự UTF-16, không tách surrogate pair; endpoint ghép nguyên thứ tự thành raw. Thư không có Message-ID dùng ID thực do buildMail sinh, không tạo ID thứ hai khi lưu.

outbound_mails/outbox_json vẫn chỉ chứa metadata; riêng QA sink lưu đầy đủ MIME, bao gồm bytes đính kèm dạng base64 để phục vụ kiểm thử. Dữ liệu QA độc lập với retention cây task và hiện chưa tự dọn. Migrate v7 trước khi bật Worker; kiểm thử SQLite/mock EMAIL không chứng minh email/D1 triển khai thật.

## Executor và giới hạn dữ liệu

- `agent/run-pool.mjs` điều phối run độc lập, nhận claim/execute qua injection. `agent.json`: `max_parallel` mặc định 3, `max_per_agent` mặc định 2; thiếu dùng mặc định, giá trị không phải số nguyên dương an toàn dùng mặc định và ghi log tên trường. Một vòng lấp chỗ single-flight, round-robin từng agent còn chỗ; giữ chỗ đồng bộ tổng/per-agent TRƯỚC await claim. Claim nguyên tử hiện có nhận `[agent]`; không đổi Worker/schema và không claim cho agent đầy.
- `/wake`, poll dự phòng và finally của mỗi run đều yêu cầu lấp chỗ; gộp wake đang xử lý và giữ tín hiệu tới trong khi claim. Lỗi claim trả chỗ đã giữ, ghi log, retry backoff 1s → 2s → ... tối đa 30s; wake/poll/run kết thúc không bỏ qua backoff. Đóng pool không tạo timer retry mới, kể cả claim reject muộn. Claim thành công (kể cả rỗng) reset chuỗi lỗi. Run đã claim bắt đầu xử lý ngay, chỗ được giữ tới khi execute/nộp kết quả kết thúc; lỗi từng run được bắt riêng và luôn trả chỗ. Claim mất response sau khi Worker đã nhận vẫn thuộc recovery run_lost, không reclaim ID.
- `agent/cli-runner.mjs` giữ child, cờ cancel/timeout và mọi timer trong từng invocation; cancel poll 15s, request state timeout 5s, CLI timeout mặc định 20 phút. Stop xóa ngay timer timeout/cancel; nguyên nhân dừng không bị callback muộn đổi. Exit đánh dấu PID gốc đã thoát, xóa timer timeout/cancel và chờ pipe tối đa 5s; không taskkill theo PID đã exit. Dừng đúng PID/cây của run đó; callback state muộn không hủy hoặc tạo timer sau khi run đã kết thúc. `/health` giữ text `ok ` rồi JSON số run đang xử lý theo từng agent, ví dụ `ok {"claude":2,"codex":1,"agy":0}`; không tính reservation claim chưa có run.
- Cwd `<workdir>/<agent>/task-<task_id>` kiểm directory thực, không junction/symlink. Worktree theo `(tag,agent,task_id)`, path worktrees/<tag>/<agent>-task-ID, branch mailbot/<tag>/<agent>-task-ID; không dùng root/session. Prune đọc được state hash thread lịch sử nhưng executor mới không dùng lại.
- Task thường dùng khóa mkdir nguyên tử `task-state/locks/<agent>-task-ID.lock`, worktree giữ khóa hiện có trong worktree-state. Lấy khóa trước khi chuẩn bị/đọc/dọn exchange; task thường chờ khóa tối đa khoảng 2s bằng timer (80 lần thử cách 25ms), worktree trùng khóa fail ngay. Không dọn dữ liệu của run giữ khóa hoặc khi chưa xác định cwd. `job-handler.mjs` giữ khóa xuyên CLI + finalize, nhả trong finally trước POST result (Worker có thể schedule lượt sau trước response); lỗi unlock chỉ log, vẫn nộp kết quả; semaphore vẫn giữ tới hết POST/retry. Retention dùng cùng khóa task, không xóa cwd đang dùng. Prepare/prune xếp hàng Promise trong tiến trình theo repo canonical (không phân biệt hoa/thường trên Windows) trước lấy khóa file dùng chung với admin. Chờ khóa file retry khoảng 2s bằng timer; Git prepare/prune chạy bất đồng bộ để không chặn wake/cancel; các API này phải await. Không giữ khóa repo qua CLI. Không tự phá khóa cũ sau crash; chủ máy đối chiếu trước xử lý.
- Inbox `inbox/run-ID/message_id-attachment_id-name`, outbox `outbox/run-ID`; dọn mọi run. Giữ lstat/fstat/realpath/nlink=1, 10 tệp/2 MiB, b64_lines CRLF/76; Worker validate tuyến tính một lần, WeakSet không nhận cờ JSON để bỏ validate.
- Claude restricted/permission-prompts none, deny SECRET_DIRS/Git metadata, shell allowlist, mặc định model opus. Codex disable plugins và từng MCP kế thừa + xác minh disabled trước bật mailbot-run. Chỉ reply/spawn/await/notify/ask_user được tự chấp thuận bằng override từng lượt `mcp_servers.mailbot-run.tools.<tên>.approval_mode="approve"`, để exec không cần hỏi duyệt MCP; giữ sandbox workspace-write và approval policy hiện có. Khóa đã được CLI 0.166.0 chấp nhận qua `mcp list --json`, giá trị sai bị từ chối theo enum; chưa kiểm model/email thật. Agy fail-closed inventory, không MCP run, stdout làm reply; vẫn spawn làm con. Không sửa global config.
- Codex kiểm kê + xác minh isolation single-flight theo `(entry,cwd)`, chỉ chia sẻ kiểm tra đang chạy; không cache kết quả/lỗi qua lượt sau vì CLI có thể thêm MCP project-local vào cwd ghi được. Mỗi lượt kiểm trạng thái cwd mới rồi disable toàn bộ server kế thừa trước cấp mailbot-run. Agy chỉ chia sẻ inventory đang chạy theo `(entry,cwd)`, mỗi caller kiểm allowlist riêng; không cache kết quả/lỗi qua lượt sau. Log chung append đồng bộ mỗi dòng; `runs/` mkdir recursive, output riêng `run-ID.out` tạo độc quyền `wx`, trùng ID không ghi đè và ghi log lỗi.
- Kiểm state sau CLI trước finalize. Hủy/timeout/lỗi/không xác minh state: không commit/session/attachments. Verify worktree trước đọc outbox; commit không hook/filter/gitattributes lạ, giữ khóa xuyên CLI+commit. Kiểm hậu kỳ thất bại xóa attachments đã đọc.
- Boundary ngẫu nhiên mỗi run; loại boundary trùng trong dữ liệu. Subject, filename, mail/child_result đều trong block không tin cậy; system/tool/cwd ở ngoài. Đây là giảm injection, không bảo đảm model miễn nhiễm.
- Claim cắt ngay trong SQL bằng window SUM: tổng event payload <=150000 ký tự, <=128 event/run, có truncated. Không lấy chuỗi lớn vào JS rồi mới cắt. Email text <=64000; full stdout ở log executor/runs.output (giới hạn 200000).

## Cron và retention

`wrangler.toml` khai báo `* * * * *`; index export scheduled. Mỗi tick tối đa 1 lost, 1 TTL, 2 timer, 2 task queue, 1 outbound text và 1 cây retention. Chọn thấp hơn ví dụ 5 của review để chừa D1 subrequests/CPU cho cascade/schedule cha; chưa đo Cloudflare Free.

Lost: không reclaim ID. Batch đánh run quá 30 phút failed, xóa token/cancel_requested=1, thêm run_lost dedupe lost:run_id chứa outcome đã ghi (spawn/notify/reply/wait), tăng lost_count. Lần đầu schedule run ID mới, tính budget; lần 2 liên tiếp hoặc hết run budget → completeTask(failed). Run được nộp bình thường reset chuỗi lost. Recovery phải xem outcome để tránh lặp tool; không replay event start/mail cũ. Session bị xóa khi lost vì chưa chắc trạng thái CLI; operator có thể xem timeline đầy đủ nếu cần khôi phục prompt. Executor cũ nộp muộn ignored.

TTL dùng completeTask(failed), revoke cây, ghi child_result/outbound TRƯỚC send. Queue sweep cứu continuation bị rate-limit; pending run không reclaim. Cron wake executor sau cập nhật. Timer dùng chỉ mục tasks(status,wait_until), event dedupe timer:<task>:<wait_until>; INSERT kiểm lại status/mode/wait_until/TTL để snapshot cron cũ không đánh thức điều kiện chờ mới. Scheduler kiểm lại điều kiện timer trước gán event. Timer cũ chưa giao được bỏ; timer đã giao giữ trong timeline. Không lặp admission khi timer đã có event mà đang kẹt quota. Ask timeout có text chính xác "người dùng chưa trả lời"; timer thường "đã đến giờ hẹn"; source=system. TTL thắng nếu thời điểm hết chờ trùng expires_at.

D1 giữ 1000 root mới nhất; mỗi tick xóa <=1 cây terminal cũ hơn 7 ngày, không con sống/outbound chưa sent, theo batch outbound/events/runs/tasks. Giữ sending/error để điều tra. Dọn command_receipts quá một giờ.

Executor ghi task-state ngoài cwd. Mỗi giờ khi agent rảnh, xét <=1 ứng viên thư mục task thường quá 7 ngày (kể cả ứng viên không được xóa); pool bận thì dừng, không gọi retention API. Lookup trước lấy khóa task, sau khóa đọc lại marker và chỉ xóa nếu last_used/identity không đổi; API phải xác nhận terminal đủ 7 ngày, không project/link, đường dẫn đúng workdir. Mở lại cập nhật last_used. Không chắc/404/link → giữ cho chủ máy. Worktree chỉ prune sạch/đã merge/không khóa/không force. Nếu D1 đã xóa trước laptop online, thư mục có thể còn và cần đối chiếu thủ công.

## Giai đoạn 4

MCP điều phối có answer_task {id,text}, thay tên dự kiến send_event để chỉ cho phép trả lời câu hỏi. Owner lấy cố định từ config, không từ caller; không thêm đọc inbox. Worker kiểm owner/root/deliver=email/waiting user/TTL trong INSERT event mail, dedupe answer:<task>:<question run>. Cùng transaction giữ một command_receipt cho answer mới, rồi xóa wait/wait_until và schedule. Answer tính một receipt; run tiếp tục vẫn tính một run trong quota chung 30/giờ. Hết quota trả 429, giữ nguyên trạng thái chờ và timer. Gọi khi sai trạng thái/owner trả 409; retry đồng thời trong cùng wait không tạo hai event/receipt, gọi lại sau khi đã thức trả 409. /status và get_task trả wait_json (user/timer/all/any và IDs), wait_until khi có thời hạn. Câu trả lời mail và answer_task được bọc trong boundary ngẫu nhiên của prompt như mọi event; chỉ dẫn ngoài block ghi rõ timer do hệ thống tạo.

Kiểm thử giai đoạn 4 dùng SQLite transaction, MCP transport in-memory và fetch/process giả: root/child ask, chặn wait lặp/ghi đè chờ con, hủy/lost/TTL/lỗi, retry/concurrent finish, năm câu hỏi, quota thư/owner, owner/RFC, chặn auto-mail, giới hạn seconds/TTL/lượt cuối, timer đến hạn/cũ/race/thư sớm, cron bounded/index, admin answer và hỏi → trả lời → tổng hợp. Test review tái hiện mail đến sát batch finish, rollback quyết định bỏ chờ, quota đầy không sinh timer, prompt ghi chú hệ thống, chờ con qua nhiều lượt, HTTP 200 khi gửi text lỗi và cron retry cùng Message-ID. Chưa xác minh email/D1/cron/model trên dịch vụ thật.

Chốt triển khai bổ sung: ask_user và await({seconds}) từ chối ở run_count=max_runs để còn lượt tiếp tục; ask_user còn từ chối ở mail_count>=14 để giữ thư kết quả cuối theo ngân sách hiện có. Mail owner vẫn nối cùng root chờ user/timer ở mail_count=14. Timeout tính từ lúc gọi tool; nếu lượt kết thúc sau hạn hẹn, cron kế tiếp xử lý timer sau khi finish đặt waiting, trừ khi chờ đã bị bỏ vì mail mới. Câu hỏi chỉ text để không gửi outbox trung gian trước lượt tổng hợp. Không thêm timeout mặc định hay tự retry sending không rõ kết quả.

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
