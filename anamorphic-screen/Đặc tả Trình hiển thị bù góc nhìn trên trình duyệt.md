# Đặc tả: Trình hiển thị bù góc nhìn trên trình duyệt

Nov 9, 2026 · @Hứa Xuân Thiệu

> Đã có triển khai phiên bản đầu. Xem [README](README.md) để cài đặt/chạy và [kiểm thử](tests/README.md) để phân biệt kiểm chứng tự động với nghiệm thu phần cứng. Tâm marker dùng giao hai đường chéo thay cho trung bình bốn góc để giảm sai số phối cảnh; giao thức có thêm `photoId` chống xác nhận ảnh cũ.

## Mục tiêu và phạm vi

Xây một ứng dụng web hiển thị text và hình ảnh đơn giản trên màn hình máy tính, được biến dạng trước (pre-warp) sao cho khi nhìn từ một vị trí nghiêng cố định, người xem thấy nội dung như đang nhìn chính diện. Vị trí nhìn được xác định một lần bằng cách dùng camera điện thoại chụp màn hình từ đúng chỗ mắt người xem.

**Trong phạm vi:**

- Nội dung: text (HTML/CSS thường) và ảnh tĩnh.
- Một vị trí nhìn cố định cho mỗi lần calibrate ("khoá góc").
- Chạy hoàn toàn trên trình duyệt: Chrome/Edge/Firefox bản mới trên máy tính, Safari/Chrome trên điện thoại.
- Mạng: máy tính và điện thoại cùng mạng LAN.

**Ngoài phạm vi (phiên bản đầu):**

- Theo dõi đầu người xem liên tục theo thời gian thực.
- Nhiều người xem cùng lúc ở các góc khác nhau.
- Màn hình cong, nhiều màn hình, video, nội dung 3D.
- Bù màu hoặc độ sáng theo góc nhìn.

**Giả định nền tảng:** màn hình là mặt phẳng và camera xấp xỉ mô hình pinhole. Khi đó ánh xạ từ toạ độ màn hình sang toạ độ ảnh chụp là một phép biến đổi xạ ảnh (homography) 3×3, và toàn bộ bài toán quy về việc tìm rồi áp homography ngược.

## Luồng sử dụng

Người dùng calibrate một lần trong khoảng một phút, sau đó màn hình tự hiển thị nội dung đã bù góc.

1. Mở trang hiển thị trên máy tính và bật fullscreen.
2. Trang hiển thị chuyển sang chế độ calibrate: hiện 4 marker tại 4 vị trí đã biết và một QR code chứa URL phiên.
3. Dùng điện thoại quét QR code để mở trang chụp ảnh của phiên đó.
4. Đặt điện thoại sát vị trí mắt người xem, dùng ống kính chính 1x, chụp sao cho thấy đủ 4 marker.
5. Ảnh được gửi về; hệ thống tự phát hiện 4 marker.
6. Nếu phát hiện tự động thất bại, trang chụp ảnh cho người dùng chạm tay vào tâm 4 marker trên ảnh.
7. Hệ thống tính phép biến đổi và gửi về trang hiển thị.
8. Trang hiển thị ẩn marker, hiện nội dung đã warp. Người dùng có thể tinh chỉnh tỉ lệ thu phóng và căn lề.
9. Calibrate được lưu lại; lần sau mở trang với cùng kích thước viewport thì dùng lại ngay.

## Kiến trúc hệ thống

Hệ thống gồm ba thành phần: trang hiển thị trên máy tính, trang chụp ảnh trên điện thoại, và một server Node nhỏ chạy trong LAN làm trung gian.

&#91;embedded content: kiến trúc · 3 thành phần, 4 luồng dữ liệu\]

Server chỉ dò marker và chuyển tiếp 4 điểm Q; mọi phép tính homography nằm trong module `shared/` chạy ở trang hiển thị, nên tinh chỉnh thu phóng không cần gọi lại server.

## Toán học: homography và matrix3d

Toàn bộ phép bù góc là hai homography giải từ 4 cặp điểm, rồi gán kết quả vào CSS `matrix3d`. Không cần WebGL.

**Ký hiệu**

| Ký hiệu | Ý nghĩa | Hệ toạ độ |
| --- | --- | --- |
| P\_i (i = 1..4) | Tâm 4 marker trên trang hiển thị | Pixel CSS của viewport |
| Q\_i | Tâm 4 marker phát hiện trong ảnh | Pixel ảnh |
| M | Homography ảnh → màn hình, giải từ Q\_i → P\_i |  |
| R\_i | 4 góc hình chữ nhật đích trong ảnh | Pixel ảnh |
| S\_i = M(R\_i) | 4 góc tương ứng trên màn hình | Pixel CSS |
| c\_i | 4 góc nội dung: (0,0), (w,0), (w,h), (0,h) | Pixel CSS của phần tử nội dung |
| G | Homography nội dung → màn hình, giải từ c\_i → S\_i |  |

**Giải homography từ 4 cặp điểm (x, y) → (u, v)**

Với H = \[\[a, b, c\], \[d, e, f\], \[g, h, 1\]\], mỗi cặp điểm cho hai phương trình tuyến tính:

```latex
\begin{aligned}
a x + b y + c - g x u - h y u &= u \\
d x + e y + f - g x v - h y v &= v
\end{aligned}
```

4 cặp cho hệ 8×8; giải bằng khử Gauss có chọn trụ (partial pivoting). Phải từ chối khi 3 điểm thẳng hàng hoặc ma trận suy biến (định thức gần 0).

Áp homography lên điểm (x, y): tính (X, Y, W) = H·(x, y, 1) rồi chia, kết quả là (X/W, Y/W).

**Chọn hình chữ nhật đích R trong ảnh**

1. Chiếu 4 góc viewport (0,0), (vw,0), (vw,vh), (0,vh) sang ảnh bằng M⁻¹ (hoặc giải trực tiếp homography màn hình → ảnh từ P\_i → Q\_i). Được tứ giác V.
2. Tìm hình chữ nhật thẳng trục, đúng tỉ lệ w:h của nội dung, lớn nhất nằm gọn trong V. Cách làm đơn giản: lấy tâm V, tìm kiếm nhị phân theo kích thước, kiểm tra 4 góc nằm trong V (V lồi).
3. Nhân thêm hệ số thu phóng s ≤ 1 do người dùng chỉnh (mặc định 0.9 để chừa lề).

**Áp vào CSS**

Phần tử nội dung có kích thước w × h, `position: absolute; left: 0; top: 0; transform-origin: 0 0`. Ma trận G 3×3 được gán thành `matrix3d` (thứ tự cột):

```
G = [[a, b, c], [d, e, f], [g, h, i]]
transform: matrix3d(a, d, 0, g,  b, e, 0, h,  0, 0, 1, 0,  c, f, 0, i)
```

**Chuẩn hoá số học:** trước khi giải, dịch và co giãn toạ độ mỗi tập điểm về quanh gốc với độ lớn trung bình khoảng √2 (chuẩn hoá Hartley), rồi khử chuẩn hoá sau. Toạ độ pixel cỡ 1000–4000 khiến hệ 8×8 kém điều kiện nếu không làm bước này.

## Calibration: marker và phát hiện điểm

Không dò viền màn hình trong ảnh. Trang hiển thị tự vẽ 4 marker tại vị trí P\_i đã biết, nên toạ độ thu được nằm thẳng trong hệ pixel CSS, tránh được sai lệch do thanh địa chỉ, taskbar và viền bezel.

**Marker**

- Dùng 4 marker ArUco khác ID (từ điển 4x4 hoặc 5x5), mỗi marker xác định một góc.
- Đặt tâm marker cách mép viewport khoảng 8% chiều tương ứng, cạnh marker khoảng 12% chiều nhỏ hơn của viewport.
- Viền trắng (quiet zone) quanh marker rộng ít nhất 1 ô; nền trang trắng khi calibrate.
- Thư viện dò gợi ý: `js-aruco2`. Bản opencv.js mặc định không có module aruco.

**Phát hiện tự động**

1. Thu nhỏ ảnh nếu cạnh dài hơn 2000 px để dò nhanh; nhớ hệ số để quy đổi lại.
2. Dò marker, lấy tâm (trung bình 4 góc marker) làm Q\_i.
3. Thành công khi tìm đủ 4 ID khác nhau. Có thể dùng thêm 16 góc marker để giải homography bằng bình phương tối thiểu, chính xác hơn 4 tâm.
4. Kiểm tra hợp lệ: tứ giác Q\_1..Q\_4 lồi, đúng thứ tự vòng, diện tích đủ lớn.

**Phương án dự phòng: chạm tay**

- Trang chụp ảnh hiển thị ảnh vừa chụp, người dùng chạm lần lượt tâm 4 marker theo thứ tự được chỉ dẫn (marker đánh số rõ ràng trên màn hình).
- Cung cấp kính lúp phóng to vùng quanh ngón tay để chạm chính xác.

**Lưu ý khi chụp**

- Dùng ống kính chính 1x; không dùng ultrawide vì méo quang học lớn.
- Camera đặt càng sát vị trí mắt càng đúng; sai lệch vị trí camera chính là sai lệch kết quả.
- Bỏ qua méo quang học của ống kính ở phiên bản đầu. Ống kính chính điện thoại có méo nhỏ ở vùng giữa ảnh.

## Giao thức và API

Server giữ trạng thái theo phiên; trang hiển thị nhận kết quả qua WebSocket, điện thoại gửi ảnh qua HTTP. Xử lý ảnh chạy ở server (Node) để dễ debug; có thể chuyển sang trình duyệt sau.

**HTTP**

| Method | Đường dẫn | Ai gọi | Nội dung |
| --- | --- | --- | --- |
| GET | `/` | Máy tính | Trang hiển thị |
| GET | `/capture/:sessionId` | Điện thoại | Trang chụp ảnh |
| POST | `/api/session` | Trang hiển thị | Tạo phiên; gửi `viewport {vw, vh, dpr}` và `markers [{id, x, y}]`; trả `sessionId` |
| POST | `/api/session/:id/photo` | Điện thoại | Upload ảnh (multipart); trả `{ok, points}` hoặc `{ok:false, reason}` |
| POST | `/api/session/:id/points` | Điện thoại | Gửi 4 điểm chạm tay `[{id, x, y}]` theo pixel ảnh gốc |

**WebSocket** `/ws?session=:id` (server → trang hiển thị)

| Sự kiện | Payload |
| --- | --- |
| `photo_received` | `{}` |
| `detect_failed` | `{reason}` |
| `calibrated` | `{Q: [[x,y]×4], imageSize: {w,h}}` |

Trang hiển thị tự tính M, R, G từ Q và P (logic toán nằm ở client, để tinh chỉnh thu phóng không cần gọi server).

**Lưu trữ phía client**

Lưu `{viewport, P, Q, imageSize, scale, offset}` vào `localStorage`, khoá theo `vw×vh×dpr`. Khi tải trang, nếu khớp viewport thì dùng lại ngay; không khớp thì báo cần calibrate lại.

**HTTPS:** không bắt buộc. Trang chụp dùng `<input type="file" accept="image/*" capture="environment">`, chạy được qua HTTP trong LAN. `getUserMedia` (preview camera trực tiếp) mới cần HTTPS và không thuộc phiên bản đầu.

## Yêu cầu chi tiết từng thành phần

**Cấu trúc mã nguồn đề xuất**

```
server/
  index.js          HTTP + WebSocket, quản lý phiên trong bộ nhớ
  detect.js         dò ArUco, trả 4 điểm Q
shared/
  homography.js     solve8, homography, apply, invert, chuẩn hoá Hartley
  fitRect.js        hình chữ nhật lớn nhất trong tứ giác lồi
client/display/     trang hiển thị
client/capture/     trang chụp ảnh trên điện thoại
```

`shared/` là module thuần (không phụ thuộc DOM hay Node), dùng chung cho server và client, có unit test riêng.

**Trang hiển thị (máy tính)**

- Ba trạng thái: `calibrating` (marker + QR), `waiting` (đã nhận ảnh, đang xử lý), `display` (nội dung đã warp).
- Nội dung lấy từ một phần tử container có thể chứa HTML bất kỳ (text, ảnh); kích thước w × h cấu hình được.
- Bảng điều khiển ẩn (hiện khi rê chuột hoặc phím tắt): thu phóng s, dịch tâm, nút calibrate lại, bật/tắt warp để so sánh.
- Theo dõi `resize`, thay đổi `devicePixelRatio`, thoát fullscreen: chuyển sang trạng thái cần calibrate lại.
- Có chế độ debug: vẽ khung tứ giác S\_i và lưới ô vuông đã warp để kiểm tra bằng mắt.

**Trang chụp ảnh (điện thoại)**

- Nút chụp lớn, hướng dẫn ngắn: đặt camera ở chỗ mắt, dùng 1x, chụp thấy đủ 4 marker.
- Upload ảnh gốc, không nén lại phía client (hoặc nén với chất lượng ≥ 0.9 nếu file quá lớn).
- Hiện kết quả dò: vẽ 4 điểm lên ảnh; nút "Đúng" / "Chạm tay".
- Đọc EXIF orientation và xoay ảnh đúng chiều trước khi xử lý.

**Server**

- Phiên lưu trong bộ nhớ, hết hạn sau 15 phút không hoạt động.
- Giới hạn ảnh upload 20 MB.
- In ra địa chỉ IP LAN khi khởi động để tạo URL trong QR code.

**Chất lượng hiển thị**

- Đặt `backface-visibility: hidden` và thử cả có và không có `will-change: transform`, chọn cách cho text sắc nét hơn trên trình duyệt đích.
- Phương án dự phòng nếu text nhoè: render nội dung vào canvas độ phân giải cao (2× kích thước hiển thị) rồi warp canvas đó.

## Rủi ro, giới hạn, tiêu chí nghiệm thu

**Giới hạn vật lý (chấp nhận, không sửa)**

| Giới hạn | Hệ quả | Giảm thiểu |
| --- | --- | --- |
| Chỉ đúng tại một điểm nhìn | Lệch đầu là nội dung méo lại | Calibrate lại; mở rộng sau bằng head tracking |
| Phía màn hình gần mắt bị nén | Mất chi tiết, text nhỏ khó đọc ở góc lớn | Cỡ chữ tối thiểu cấu hình được; cảnh báo khi tỉ lệ nén vượt ngưỡng |
| Màn hình TN đổi màu theo góc | Màu sai, tương phản giảm | Ghi trong hướng dẫn; khuyên dùng IPS/OLED |
| Camera không trùng mắt | Sai số tỉ lệ với khoảng lệch | Hướng dẫn đặt camera sát mắt |

**Rủi ro kỹ thuật**

| Rủi ro | Cách xử lý |
| --- | --- |
| Dò marker thất bại (chói, mờ, nghiêng quá) | Phương án chạm tay |
| Text nhoè dưới `matrix3d` | Phương án canvas độ phân giải cao |
| Hệ 8×8 kém điều kiện | Chuẩn hoá Hartley, kiểm tra định thức |
| Ảnh xoay sai chiều do EXIF | Đọc EXIF orientation trước khi dò |
| Viewport đổi sau calibrate | Phát hiện và yêu cầu calibrate lại |

**Tiêu chí nghiệm thu**

- [x] Unit test `shared/`: homography dựng lại đúng 4 điểm với sai số < 1e-6 sau chuẩn hoá; ghép H rồi H⁻¹ ra đơn vị.
- [x] Test tổng hợp không cần phần cứng: dựng ảnh giả lập bằng một homography biết trước, chạy cả pipeline, 4 góc nội dung trong ảnh giả lập tạo hình chữ nhật với sai lệch < 1 px.
- [ ] Thực tế: nhìn lệch 45° theo phương ngang, chụp kiểm tra từ đúng vị trí calibrate, các cạnh nội dung song song với trục ảnh trong phạm vi 1°.
- [ ] Phát hiện marker tự động thành công trong ít nhất 9/10 lần chụp ở điều kiện ánh sáng phòng bình thường.
- [ ] Toàn bộ luồng từ mở trang đến hiển thị warp dưới 60 giây.
- [ ] Text 24 px vẫn đọc được từ vị trí calibrate ở góc 45°.

**Hướng mở rộng sau phiên bản đầu:** dùng webcam máy tính theo dõi khuôn mặt, ước lượng vị trí mắt 3D và tính lại G mỗi khung hình (off-axis projection).
