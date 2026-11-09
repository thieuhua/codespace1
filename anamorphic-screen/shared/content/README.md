# Hợp đồng nội dung dùng chung

`schema.js` định nghĩa adapter/input cho biểu mẫu hai thiết bị, ba mẫu hiển thị, cấu hình mẫu và validator. Cấu hình phiên có phiên bản `1`, `adapterId`, `config`, `templateId`, `fieldMap`, `contentRevision`; chỉ server tăng revision. `normalizeFields` giới hạn độ dài và chỉ cho ảnh HTTP(S).

`mapping.js` cung cấp JSON Pointer (không truy cập prototype), tên trường RSS/Atom không phân biệt hoa thường, bộ bước selector HTML đơn giản và formatter `trim`, `upper`, `date`, `number`. Selector không chạy trong DOM của nguồn; parser tĩnh server thực hiện các bước. Không dùng eval, Function hoặc mã tùy ý.

Không có thiết lập/build riêng. Kiểm thử từ thư mục dự án: `node --test tests/content-mapping.test.js tests/content-parsers.test.js`. Khi thêm adapter hoặc loại input, cập nhật schema, validator, [adapter trình duyệt](../../client/display/content/README.md) hoặc [adapter server](../../server/content/README.md), cùng fixture/test tương ứng.
