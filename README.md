# Shared Codespace

Workspace này dùng chung cho nhiều dự án. Mỗi dự án phải nằm trong một thư mục con riêng ở thư mục gốc; không đặt mã nguồn dự án trực tiếp tại đây.

## Dự án

| Dự án | Mô tả | Hướng dẫn |
| --- | --- | --- |
| [Agent Mailbox](agent-mailbox/) | Session và mailbox MCP cục bộ trên Windows cho Codex/Antigravity | [README](agent-mailbox/README.md) |
| [VPS MCP Gateway](vps-mcp/) | MCP Server chạy trên VPS Debian 12; Codespace chỉ sửa mã nguồn | [README](vps-mcp/README.md) |
| [Mailbot](mailbot/) | Hộp thư `claude@` cho agent + mailbot chạy CLI (`claude`/`codex`/`agy`) theo thư từ whitelist | [README](mailbot/README.md) |
| [Laptop Tunnel](laptop-tunnel/) | Đưa dịch vụ TCP/UDP trên laptop Windows ra Internet qua VPS bằng WireGuard (`laptop.xuanthieu.site`) | [README](laptop-tunnel/README.md) |
| [Focus Monitor](focus-monitor/) | Demo nhận diện mất focus, trang bị ẩn, rời trang và dấu hiệu cần xem xét | [README](focus-monitor/README.md) |
| [Anamorphic Screen](anamorphic-screen/) | Ứng dụng LAN bù góc nhìn bằng ảnh điện thoại, marker ArUco và CSS homography | [README](anamorphic-screen/README.md) |
| [INT1433 nhóm 0060](int1433-06-20261-grp-int1433-06-0060/) | Bài tập lớn Lập trình mạng (INT1433, PTIT) — submodule từ `ptit-hungdn-2026` | [README](int1433-06-20261-grp-int1433-06-0060/README.md) |
| [IoT Chuồng Trại Thông Minh](IoT-chuong-trai-thong-minh/) | Nền tảng thiết bị ESP32 và Mosquitto | [README](IoT-chuong-trai-thong-minh/README.md) |

Khi thêm dự án, cập nhật bảng này và đặt liên kết đến `README.md` của dự án.

## Điều hướng

- Bắt đầu tại README này để chọn dự án.
- Đọc `README.md` trong thư mục dự án trước khi làm việc; README đó cần nêu mục đích, cách cài đặt/chạy/kiểm thử và liên kết đến các phần chính.
- Các thư mục con có nội dung hoặc cấu trúc đáng kể nên có README riêng mô tả nội dung và liên kết đến thư mục con liên quan. Không cần README cho từng thư mục mã nguồn nhỏ.
- Đọc thêm `AGENTS.md` để biết các quy tắc áp dụng cho toàn workspace.
