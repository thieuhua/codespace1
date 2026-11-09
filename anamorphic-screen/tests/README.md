# Kiểm thử Anamorphic Screen

Chạy các lệnh ở thư mục dự án sau `npm ci`:

```bash
npm test
npx playwright install chromium
npm run test:browser
```

Linux thiếu thư viện trình duyệt: `npx playwright install-deps chromium`. Playwright khởi động server kiểm thử riêng tại `127.0.0.1:3177`, tự dừng khi hoàn tất; cổng này cần trống. Ảnh chụp kiểm tra, trace và báo cáo lỗi nằm trong `test-results/` và không đưa vào Git.

## Nội dung

- `math.test.js`: validator dùng chung từ chối chân trời cắt viewport; Jacobian với shear 5°, xoay/scale đều, phối cảnh và đối chiếu sai phân hữu hạn; sai số homography < 1e-6 ở tọa độ pixel lớn, chuẩn hóa với offset lớn, nghịch đảo, ma trận CSS theo cột, từ chối suy biến, thứ tự marker và vùng nội dung không vượt tứ giác khi dịch tâm.
- `fixtures.js`: dựng marker ArUco thật vào ảnh raster rồi lấy mẫu qua homography camera biết trước; không giả lập đầu ra detector.
- `detection.test.js`: ảnh raster → dò marker → phép bù; cạnh nội dung sau chiếu lệch trục < 1 px, EXIF xoay, ảnh lật, ảnh trên 2000 px và fallback khi không thấy marker.
- `server.test.js`: HTTP/multipart và WebSocket thật, worker nhận diện thật, replay kết quả khi kết nối lại, chọn điểm sai/cũ, giới hạn 20 MiB, TTL và xóa phiên.
- `live.test.js`: URL Codespaces/PUBLIC_URL, EMA/median, quyền gửi luồng, ack, khung cũ, đổi viewport cùng phiên, mẫu thiếu/đổi kích thước/quá hạn và ảnh upload không được ghi đè lượt live mới.
- `protocol.test.js`: không mở cổng; tuổi từng ID, tái hiện khung trống sau 60 giây, cửa sổ tuổi tùy chỉnh, ACK chứa đúng median/số mẫu/dao động, kiểm tra chân trời live/chốt, chuyển tiếp `display_applied`, `sync` và trạng thái ghép đôi.
- `temporal-markers.test.js`: tuổi không đổi bởi khung trống, ngưỡng ổn định, dao động và gom bốn ID từ các khung riêng, giữ qua khung trống, thay đúng tọa độ vừa thấy, không đếm điểm nhớ thành mẫu mới, median theo ID và xóa khi ngữ cảnh camera/viewport đổi.
- `camera-settings.test.js`: chọn camera sau thường, zoom theo dải/bước thiết bị, bảo toàn zoom khi autofocus, gộp/tuần tự hóa yêu cầu, lỗi/cancel và tọa độ chạm lấy nét theo sensor.
- `browser/workflow.spec.js`: hai trang desktop/điện thoại, upload ảnh chụp trang có marker thật, overlay, thao tác chạm/hoàn tác, xác nhận, điều khiển, canvas 2×, lưu/khôi phục, resize/đổi DPR/thoát fullscreen và mất mạng/kết nối lại.
- `browser/live.spec.js`: video camera Y4M giả lập → `getUserMedia` thật → worker ArUco thật → WebSocket → live/chốt/hiệu chỉnh lại, không upload ảnh; kiểm tra một lượt đang xử lý, refresh cả hai thiết bị, nối lại mạng, jsQR thật khi không có BarcodeDetector và giữ warp khi chân trời cắt viewport. `fake-camera.js` chỉ thay phần cứng camera bằng video sinh từ ảnh tổng hợp, không giả đầu ra detector.
- Có video mỗi khung chỉ chứa **một marker**, rồi một đoạn hoàn toàn trống: phải gom đủ 4, cập nhật màn hình và chốt được khi từng ID còn mới/ổn định dù chưa từng dò đủ bốn ID cùng khung. Kiểm thử cũng đối chiếu tọa độ CSS với tứ giác mới nhất sau khi chỉ cập nhật một ID, để phát hiện việc vẫn render khung cũ/EMA.
- Browser còn kiểm tra bộ chọn ảnh bằng Enter, giữ 3 marker và chỉ đặt ID thiếu, xác nhận desktop đã áp dụng, cảnh báo HTTP trước QR và trợ giúp phím tắt.
- `browser/lens.spec.js`: video/worker thật cùng capabilities và phần cứng lens giả lập; chọn camera, đổi/nhớ zoom, autofocus/chạm/chỉnh tay, xóa mẫu sau đổi thiết lập và fallback khi API không có. Test xác minh yêu cầu API và luồng ứng dụng, không đo độ nét quang học của điện thoại.

Các test trình duyệt tự động dùng **Chromium**, điện thoại là viewport có mô phỏng cảm ứng/video camera giả lập. Chưa xác minh Safari/Firefox hoặc camera thật. Số liệu tổng hợp không thay thế tỷ lệ nhận diện 9/10 ảnh thực tế hay đảm bảo 10–15 fps trên mọi điện thoại. Video/ảnh/trace sinh ra trong `test-results/`, không đưa vào Git.

Nếu sandbox chặn TCP bằng `listen EPERM`, báo lỗi môi trường ở `live.test.js`/`server.test.js`, không bỏ kiểm tra hoặc sửa server để lách. Có thể chạy riêng bộ không mở cổng:

```bash
node --test tests/math.test.js tests/detection.test.js tests/camera-settings.test.js tests/temporal-markers.test.js tests/protocol.test.js
```

Browser spec cần mở được cổng và khởi chạy được Chromium đã cài; nếu không, ghi rõ chưa chạy, không cài thêm trong phiên kiểm tra.

## Nghiệm thu với phần cứng

1. Chạy server trên máy tính, mở trang qua LAN và bật fullscreen trước khi chụp. Dùng điện thoại cùng Wi-Fi, ống kính chính 1×, camera đúng chỗ mắt.
2. Dùng HTTPS (ví dụ URL cổng Public Codespaces) cho camera trực tiếp. Đặt góc nhìn lệch ngang khoảng 45°, ghép QR bằng camera hệ thống và `/capture?scan=1`, cho phép camera sau, giữ 1× và đủ bốn marker.
3. Giữ camera cố định, che lần lượt các marker để không khung nào thấy đủ bốn ID. Số **đã nhớ** phải tăng đến 4/4; mỗi ID cần ít nhất 3 mẫu/dao động ≤ 4 px để nút Chốt bật. Từng tọa độ mới cập nhật màn hình, mất dấu không xóa điểm; quá 3 giây không thấy một ID thì Chốt phải tắt và báo ID cũ. Quan sát lại rồi chốt; điện thoại chỉ báo đã áp dụng sau xác nhận từ desktop. Thử xóa điểm, hiệu chỉnh lại, đổi lens/zoom/focus, refresh/mất mạng và resize; phiên/QR giữ nguyên. Thử từ chối quyền camera và luồng upload/chạm tay.
4. Bật lưới debug, chụp lại từ cùng vị trí. Đo cạnh nội dung song song trục ảnh trong 1°; thử chữ chính 24 px và ghi lại có đọc được không.
5. Lặp lại 10 ảnh dưới ánh sáng phòng, ghi số lần nhận diện tự động (mục tiêu ≥ 9/10), thời gian hiệu chuẩn (< 60 giây) và fps live đo được. Kiểm tra Chrome/Edge/Firefox trên máy tính, Safari/Chrome trên điện thoại thật.

Các tiêu chí ở phần này chưa thể kết luận từ môi trường Codespaces. Xem [README dự án](../README.md) để chạy trong LAN.
