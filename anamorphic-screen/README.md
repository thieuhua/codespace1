# Anamorphic Screen — Trình hiển thị tự bù góc nhìn

Ứng dụng web hiển thị chữ hoặc hình ảnh đơn giản trên màn hình máy tính, biến dạng trước nội dung để người nhìn từ một góc nghiêng cố định thấy chữ thẳng và hình chữ nhật đúng dáng như khi nhìn chính diện.

**Trạng thái:** đã có ghép đôi bền vững, camera live nhớ marker qua nhiều khung, chốt theo từng marker và phương án chụp ảnh/chạm tay. Chạy bằng Node.js và JavaScript thuần. Các tiêu chí quang học trên màn hình/điện thoại thật vẫn cần kiểm chứng.

## Luồng sử dụng

1. Mở trang hiển thị trên máy tính và bật toàn màn hình. Quét QR bằng camera hệ thống, hoặc mở `/capture?scan=1` trên điện thoại để quét ngay trong web.
2. Cho phép camera sau. Dùng ống kính chính 1×, giữ camera cố định tại vị trí mắt. Bốn marker không cần được dò thành công trong cùng một khung hình.

   Trong phần camera, chọn đúng **Camera đang dùng** nếu điện thoại có nhiều ống kính. Ứng dụng ưu tiên camera sau góc rộng thông thường khi nhận ra tên thiết bị; lựa chọn của bạn được nhớ cho lần mở sau. Zoom có thanh chỉnh và các mức nhanh theo dải thiết bị hỗ trợ, hiển thị giá trị camera báo lại và nhớ riêng theo camera, không ép về 1× khi mở lại. Mức 1× tính theo camera đã chọn, có thể khác giữa các ống kính.

   Lấy nét mặc định ưu tiên **Tự động liên tục**. Có nút **Lấy nét lại**, chạm vào ảnh để chọn điểm lấy nét và **Chỉnh tay** khi camera/trình duyệt cung cấp các API tương ứng. Chức năng không hỗ trợ sẽ được ghi rõ; có thể dùng camera hệ thống qua **Chụp ảnh màn hình**. Đổi camera/zoom/lấy nét xóa bộ nhớ marker trong cùng phiên để không trộn hai cấu hình.

3. Điện thoại dò ArUco trong Web Worker ở cạnh dài tối đa 640 px, mục tiêu 12,5 lượt/giây. Mỗi marker có bộ nhớ riêng: thấy ID nào thì thay tọa độ ID đó, không thấy thì giữ điểm từ khung trước. Khung chỉ thấy 1–2 marker vẫn góp điểm; khung trống không xóa bộ nhớ. Mỗi lượt đợi xác nhận server, không xếp hàng video; chỉ các điểm vừa dò được đi qua mạng.
4. Khi đã nhớ đủ bốn ID, máy tính render ngay tứ giác mới nhất sau mỗi lần có điểm cập nhật. Không chờ một khung có đủ bốn marker hay bộ 15 khung hoàn chỉnh, không dùng EMA để kéo các góc chưa thấy sang vị trí khác. Phối cảnh không hợp lệ giữ bản hiển thị hợp lệ gần nhất. Cả hai trang phân biệt **số marker vừa thấy** và **số marker đã nhớ**; điểm vừa thấy được tô sáng, điểm cũ có viền.
5. **Chốt** khả dụng khi bộ nhớ có đủ bốn điểm và phối cảnh hợp lệ. Mỗi ID có tối đa 15 lần quan sát thật để lấy median riêng; có một lần thấy mỗi ID cũng chốt được. Dùng lại điểm cũ không được tính thêm mẫu. Máy tính lưu kết quả và ẩn marker; camera tắt.
6. **Hiệu chỉnh lại** trên một trong hai thiết bị đưa màn hình về live trong cùng phiên. Sau khi đã được cấp quyền, điện thoại mở lại camera; không cần đổi QR hay quét lại. Tạm dừng camera cũng giữ ghép đôi.

Nếu đã di chuyển camera khi gom điểm, dùng **Xóa điểm đã nhớ** để gom lại; nút này giữ nguyên phiên/QR. Bộ nhớ điểm không phải optical flow và không ước lượng chuyển động giữa các khung, vì vậy cần giữ camera ổn định khi đang tích lũy marker.

Nếu không mở được camera trực tiếp hoặc dò thiếu marker, chọn **Dùng chụp ảnh / chạm tay**. Ảnh gốc được upload, server dò marker; có kính lúp và hoàn tác khi chọn tay. Luồng này vẫn chạy trên HTTP LAN.

Góc nhìn được khóa sau lần chụp. Đổi chỗ ngồi hoặc thay đổi kích thước vùng hiển thị thì cần hiệu chuẩn lại. Kết quả chỉ được dùng lại khi vị trí mắt, màn hình và cấu hình hiển thị vẫn phù hợp.

## Tính năng đã triển khai

- Một màn hình phẳng, một điểm nhìn cố định; nội dung là chữ và ảnh tĩnh đơn giản.
- Trang máy tính hiển thị marker, QR, nội dung đã biến dạng và điều khiển hiệu chuẩn.
- Trang điện thoại chụp/gửi ảnh, xem kết quả nhận diện và hỗ trợ chọn marker thủ công.
- Server quản lý phiên và chuyển tiếp điểm qua WebSocket; chỉ giải mã/dò ảnh khi dùng luồng upload dự phòng.
- Module toán học tính homography với chuẩn hóa Hartley, khử Gauss chọn trụ, từ chối suy biến và chuyển sang `matrix3d` ở phía trang hiển thị.
- Điều chỉnh chữ, ảnh tĩnh, kích thước nội dung, cỡ chữ, thu phóng và dịch tâm; dịch tâm được giới hạn để nội dung không vượt khỏi màn hình.
- Lưới/đường bao debug, bật/tắt bù góc, tùy chọn `will-change` và render canvas 2× bằng html2canvas khi cần so sánh độ nét.
- Hai thiết bị nhớ `sessionId` trong localStorage, nối lại cùng phiên khi refresh/mất mạng. Hiệu chuẩn đã chốt vẫn lưu theo `vw × vh × dpr`; resize/đổi DPR/thoát fullscreen cập nhật marker và bắt đầu lượt live mới, giữ nguyên phiên/QR.

Camera trực tiếp/quét QR cần **HTTPS hoặc localhost** và quyền camera. QR ưu tiên `BarcodeDetector` nếu hỗ trợ QR, dự phòng bằng jsQR trong worker. Khi trang điện thoại vào nền, camera dừng; khi trở lại lượt live có thể tiếp tục với quyền đã cấp. Bản upload xử lý EXIF trước khi dò, trả ảnh preview cùng hệ tọa độ với các điểm và hỗ trợ phím mũi tên/Enter.

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

Mở `http://localhost:3000` trên máy tính. Server in ra các IP LAN; QR mặc định dùng một IP LAN khi truy cập bằng localhost. HTTP LAN dùng được phương án chụp/upload; muốn camera trực tiếp trên điện thoại cần truy cập qua HTTPS. Nếu QR chọn nhầm card mạng/VPN, mở **Địa chỉ kết nối điện thoại** và nhập IP/URL đúng. Cổng mặc định là 3000.

```bash
# Đổi cổng hoặc đặt trước URL dùng trong QR
PORT=8080 PUBLIC_URL=http://192.168.1.10:8080 npm start
# Tự khởi động lại server khi mã server/module được import thay đổi
npm run dev
```

`HOST` mặc định là `0.0.0.0`. Trong PowerShell đặt biến bằng `$env:PORT="8080"` trước `npm start`.

**Chạy trong Codespaces:** server tự dựng `https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}` cho QR và log khởi động. `PUBLIC_URL` ghi đè giá trị tự động. Chuyển tiếp cổng 3000, đặt Public nếu muốn điện thoại truy cập không cần đăng nhập GitHub, rồi mở **cùng URL HTTPS đó trên máy tính lẫn điện thoại**. Với Codespace hiện tại: `https://supreme-acorn-69g4wgg9qx75hrj44-3000.app.github.dev`. Không dùng IP `172.x` của container để ghép điện thoại. Không cần cấu hình `PUBLIC_URL` khi hai biến Codespaces đã có.

**Điều khiển:** rê chuột để hiện thanh công cụ; `C` mở tùy chỉnh, `W` bật/tắt bù, `D` hiện lưới và đường bao, `F` bật/tắt fullscreen. **Xem nội dung mẫu** cho phép thử các điều khiển trước khi hiệu chuẩn. Ảnh nội dung chọn trên máy tính chỉ được đọc cục bộ, không gửi lên server và không lưu sau khi tải lại trang. Có thể sửa HTML trong phần tử `#content` để thay mẫu; giữ các phần tử có ID mà `app.js` sử dụng.

```bash
npm test                         # Toán học, ảnh tổng hợp và HTTP/WebSocket thật
npx playwright install chromium # Một lần cho kiểm thử trình duyệt
# Linux thiếu thư viện hệ thống: npx playwright install-deps chromium
npm run test:browser             # Luồng desktop + điện thoại cảm ứng giả lập bằng Chromium
```

Xem [hướng dẫn kiểm thử](tests/README.md) để hiểu dữ liệu tổng hợp, giới hạn xác minh và quy trình nghiệm thu thực tế. Không cần bước build; CSS, ES modules và các thư viện trình duyệt đều được phục vụ từ server, không cần CDN.

## Phiên, ảnh và API

- Phiên/preview chỉ nằm trong RAM, **không hết hạn khi còn WebSocket mở** ở bất kỳ thiết bị nào. Sau khi socket cuối cùng đóng, có 15 phút để nối lại. Restart server xóa phiên và cần ghép lại; bản hiệu chuẩn đã chốt trong localStorage vẫn hiển thị được.
- Tối đa 40 phiên; 1 ảnh đang xử lý mỗi phiên; hàng đợi dò toàn server tối đa 4 ảnh chờ. Dò ArUco chạy trong worker thread để không chặn HTTP/WebSocket.
- Upload tối đa **20 MiB**, giải mã tối đa **64 triệu pixel**. JPEG/PNG/WebP được hỗ trợ; HEIF/AVIF/TIFF tùy codec của Sharp. Nếu HEIC không đọc được, chọn JPEG/PNG. Server không giữ ảnh gốc; chỉ giữ preview JPEG tối đa 2000 px cùng tọa độ theo ảnh gốc đã xử lý EXIF.
- Dùng từ điển ArUco **ARUCO (5×5)**, ID `17, 42, 73, 99`, tương ứng nhãn **1, 2, 3, 4** theo chiều kim đồng hồ từ trên trái. Tâm marker được lấy bằng giao hai đường chéo để tránh sai số phối cảnh của trung bình bốn góc.
- Hình chữ nhật đích có tâm tại trung bình bốn đỉnh viewport chiếu lên ảnh; tìm kích thước lớn nhất ở tâm đó rồi nhân hệ số mặc định 0,9, đúng phương pháp xấp xỉ trong đặc tả.
- Mỗi lượt có `revision`; đổi viewport/hiệu chỉnh lại tăng revision để bỏ dữ liệu cũ. Một điện thoại giữ quyền gửi luồng tại một thời điểm. Bộ nhớ giữ từng ID qua các lần mất dấu, không tự hết hạn do thiếu marker. Đổi kích thước khung/camera/zoom/focus, xóa điểm, tạm dừng hoặc nối lại luồng sẽ gom lại từ đầu. Khi chốt, camera phải vẫn đang gửi, nhưng không bắt buộc cả bốn điểm được thấy gần đây hay cùng lúc. FPS thực tế phụ thuộc thiết bị và mạng.

API cốt lõi giữ theo [đặc tả](<Đặc tả Trình hiển thị bù góc nhìn trên trình duyệt.md>): tạo phiên, upload multipart trường `photo`, gửi 4 điểm, WebSocket `/ws?session=:id` với `photo_received`, `detect_failed`, `calibrated`. Nhận diện tự động hợp lệ sẽ áp dụng ngay; nút **Đúng** trên điện thoại xác nhận lại, **Chạm tay** gửi kết quả sửa.

Các endpoint hỗ trợ: `GET /api/config`, `GET /api/markers/:id.svg`, `GET /api/session/:id`, `DELETE /api/session/:id`, `GET /api/session/:id/photo`, `GET /api/session/:id/qr?url=...`. Client gửi điểm dưới dạng `{photoId, points:[{id,x,y}]}` để từ chối xác nhận ảnh đã bị thay; server cũng nhận mảng điểm thuần theo hợp đồng ban đầu. ID phiên là khóa truy cập ngẫu nhiên trong URL; ứng dụng thiết kế cho LAN tin cậy, chưa có tài khoản người dùng.

WebSocket `/ws?session=:id&role=display|capture` giữ các sự kiện cũ và bổ sung:

| Hướng | Sự kiện | Nội dung |
| --- | --- | --- |
| Client → server | `configure` (display) | `{viewport, markers, force?, requestId}`; cập nhật cùng phiên |
| Client → server | `start_live`, `fallback` | `{requestId}`; chuyển lượt live/chụp ảnh |
| Capture → server | `live_points` | `{revision, seq, points:[{id,x,y}], imageSize:{w,h}, fps}`; 1–4 điểm **vừa thấy**, không gửi điểm nhớ như mẫu mới |
| Capture → server | `live_status` | `{revision, seq, points:[], imageSize:{w,h}, fps}`; khung không có điểm mới, giữ nguyên bộ nhớ |
| Capture → server | `freeze` | `{revision, lastSeq, requestId}`; chốt median riêng của từng ID đã nhớ |
| Capture → server | `pause` | `{requestId}`; dừng luồng nhưng giữ phiên |
| Server → client | `connected` | snapshot `{sessionId, viewport, markers, revision, mode, result, peers}` |
| Server → client | `live_started`, `capture_started` | snapshot của lượt mới |
| Server → client | `live_points`, `live_status`, `peers` | tứ giác mới nhất đã gom, `detected`, `tracked`, `updatedIds`, thống kê/ghép đôi |
| Server → capture | `frame_ack` | `{seq, revision, ok, tracked, ready, sampleCounts, lastSeq, samples, reason?}`; `samples` là số quan sát tối thiểu giữa các ID, không phải điều kiện 15 khung |
| Server → client | `command_ack` | `{requestId, revision, ok, reason?}` |

Server xác thực và gom tọa độ theo ID, chuyển tứ giác mới nhất và tổng hợp median từng marker khi chốt; không nhận video hay tính homography. Worker điện thoại và trang máy tính đều kiểm tra phối cảnh. Live tích lũy dùng tọa độ mới nhất trực tiếp; chỉ ghi localStorage khi chốt.

## Điều hướng

- [Đặc tả chi tiết](<Đặc tả Trình hiển thị bù góc nhìn trên trình duyệt.md>): thiết kế toán học, giao thức và tiêu chí nghiệm thu.
- [client/display/index.html](client/display/index.html), [app.js](client/display/app.js), [style.css](client/display/style.css): trang máy tính, nội dung và điều khiển.
- [client/capture/](client/capture/): trang điện thoại; [camera.js](client/capture/camera.js) quản lý camera/backpressure, [vision-worker.js](client/capture/vision-worker.js) dò marker/QR. [client/common/connection.js](client/common/connection.js) nối lại phiên và xác nhận lệnh dùng chung.
- [client/capture/track-controls.js](client/capture/track-controls.js), [lens-ui.js](client/capture/lens-ui.js): điều khiển camera/zoom/focus theo capabilities; [shared/camera-settings.js](shared/camera-settings.js): dải/bước zoom, chọn camera và ánh xạ điểm lấy nét.
- [server/index.js](server/index.js): HTTP/WebSocket và hàng đợi ảnh; [protocol.js](server/protocol.js): lệnh live; [public-url.js](server/public-url.js): URL Codespaces; [sessions.js](server/sessions.js): vòng đời phiên.
- [shared/homography.js](shared/homography.js), [fitRect.js](shared/fitRect.js), [calibration.js](shared/calibration.js): module thuần dùng chung, không phụ thuộc DOM/Node.
- [shared/live.js](shared/live.js), [markers.js](shared/markers.js): nhịp xử lý, giới hạn quan sát, EMA cho gói cũ và tâm marker dùng chung.
- [shared/temporal-markers.js](shared/temporal-markers.js): bộ nhớ theo ID, tứ giác mới nhất và median từ các quan sát thật.
- [tests/](tests/README.md): kiểm thử toán, ảnh, API và trình duyệt.

Thư viện chính: [js-aruco2](https://github.com/damianofalcioni/js-aruco2), [jsQR](https://github.com/cozmo/jsQR), [Sharp](https://sharp.pixelplumbing.com/api-operation/), Express, ws, qrcode và html2canvas. Tất cả được phục vụ cục bộ; không cần CDN. `package-lock.json` khóa phiên bản để cài đặt lặp lại được.

## Hướng mở rộng

Dùng webcam theo dõi vị trí đầu/mắt và cập nhật phép biến đổi liên tục, giảm nhu cầu chụp lại khi người xem di chuyển. Hướng này cần bổ sung ước lượng vị trí mắt và hiệu chuẩn camera so với màn hình.
