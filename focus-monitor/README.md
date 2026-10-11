# Focus Monitor

Demo HTML/JavaScript theo dõi phiên làm bài: mất focus, trang bị ẩn (đổi tab/thu nhỏ cửa sổ), rời trang, sao chép/cắt/dán và thoát toàn màn hình. Các tín hiệu không đủ để kết luận gian lận.

## Thiết lập và chạy

Không cần cài dependency hay build. Mở [index.html](index.html) trực tiếp bằng trình duyệt hiện đại.

Hoặc chạy máy chủ tĩnh từ thư mục dự án:

```bash
cd focus-monitor
python3 -m http.server 8000
```

Mở http://localhost:8000. Nếu dùng Codespaces, mở cổng 8000 trong bảng Ports.

## Kiểm thử thủ công

1. Nhấn **Bắt đầu**, chuyển tab/cửa sổ rồi quay lại: nhật ký có sự kiện và thời gian mất focus tăng. Blur và trang bị ẩn cùng lúc chỉ tính một khoảng mất focus.
2. Sao chép/cắt/dán trong khu vực trả lời: ghi loại thao tác, không lưu nội dung clipboard hoặc câu trả lời.
3. Bật toàn màn hình rồi nhấn Esc: ghi nhận thoát toàn màn hình nếu trình duyệt hỗ trợ.
4. Nhấn **Thử chuyển trang**, quay lại: nhật ký cũ còn trong cùng tab, phiên kết thúc khi tải lại trang.
5. Bật xác nhận rời trang rồi tải lại: trình duyệt có thể yêu cầu xác nhận sau khi người dùng tương tác. Hủy điều hướng không được coi là đã rời trang.
6. Nhấn **Kết thúc**, tiếp tục thao tác: không ghi thêm sự kiện. **Xuất JSON** tải nhật ký; **Xóa nhật ký** đặt lại phiên.

## Thành phần và giới hạn

- [index.html](index.html): giao diện, CSS và xử lý sự kiện; không có máy chủ ứng dụng.
- Nhật ký dùng sessionStorage, tồn tại khi tải lại trong cùng tab. Không gửi dữ liệu đến máy chủ.
- Không biết trang đích hay nội dung tab khác; không phát hiện đáng tin cậy AI, DevTools, chụp màn hình hoặc thiết bị thứ hai.
- pagehide/beforeunload không đảm bảo chạy khi trình duyệt bị đóng đột ngột. Nhật ký phía máy khách có thể bị sửa/xóa.
- Quy tắc chung: [AGENTS.md](../AGENTS.md). Danh sách dự án: [README workspace](../README.md).
