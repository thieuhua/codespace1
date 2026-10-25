# Agent Mailbox — Session + Mailbox MCP cục bộ

Cho Codex CLI và Antigravity CLI (`agy`) trao đổi tin nhắn bền vững trên cùng
máy Windows. Có hai chế độ: **router HTTP duy nhất** cho vòng lặp nhận lệnh và
**stdio riêng cho từng client** cho session/mailbox hiện có. Hai chế độ dùng chung
token principal, nhưng lưu thư riêng trong `router.db` và `mailbox.db` (SQLite WAL).
Không có công cụ quản trị qua MCP.
Core được chép độc lập từ `vps-mcp` tại `a5d3062`; xem [nguồn gốc](agent_mailbox/core/PROVENANCE.md).

## Router: một server, nhiều agent chờ lệnh

```text
Claude / operator (CLI offline, tin cậy)
          | router ctl send / inbox / status / stop
          v
       router.db <-- watcher chung mỗi 100 ms --> một FastMCP HTTP /mcp
                                                       ^           ^
                                                   token codex  token antigravity
                                                       |           |
                                                    Codex CLI    agy CLI
                                                    receive -> xử lý/reply -> receive ...
```

Router có đúng 5 tool: `whoami`, `mailbox_receive`, `mailbox_send`, `mailbox_reply`,
`mailbox_ack`. Không cần tạo session/mailbox chung; dùng các principal/token đã cấp
bằng setup/admin. Operator dùng địa chỉ `operator` (alias `claude` khi agent gửi).
Chạy từ thư mục dự án, sau khi thiết lập bên dưới:

```powershell
.\.venv\Scripts\python.exe -m agent_mailbox router serve --host 127.0.0.1 --port 8766 --hold-seconds 50
# Hoặc chạy nền (PID/log trong state dir); dùng -WhatIf để xem trước:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\router-start.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\router-stop.ps1
```

Endpoint mặc định: `http://127.0.0.1:8766/mcp`. State vẫn theo `--state-dir`,
`AGENT_MAILBOX_HOME`, rồi `%LOCALAPPDATA%\agent-mailbox`. Router không đọc token từ
argument để chọn danh tính: mỗi request phải có Bearer token hợp lệ của principal.
Thu hồi/disable có hiệu lực cả khi đang long-poll. Mỗi state chỉ có một server router.

Đăng ký thay thế entry `agent_mailbox` hiện có bằng URL (script chỉ chạy khi người
vận hành chủ động gọi; không chạy trong build/test với config thật):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-router-clients.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-router-clients.ps1
$env:AGENT_MAILBOX_ROUTER_TOKEN = (Get-Content -Raw "$env:LOCALAPPDATA\agent-mailbox\tokens\codex.token").Trim()
codex exec -c 'mcp_servers.agent_mailbox.tool_timeout_sec=90' -c 'mcp_servers.agent_mailbox.default_tools_approval_mode="approve"' 'Gọi agent_mailbox.whoami, rồi lặp mailbox_receive. Có thư thì xử lý và reply, no_mail thì nhận tiếp. Chỉ kết thúc khi status stop.'
```

Script hỗ trợ `-Client`, `-Url`, `-StateDir`, `-CodexTokenFile`,
`-AntigravityTokenFile`, `-WhatIf` và `-DryRun`. Codex lưu tên biến môi trường
`AGENT_MAILBOX_ROUTER_TOKEN`; **shell khởi chạy Codex phải đặt biến này** từ token
được chọn, kể cả sau rotation. `-CodexTokenFile` chỉ chọn đường dẫn được hướng dẫn,
không tự đặt biến cho shell cha. Tool timeout phải lớn hơn hold (nếu hold 300 giây,
đặt timeout lớn hơn 300). Các cờ đã được đối chiếu bằng CLI `--help` cài trên máy và
[OpenAI Docs về MCP](https://learn.chatgpt.com/docs/extend/mcp).
Antigravity dùng header đọc từ file tại lúc đăng ký và **lưu token plaintext trong
config agy**, cần đăng ký lại sau rotation. Script che token khi in lệnh.
Allow-rule hiện có cho đúng 5 tên tool trên tiếp tục dùng được.

Vòng lặp agent: gọi `whoami`, rồi liên tục `mailbox_receive()`; `no_mail` thì gọi
lại ngay, `mail` thì xử lý và `mailbox_send`/`mailbox_reply` rồi nhận tiếp; **không
kết thúc turn** cho tới khi `status: stop`, khi đó tóm tắt một dòng và kết thúc.
Hold mặc định 50 giây, `wait_seconds` là số nguyên không âm được giới hạn bởi hold.
`set-hold` nhận cả số lẻ 0..300 giây và áp dụng từ lần receive tiếp theo.

```powershell
.\.venv\Scripts\python.exe -m agent_mailbox router ctl send --to codex 'Kiểm tra công việc rồi báo lại operator'
.\.venv\Scripts\python.exe -m agent_mailbox router ctl send --to all 'Báo tiến độ'
.\.venv\Scripts\python.exe -m agent_mailbox router ctl inbox --wait 30 --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl inbox --all --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl status --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl stats --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl log --tail 20 --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl stop all --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl resume all --json
.\.venv\Scripts\python.exe -m agent_mailbox router ctl set-hold 50 --json
```

Tất cả lệnh ctl có `--json`; `inbox` đánh dấu đã đọc, `--all` xem cả lịch sử.
`status` hiển thị waiting, lần nhận gần nhất, tổng số lần nhận, streak hiện tại,
số thư vào/ra, pending và lỗi gần nhất. Streak là các receive thành công mail/no_mail
cách nhau tối đa 60 giây; stop, hủy, lỗi hoặc restart làm reset. `stats` có từng bản
ghi receive, tổng send và số task/thread/connection/waiter. Lịch sử router không tự được
dọn bởi lệnh `admin cleanup` của stdio.

Thư nhận thành công được coi là delivered, ACK là tùy chọn và idempotent. Hủy/ngắt
kết nối trước khi gửi response trả thư về pending; lần receive sau nhận được một
lần. Có cửa sổ hiếm sau commit delivered nhưng response bị mất trước khi client
nhận: thư vẫn được đánh dấu delivered. Đây không phải bảo đảm exactly-once qua lỗi
mạng; xem [API, semantics và thiết kế router](docs/ROUTER.md).

Mặc định chỉ bind loopback, bật bảo vệ DNS rebinding/Host/Origin của SDK; địa chỉ
khác cần cờ rõ ràng `--allow-non-loopback`. Không có TLS. Cùng tài khoản Windows
vẫn có thể đọc token/config/DB hoặc chạy ctl, nên token không tạo cách ly OS.
Router giới hạn 1 receive/principal, 64 receive và 64 session HTTP; tối đa 100 thư
mỗi lượt và 65.536 byte UTF-8 mỗi thư. Muốn trở về stdio, chạy script
`register-clients.ps1` hiện có.

## Thiết lập

Yêu cầu Windows PowerShell 5.1+, Python 3.11 (`py -3.11`), `codex` và `agy`
trong PATH nếu cần đăng ký. Chạy từ thư mục dự án:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

`-ExecutionPolicy Bypass` chỉ áp dụng cho tiến trình PowerShell này; không đổi
execution policy của tài khoản hay máy.

Script tạo `.venv`, cài MCP **1.30.0** và package ở chế độ editable, khởi tạo
state, cấp token cho `codex`/`antigravity`, tạo session chung và mailbox `collab`.
Có thể chạy lại: giữ token và mailbox hiện có, gia hạn session còn hoạt động;
nếu session đã hết hạn sẽ tạo session mới. Token đã thu hồi không tự được phục hồi.

State mặc định là `%LOCALAPPDATA%\agent-mailbox\`: `mailbox.db`, WAL/SHM và
`tokens\<principal>.token`. Đổi bằng `-StateDir D:\AgentState` khi chạy script,
`--state-dir` khi dùng Python, hoặc biến `AGENT_MAILBOX_HOME` (ưu tiên theo thứ tự đó).
State/token trong repository, đường dẫn symlink/junction và file hardlink bị từ chối.
Dependency ở `.venv`; **không đặt DB, token hoặc log trong repository**.

## Chạy và quản trị

```powershell
.\.venv\Scripts\python.exe -m agent_mailbox admin init
.\.venv\Scripts\python.exe -m agent_mailbox admin add-principal codex --if-missing
.\.venv\Scripts\python.exe -m agent_mailbox admin add-principal antigravity --if-missing
.\.venv\Scripts\python.exe -m agent_mailbox admin create-shared-session --owner codex --participant antigravity --mailbox collab
.\.venv\Scripts\python.exe -m agent_mailbox admin list-principals
.\.venv\Scripts\python.exe -m agent_mailbox serve --token-file "$env:LOCALAPPDATA\agent-mailbox\tokens\codex.token"
```

`serve` chỉ đọc/ghi giao thức MCP trên stdin/stdout; phải kết nối bằng client MCP.
Không khởi tạo DB nếu chưa chạy admin. `whoami` trả về `principal_id` đã xác thực.
Mỗi tiến trình đọc một token lúc khởi động; thay nội dung file yêu cầu khởi động
lại tiến trình. Ưu tiên `--token-file`, rồi `AGENT_MAILBOX_TOKEN_FILE`, rồi
`AGENT_MAILBOX_TOKEN` dự phòng. File không đọc được không được fallback sang biến token.

Token không được in mặc định. Chỉ dùng `--print-token` khi chủ động cần hiển thị.
`admin revoke codex` thu hồi token; `admin disable codex` đồng thời vô hiệu hóa
principal. Đổi token bằng `admin add-principal codex --rotate --token-file
D:\AgentState\tokens\codex-new.token`, rồi cập nhật đường dẫn client và khởi động lại.
Sau rotation, dùng `-CodexTokenFile D:\AgentState\tokens\codex-new.token` cho cả
`setup.ps1` và `register-clients.ps1` (tương tự `-AntigravityTokenFile`). Các lần
chạy sau phải giữ lựa chọn này: file mặc định cũ đã mất hiệu lực; script không
tự tìm token hoặc khôi phục credential đã thu hồi. Đường dẫn tương đối tính từ `$PWD`.
`admin cleanup` dọn dữ liệu quá retention và checkpoint WAL. Tất cả lệnh admin là
quyền offline của người dùng Windows, không phải công cụ dành cho model.

## Đăng ký client

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-clients.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-clients.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\unregister-clients.ps1 -WhatIf
# Chỉ chạy khi muốn gỡ cả hai cấu hình:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\unregister-clients.ps1
```

Hỗ trợ `-Client codex`, `-Client antigravity`, `-StateDir` và `-DryRun`.
`-WhatIf`/`-DryRun` chỉ in lệnh, không gọi CLI hay đọc token. Tên server là
`agent_mailbox`. Cấu hình lưu đường dẫn tuyệt đối tới Python `.venv` và **file token**;
Python dùng `-I` và package editable để chạy độc lập với thư mục hiện tại của client.
Với `agy`, mọi cờ `--env` đứng trước tên server.

Codex CLI **0.164.0** đã được kiểm tra bằng `--help`. `codex mcp add` không có cờ
phê duyệt công cụ; đăng ký server không đồng nghĩa với cho phép mọi lời gọi.
Trong `codex exec`, tránh cấu hình cần hỏi người dùng khi chạy tự động. Nếu đã
quyết định cho phép riêng các công cụ mailbox trong lần chạy đó, dùng:

```powershell
codex exec -c 'mcp_servers.agent_mailbox.default_tools_approval_mode="approve"' 'Dùng agent_mailbox.whoami rồi liệt kê session và mailbox collab.'
```

`approve` là thiết lập riêng server, khác với policy shell/sandbox toàn cục.
Có thể ghi `default_tools_approval_mode = "approve"` trong bảng
`[mcp_servers.agent_mailbox]` hoặc đặt `tools.<tên>.approval_mode` cho từng tool.
Script không tự thay đổi policy phê duyệt. Chính sách quản trị có thể ghi đè.
Xem [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) và
[cấu hình Codex](https://learn.chatgpt.com/docs/config-file/config-reference).
Antigravity chạy headless (`agy -p`) tự từ chối tool MCP nếu chưa có allow-rule.
Thêm `mcp(agent_mailbox/<tool>)` cho từng tool vào `permissions.allow` trong
`~/.gemini/antigravity-cli/settings.json`; không cần `--dangerously-skip-permissions`.
Phiên `codex exec` và `agy` thật đã trao đổi qua mailbox: xem
[interop report](docs/INTEROP_REPORT.md).

## Luồng trao đổi

1. Hai agent gọi `whoami`, `session_list`, rồi `mailbox_list` để tìm session/mailbox chung.
2. Codex gửi bằng `mailbox_send`, luôn đặt `idempotency_key` cho thao tác có thể retry.
3. Antigravity gọi `mailbox_receive` với `wait_seconds` tối đa 20 giây, ACK rồi reply.
4. Codex nhận tiếp bằng `after_cursor` đã lưu. Lưu cursor sau khi xử lý thành công.

ACK thuộc từng principal và không xóa/lọc lịch sử. Grant bao phủ toàn bộ mailbox
trong session; muốn nhóm người đọc khác nhau phải dùng session khác.
Session mặc định 1 ngày, tối đa 7 ngày; lệnh tạo session chung dùng 7 ngày.
Chủ sở hữu dùng `session_renew` trước khi hết hạn. Tin cũ được giữ 7 ngày.
Xem [hợp đồng 13 tools](docs/MAILBOX_API.md) về quota, pagination và lỗi.

## Giới hạn bảo mật

Token ngẫu nhiên mạnh; DB chỉ giữ salt và HMAC-SHA256, so sánh constant-time.
Mọi tool kiểm tra token trước khi dispatch và kiểm tra lại revocation/enabled
trong từng transaction, kể cả snapshot của long-poll. Token thiếu/sai/thu hồi hoặc
principal bị disable trả `UNAUTHENTICATED`; tool arguments không chọn được danh tính.
Agent không được grant nhận `NOT_FOUND` như resource không tồn tại.

Admin áp dụng ACL chỉ cho tài khoản hiện tại trên Windows khi hệ điều hành cho phép,
trước khi ghi token. Nếu Windows chạy bằng **restricted token** không cho đổi DACL,
admin phát cảnh báo và giữ ACL kế thừa; chạy setup lại từ PowerShell thông thường
của chủ tài khoản để đặt ACL riêng. Lỗi ACL ngoài trường hợp này làm lệnh thất bại.
Trên POSIX dùng thư mục 0700/file 0600.

**Cùng một tài khoản Windows: token chỉ ngăn mạo danh nhầm giữa các agent, không
phải cách ly hệ điều hành.** Agent có quyền đọc file của tài khoản có thể đọc token
khác, sửa code hoặc DB, hay chạy admin. Không dùng cho tác nhân không đáng tin cậy.
ACL phụ thuộc quyền chủ tài khoản và không chặn quản trị viên Windows.
SQLite không mã hóa; quota main DB 128 MiB không giới hạn tổng WAL/SHM.
Giới hạn worker/waiter áp dụng theo tiến trình; không có dịch vụ nền tự dọn state.

## Kiểm thử và điều hướng

```powershell
.\.venv\Scripts\python.exe -m unittest discover -v
.\.venv\Scripts\python.exe -m compileall -q agent_mailbox tests
```

Test chỉ dùng thư mục tạm, SDK client thật và server con thật. Không chạy script
đăng ký hoặc setup vào state/config thật trong quá trình build/test. Bộ test gồm
core ACL/quota/retention/crash, protocol, hardening, stress 2.000 tin với giới hạn
RAM 1 GiB, admin CLI, kiểm tra token và long-poll xuyên tiến trình.

- [Core và nguồn gốc](agent_mailbox/core/README.md)
- [Tests](tests/README.md), [scripts](scripts/README.md)
- [API](docs/MAILBOX_API.md), [build report](docs/BUILD_REPORT.md),
  [review](docs/REVIEW_ANTIGRAVITY.md), [interop report](docs/INTEROP_REPORT.md),
  [endurance report](docs/ENDURANCE_REPORT.md)
