# Shared Codespace

Workspace này dùng chung cho nhiều dự án. Mỗi dự án phải nằm trong một thư mục con riêng ở thư mục gốc; không đặt mã nguồn dự án trực tiếp tại đây.

## Dự án

| Dự án | Mô tả | Hướng dẫn |
| --- | --- | --- |
| [Agent Mailbox](agent-mailbox/) | Session và mailbox MCP cục bộ trên Windows cho Codex/Antigravity | [README](agent-mailbox/README.md) |
| [VPS MCP Gateway](vps-mcp/) | MCP Server chạy trên VPS Debian 12; Codespace chỉ sửa mã nguồn | [README](vps-mcp/README.md) |
| [Focus Monitor](focus-monitor/) | Demo nhận diện mất focus, trang bị ẩn, rời trang và dấu hiệu cần xem xét | [README](focus-monitor/README.md) |

Khi thêm dự án, cập nhật bảng này và đặt liên kết đến `README.md` của dự án.

## Điều hướng

- Bắt đầu tại README này để chọn dự án.
- Đọc `README.md` trong thư mục dự án trước khi làm việc; README đó cần nêu mục đích, cách cài đặt/chạy/kiểm thử và liên kết đến các phần chính.
- Các thư mục con có nội dung hoặc cấu trúc đáng kể nên có README riêng mô tả nội dung và liên kết đến thư mục con liên quan. Không cần README cho từng thư mục mã nguồn nhỏ.
- Đọc thêm `AGENTS.md` để biết các quy tắc áp dụng cho toàn workspace.