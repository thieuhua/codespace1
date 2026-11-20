# Giai đoạn 3: server fork scrcpy, truyền thẳng qua LAN

Fork server scrcpy **5.0.1**, dùng với client scrcpy 5.0.1 có sẵn (qua `SCRCPY_SERVER_PATH`). Ưu tiên: **âm thanh liền mạch**, video được phép bỏ khung. Video, audio và điều khiển đi thẳng qua Wi-Fi, mỗi luồng một kết nối TCP+TLS riêng, nên video nghẽn không chặn audio như khi chung một kết nối adb.

```
scrcpy.exe ──TCP 127.0.0.1:R──► phonectl-relay.exe ══TLS 1.2 qua LAN══► server.jar (app_process, uid shell) :P
     ▲ client gốc, không sửa         (pin chứng chỉ, gửi token)              (fork scrcpy 5.0.1)
     └─ adb vẫn dùng để: push jar, push file phiên, khởi động server (do client scrcpy làm)
```

## Phiên (session)

Mỗi lần launcher chạy scrcpy:

1. Launcher lấy IP Wi-Fi của điện thoại (`adb shell ip -4 addr show wlan0`). IP laptop là địa chỉ nguồn khi `connect` một socket UDP tới IP điện thoại, không suy từ địa chỉ adb.
2. Launcher khởi động `phonectl-relay.exe` (stdin/env, **không** qua dòng lệnh) với: IP điện thoại, cổng P ngẫu nhiên 20000–60999, đường dẫn file phiên tạm. Relay tự sinh: token 32 byte ngẫu nhiên, khóa EC P-256 + chứng chỉ tự ký, cổng loopback R ngẫu nhiên. Relay ghi file phiên rồi in một dòng `READY <R>`.
3. Launcher `adb push` file phiên lên `/data/local/tmp/phonectl-session`, `chmod 600`, xóa bản trên laptop.
4. Launcher chạy scrcpy với `SCRCPY_SERVER_PATH=<server.jar>` và `--force-adb-forward --tunnel-host=127.0.0.1 --tunnel-port=<R>` cộng `scrcpyArgs`.
5. Server đọc rồi **xóa ngay** file phiên. File cũ hơn 120 s bị bỏ qua.
6. scrcpy thoát hoặc relay chết thì launcher dừng cả hai, rồi vòng kết nối lại như hiện nay.

### File phiên (`key=value`, mỗi dòng một cặp, ASCII)

| Khóa | Ý nghĩa |
| --- | --- |
| `version` | `1` |
| `created` | Unix ms lúc tạo |
| `port` | Cổng P server lắng nghe |
| `peer` | IP laptop. Server chỉ nhận kết nối từ IP này (lớp lọc phụ, không phải lớp bảo vệ chính) |
| `token` | Base64 của 32 byte |
| `pfx` | Base64 của PKCS#12 (chứng chỉ + khóa riêng của server, 3DES/SHA1 để Android đọc được) |
| `pfxpass` | Mật khẩu PKCS#12 |
| `vlat`, `vminbr` | Tùy chọn: ngân sách trễ video (ms, mặc định 100), bitrate tối thiểu (bps, mặc định 1000000) |

Không có file phiên thì server chạy **y như server gốc** (đường hầm adb), nhưng vẫn có điều khiển nghẽn video.

## Giao thức trên mỗi kết nối LAN

1. TCP tới `phone:P`, rồi bắt tay TLS 1.2. Relay chỉ chấp nhận đúng chứng chỉ của phiên (so SHA-256 của DER) và từ chối trước khi gửi bất cứ gì.
2. Relay gửi 33 byte: `token[32] + role_index[1]`. `role_index` là thứ tự relay nhận kết nối cục bộ trong phiên: 0, 1, 2. Client gốc kết nối lần lượt video → audio → điều khiển.
3. Server so token theo thời gian hằng (constant time). Sai thì đóng. Đúng thì ánh xạ `role_index` sang danh sách vai trò đang bật theo thứ tự `[video?, audio?, control?]` (lấy từ tham số client: `video`, `audio`, `control`).
4. Kết nối có `role_index = 0`: server gửi 1 dummy byte như chế độ forward gốc, vì client chờ byte này.
5. Từ đó là luồng scrcpy gốc, đi bên trong TLS.

### Quy tắc phía server

- Chỉ lắng nghe sau khi đọc được file phiên. Mỗi kết nối bắt tay ở thread riêng, `soTimeout` 3 s, nên kết nối rác hay treo không chặn được `accept`.
- Đủ các vai trò đang bật thì đóng listener. Quá 20 s mà chưa đủ thì thoát với lỗi.
- **Mọi** ghi/đọc đi qua stream của `SSLSocket`. Không ghi vào FileDescriptor thô (`Streamer`, `sendDeviceMeta`, `ControlChannel` phải sửa lại). `shutdownInput`/`shutdownOutput` không dùng được với SSLSocket: dùng `close()` hoặc `Os.shutdown` trên fd của socket thường bên dưới.
- Socket audio và điều khiển: `TCP_NODELAY`, `setTrafficClass(0xB8)`.

### Quy tắc phía relay

- Mở kết nối lên điện thoại **khi** client kết nối cục bộ (lazy), timeout kết nối 1 s, thử lại tối đa 3 s. Với kết nối 0: thất bại thì đóng kết nối cục bộ để client tự thử lại (client thử 100 lần × 100 ms).
- `NoDelay` ở cả hai chân, một thread cho mỗi chiều, bộ đệm nhỏ (≤ 64 KB).
- Một chân đóng thì đóng toàn bộ kết nối của phiên. Relay thoát khi stdin đóng (launcher chết).

## Điều khiển nghẽn video (server)

- Encoder không ghi socket trực tiếp nữa: `encoder thread → hàng đợi giới hạn → sender thread → stream TLS`. Nhờ vậy encoder không bao giờ bị chặn bởi mạng, và có thể bỏ khung trước khi ghi.
- Tín hiệu nghẽn: tuổi gói cũ nhất trong hàng đợi, thời gian hoàn tất mỗi lần ghi, và nếu đọc được thì `SIOCOUTQNSD` (0x894B) hoặc `TCP_INFO` trên fd của socket thường bên dưới. Ioctl gọi qua reflection, chỉ là thông tin phụ: lỗi thì bỏ qua.
- Chính sách:
  - Hàng đợi vượt ngân sách `vlat`: bỏ mọi gói đang chờ (trừ gói config codec), vào **chế độ chờ keyframe** (bỏ các gói tới cho đến IDR kế tiếp), xin sync frame. Hai lần xin sync frame cách nhau ít nhất 1 s.
  - Bitrate theo AIMD qua `PARAMETER_KEY_VIDEO_BITRATE`: nghẽn thì nhân 0,7 (không dưới `vminbr`), 2 s không nghẽn thì cộng 10% (không vượt bitrate client yêu cầu).
  - Không bao giờ cắt ngang một gói đang ghi, không bỏ gói config.
- **Audio không bỏ gì.** Audio liền mạch nhờ video không chiếm hết đường truyền, cộng `--audio-buffer` phía client.
- Ghi log mỗi quyết định (bỏ khung, đổi bitrate, sync) qua `Ln` để chỉnh tham số.

## Launcher

- `config.json`: `"transport": "lan"` (mặc định) hoặc `"adb"` (dùng server gốc như giai đoạn 1).
- Chỉ dùng server fork khi `scrcpy --version` đúng `5.0.1`. Lệch phiên bản thì dùng server gốc, in cảnh báo, không làm hỏng việc chạy.
- `install.ps1` build `server/build/scrcpy-server` (bằng `server/build.ps1`) và `relay/build/phonectl-relay.exe` (bằng `csc` của .NET Framework) nếu chưa có.

## Bảo mật

- Bảo vệ chính: chứng chỉ được pin và token, cả hai chỉ đi qua adb (kênh đã có TLS và xác thực khi ghép đôi). Lọc IP chỉ là lớp phụ.
- Mạng ký túc xá dùng chung: không có token thì không xem được màn hình, không điều khiển được. Không có chứng chỉ thì không giả làm điện thoại được.
- Cổng loopback R ngẫu nhiên. Tiến trình khác của cùng người dùng trên laptop vẫn có thể kết nối vào R. Chấp nhận rủi ro này, vì tiến trình như thế vốn đã có toàn quyền với tài khoản đó.
