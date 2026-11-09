# Proxy nội dung và vòng đời phiên

Chạy `npm start` tại thư mục dự án; không cần build/dependency mới. Chạy `node --test tests/content-*.test.js` để kiểm thử không mở cổng, DNS/transport được tiêm giả lập. Xem [README dự án](../../README.md) cho API, biến môi trường và ghép quyền điều khiển.

- `safe-fetch.js`: HTTP(S), cổng cho phép, DNS toàn bộ địa chỉ, `node:net` BlockList/isIP, ghim IP qua `lookup`, tối đa 3 redirect đều kiểm tra lại, deadline 8 giây (kể cả DNS), body 2 MiB và Content-Type theo adapter. Header có khóa không theo redirect khác origin. Không tự giải nén body.
- `routes.js`: xác thực token, giới hạn theo phiên, preview không đổi cấu hình, ghi có `contentRevision`, một poller/phiên. Poll không chồng nhau, tối thiểu 15 giây; lỗi giữ dữ liệu tốt. Đổi nguồn, hết hạn/xóa phiên hoặc đóng ứng dụng hủy poller và bỏ kết quả trễ. `server/index.js` nối vòng đời này với SessionStore và WS.
- `adapters/`: JSON; RSS 2.0/Atom theo mục N; HTML tĩnh với selector đơn giản. `markup.js` là parser giới hạn, không phải trình duyệt HTML5 và không chạy JS; XML từ chối DOCTYPE/entity. HTML hỏng hoặc trang cần JavaScript có thể không trích xuất được như mong muốn.

`CONTENT_ALLOW_HOSTS=bangtin.lan` chỉ miễn chặn IP cho đúng host đó (không wildcard); mọi hop khác vẫn kiểm tra. `CONTENT_ALLOW_PORTS=80,443,8080` thay danh sách cổng mặc định `80,443`. Khóa API chỉ nằm trong `session.contentSecrets`, có tên và origin, không đưa vào snapshot/cấu hình/QR. Lưu khóa yêu cầu cả controller token và khóa riêng tab máy tính; chỉ cho phép các header API được liệt kê.

## Viết adapter proxy mới

1. Khai báo ID/input, validation và `isServerSource` trong `shared/content/schema.js`.
2. Thêm parser thuần tại `adapters/`; giới hạn kích thước/cấu trúc, không chạy JS, không tự tải URL hoặc entity phụ.
3. Đăng ký Content-Type, parser và kiểu mapping trong `routes.js:preview`; mọi tải mạng phải qua `safeFetch`. URL tương đối của trường ảnh được giải theo URL cuối sau redirect.
4. Tái sử dụng poller/ủy quyền hiện có; không tạo timer riêng hoặc ghi vào revision hiệu chuẩn. Dùng secret có tên và không đưa giá trị vào lỗi/trạng thái.
5. Thêm fixture/parser test và kiểm thử hủy/ghi cũ/quyền trong `tests/content-*.test.js`; DNS/redirect test luôn dùng resolver và transport giả, không gọi mạng.
