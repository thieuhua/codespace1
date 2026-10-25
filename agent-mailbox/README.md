# Agent Mailbox — Session + Mailbox MCP cục bộ

Cho Codex CLI và Antigravity CLI (`agy`) trao đổi tin nhắn bền vững trên cùng
máy Windows. Mỗi client chạy một tiến trình stdio riêng; tất cả dùng chung SQLite
WAL. Có 13 công cụ session/mailbox và `whoami`, không có công cụ quản trị qua MCP.
Core được chép độc lập từ `vps-mcp` tại `a5d3062`; xem [nguồn gốc](agent_mailbox/core/PROVENANCE.md).

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
  [review](docs/REVIEW_ANTIGRAVITY.md), [interop report](docs/INTEROP_REPORT.md)
