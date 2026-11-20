# Launcher Windows (PowerShell 5.1)

Chạy `..\install.cmd` một lần theo [README dự án](../README.md), rồi hằng ngày click
shortcut **phonectl** ở Desktop/Start Menu. Có thể double-click `phonectl.cmd`, hoặc
chạy từ thư mục `phonectl`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File launcher\phonectl.ps1
# Trong PowerShell, truyền mảng tùy chọn scrcpy:
.\launcher\phonectl.ps1 -ScrcpyArgs @('--no-audio', '--window-title', 'My phone')
```

ADB được tìm theo thứ tự: `vendor/platform-tools/adb.exe`,
`E:\Android\Sdk\platform-tools\adb.exe`, `$env:ANDROID_HOME\platform-tools\adb.exe`,
rồi PATH. Chạy `powershell -File tools\fetch-platform-tools.ps1` để chép ADB và
DLL từ SDK có sẵn; có thể chỉ định `-SdkPath 'D:\Android\Sdk'`. Không tải mạng.
scrcpy được tìm ở `vendor/scrcpy/scrcpy.exe`, rồi PATH hiện tại và PATH User/Machine
lưu trong registry (kể cả console mở trước khi cài scrcpy); nếu thiếu, cài bằng
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
được báo lỗi, không tự ghi đè. Config có thể chỉ chứa `scrcpyArgs` khi chưa chọn máy;
lưu serial giữ các trường khác. Installer xử lý pairing và lưu serial trước.

Config nhận `"transport"` (`"lan"` mặc định hoặc `"adb"`) và mảng chuỗi `scrcpyArgs` tùy chọn, ví dụ:

```json
{ "serial": "PHONE123", "transport": "lan", "scrcpyArgs": ["--no-audio", "--max-size", "1280"] }
```

Tham số được ghép theo thứ tự: mặc định → config → `-ScrcpyArgs`. Không có config
thì `"transport"` mặc định là `"lan"` và không thêm tùy chọn scrcpy. `--window-title`
mặc định lấy từ `getprop ro.product.model`, dùng serial nếu không đọc được; có thể
ghi đè bằng tùy chọn scrcpy của bạn.

Khi `"transport": "lan"` (mặc định), launcher chỉ dùng server fork nếu có
`server/build/scrcpy-server` và `scrcpy --version` báo đúng `5.0.1`; nếu thiếu file
hoặc lệch phiên bản thì in cảnh báo và tự lùi về server gốc qua ADB (`"adb"`).
Trong phiên LAN (theo [../server/DESIGN.md](../server/DESIGN.md)):
1. Đọc IPv4 Wi-Fi của điện thoại (`adb shell ip -4 addr show wlan0`) và tìm IP nguồn
   của laptop bằng cách `Connect` một socket UDP tới IP điện thoại.
2. Khởi động `relay/build/phonectl-relay.exe` (qua stdin và biến môi trường, không truyền
   argv) với IP điện thoại, cổng ngẫu nhiên `P` (20000–60999) và đường dẫn file phiên tạm;
   đợi dòng `READY <R>`.
3. `adb push` file phiên lên `/data/local/tmp/phonectl-session`, `chmod 600`, rồi xóa
   ngay bản tạm trên laptop.
4. Đặt `SCRCPY_SERVER_PATH` trỏ tới `server/build/scrcpy-server` và chạy
   `scrcpy -s <id> -S -w --window-title <model> --force-adb-forward --tunnel-host=127.0.0.1 --tunnel-port=<R>`
   kèm `scrcpyArgs`.
5. Nếu `scrcpy` thoát hoặc `phonectl-relay.exe` chết, launcher dừng cả hai; `scrcpy`
   thoát mã 0 thì đóng launcher, mã khác hoặc lỗi phiên thì thử lại sau
   2, 4, 8, 16, 30 giây (tối đa 30). Ctrl+C dừng và thu hồi process do launcher giữ.
Lệnh ADB có timeout, riêng getprop 3 giây mỗi địa chỉ nên vòng dò có thể vượt 10 giây.

Named mutex giữ một launcher cho mỗi user trong phiên Windows. Lần mở thứ hai in
`already running` và thoát mã 0. Log nối tiếp có timestamp và output/lỗi scrcpy ở
`%LOCALAPPDATA%\phonectl\launcher.log`, giữ khoảng 1 MB cuối cả khi chạy lâu.
Nếu mDNS rỗng, kiểm tra firewall trên mạng Private, AP/client isolation và VPN.

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

`AdbParse.psm1` chứa hàm thuần (parser connect/pairing, kiểm tra endpoint, ghép config);
`tests/fixtures/` chứa output mẫu. Test dùng assert và mô phỏng luồng launcher/installer,
thêm kiểm tra mutex, log, timeout/exit code bằng process PowerShell con;
thoát khác 0 nếu có lỗi. `phonectl.ps1` giữ phần gọi process, config và nối lại.
