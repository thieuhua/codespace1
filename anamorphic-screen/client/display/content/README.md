# Nội dung trên trình duyệt

Không có bước build. Chạy `npm start` từ thư mục dự án rồi mở `/`; thư viện trình duyệt lấy cục bộ qua server. Kiểm thử: `node --test tests/content-*.test.js`; trình duyệt: `npm run test:browser -- content.spec.js` (cần mở được cổng và có Chromium). Xem [README dự án](../../../README.md) cho thiết lập và nguồn hỗ trợ.

- `runtime.js`: registry `register(id, factory)`, `create(config) → {start({signal,onData,onStatus}), stop()}`. Gộp dữ liệu theo cửa sổ 80 ms cố định; bỏ callback của đời đã dừng, hủy nguồn khi abort, giữ dữ liệu hợp lệ khi lỗi. `push`/`status` nhận dữ liệu proxy đã đồng bộ; `lastGood` là bản phát gần nhất.
- `adapters/index.js`: nhập tay, JSON CORS, WebSocket, đồng hồ, iframe. RSS/HTML/JSON proxy nhận dữ liệu từ server, không tự mở thêm poller trình duyệt.
- `renderer.js`, `templates/`: chỉ dựng DOM bằng `textContent`, URL ảnh đã chuẩn hóa; iframe có sandbox rỗng. Ba mẫu: áp phích, danh sách trường, chữ lớn. Ảnh cục bộ chỉ truyền dưới dạng object URL, không đưa vào cấu hình hay server.
- `../app.js`: `renderFields` chỉ đổi nội dung; `measureLayout`, `updateWarp`, `saveSettings` xử lý bố cục/hiệu chuẩn riêng. `scheduleRaster` dùng bản sao không biến dạng, đợi font/ảnh tối đa 5 giây, không khởi động chồng lượt; khoảng cách tối thiểu 650 ms giữa hai lần bắt đầu. Không hủy canvas hiện tại khi feed mới đến.

## Viết adapter mới

1. Thêm ID và mô tả input vào `shared/content/schema.js`, bổ sung kiểm tra cấu hình và giới hạn cần thiết. UI chung đọc schema này.
2. Thêm factory trong `adapters/index.js` hoặc gọi `register(id, factory)` trước `create`. Factory nhận cấu hình đã kiểm tra và trả `start`/`stop`.
3. `start` nhận `signal`, `onData(fields)`, `onStatus({state, reason})`; chỉ phát trường đã map bằng `mapFields` hoặc dữ liệu nhập tay hợp lệ. Dùng `loading|ready|stale|error`. Runtime chuyển lỗi thành `stale` khi đã có dữ liệu tốt.
4. `stop` dọn timer/socket/listener; fetch phải nhận signal. Không sửa marker, calibration, transform hay localStorage. Không thực thi JS từ mapping.
5. Thêm kiểm thử vòng đời, burst, lỗi/khôi phục và callback đến sau stop trong `tests/content-runtime.test.js`. Nếu thêm mẫu, đăng ký trong schema/renderer và dùng `textContent` cho mọi trường.
