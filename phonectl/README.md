# phonectl

Xem và điều khiển điện thoại Android từ laptop Windows qua LAN, chỉ dùng ADB. Không cần root hay Shizuku. Mở launcher là nó tự kết nối, mất kết nối thì tự nối lại. Màn điện thoại có thể tắt mà máy vẫn chạy.

## Thành phần

| Thư mục | Vai trò | Trạng thái |
| --- | --- | --- |
| [launcher/](launcher/) | Launcher PowerShell: dò máy qua mDNS, `adb connect`, cấp phát phiên LAN TLS hoặc chạy đường hầm ADB, tự nối lại | Giai đoạn 1 & 3 |
| [adbkeeper/](adbkeeper/) | App Android không giao diện (Kotlin), tự bật lại Wireless debugging sau khi khởi động lại hoặc rớt Wi-Fi | Giai đoạn 2 |
| [relay/](relay/) | Relay C# (.NET Framework 4.8.1): sinh chứng chỉ/token phiên, lắng nghe loopback và chuyển tiếp mỗi luồng qua TLS 1.2 có pin chứng chỉ | Giai đoạn 3 |
| [server/](server/) | Fork `scrcpy-server` 5.0.1: nhận kết nối TLS 1.2 trực tiếp qua LAN cho video/audio/control và điều khiển nghẽn video | Giai đoạn 3 |
| [tools/](tools/) | `fetch-platform-tools.ps1` chép `adb.exe` vào `vendor/`; `setup-phone.ps1` cài `adbkeeper` và cấp quyền | |

## Thiết lập một lần

Các lệnh trong README này chạy từ thư mục `phonectl` (`cd phonectl` nếu đang ở gốc workspace). Đứng ở chỗ khác thì ghi đường dẫn đầy đủ tới script.

1. Chuẩn bị Android SDK platform-tools và scrcpy (`winget install Genymobile.scrcpy`, hoặc giải nén vào `vendor\scrcpy\`). Nếu cần build APK/server, xem yêu cầu JDK/SDK và cache Gradle trong [adbkeeper/README.md](adbkeeper/README.md).
2. Điện thoại và laptop cùng LAN. Bật Developer options → Wireless debugging, cho phép mạng Wi-Fi hiện tại; mở **Pair device with pairing code** nếu máy chưa ghép đôi.
3. Double-click **`install.cmd`** một lần. Script chép ADB từ SDK nếu thiếu, tìm scrcpy cả trong PATH lưu ở registry, build APK (`adbkeeper`), relay (`relay\build\phonectl-relay.exe` bằng `csc.exe`) và server fork (`server\build\scrcpy-server` bằng `server\build.ps1`) nếu thiếu, chờ ADB tự kết nối khoảng 10 giây. Nếu chưa có máy, script dò cổng pairing qua mDNS và chỉ hỏi mã 6 số; không thấy dịch vụ thì hỏi thêm IP:port trên hộp thoại pairing. Sau khi pair, script chờ kết nối tự động tối đa 30 giây, cài/cấp quyền/khởi động `adbkeeper`, lưu serial và tạo shortcut **phonectl** ở Desktop và Start Menu. Nếu có nhiều máy chưa chọn, ngắt các máy khác rồi chạy lại.
4. Hoàn tất checklist trên điện thoại: Xiaomi bật **USB debugging (Security settings)** để điều khiển; cho `adbkeeper` **Autostart / Tự khởi động** và pin **No restrictions / Không hạn chế**. Giữ Wireless debugging bật.

Có thể chạy lại installer; APK, relay và server hiện có được dùng lại, cài app bằng `install -r`, config giữ các tùy chọn khác và shortcut được cập nhật. Ép build lại tất cả: `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Rebuild` (hoặc `install.cmd -Rebuild`). Script không tự cài scrcpy hay tải platform-tools; thiếu scrcpy sẽ in lệnh winget rồi dừng. SDK khác vị trí mặc định: chạy `powershell -ExecutionPolicy Bypass -File tools\fetch-platform-tools.ps1 -SdkPath 'D:\Android\Sdk'` trước.

`setup-phone.ps1` vẫn cài APK, cấp `WRITE_SECURE_SETTINGS` và `POST_NOTIFICATIONS` (Android 13+), whitelist deviceidle, rồi khởi động service lần đầu. Bước này bắt buộc vì app không có launcher activity và cần thoát trạng thái stopped để nhận `BOOT_COMPLETED`.

## Chạy

Hằng ngày, click shortcut **phonectl** ở Desktop hoặc Start Menu. Launcher chạy một phiên duy nhất, tự nối lại khi mất mạng; đóng cửa sổ scrcpy để thoát. Tên cửa sổ mặc định là model điện thoại. Có thể mở trực tiếp `launcher\phonectl.cmd` hoặc chạy `powershell -ExecutionPolicy Bypass -File launcher\phonectl.ps1`.

Serial vật lý (`ro.serialno`) được lưu trong `%LOCALAPPDATA%\phonectl\config.json` để chỉ kết nối đúng máy. Config hỗ trợ `"transport": "lan"` (mặc định: truyền thẳng qua LAN TLS 1.2 khi có `server\build\scrcpy-server` và `scrcpy --version` là `5.0.1`, lệch phiên bản hoặc thiếu file thì cảnh báo và dùng server gốc) hoặc `"adb"` (dùng đường hầm ADB và server gốc), cùng tùy chọn `"scrcpyArgs": ["--no-audio"]` được ghép trước `-ScrcpyArgs`. Chi tiết xem [launcher/README.md](launcher/README.md) và [server/DESIGN.md](server/DESIGN.md).

## Xử lý sự cố

- Âm thanh đôi lúc đứt trên mạng chập chờn: tăng bộ đệm âm thanh phía client, ví dụ thêm `"--audio-buffer=200"` vào `scrcpyArgs` (mặc định của scrcpy là 50 ms; đánh đổi: tiếng trễ hơn hình khoảng 0,15 s).
- Hình/tiếng trễ dần như tua chậm (thao tác vẫn nhanh): video vượt băng thông nên dồn hàng trong TCP. Tránh Mobile Hotspot của laptop ở 2.4 GHz: card Wi-Fi phải chia thời gian giữa hai kênh, đo được chỉ ~6 Mbps qua adb so với ~34 Mbps khi cả hai máy cùng vào một Wi-Fi 5 GHz. Sau đó chỉnh `scrcpyArgs` cho vừa, ví dụ mạng tốt `["--video-codec=h265","--video-bit-rate=8M","--max-size=1920","--max-fps=60"]`, mạng yếu `2M`, `--max-size=1280`, `--max-fps=30`.
- `vendor\platform-tools\adb.exe mdns services` rỗng: kiểm tra laptop dùng mạng **Private**, firewall cho phép ADB trên mạng Private, router tắt **AP/client isolation**, thử ngắt VPN. Khi pairing, giữ hộp thoại mã trên điện thoại mở; cổng pairing khác cổng kết nối.
- Đã pair nhưng không tự kết nối: giữ Wireless debugging bật, kiểm tra `_adb-tls-connect._tcp` và các mục mạng trên rồi chạy lại `install.cmd`. Không dùng cổng pairing cho `adb connect`.
- Xem log có timestamp tại **`%LOCALAPPDATA%\phonectl\launcher.log`**; log nối tiếp giữa các lần chạy và giữ khoảng 1 MB cuối, gồm output/lỗi scrcpy. Config JSON hỏng sẽ báo lỗi thay vì ghi đè.
- Không điều khiển được Xiaomi: kiểm tra **USB debugging (Security settings)**; app ngừng sau boot/rớt Wi-Fi: kiểm tra Autostart và pin No restrictions, mở khóa máy một lần sau boot.
- Build lỗi: kiểm tra JDK/SDK và dependency đã cache theo README adbkeeper; installer dừng khi build hoặc setup lỗi. Di chuyển thư mục dự án thì chạy lại installer để cập nhật shortcut.

## Kiểm thử

- Server fork: `powershell -NoProfile -ExecutionPolicy Bypass -File server\build.ps1` build `server\build\scrcpy-server`; `powershell -NoProfile -ExecutionPolicy Bypass -File server\test\run-tests.ps1` kiểm tra chính sách nghẽn video (bỏ khung chờ IDR, giới hạn xin sync frame, AIMD bitrate) bằng Java trên máy tính.
- Relay TLS (C#): `powershell -NoProfile -ExecutionPolicy Bypass -File relay\tests\run-tests.ps1` build `phonectl-relay.exe`, chạy fake TLS server trong tiến trình để kiểm tra PFX 3DES/SHA1, pin chứng chỉ, token + thứ tự role 0/1/2, retry role 0 và đóng toàn phiên.
- Launcher/installer: `powershell -NoProfile -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1` kiểm tra parser, ghép config, phiên LAN/relay, pairing và luồng cài giả lập, mutex/log/process; không cần điện thoại.
- adbkeeper: `cd adbkeeper; .\gradlew.bat assembleDebug`.

## Kiến trúc và lộ trình

1. **Launcher + scrcpy** (đã làm): `adb start-server`, chờ adb tự kết nối qua mDNS (`_adb-tls-connect`). Nếu không thấy máy thì đọc `adb mdns services` rồi `adb connect`. Sau đó chạy `scrcpy -s <id> -S -w`. scrcpy thoát mã 0 (người dùng đóng cửa sổ) thì launcher thoát. Mã khác thì kết nối lại, có backoff.
2. **adbkeeper** (đã làm): khi khởi động lại hoặc có lại Wi-Fi, app ghi `adb_wifi_enabled=1` và `stay_on_while_plugged_in=7`.
3. **Server fork scrcpy 5.0.1 + LAN TLS relay** (đã làm, xem [server/DESIGN.md](server/DESIGN.md)): `phonectl-relay.exe` sinh khóa EC P-256 (hoặc RSA-2048), chứng chỉ tự ký PKCS#12 (3DES/SHA1) và token 32 byte cho mỗi phiên; launcher đẩy file phiên lên `/data/local/tmp/phonectl-session` (`chmod 600`) rồi chạy client scrcpy 5.0.1 gốc qua `SCRCPY_SERVER_PATH` và cổng loopback của relay. Mỗi luồng video/audio/control đi trên một kết nối TCP+TLS 1.2 riêng qua Wi-Fi kèm điều khiển nghẽn video để giữ âm thanh liền mạch.
4. **Client C++ riêng** (chưa làm): FFmpeg + D3D11VA, render bằng SDL2, thay cho scrcpy. Launcher đã chừa sẵn các bước push `server.jar` (bỏ qua nếu hash trùng), `adb forward tcp:27183 localabstract:phonectl` và giữ process `adb shell`.

## Giới hạn đã biết

- Sau khi khởi động lại thường phải mở khóa máy một lần: trên máy mã hóa theo file, `BOOT_COMPLETED` chỉ đến sau lần mở khóa đầu. App có thử `LOCKED_BOOT_COMPLETED`, nhưng có chạy được không là tùy ROM.
- Đổi sang mạng Wi-Fi khác thì phải tích "Luôn cho phép" lại cho mạng đó.
- Cổng Wireless debugging đổi mỗi lần bật, nên launcher dựa vào mDNS chứ không hardcode cổng.
- `stay_on_while_plugged_in` chỉ giữ máy thức khi đang cắm sạc.
