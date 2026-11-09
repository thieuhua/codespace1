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
- `accuracy.test.js`: ảnh góc mờ/xoay có tọa độ phân số, subpix giảm RMS 1,431 → 0,165 px; 80 lần nhiễu Gaussian 0,6 px/điểm cho RMS chiếu lưới 0,703 → 0,355 px (4 tâm → 16 góc). Tâm trong phép so sánh là phép đo độc lập có cùng mức nhiễu, không phải trung bình bốn góc. Kiểm tra loại cả marker lệch, fallback tâm, biên đen, góc xoay, căn cạnh trên; tối ưu tâm nằm trong tứ giác ở hai chiều đỉnh và diện tích ≥ mặc định (tăng tối đa 153,6% trong bộ mẫu).
- `fixtures.js`: dựng SVG ArUco thật với đúng kích thước/tâm phân số như CSS, lấy mẫu qua homography camera biết trước; thêm ảnh góc khử răng cưa/làm mờ. Không giả lập đầu ra detector.
- `detection.test.js`: ảnh raster → dò/tinh chỉnh 16 góc → phép bù; cạnh nội dung lệch trục < 1 px. ROI 1280 px giảm RMS góc 0,526 → 0,153 px trong khung 640 px, gộp không lặp ID, cứu marker bị mất ở lượt thô; ảnh trống không sinh quan sát từ bộ nhớ. Có EXIF xoay, ảnh lật, ảnh trên 2000 px và fallback.
- `camera-pipeline.test.js`: lớp Camera thật với canvas/video và độ trễ worker/ACK giả; không chồng tác vụ khi worker/mạng chậm, giữ chu kỳ tối thiểu 80 ms, khung 640 và chi tiết 1280 lấy cùng ảnh, xóa ROI sau reset.
- `server.test.js`: HTTP/multipart và WebSocket thật, worker nhận diện thật, replay kết quả khi kết nối lại, chọn điểm sai/cũ, giới hạn 20 MiB, TTL và xóa phiên.
- `live.test.js`: URL Codespaces/PUBLIC_URL, EMA/median, quyền gửi luồng, ack, khung cũ, đổi viewport cùng phiên, mẫu thiếu/đổi kích thước/quá hạn và ảnh upload không được ghi đè lượt live mới.
- `protocol.test.js`: không mở cổng; tuổi từng ID, khung trống sau 60 giây, ACK chứa đúng median tâm/từng góc, relay/chốt/snapshot giữ góc và thống kê ms/RMS, RMS > 2 px chặn chốt, loại ngoại lai và fallback client cũ; chân trời live/chốt, `display_applied`, `sync`, ghép đôi.
- `temporal-markers.test.js`: tuổi không đổi bởi khung trống, ngưỡng ổn định, dao động và gom bốn ID từ các khung riêng, giữ qua khung trống, thay đúng tọa độ vừa thấy, không đếm điểm nhớ thành mẫu mới, median theo ID và xóa khi ngữ cảnh camera/viewport đổi.
- `camera-settings.test.js`: chọn camera sau thường, zoom theo dải/bước thiết bị, bảo toàn zoom khi autofocus, gộp/tuần tự hóa yêu cầu, lỗi/cancel và tọa độ chạm lấy nét theo sensor.
- `content-*.test.js`: schema/mapping/formatter, IP/DNS/redirect và deadline qua resolver/transport giả; fixture RSS/Atom/HTML trong `fixtures/`; vòng đời adapter, burst, hủy, giữ dữ liệu cũ, DOM không phân tích XSS, chờ font/ảnh, quyền HTTP/WS nội dung, khóa API có origin, poller và revision hiệu chuẩn không đổi. Bộ này không dùng mạng hay mở cổng.
- `browser/content.spec.js`: nội dung nhập tay/JSON/đồng hồ/iframe, XSS, điện thoại có token từ fragment, lưu/đồng bộ, giữ bản hiệu chuẩn và canvas 2× có throttle trong feed liên tục. Nguồn bên ngoài được chặn bằng route/factory giả; API/WS phiên và DOM/canvas chạy thật.
- `browser/workflow.spec.js`: hai trang desktop/điện thoại, upload ảnh chụp trang có marker thật, overlay, thao tác chạm/hoàn tác, xác nhận, điều khiển, canvas 2×, lưu/khôi phục, resize/đổi DPR/thoát fullscreen và mất mạng/kết nối lại.
- `browser/live.spec.js`: video camera Y4M 1280 px → worker toàn khung/ROI → WebSocket → live/chốt/hiệu chỉnh lại; kiểm tra ms/RMS và 16 góc sau chốt, một lượt đang xử lý, refresh, nối lại, jsQR và chân trời. `fake-camera.js` chỉ thay phần cứng camera bằng video tổng hợp. `browser/workflow.spec.js` còn kiểm tra hai tùy chọn tâm/căn cạnh mặc định tắt và được nhớ sau tải lại.
- Có video mỗi khung chỉ chứa **một marker**, rồi một đoạn hoàn toàn trống: phải gom đủ 4, cập nhật màn hình và chốt được khi từng ID còn mới/ổn định dù chưa từng dò đủ bốn ID cùng khung. Kiểm thử cũng đối chiếu tọa độ CSS với tứ giác mới nhất sau khi chỉ cập nhật một ID, để phát hiện việc vẫn render khung cũ/EMA.
- Browser còn kiểm tra bộ chọn ảnh bằng Enter, giữ 3 marker và chỉ đặt ID thiếu, xác nhận desktop đã áp dụng, cảnh báo HTTP trước QR và trợ giúp phím tắt.
- `browser/lens.spec.js`: video/worker thật cùng capabilities và phần cứng lens giả lập; chọn camera, đổi/nhớ zoom, autofocus/chạm/chỉnh tay, xóa mẫu sau đổi thiết lập và fallback khi API không có. Test xác minh yêu cầu API và luồng ứng dụng, không đo độ nét quang học của điện thoại.

Các test trình duyệt tự động dùng **Chromium**, điện thoại là viewport có mô phỏng cảm ứng/video camera giả lập. Chưa xác minh Safari/Firefox hoặc camera thật. Số liệu tổng hợp không thay thế tỷ lệ nhận diện 9/10 ảnh thực tế hay đảm bảo 10–15 fps trên mọi điện thoại. Video/ảnh/trace sinh ra trong `test-results/`, không đưa vào Git.

Nếu sandbox chặn TCP bằng `listen EPERM`, báo lỗi môi trường ở `live.test.js`/`server.test.js`, không bỏ kiểm tra hoặc sửa server để lách. Có thể chạy riêng bộ không mở cổng:

```bash
node --test --test-isolation=none tests/content-*.test.js tests/math.test.js tests/accuracy.test.js tests/detection.test.js tests/camera-settings.test.js tests/camera-pipeline.test.js tests/temporal-markers.test.js tests/protocol.test.js
```

Browser spec cần mở được cổng và khởi chạy được Chromium đã cài; nếu không, ghi rõ chưa chạy, không cài thêm trong phiên kiểm tra.

Các số RMS trên là kết quả xác định của ảnh tổng hợp, không phải cam kết độ chính xác camera thật. `--test-isolation=none` (Node hỗ trợ) giúp hiện từng ca test khi môi trường chỉ xuất tóm tắt theo tệp.

## Nghiệm thu với phần cứng

1. Chạy server trên máy tính, mở trang qua LAN và bật fullscreen trước khi chụp. Dùng điện thoại cùng Wi-Fi, ống kính chính 1×, camera đúng chỗ mắt.
2. Dùng HTTPS (ví dụ URL cổng Public Codespaces) cho camera trực tiếp. Đặt góc nhìn lệch ngang khoảng 45°, ghép QR bằng camera hệ thống và `/capture?scan=1`, cho phép camera sau, giữ 1× và đủ bốn marker.
3. Giữ camera cố định, che lần lượt các marker để không khung nào thấy đủ bốn ID. Số **đã nhớ** phải tăng đến 4/4; mỗi ID cần ít nhất 3 mẫu/dao động ≤ 4 px để nút Chốt bật. Từng tọa độ mới cập nhật màn hình, mất dấu không xóa điểm; quá 3 giây không thấy một ID thì Chốt phải tắt và báo ID cũ. Quan sát lại rồi chốt; điện thoại chỉ báo đã áp dụng sau xác nhận từ desktop. Thử xóa điểm, hiệu chỉnh lại, đổi lens/zoom/focus, refresh/mất mạng và resize; phiên/QR giữ nguyên. Thử từ chối quyền camera và luồng upload/chạm tay.
4. Bật lưới debug, chụp lại từ cùng vị trí. Đo cạnh nội dung song song trục ảnh trong 1°; thử chữ chính 24 px và ghi lại có đọc được không.
5. Lặp lại 10 ảnh dưới ánh sáng phòng, ghi số lần nhận diện tự động (mục tiêu ≥ 9/10), thời gian hiệu chuẩn (< 60 giây) và fps live đo được. Kiểm tra Chrome/Edge/Firefox trên máy tính, Safari/Chrome trên điện thoại thật.

Các tiêu chí ở phần này chưa thể kết luận từ môi trường Codespaces. Xem [README dự án](../README.md) để chạy trong LAN.
