# Anamorphic Screen — Trình hiển thị tự bù góc nhìn

Ứng dụng web hiển thị chữ hoặc hình ảnh đơn giản trên màn hình máy tính, biến dạng trước nội dung để người nhìn từ một góc nghiêng cố định thấy chữ thẳng và hình chữ nhật đúng dáng như khi nhìn chính diện.

**Trạng thái:** đã có ghép đôi bền vững, camera live nhớ marker qua nhiều khung, chốt theo từng marker, phương án chụp ảnh/chạm tay và nội dung qua adapter. Chạy bằng Node.js và JavaScript thuần. Các tiêu chí quang học trên màn hình/điện thoại thật vẫn cần kiểm chứng.

## Luồng sử dụng

1. Mở trang hiển thị trên máy tính và bật toàn màn hình. Quét QR bằng camera hệ thống, hoặc mở `/capture?scan=1` trên điện thoại để quét ngay trong web.
2. Cho phép camera sau. Dùng ống kính chính 1×, giữ camera cố định tại vị trí mắt. Bốn marker không cần được dò thành công trong cùng một khung hình.

   Trong phần camera, chọn đúng **Camera đang dùng** nếu điện thoại có nhiều ống kính. Ứng dụng ưu tiên camera sau góc rộng thông thường khi nhận ra tên thiết bị; lựa chọn của bạn được nhớ cho lần mở sau. Zoom có thanh chỉnh và các mức nhanh theo dải thiết bị hỗ trợ, hiển thị giá trị camera báo lại và nhớ riêng theo camera, không ép về 1× khi mở lại. Mức 1× tính theo camera đã chọn, có thể khác giữa các ống kính.

   Lấy nét mặc định ưu tiên **Tự động liên tục**. Có nút **Lấy nét lại**, chạm vào ảnh để chọn điểm lấy nét và **Chỉnh tay** khi camera/trình duyệt cung cấp các API tương ứng. Chức năng không hỗ trợ sẽ được ghi rõ; có thể dùng camera hệ thống qua **Chụp ảnh bằng camera hệ thống**. Đổi camera/zoom/lấy nét xóa bộ nhớ marker trong cùng phiên để không trộn hai cấu hình.

3. Điện thoại luôn dò toàn khung ở cạnh dài tối đa 640 px. Khi đã thấy marker, worker dò thêm vùng quanh các góc đã nhớ, lấy từ cùng khung camera ở độ phân giải tương đương tối đa 1280 px; kết quả ROI được ưu tiên và gộp theo ID. Mỗi lượt cách nhau ít nhất 80 ms, đợi cả worker và ACK server, không xếp hàng video. Hai trang hiện thời gian dò (ms). Khung chỉ thấy 1–2 marker vẫn góp điểm; khung trống không xóa bộ nhớ hay tạo mẫu mới. Chỉ tọa độ vừa dò được đi qua mạng.
4. Khi đã nhớ đủ bốn ID, máy tính render ngay tứ giác mới nhất sau mỗi lần có điểm cập nhật. Không chờ một khung có đủ bốn marker hay bộ 15 khung hoàn chỉnh, không dùng EMA để kéo các góc chưa thấy sang vị trí khác. Phối cảnh không hợp lệ giữ bản hiển thị hợp lệ gần nhất. Cả hai trang phân biệt **số marker vừa thấy** và **số marker đã nhớ**; điểm vừa thấy được tô sáng, điểm cũ có viền.
5. Điện thoại phân biệt **đủ điểm** với **ổn định**: mỗi ID cần ít nhất 3 mẫu, dao động tâm/góc ≤ 4 px, tuổi ≤ 3000 ms và RMS chiếu lại ≤ 2 px để bật **Chốt**. Tuổi, số mẫu và độ dao động (khoảng cách lớn nhất giữa tối đa 15 quan sát thật gần nhất, theo pixel khung dò) hiện riêng từng ID. Server chốt median riêng từng tọa độ tâm và từng góc của cửa sổ mẫu trong ACK; khung trống không làm điểm mới hơn hay tăng mẫu. ID được thấy lại sau khi quá hạn bắt đầu cửa sổ mẫu mới. Server vẫn nhận lệnh chốt từ client cũ với ít mẫu nếu cả bốn ID còn mới và phối cảnh hợp lệ; lỗi nêu rõ ID quá cũ. Máy tính gửi xác nhận áp dụng hoặc từ chối về điện thoại; chỉ báo thành công khi đã được máy tính xác nhận.
6. **Hiệu chỉnh lại** trên một trong hai thiết bị đưa màn hình về live trong cùng phiên. Sau khi đã được cấp quyền, điện thoại mở lại camera; không cần đổi QR hay quét lại. Tạm dừng camera cũng giữ ghép đôi.

Nếu đã di chuyển camera khi gom điểm, dùng **Xóa điểm đã nhớ** để gom lại; nút này giữ nguyên phiên/QR. Bộ nhớ điểm không phải optical flow và không ước lượng chuyển động giữa các khung, vì vậy cần giữ camera ổn định khi đang tích lũy marker.

Nếu không mở được camera trực tiếp hoặc dò thiếu marker, chọn **Dùng chụp ảnh / chạm tay**. Ảnh gốc được upload, server dò marker; giữ lại 1–3 marker đã dò để chỉ đặt các điểm còn thiếu, có kính lúp, hoàn tác và chọn ảnh bằng bàn phím. Bảng camera/zoom/lấy nét nằm trong mục **Nâng cao** có thể thu gọn. Luồng này vẫn chạy trên HTTP LAN.

Góc nhìn được khóa sau lần chụp. Đổi chỗ ngồi hoặc thay đổi kích thước vùng hiển thị thì cần hiệu chuẩn lại. Kết quả chỉ được dùng lại khi vị trí mắt, màn hình và cấu hình hiển thị vẫn phù hợp.

## Tính năng đã triển khai

- Một màn hình phẳng, một điểm nhìn cố định; nội dung gồm trường chữ, ảnh URL và các nguồn cập nhật qua adapter.
- Trang máy tính hiển thị marker, QR, nội dung đã biến dạng và điều khiển hiệu chuẩn.
- Trang điện thoại chụp/gửi ảnh, xem kết quả nhận diện và hỗ trợ chọn marker thủ công.
- Server quản lý phiên và chuyển tiếp điểm qua WebSocket; chỉ giải mã/dò ảnh khi dùng luồng upload dự phòng.
- Homography chuẩn hóa Hartley: DLT bình phương tối thiểu cho tối đa 16 góc, trị riêng Jacobi và loại ngoại lai theo marker; dự phòng khử Gauss bốn tâm cho client cũ/chạm tay. Từ chối suy biến và chuyển sang `matrix3d` ở phía trang hiển thị.
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

**Điều khiển:** nút **?** trên thanh công cụ hoặc phím `?` mở trợ giúp; rê chuột để hiện thanh công cụ; `C` mở tùy chỉnh, `W` bật/tắt bù, `D` hiện lưới và đường bao, `F` bật/tắt fullscreen. **Xem nội dung mẫu** cho phép thử các điều khiển trước khi hiệu chuẩn. Đổi nội dung bằng bảng **Nội dung**. Ảnh chọn bằng **Chọn ảnh tĩnh** chỉ dùng với nguồn nhập tay, được đọc cục bộ, không gửi lên server và không lưu sau khi tải lại trang.

## Nguồn nội dung và đồng bộ

Trên máy tính chọn **Nội dung → nguồn → cấu hình → Thử → Ánh xạ trường → mẫu hiển thị → Áp dụng**. **Thử** chỉ xem dữ liệu, không đổi màn hình. Nút **Dùng nội dung mẫu** điền lại cấu hình nhập tay; bấm **Áp dụng** để dùng. Điện thoại có mục **Nội dung** thu gọn sau phần hiệu chuẩn, dùng cùng schema/biểu mẫu. Đổi trường hoặc nguồn không đổi marker, revision live, phép bù hay bản lưu hiệu chuẩn.

| Adapter | Cấu hình / giới hạn |
| --- | --- |
| `manual` | Nhập trường chữ/URL ảnh; giữ bộ chọn ảnh cục bộ trên máy tính. |
| `json` | URL JSON công khai có CORS; chu kỳ ≥ 5 giây. Bật **Lấy qua server** nếu cần proxy hoặc khóa có tên; khi đó chu kỳ ≥ 15 giây. |
| `websocket` | URL `ws:`/`wss:` công khai, mỗi thông điệp là JSON ≤ 2 MiB; tự nối lại. Trang HTTPS cần `wss:`. |
| `clock` | Đồng hồ/ngày trên thiết bị hiển thị, không cần mạng. |
| `rss` | RSS 2.0 / Atom qua server, chọn mục từ 0, chu kỳ ≥ 15 giây. |
| `html` | Trích xuất HTML tĩnh qua server, chu kỳ ≥ 15 giây; không chạy JavaScript nguồn. |
| `iframe` | Nhúng tài liệu trong iframe sandbox, không canvas 2×. Website có thể chặn bằng CSP/X-Frame-Options; không thể trích xuất hay xác nhận đã tải từ tài liệu khác origin. |

Ba mẫu là **Áp phích** (`title`, `description`, `kicker`, `footer`, `image`), **Danh sách trường** (nhãn/giá trị theo mapping), **Chữ lớn** (`title` hoặc trường đầu có dữ liệu). Loại trường `text` tối đa 2.000 ký tự, `multiline` 10.000, `imageUrl` 2.048; tối đa 24 trường. Có thể đặt `maxLength` nhỏ hơn. Chữ luôn đi qua `textContent`, ảnh chỉ nhận HTTP(S) và tắt referrer; ảnh từ xa cần CORS để dùng trên canvas. Nội dung cập nhật dồn được gộp, lỗi giữ dữ liệu hợp lệ gần nhất; thanh công cụ báo đang tải / sẵn sàng / dữ liệu cũ / lỗi nguồn. Canvas 2× đợi font/ảnh có thời hạn, giới hạn khoảng 1–2 lượt/giây, cửa sổ chờ cố định không bị feed nhanh đẩy lùi; giữ canvas cũ đến khi canvas mới sẵn sàng.

Ánh xạ là JSON, không thực thi mã. JSON dùng JSON Pointer (`/items/0/title`, `~1` cho `/`, `~0` cho `~`); RSS/Atom dùng tên phần tử trong item/entry (`title`, `pubDate`, `summary`, `content:encoded`; không phân biệt hoa thường). HTML hỗ trợ tag, `#id`, `.class`, `[name=value]`, hậu duệ và `>`; lấy phần tử khớp đầu tiên, không hỗ trợ pseudo-selector/comma. Thuộc tính trích xuất: `src`, `href`, `content`, `datetime`, `title`. Bộ định dạng chỉ có `trim`, `upper`, `date` (UTC, định dạng Việt Nam), `number`. Ví dụ JSON:

```json
{
  "title": { "source": "/items/0/title", "type": "multiline", "formatters": ["trim"] },
  "image": { "source": "/items/0/image", "type": "imageUrl" }
}
```

Server giữ `{version, adapterId, config, templateId, fieldMap, contentRevision}` trong RAM cho từng phiên; máy tính lưu riêng tại `anamorphic:content:v1`. Hiệu chuẩn tiếp tục dùng khóa riêng theo viewport. Cấu hình có revision để từ chối ghi đè bản đã đổi trên thiết bị khác. Nguồn server có đúng một poller mỗi phiên, dừng khi phiên bị xóa/hết hạn; snapshot/WS khôi phục cấu hình và dữ liệu gần nhất.

Tạo phiên trả `controllerToken` cho máy tính. QR/đường dẫn chuyển quyền sửa qua fragment `#k=…`; fragment không nằm trong URL yêu cầu HTTP, QR được tạo bằng POST để khóa không vào query log. Hai thiết bị chỉ nhớ quyền trong `sessionStorage` của tab, không trong localStorage; điện thoại xóa fragment khỏi thanh địa chỉ sau khi nhận. Ai có đường dẫn này có quyền đổi nội dung. Nếu đóng tab làm mất quyền trong khi phiên còn được nhớ, bảng Nội dung trên máy tính có nút tạo phiên mới để lấy quyền và ghép lại điện thoại.

Khóa API/header nguồn nhập tại **JSON/RSS/HTML → Nhập khóa nguồn vào RAM server** trên tab máy tính tạo phiên. Khóa có tên, gắn với origin; cấu hình chỉ lưu `secretRef`, không lưu giá trị. JSON dùng khóa cần bật **Lấy qua server**. Không nhập khóa vào URL hay trường nội dung. Header cho phép: `Authorization`, `X-Api-Key`, `Api-Key`; server không gửi khóa sang origin chuyển hướng khác. Giá trị khóa không nằm trong localStorage, QR hay snapshot, mất khi phiên/server kết thúc.

### Proxy và cấu hình mạng

Proxy chỉ nhận HTTP(S), mặc định cổng 80/443; DNS được kiểm tra toàn bộ địa chỉ, chặn loopback, mạng riêng, link-local, CGNAT, multicast, metadata, IPv6 ULA/`::1` và các dải không công khai. Mỗi hop chuyển hướng (tối đa 3) được kiểm tra lại và request ghim IP đã phân giải bằng `lookup` để chống DNS rebinding. Tổng thời gian ≤ 8 giây, body ≤ 2 MiB, kiểm tra Content-Type theo adapter; không nhận body nén. XML không cho DOCTYPE/entity, parser giới hạn độ sâu/số phần tử. Preview giới hạn 10 lượt/phút/phiên, cấu hình 20, lưu khóa 5.

`CONTENT_ALLOW_HOSTS` là ngoại lệ **tên host chính xác**, phân tách dấu phẩy, cho nguồn nội bộ bạn chủ động tin cậy; không wildcard. Ngoại lệ bỏ chặn dải IP cho host đó, vẫn kiểm tra giao thức/cổng/chuyển hướng/thời gian/kích thước. `CONTENT_ALLOW_PORTS` thay danh sách cổng proxy được phép. Không cấu hình ngoại lệ rộng cho nguồn không tin cậy. Các kiểm tra DNS/IP này áp dụng cho proxy server; nguồn JSON/WebSocket trực tiếp và ảnh/iframe chạy trong trình duyệt, theo CORS/chính sách của trình duyệt.

```bash
CONTENT_ALLOW_HOSTS=bangtin.lan CONTENT_ALLOW_PORTS=80,443,8080 npm start
```

API nội dung: `GET/PUT /api/session/:id/content/config`, `POST /api/session/:id/content/preview`, `PUT /api/session/:id/content/secrets`. Ghi/preview cần header `X-Controller-Token`; lưu khóa cần thêm `X-Content-Display-Key` chỉ trả lúc tạo phiên. WebSocket bổ sung `content_config` (lệnh có token và `contentConfig`), `content_data` (`fields`, `contentRevision`) và `content_status` (`state`, `reason`, `contentRevision`). Máy tính báo trạng thái nguồn chạy tại trình duyệt về server để điện thoại theo dõi.

```bash
npm test                         # Toán học, ảnh tổng hợp và HTTP/WebSocket thật
npx playwright install chromium # Một lần cho kiểm thử trình duyệt
# Linux thiếu thư viện hệ thống: npx playwright install-deps chromium
npm run test:browser             # Luồng desktop + điện thoại cảm ứng giả lập bằng Chromium
```

Xem [hướng dẫn kiểm thử](tests/README.md) để hiểu dữ liệu tổng hợp, giới hạn xác minh và quy trình nghiệm thu thực tế. Không cần bước build; CSS, ES modules và các thư viện trình duyệt đều được phục vụ từ server, không cần CDN.

## Phiên, ảnh và API

- Phiên/preview chỉ nằm trong RAM, **không hết hạn khi còn WebSocket mở** ở bất kỳ thiết bị nào. Sau khi socket cuối cùng đóng, có 15 phút để nối lại. Restart server xóa phiên và cần ghép lại; bản hiệu chuẩn đã chốt trong localStorage vẫn hiển thị được.
- Tối đa 40 phiên; 1 ảnh đang xử lý mỗi phiên; hàng đợi dò toàn server tối đa 4 ảnh chờ, mỗi tác vụ tối đa 30 giây. Client chờ upload tối đa 180 giây, hiện vị trí xếp hàng và đồng bộ snapshot/kết quả qua WebSocket nếu HTTP hết thời gian chờ. Dò ArUco chạy trong worker thread để không chặn HTTP/WebSocket.
- Upload tối đa **20 MiB**, giải mã tối đa **64 triệu pixel**. JPEG/PNG/WebP được hỗ trợ; HEIF/AVIF/TIFF tùy codec của Sharp. Nếu HEIC không đọc được, chọn JPEG/PNG. Server không giữ ảnh gốc; chỉ giữ preview JPEG tối đa 2000 px cùng tọa độ theo ảnh gốc đã xử lý EXIF.
- Dùng từ điển ArUco **ARUCO (5×5)**, ID `17, 42, 73, 99`, tương ứng nhãn **1, 2, 3, 4** theo chiều kim đồng hồ từ trên trái. Tâm marker được lấy bằng giao hai đường chéo để tránh sai số phối cảnh của trung bình bốn góc.
- Mặc định hình chữ nhật đích có tâm tại trung bình bốn đỉnh viewport chiếu lên ảnh; tìm kích thước lớn nhất ở tâm đó rồi nhân hệ số 0,9, giữ hành vi đặc tả. **Tối ưu tâm để tăng diện tích nội dung** trong Tùy chỉnh giải bài toán tuyến tính theo tâm và kích thước, giữ đúng tỉ lệ và nằm trong tứ giác. **Căn nội dung theo cạnh ngang màn hình trong ảnh** xoay hệ trục theo cạnh trên đã chiếu. Chỉ số góc xoay camera lấy từ hướng cạnh này trong ảnh (góc biểu kiến, chưa tách tư thế 3D/đặc tính ống kính).
- Mỗi lượt có `revision`; đổi viewport/hiệu chỉnh lại tăng revision để bỏ dữ liệu cũ. Một điện thoại giữ quyền gửi luồng tại một thời điểm. Bộ nhớ giữ từng ID qua các lần mất dấu, không tự hết hạn do thiếu marker. Đổi kích thước khung/camera/zoom/focus, xóa điểm, tạm dừng hoặc nối lại luồng sẽ gom lại từ đầu. Khi chốt, camera phải vẫn đang gửi và cả bốn ID được thấy trong cửa sổ tuổi cho phép, không cần cùng khung. Biến môi trường `MARKER_MAX_AGE_MS` (mặc định `3000`) hoặc tùy chọn `createApplication({markerMaxAgeMs})` thay cửa sổ này. FPS thực tế phụ thuộc thiết bị và mạng.

API cốt lõi giữ theo [đặc tả](<Đặc tả Trình hiển thị bù góc nhìn trên trình duyệt.md>): tạo phiên, upload multipart trường `photo`, gửi 4 điểm, WebSocket `/ws?session=:id` với `photo_received`, `detect_failed`, `calibrated`. Nhận diện tự động hợp lệ sẽ áp dụng ngay; nút **Đúng** trên điện thoại xác nhận lại, **Chạm tay** gửi kết quả sửa.

Các endpoint hỗ trợ: `GET /api/config`, `GET /api/markers/:id.svg`, `GET /api/session/:id`, `DELETE /api/session/:id`, `GET /api/session/:id/photo`, `GET /api/session/:id/qr?url=...`. Client gửi điểm dưới dạng `{photoId, points:[{id,x,y}]}` để từ chối xác nhận ảnh đã bị thay; server cũng nhận mảng điểm thuần theo hợp đồng ban đầu. ID phiên là khóa truy cập ngẫu nhiên trong URL; ứng dụng thiết kế cho LAN tin cậy, chưa có tài khoản người dùng.

### Nhận diện và độ chính xác

Worker và server tinh chỉnh bốn góc biên đen bằng giao các đường gradient trên ảnh xám, cửa sổ bán kính tối đa 5 px, tối đa 8 vòng; cửa sổ thu nhỏ theo bề dày viền ở marker nhỏ. Các góc giữ thứ tự trên trái → trên phải → dưới phải → dưới trái **của SVG gốc**, kể cả khi camera xoay. `markerBlackSide`/`markerCorners` dùng cùng kích thước khi vẽ: biên đen rộng `0.12 × min(vw,vh)`, SVG rộng thêm `9/7`; vùng trắng một ô không thuộc cặp điểm hiệu chuẩn.

Khi đủ bộ góc của bốn marker, DLT chuẩn hóa giải ảnh→màn hình từ 16 cặp. Thử cả bộ và từng bộ ba, chọn đồng thuận theo RMS mỗi marker ≤ 2 px rồi giải lại trên các marker được giữ (12 hoặc 16 góc). `reprojectionError` là RMS Euclid màn hình→ảnh trên các góc được giữ; `rejectedIds` nêu ID bị loại. Thiếu bộ góc của bất kỳ marker nào thì dùng bốn tâm, kể cả tâm đặt tay; sai số là `null` vì bốn tâm khớp đúng không cho một thước đo dư độc lập. Live dùng pixel khung 640 px (ROI quy về cùng hệ), ảnh upload dùng pixel ảnh gốc sau EXIF. Hai trang cảnh báo trên 2 px; live không cho chốt, ảnh tự động chuyển sang kiểm tra/chạm tay. `validateCalibration` vẫn kiểm tra tâm, thứ tự, miền ảnh và chân trời; phép chiếu từ góc cũng được kiểm tra chân trời.

WebSocket `/ws?session=:id&role=display|capture` giữ các sự kiện cũ và bổ sung:

| Hướng | Sự kiện | Nội dung |
| --- | --- | --- |
| Client → server | `configure` (display) | `{viewport, markers, force?, requestId}`; cập nhật cùng phiên |
| Client → server | `start_live`, `fallback` | `{requestId}`; chuyển lượt live/chụp ảnh |
| Capture → server | `live_points` | `{revision, seq, points:[{id,x,y,corners?:[{x,y}×4]}], imageSize:{w,h}, fps, detectionMs?}`; 1–4 marker **vừa thấy**; tâm luôn được giữ để tương thích |
| Capture → server | `live_status` | `{revision, seq, points:[], imageSize:{w,h}, fps}`; khung không có điểm mới, giữ nguyên bộ nhớ |
| Capture → server | `freeze` | `{revision, lastSeq, requestId}`; chốt median server, từ chối từng ID quá cũ |
| Display → server → capture | `display_applied` | `{revision, calibrationId?, seq?, ok, reason?}`; xác nhận áp dụng/từ chối, `seq` cho live, `calibrationId` cho bản chốt/ảnh |
| Client → server | `sync` | `{requestId}`; yêu cầu `snapshot` để khôi phục kết quả upload đến muộn |
| Capture → server | `pause` | `{requestId}`; dừng luồng nhưng giữ phiên |
| Server → client | `connected` | snapshot `{sessionId, viewport, markers, revision, mode, result, peers, photo, busy, displayApplied}` |
| Server → client | `live_started`, `capture_started` | snapshot của lượt mới |
| Server → client | `live_points`, `live_status`, `peers` | tứ giác/tâm `Q`, `points` có góc, `detected`, `tracked`, `updatedIds`, `markerStats`, `freezeQ`, `freezePoints`, `detectionMs`, `reprojectionError`, `freezeReprojectionError`, `correspondenceCount`, `rejectedIds`; `peers` có `display`, `capture`, `streaming` |
| Server → capture | `frame_ack` | `{seq, revision, ok, tracked, ready, sampleCounts, markerStats, freezeQ, freezePoints, imageSize, maxAgeMs, fresh, stable, lastSeq, samples, detectionMs, reprojectionError, freezeReprojectionError, warning?, reason?}`; `markerStats[id] = {ageMs, sampleCount, cornerSampleCount, jitter}` (`ageMs:null` nếu chưa thấy), `ready` gồm phối cảnh + tuổi + RMS; `samples` là số mẫu tối thiểu giữa các ID |
| Server → client | `calibrated` | Giữ `Q`/`imageSize`/revision cũ; thêm `points` (góc median khi chốt live), `reprojectionError`, `correspondenceCount`, `rejectedIds`. Luồng ảnh/POST points/snapshot dùng cùng dữ liệu góc tùy chọn. |
| Server → client | `photo_status`, `photo_ready`, `snapshot` | hàng đợi `{revision,state,position}`; metadata ảnh/preview đến muộn; snapshot có kết quả và xác nhận máy tính |
| Server → client | `command_ack` | `{requestId, revision, ok, reason?}` |

Server xác thực và gom tọa độ theo ID, chuyển tứ giác mới nhất và tổng hợp median từng marker khi chốt; không nhận video. `validateCalibration` dùng chung cho HTTP, live/chốt, worker và display, kiểm tra cả chân trời khi biết viewport. Display giữ bản hợp lệ gần nhất khi từ chối và gửi lỗi nổi bật về điện thoại. Trang máy tính hiển thị riêng chưa có điện thoại / đã kết nối / camera đang gửi. Live tích lũy dùng tọa độ mới nhất trực tiếp; chỉ ghi localStorage khi chốt. Chỉ số `compression` là giá trị nhỏ nhất của σmin/σmax của Jacobian nội dung→màn hình ở 4 góc và tâm; `minScale` là σmin nhỏ nhất (px màn hình/px nội dung). Nén dưới 35% cảnh báo co giãn lệch hướng; không thay thế phép đo độ nét bằng camera thật. Vùng đọc màn hình chỉ tóm tắt live tối đa mỗi 2 giây, không đọc FPS từng khung.

## Điều hướng

- [Đặc tả chi tiết](<Đặc tả Trình hiển thị bù góc nhìn trên trình duyệt.md>): thiết kế toán học, giao thức và tiêu chí nghiệm thu.
- [client/display/index.html](client/display/index.html), [app.js](client/display/app.js), [style.css](client/display/style.css): trang máy tính, nội dung và điều khiển.
- [client/display/content/](client/display/content/README.md): runtime, adapter, renderer và mẫu; [client/common/content-panel.js](client/common/content-panel.js): biểu mẫu dùng chung máy tính/điện thoại.
- [shared/content/](shared/content/README.md): schema, trường mẫu, JSON Pointer/selector và formatter dùng chung; [server/content/](server/content/README.md): proxy an toàn, parser và poller phiên.
- [client/capture/](client/capture/): trang điện thoại; [camera.js](client/capture/camera.js) quản lý camera/backpressure, [vision-worker.js](client/capture/vision-worker.js) dò marker/QR. [client/common/connection.js](client/common/connection.js) nối lại phiên và xác nhận lệnh dùng chung.
- [client/capture/track-controls.js](client/capture/track-controls.js), [lens-ui.js](client/capture/lens-ui.js): điều khiển camera/zoom/focus theo capabilities; [shared/camera-settings.js](shared/camera-settings.js): dải/bước zoom, chọn camera và ánh xạ điểm lấy nét.
- [server/index.js](server/index.js): HTTP/WebSocket và hàng đợi ảnh; [protocol.js](server/protocol.js): lệnh live; [public-url.js](server/public-url.js): URL Codespaces; [sessions.js](server/sessions.js): vòng đời phiên.
- [shared/homography.js](shared/homography.js), [fitRect.js](shared/fitRect.js), [calibration.js](shared/calibration.js): DLT/Jacobi, đồng thuận marker, hình chữ nhật và kiểm tra hình học dùng chung, không phụ thuộc DOM/Node.
- [shared/subpix.js](shared/subpix.js), [detection.js](shared/detection.js): tinh chỉnh gradient, ROI đa độ phân giải và gộp theo ID.
- [shared/live.js](shared/live.js), [markers.js](shared/markers.js): nhịp xử lý, giới hạn quan sát, EMA cho gói cũ và tâm marker dùng chung.
- [shared/temporal-markers.js](shared/temporal-markers.js): tuổi, cửa sổ mẫu, dao động, tứ giác mới nhất và median theo ID. [shared/photo.js](shared/photo.js): giới hạn hàng đợi và timeout upload dùng chung.
- [tests/](tests/README.md): kiểm thử toán, ảnh, API và trình duyệt.

Thư viện chính: [js-aruco2](https://github.com/damianofalcioni/js-aruco2), [jsQR](https://github.com/cozmo/jsQR), [Sharp](https://sharp.pixelplumbing.com/api-operation/), Express, ws, qrcode và html2canvas. Tất cả được phục vụ cục bộ; không cần CDN. `package-lock.json` khóa phiên bản để cài đặt lặp lại được.

## Hướng mở rộng

Dùng webcam theo dõi vị trí đầu/mắt và cập nhật phép biến đổi liên tục, giảm nhu cầu chụp lại khi người xem di chuyển. Hướng này cần bổ sung ước lượng vị trí mắt và hiệu chuẩn camera so với màn hình.
