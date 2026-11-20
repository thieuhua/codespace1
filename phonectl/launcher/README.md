# Launcher Windows (PowerShell 5.1)

Double-click `phonectl.cmd`, hoặc chạy từ thư mục `phonectl`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File launcher\phonectl.ps1
# Trong PowerShell, truyền mảng tùy chọn scrcpy:
.\launcher\phonectl.ps1 -ScrcpyArgs @('--no-audio', '--window-title', 'My phone')
```

ADB được tìm theo thứ tự: `vendor/platform-tools/adb.exe`,
`E:\Android\Sdk\platform-tools\adb.exe`, `$env:ANDROID_HOME\platform-tools\adb.exe`,
rồi PATH. Chạy `powershell -File tools\fetch-platform-tools.ps1` để chép ADB và
DLL từ SDK có sẵn; có thể chỉ định `-SdkPath 'D:\Android\Sdk'`. Không tải mạng.
scrcpy được tìm ở `vendor/scrcpy/scrcpy.exe`, rồi PATH; nếu thiếu, cài bằng
`winget install Genymobile.scrcpy`. Launcher đặt biến `ADB` cho scrcpy dùng chung ADB.

Mỗi vòng khởi động ADB, chờ khoảng 10 giây để ADB tự tìm máy. Chỉ dùng trạng thái
`device` và đọc `ro.serialno` để xác minh; bỏ qua `offline`/`unauthorized`.
Các địa chỉ cùng serial được gộp, ưu tiên địa chỉ trả lời đầu tiên. Nếu chưa thấy,
đọc mDNS `_adb-tls-connect._tcp`, thử `adb connect` các địa chỉ đúng serial hoặc
ứng viên duy nhất, rồi xác minh lại. Nhiều dịch vụ mDNS chưa biết máy nào thì chờ
ADB tự kết nối; có thể chạy `adb connect ip:port` thủ công trước khi chọn máy.

Lần đầu chỉ có một điện thoại thì tự lưu `{ "serial": "..." }` vào
`%LOCALAPPDATA%\phonectl\config.json`; nhiều điện thoại thì liệt kê và hỏi một lần.
Lựa chọn sai định dạng làm launcher thoát. Sửa/xóa config để chọn lại; config hỏng
được báo lỗi, không tự ghi đè. Cần pairing Wireless debugging từ trước theo
[README dự án](../README.md).

Chạy `scrcpy -s <id> -S -w` kèm `-ScrcpyArgs`: tắt màn hình điện thoại và giữ thức.
Thoát mã 0 thì đóng launcher; mã khác hoặc chưa tìm được máy thì thử lại sau
2, 4, 8, 16, 30 giây (tối đa 30). Ctrl+C dừng và thu hồi process do launcher giữ.
Lệnh ADB có timeout, riêng getprop 3 giây mỗi địa chỉ nên vòng dò có thể vượt 10 giây.

`-Mode native` là khung giai đoạn 3: thiếu `server/build/server.jar` thì báo
`server not built yet` và thoát mã 1. Khi có JAR, so SHA-256 rồi chỉ push nếu khác
hoặc chưa đọc được hash; forward `tcp:27183` tới `localabstract:phonectl`, giữ
`adb shell CLASSPATH=/data/local/tmp/server.jar app_process / com.phonectl.Server`
đang chạy và nối lại khi process thoát. Ctrl+C dừng process và gỡ forward.
Chưa có client native; chưa kiểm chứng hành vi trên điện thoại thật.

Kiểm thử không cần điện thoại, không chạy ADB thật hay ghi config:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1
```

`AdbParse.psm1` chứa hàm thuần; `tests/fixtures/` chứa output mẫu. Test dùng assert
và mô phỏng luồng chạy, thêm kiểm tra timeout/exit code bằng process PowerShell con;
thoát khác 0 nếu có lỗi. `phonectl.ps1` giữ phần gọi process, config và nối lại.
