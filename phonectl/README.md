# phonectl

Xem và điều khiển điện thoại Android từ laptop Windows qua LAN, chỉ dùng ADB. Không cần root hay Shizuku. Mở launcher là nó tự kết nối, mất kết nối thì tự nối lại. Màn điện thoại có thể tắt mà máy vẫn chạy.

## Thành phần

| Thư mục | Vai trò | Trạng thái |
| --- | --- | --- |
| [launcher/](launcher/) | Launcher PowerShell: dò máy qua mDNS, `adb connect`, chạy client, tự nối lại | Giai đoạn 1: chạy kèm scrcpy |
| [adbkeeper/](adbkeeper/) | App Android không giao diện (Kotlin), tự bật lại Wireless debugging sau khi khởi động lại hoặc rớt Wi-Fi | Giai đoạn 2 |
| [tools/](tools/) | `fetch-platform-tools.ps1` chép `adb.exe` vào `vendor/`; `setup-phone.ps1` cài `adbkeeper` và cấp quyền | |

## Thiết lập một lần

1. Lấy adb: `powershell -File tools\fetch-platform-tools.ps1`. Script chép platform-tools từ Android SDK vào `vendor\platform-tools\`.
2. Cài scrcpy: `winget install Genymobile.scrcpy`, hoặc giải nén vào `vendor\scrcpy\`.
3. Trên điện thoại: bật Developer options, rồi bật Wireless debugging. Trên laptop chạy `adb pair ip:port` và nhập mã 6 số. Tích "Luôn cho phép trên mạng này".
4. Build và cài `adbkeeper` (xem [adbkeeper/README.md](adbkeeper/README.md)), rồi chạy `powershell -File tools\setup-phone.ps1`. Script cài APK, `pm grant` quyền `WRITE_SECURE_SETTINGS` và `POST_NOTIFICATIONS`, thêm app vào whitelist deviceidle, rồi khởi động service lần đầu. Bước khởi động này bắt buộc: app không có launcher activity nằm ở trạng thái stopped và sẽ không nhận `BOOT_COMPLETED`.
5. Trên ROM Xiaomi, Oppo, Samsung: bật Tự khởi động cho `adbkeeper` và tắt tối ưu pin cho nó.
6. Nên đặt IP cố định cho điện thoại (DHCP reservation trên router) và dùng Wi-Fi 5 GHz.

## Chạy

Mở bằng double-click `launcher\phonectl.cmd`, hoặc chạy `powershell -File launcher\phonectl.ps1`. Lần đầu, nếu chỉ có một máy, launcher lưu `ro.serialno` của máy đó vào `%LOCALAPPDATA%\phonectl\config.json` và từ đó chỉ kết nối đúng máy này. Chi tiết luồng xem [launcher/README.md](launcher/README.md).

## Kiểm thử

- Launcher: `powershell -File launcher\tests\run-tests.ps1` kiểm tra phần phân tích output adb bằng dữ liệu mẫu, không cần điện thoại.
- adbkeeper: `cd adbkeeper; .\gradlew.bat assembleDebug`.

## Kiến trúc và lộ trình

1. **Launcher + scrcpy** (đã làm): `adb start-server`, chờ adb tự kết nối qua mDNS (`_adb-tls-connect`). Nếu không thấy máy thì đọc `adb mdns services` rồi `adb connect`. Sau đó chạy `scrcpy -s <id> -S -w`. scrcpy thoát mã 0 (người dùng đóng cửa sổ) thì launcher thoát. Mã khác thì kết nối lại, có backoff.
2. **adbkeeper** (đã làm): khi khởi động lại hoặc có lại Wi-Fi, app ghi `adb_wifi_enabled=1` và `stay_on_while_plugged_in=7`.
3. **Server riêng** (chưa làm): `server.jar` chạy bằng `app_process` dưới uid shell, lắng nghe `localabstract:phonectl`. Lấy hình qua SurfaceControl/DisplayManager và encode bằng MediaCodec H.264/H.265 độ trễ thấp. Nhập thao tác bằng `InputManager.injectInputEvent`. Tắt màn bằng display power mode OFF, kèm PARTIAL_WAKE_LOCK. Có clipboard hai chiều, tùy chọn audio `REMOTE_SUBMIX` + Opus. Tham khảo server của scrcpy (Apache 2.0).
4. **Client C++ riêng** (chưa làm): FFmpeg + D3D11VA, render bằng SDL2, thay cho scrcpy. Launcher đã chừa sẵn các bước push `server.jar` (bỏ qua nếu hash trùng), `adb forward tcp:27183 localabstract:phonectl` và giữ process `adb shell`.

## Giới hạn đã biết

- Sau khi khởi động lại thường phải mở khóa máy một lần: trên máy mã hóa theo file, `BOOT_COMPLETED` chỉ đến sau lần mở khóa đầu. App có thử `LOCKED_BOOT_COMPLETED`, nhưng có chạy được không là tùy ROM.
- Đổi sang mạng Wi-Fi khác thì phải tích "Luôn cho phép" lại cho mạng đó.
- Cổng Wireless debugging đổi mỗi lần bật, nên launcher dựa vào mDNS chứ không hardcode cổng.
- `stay_on_while_plugged_in` chỉ giữ máy thức khi đang cắm sạc.
