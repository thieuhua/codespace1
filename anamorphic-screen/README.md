# Anamorphic Screen — Trình hiển thị tự bù góc nhìn

Ứng dụng web hiển thị chữ hoặc hình ảnh đơn giản trên màn hình máy tính, biến dạng trước nội dung để người nhìn từ một góc nghiêng cố định thấy chữ thẳng và hình chữ nhật đúng dáng như khi nhìn chính diện.

**Trạng thái:** đã triển khai phiên bản đầu chạy cục bộ/LAN bằng Node.js và JavaScript thuần. Có hiệu chuẩn tự động, chọn điểm thủ công, lưu góc nhìn và kiểm thử tự động. Các tiêu chí quang học trên màn hình/điện thoại thật vẫn cần kiểm chứng.

## Luồng sử dụng

1. Mở trang hiển thị trên máy tính, bật toàn màn hình. Trang hiện các marker ở vị trí đã biết và QR code của phiên hiệu chuẩn.
2. Điện thoại cùng mạng LAN quét QR để mở trang chụp ảnh.
3. Đặt camera điện thoại ngay vị trí mắt sẽ nhìn màn hình, chụp đủ các marker bằng ống kính chính 1x.
4. Gửi ảnh qua server nhỏ trong LAN. Hệ thống nhận diện marker; nếu thất bại, người dùng chỉ điểm thủ công trên ảnh.
5. Từ các cặp tọa độ marker trên màn hình và trong ảnh, tính homography mô tả độ méo phối cảnh. Chọn vùng chữ nhật đích trong ảnh và ánh xạ ngược về màn hình để tạo phép biến dạng nội dung.
6. Trang máy tính nhận kết quả, áp CSS `transform: matrix3d(...)` và hiển thị nội dung đã bù góc. Người dùng có thể chỉnh thu phóng, căn vị trí và bật/tắt bù để so sánh.

Góc nhìn được khóa sau lần chụp. Đổi chỗ ngồi hoặc thay đổi kích thước vùng hiển thị thì cần hiệu chuẩn lại. Kết quả chỉ được dùng lại khi vị trí mắt, màn hình và cấu hình hiển thị vẫn phù hợp.

## Tính năng đã triển khai

- Một màn hình phẳng, một điểm nhìn cố định; nội dung là chữ và ảnh tĩnh đơn giản.
- Trang máy tính hiển thị marker, QR, nội dung đã biến dạng và điều khiển hiệu chuẩn.
- Trang điện thoại chụp/gửi ảnh, xem kết quả nhận diện và hỗ trợ chọn marker thủ công.
- Server trong LAN quản lý phiên, nhận ảnh, dò marker và đẩy kết quả về trang máy tính qua WebSocket.
- Module toán học tính homography với chuẩn hóa Hartley, khử Gauss chọn trụ, từ chối suy biến và chuyển sang `matrix3d` ở phía trang hiển thị.
- Điều chỉnh chữ, ảnh tĩnh, kích thước nội dung, cỡ chữ, thu phóng và dịch tâm; dịch tâm được giới hạn để nội dung không vượt khỏi màn hình.
- Lưới/đường bao debug, bật/tắt bù góc, tùy chọn `will-change` và render canvas 2× bằng html2canvas khi cần so sánh độ nét.
- Khôi phục theo `vw × vh × dpr`; yêu cầu hiệu chuẩn lại khi resize, đổi DPR hoặc thoát fullscreen. WebSocket tự kết nối lại và lấy kết quả đã bỏ lỡ.

Trang điện thoại dùng bộ chọn ảnh có tùy chọn chụp bằng camera, hoạt động qua HTTP trong LAN. Server xử lý EXIF trước khi dò và trả ảnh preview cùng hệ tọa độ với các điểm. Khi chọn tay, có kính lúp, hoàn tác và hỗ trợ phím mũi tên/Enter. Không có preview camera trực tiếp.

## Giới hạn

- Chỉ bù đúng tại một điểm nhìn; di chuyển đầu sẽ thấy méo trở lại.
- Góc nghiêng lớn làm một phần nội dung bị nén, mất chi tiết và giảm độ rõ của chữ; vùng nội dung hữu dụng có thể nhỏ lại.
- Không sửa được hiện tượng đổi màu, độ sáng hay tương phản theo góc của màn hình, đặc biệt với tấm nền TN.
- Độ chính xác phụ thuộc vị trí camera so với mắt, độ rõ của marker và méo ống kính. Homography giả định màn hình phẳng và camera gần mô hình pinhole.

## Thiết lập, chạy và kiểm thử

Yêu cầu **Node.js 22 trở lên** và npm. Chạy trong thư mục dự án:

```bash
cd anamorphic-screen
npm ci
npm start
```

Mở `http://localhost:3000` trên máy tính. Server in ra các IP LAN; QR mặc định dùng một IP LAN khi truy cập bằng localhost. Bật **Toàn màn hình trước khi chụp**, rồi dùng điện thoại cùng Wi-Fi quét QR. Nếu QR chọn nhầm card mạng/VPN, mở **Địa chỉ kết nối điện thoại** và chọn hoặc nhập IP đúng. Cổng mặc định là 3000; cho phép điện thoại truy cập cổng này trong tường lửa của máy chạy server.

```bash
# Đổi cổng hoặc đặt trước URL dùng trong QR
PORT=8080 PUBLIC_URL=http://192.168.1.10:8080 npm start
# Tự khởi động lại server khi mã server/module được import thay đổi
npm run dev
```

`HOST` mặc định là `0.0.0.0`. Trong PowerShell đặt biến bằng `$env:PORT="8080"` trước `npm start`.

**Chạy trong Codespaces:** chuyển tiếp cổng 3000, mở URL của cổng trên máy tính, nhập URL đó trong phần địa chỉ kết nối nếu cần. Điện thoại phải mở được cùng URL, bao gồm đăng nhập GitHub khi cổng để riêng tư. IP `172.x` của container thường không phải địa chỉ LAN mà điện thoại truy cập được. Để dùng hoàn toàn trong LAN như thiết kế, chạy server trên máy tính cùng mạng với điện thoại.

**Điều khiển:** rê chuột để hiện thanh công cụ; `C` mở tùy chỉnh, `W` bật/tắt bù, `D` hiện lưới và đường bao, `F` bật/tắt fullscreen. **Xem nội dung mẫu** cho phép thử các điều khiển trước khi hiệu chuẩn. Ảnh nội dung chọn trên máy tính chỉ được đọc cục bộ, không gửi lên server và không lưu sau khi tải lại trang. Có thể sửa HTML trong phần tử `#content` để thay mẫu; giữ các phần tử có ID mà `app.js` sử dụng.

```bash
npm test                         # Toán học, ảnh tổng hợp và HTTP/WebSocket thật
npx playwright install chromium # Một lần cho kiểm thử trình duyệt
# Linux thiếu thư viện hệ thống: npx playwright install-deps chromium
npm run test:browser             # Luồng desktop + điện thoại cảm ứng giả lập bằng Chromium
```

Xem [hướng dẫn kiểm thử](tests/README.md) để hiểu dữ liệu tổng hợp, giới hạn xác minh và quy trình nghiệm thu thực tế. Không cần bước build; CSS, ES modules và các thư viện trình duyệt đều được phục vụ từ server, không cần CDN.

## Phiên, ảnh và API

- Phiên/preview chỉ nằm trong RAM, hết hạn sau **15 phút không hoạt động**; restart server sẽ xóa chúng. Ping WebSocket không kéo dài phiên. Bản hiệu chuẩn trong `localStorage` không cần giữ server session để tiếp tục hiển thị.
- Tối đa 40 phiên; 1 ảnh đang xử lý mỗi phiên; hàng đợi dò toàn server tối đa 4 ảnh chờ. Dò ArUco chạy trong worker thread để không chặn HTTP/WebSocket.
- Upload tối đa **20 MiB**, giải mã tối đa **64 triệu pixel**. JPEG/PNG/WebP được hỗ trợ; HEIF/AVIF/TIFF tùy codec của Sharp. Nếu HEIC không đọc được, chọn JPEG/PNG. Server không giữ ảnh gốc; chỉ giữ preview JPEG tối đa 2000 px cùng tọa độ theo ảnh gốc đã xử lý EXIF.
- Dùng từ điển ArUco **ARUCO (5×5)**, ID `17, 42, 73, 99`, tương ứng nhãn **1, 2, 3, 4** theo chiều kim đồng hồ từ trên trái. Tâm marker được lấy bằng giao hai đường chéo để tránh sai số phối cảnh của trung bình bốn góc.
- Hình chữ nhật đích có tâm tại trung bình bốn đỉnh viewport chiếu lên ảnh; tìm kích thước lớn nhất ở tâm đó rồi nhân hệ số mặc định 0,9, đúng phương pháp xấp xỉ trong đặc tả.

API cốt lõi giữ theo [đặc tả](<Đặc tả Trình hiển thị bù góc nhìn trên trình duyệt.md>): tạo phiên, upload multipart trường `photo`, gửi 4 điểm, WebSocket `/ws?session=:id` với `photo_received`, `detect_failed`, `calibrated`. Nhận diện tự động hợp lệ sẽ áp dụng ngay; nút **Đúng** trên điện thoại xác nhận lại, **Chạm tay** gửi kết quả sửa.

Các endpoint hỗ trợ: `GET /api/config`, `GET /api/markers/:id.svg`, `GET /api/session/:id`, `DELETE /api/session/:id`, `GET /api/session/:id/photo`, `GET /api/session/:id/qr?url=...`. Client gửi điểm dưới dạng `{photoId, points:[{id,x,y}]}` để từ chối xác nhận ảnh đã bị thay; server cũng nhận mảng điểm thuần theo hợp đồng ban đầu. ID phiên là khóa truy cập ngẫu nhiên trong URL; ứng dụng thiết kế cho LAN tin cậy, chưa có tài khoản người dùng.

## Điều hướng

- [Đặc tả chi tiết](<Đặc tả Trình hiển thị bù góc nhìn trên trình duyệt.md>): thiết kế toán học, giao thức và tiêu chí nghiệm thu.
- [client/display/index.html](client/display/index.html), [app.js](client/display/app.js), [style.css](client/display/style.css): trang máy tính, nội dung và điều khiển.
- [client/capture/](client/capture/): trang điện thoại, upload, overlay điểm và kính lúp; tiện ích/CSS chung trong [client/common/](client/common/).
- [server/index.js](server/index.js): HTTP/WebSocket và hàng đợi worker; [detect.js](server/detect.js): ảnh/ArUco; [sessions.js](server/sessions.js): vòng đời phiên.
- [shared/homography.js](shared/homography.js), [fitRect.js](shared/fitRect.js), [calibration.js](shared/calibration.js): module thuần dùng chung, không phụ thuộc DOM/Node.
- [tests/](tests/README.md): kiểm thử toán, ảnh, API và trình duyệt.

Thư viện chính: [js-aruco2](https://github.com/damianofalcioni/js-aruco2), [Sharp](https://sharp.pixelplumbing.com/api-operation/), Express, ws, qrcode và html2canvas. `package-lock.json` khóa phiên bản để cài đặt lặp lại được.

## Hướng mở rộng

Dùng webcam theo dõi vị trí đầu/mắt và cập nhật phép biến đổi liên tục, giảm nhu cầu chụp lại khi người xem di chuyển. Hướng này cần bổ sung ước lượng vị trí mắt và hiệu chuẩn camera so với màn hình.
