# Kiểm thử Anamorphic Screen

Chạy các lệnh ở thư mục dự án sau `npm ci`:

```bash
npm test
npx playwright install chromium
npm run test:browser
```

Linux thiếu thư viện trình duyệt: `npx playwright install-deps chromium`. Playwright khởi động server kiểm thử riêng tại `127.0.0.1:3177`, tự dừng khi hoàn tất; cổng này cần trống. Ảnh chụp kiểm tra, trace và báo cáo lỗi nằm trong `test-results/` và không đưa vào Git.

## Nội dung

- `math.test.js`: sai số homography < 1e-6 ở tọa độ pixel lớn, chuẩn hóa với offset lớn, nghịch đảo, ma trận CSS theo cột, từ chối suy biến, thứ tự marker và vùng nội dung không vượt tứ giác khi dịch tâm.
- `fixtures.js`: dựng marker ArUco thật vào ảnh raster rồi lấy mẫu qua homography camera biết trước; không giả lập đầu ra detector.
- `detection.test.js`: ảnh raster → dò marker → phép bù; cạnh nội dung sau chiếu lệch trục < 1 px, EXIF xoay, ảnh lật, ảnh trên 2000 px và fallback khi không thấy marker.
- `server.test.js`: HTTP/multipart và WebSocket thật, worker nhận diện thật, replay kết quả khi kết nối lại, chọn điểm sai/cũ, giới hạn 20 MiB, TTL và xóa phiên.
- `browser/workflow.spec.js`: hai trang desktop/điện thoại, upload ảnh chụp trang có marker thật, overlay, thao tác chạm/hoàn tác, xác nhận, điều khiển, canvas 2×, lưu/khôi phục, resize/đổi DPR/thoát fullscreen và mất mạng/kết nối lại.

Các test trình duyệt tự động dùng **Chromium**, điện thoại là viewport có mô phỏng cảm ứng. Chưa xác minh Safari/Firefox hoặc camera thật. Số liệu ảnh tổng hợp không thay thế tỷ lệ nhận diện 9/10 ảnh thực tế.

## Nghiệm thu với phần cứng

1. Chạy server trên máy tính, mở trang qua LAN và bật fullscreen trước khi chụp. Dùng điện thoại cùng Wi-Fi, ống kính chính 1×, camera đúng chỗ mắt.
2. Đặt góc nhìn lệch ngang khoảng 45°. Quét QR, chụp đủ bốn marker, kiểm tra các tâm nhận diện và xác nhận.
3. Bật lưới debug, chụp lại từ cùng vị trí. Đo cạnh nội dung song song trục ảnh trong 1°; thử chữ chính 24 px và ghi lại có đọc được không.
4. Lặp lại 10 ảnh dưới ánh sáng phòng, ghi số lần nhận diện tự động (mục tiêu ≥ 9/10) và thời gian từ mở trang đến hiệu chuẩn (mục tiêu < 60 giây).
5. Thử chọn tay với kính lúp, ảnh chụp dọc/ngang, đổi chỗ mắt, resize/thoát fullscreen và ngắt Wi-Fi rồi kết nối lại. Kiểm tra thêm Chrome/Edge/Firefox trên máy tính và Safari/Chrome trên điện thoại thật.

Các tiêu chí ở phần này chưa thể kết luận từ môi trường Codespaces. Xem [README dự án](../README.md) để chạy trong LAN.
