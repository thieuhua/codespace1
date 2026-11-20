# adbkeeper

App Kotlin không giao diện, package `com.phonectl.adbkeeper`, Android 11+ (API 30).
Chỉ dùng Android framework và Kotlin chuẩn; không có AndroidX hay thư viện ngoài.

## Build offline

Cần JDK 17+, SDK Android 36 và Build Tools 36.0.0. Gradle 9.1.0 (`all`),
AGP 9.0.1, Kotlin 2.3.20 cùng dependency build phải có sẵn trong cache Gradle.
Tạo `local.properties` (được gitignore): `sdk.dir=E:/Android/Sdk`.

```powershell
cd phonectl\adbkeeper
.\gradlew.bat assembleDebug
```

APK: `app\build\outputs\apk\debug\app-debug.apk`.
Wrapper trong `gradle/wrapper/`; cấu hình module tại `app/build.gradle.kts`;
mã nguồn và manifest trong `app/src/main/`.

## Cài và kiểm tra

Bật Developer options, ghép đôi Wireless debugging hoặc nối USB và chấp nhận ADB trước.
Từ thư mục `phonectl`, chạy PowerShell 5.1:

```powershell
powershell -File tools\setup-phone.ps1
# Nếu có nhiều thiết bị:
powershell -File tools\setup-phone.ps1 -Serial "IP:PORT"
adb shell settings get global adb_wifi_enabled
adb shell settings get global stay_on_while_plugged_in
adb logcat -s adbkeeper
```

Script tìm ADB lần lượt trong `vendor/platform-tools`, `E:\Android\Sdk\platform-tools`,
rồi PATH; cài APK, cấp `WRITE_SECURE_SETTINGS`, `POST_NOTIFICATIONS` (API 33+),
whitelist deviceidle và khởi động service lần đầu để app nhận broadcast sau này.
Khi dùng nhiều thiết bị, thêm `-s SERIAL` vào các lệnh `adb` kiểm tra.
Giá trị mong đợi là `1` và `7`. Thử tắt/bật Wi-Fi, khởi động lại và kiểm tra log.

## Hoạt động và giới hạn

`BootReceiver` xử lý boot, locked boot và cập nhật app, lên lịch job rồi mở service.
`KeeperJobService` chạy định kỳ tối thiểu 15 phút khi mạng không tính phí, ghi cả hai
setting; thời điểm thực tế do Android quyết định. `KeeperService` chạy foreground
loại `specialUse`, thông báo mức thấp, theo dõi Wi-Fi và bật Wireless debugging
khi có mạng; sau khoảng 4 giây đọc lại và ghi lại nếu giá trị về 0.
Service cũng ghi cả hai setting khi được khởi động; các thành phần đều direct-boot aware,
không dùng SharedPreferences. Lỗi thiếu quyền được ghi với tag `adbkeeper`.

Trên Xiaomi/Oppo/Samsung và ROM hạn chế nền, bật **Tự khởi động** và bỏ tối ưu pin
cho app. Một số ROM cần mở khóa sau boot hoặc chặn sửa setting dù đã cấp quyền;
cần kiểm tra trên máy thật. Force-stop sẽ cần khởi động service lại bằng script.
Mạng Wi-Fi mới vẫn cần xác nhận cho phép Wireless debugging; app không thay bước ghép đôi.
`stay_on_while_plugged_in=7` chỉ giữ máy thức khi cắm nguồn AC/USB/không dây.
