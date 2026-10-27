# CNPM Tuần 7: Tiến hóa kiến trúc ứng dụng quản lý công việc

Dự án cài đặt ứng dụng quản lý công việc (Task Management) tiến hóa qua các phiên bản kiến trúc theo yêu cầu môn **Công nghệ phần mềm** (Software Architecture Evolution).

---

## 📌 Tổng quan các phiên bản

| Phiên bản | Mô hình kiến trúc | Phạm vi triển khai & Lưu trữ | Trạng thái |
| :--- | :--- | :--- | :--- |
| **V1** | Standalone Local Process | Chạy cục bộ 1 máy, file `tasks.json` | ✅ Hoàn thành (`tag: v1.0`) |
| **V2** | Client–Server (Centralized State) | Nhiều client kết nối chung 1 C server qua LAN / Ngrok Tunnel | ✅ Hoàn thành (`tag: v2.0`) |
| **V3** | N-Layer & Kanban Board | Tách 3 tầng (Presentation / Service / Repository), Database SQLite3 | ✅ Hoàn thành (`tag: v3.0`) |
| **V3.5** | **N-Layer + SSE Real-time Collaboration** | **Thay HTTP Polling bằng Server-Sent Events; nhận biết người dùng online** | ✅ **Hoàn thành (`tag: v3.5`)** |
| **V4** | Peer-to-Peer (P2P Direct Sync) | Đồng bộ ngang hàng khi mất server trung tâm | ⏳ Tiếp theo |

---

## 🌐 Đường link truy cập ứng dụng

- **Truy cập cục bộ:** [http://localhost:8080](http://localhost:8080)
- **Truy cập công khai đa thiết bị qua Internet (Ngrok Tunnel):**  
  👉 **[https://kiera-keratometric-varietally.ngrok-free.dev](https://kiera-keratometric-varietally.ngrok-free.dev)**
- **Kiểm tra thông số kiến trúc API:** `GET /api/info`

---

## 🚀 Hướng dẫn khởi chạy & Kiểm chứng

### 1. Khởi chạy C Backend & Ngrok Tunnel
```bash
./start_ngrok.sh
```

### 2. Kiểm chứng tự động từng phiên bản
```bash
# Kiểm chứng Version 1 (Persistence trên tasks.json)
./test_v1.sh

# Kiểm chứng Version 2 (Client A và Client B đa thiết bị)
./test_v2.sh

# Kiểm chứng Version 3 (N-Layer, SQLite Migration & Kanban)
./test_v3.sh

# Kiểm chứng Version 3.5 (SSE Real-time, Online Users)
./test_v3_5.sh
```

---

## 🏛️ Chi tiết kiến trúc Version 3: N-Layer & Thay đổi Nguồn lưu trữ / UI

### 1. Yêu cầu & Ràng buộc theo đề bài
- **Yêu cầu từ khách hàng:**
  1. Giao diện danh sách cũ phải thay bằng **bảng Kanban hai cột: Chưa hoàn thành và Hoàn thành**.
  2. Thay cách lưu trữ từ **tệp JSON sang cơ sở dữ liệu SQLite** (`tasks.db`).
  3. **Không được mất các task cũ** (Dữ liệu từ V1 và V2 được tự động chuyển đổi sang SQLite).
- **Thuộc tính chất lượng (NFR):**
  - **Modifiability (Khả năng thay đổi):** Dễ dàng thay thế giao diện người dùng (Presentation) và nguồn lưu trữ (Persistence) mà nghiệp vụ cốt lõi không bị xáo trộn hoặc phụ thuộc lẫn nhau.
  - **Separation of Concerns (Tách biệt mối quan tâm):** Áp dụng mô hình **N-Layer** phân rã ứng dụng thành các lớp chuyên biệt.

---

### 2. Phân chia các tầng kiến trúc N-Layer trong mã nguồn

```text
                  +----------------------------------------------+
                  |              PRESENTATION LAYER              |
                  |  - Web UI: Kanban Board (HTML5, CSS, JS)     |
                  |  - HTTP Controller & Router: server.c        |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |             BUSINESS LOGIC LAYER             |
                  |  - Task Service: task_service.h / .c         |
                  |  - Task Validation & Business Rules          |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |              DATA ACCESS LAYER               |
                  |  - Repository Interface: task_repository.h   |
                  |  - SQLite Implementation: sqlite_repository.c|
                  |  - Migration Logic (tasks.json -> tasks.db)  |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |               DATABASE ENGINE                |
                  |  - SQLite 3 (tasks.db) with WAL mode         |
                  +----------------------------------------------+
```

#### 🔹 Tầng 1: Presentation Layer (Giao diện & Điều khiển HTTP)
- **Mã nguồn:** [server.c](file:///home/cheems/Projects/CNPM-W7-TODO/server.c), [public/index.html](file:///home/cheems/Projects/CNPM-W7-TODO/public/index.html), [public/style.css](file:///home/cheems/Projects/CNPM-W7-TODO/public/style.css), [public/app.js](file:///home/cheems/Projects/CNPM-W7-TODO/public/app.js)
- **Trách nhiệm:** 
  - Lắng nghe HTTP request, định tuyến URL (`/api/tasks`, `/api/info`), kiểm tra định dạng HTTP body và trả về mã trạng thái HTTP (200, 201, 400, 404).
  - Phục vụ bảng **Kanban 2 cột**: Cột *Chưa hoàn thành* và Cột *Đã hoàn thành*. Hỗ trợ tương tác kéo-thả (Drag & Drop) và nút chuyển nhanh 1-chạm giữa 2 cột.
  - **Độc lập:** Tầng này không chứa câu lệnh SQL nào và không truy cập trực tiếp file database.

#### 🔹 Tầng 2: Business Logic Layer (Dịch vụ Nghiệp vụ)
- **Mã nguồn:** [task_service.h](file:///home/cheems/Projects/CNPM-W7-TODO/task_service.h), [task_service.c](file:///home/cheems/Projects/CNPM-W7-TODO/task_service.c)
- **Trách nhiệm:**
  - Thực thi quy tắc nghiệp vụ: Xác thực tính hợp lệ của tiêu đề task (không được rỗng, không chứa khoảng trắng đơn thuần, giới hạn độ dài), kiểm tra tính hợp lệ của ID.
  - Đóng vai trò trung gian phối hợp giữa Controller và Repository.
  - **Độc lập:** Hoàn toàn **không biết** về giao diện Kanban, cũng **không biết** cơ sở dữ liệu là SQLite hay JSON. Nếu thay thế giao diện (từ Kanban sang Calendar hay Gantt chart), tầng nghiệp vụ hoàn toàn giữ nguyên.

#### 🔹 Tầng 3: Data Access Layer (Truy xuất Dữ liệu)
- **Mã nguồn:** [task_repository.h](file:///home/cheems/Projects/CNPM-W7-TODO/task_repository.h), [sqlite_repository.c](file:///home/cheems/Projects/CNPM-W7-TODO/sqlite_repository.c)
- **Trách nhiệm:**
  - Định nghĩa interface trừu tượng `task_repository.h` (`repo_get_all_tasks`, `repo_create_task`, `repo_update_task`, `repo_delete_task`).
  - Hiện thực bằng thư viện SQLite3 (`sqlite_repository.c`): Khởi tạo bảng `tasks`, bật chế độ ghi nhật ký `WAL (Write-Ahead Logging)` giúp tối ưu truy cập đồng thời, thực thi các câu lệnh SQL chuẩn hóa.
  - **Cơ chế Migration tự động:** Khi khởi động, nếu bảng `tasks` trong SQLite còn trống và tệp `tasks.json` cũ tồn tại, hệ thống tự động đọc và insert toàn bộ task cũ vào SQLite, giữ nguyên toàn bộ ID, trạng thái và mốc thời gian.

---

### 3. Minh chứng tách biệt: Các file thay đổi ở Version 3

Theo yêu cầu đề bài: *"Chỉ rõ những file thay đổi khi đổi UI và khi đổi database"*:

| Thao tác tiến hóa | Các file thay đổi / tạo mới | Giải thích kiến trúc |
| :--- | :--- | :--- |
| **Đổi UI (Danh sách cũ &rarr; Bảng Kanban 2 cột)** | - [public/index.html](file:///home/cheems/Projects/CNPM-W7-TODO/public/index.html)<br>- [public/style.css](file:///home/cheems/Projects/CNPM-W7-TODO/public/style.css)<br>- [public/app.js](file:///home/cheems/Projects/CNPM-W7-TODO/public/app.js) | Chỉ thay đổi phần Presentation (HTML cấu trúc 2 cột, CSS Kanban dropzone và JS Drag & Drop). **Tầng Service và Repository không thay đổi một dòng code nào.** |
| **Đổi Database (File JSON &rarr; SQLite3 Database)** | - [task_repository.h](file:///home/cheems/Projects/CNPM-W7-TODO/task_repository.h)<br>- [sqlite_repository.c](file:///home/cheems/Projects/CNPM-W7-TODO/sqlite_repository.c)<br>- [Makefile](file:///home/cheems/Projects/CNPM-W7-TODO/Makefile) (thêm `-lsqlite3`) | Toàn bộ truy xuất SQL và logic migration được đóng gói bên trong tầng Data Access. Giao diện Web bên ngoài và các endpoint API `/api/tasks` giữ nguyên hợp đồng giao tiếp (API Contract). |

---

## 📊 Nhật ký quyết định kiến trúc (Mẫu Mục 04)

| Version | NFR mới | Quyết định thiết kế | File/thành phần đổi | Kết quả test |
| :--- | :--- | :--- | :--- | :--- |
| **V1** | **Data Persistence** trên một máy cục bộ (Dữ liệu không mất khi restart). | Xây dựng Single-Process C Backend với POSIX Sockets phục vụ REST API + Static Files; đọc/ghi dữ liệu vào `tasks.json` an toàn bằng `cJSON` và atomic rename. | `server.c`, `cJSON.c`, `cJSON.h`, `Makefile`, `public/index.html`, `public/style.css`, `public/app.js`, `tasks.json`. | Đạt: Tạo 2 task, cập nhật 1 task, tắt và khởi động lại server dữ liệu được khôi phục 100%. |
| **V2** | **Centralized Shared State** giữa nhiều client đồng thời qua mạng; tính tươi mới (Freshness). | Cấu hình C Server bind `0.0.0.0`, mở rộng CORS; chuyển tiếp port qua **Ngrok Tunnel** ra Internet; bổ sung cơ chế **Auto-Polling (2.5s)** trên Frontend để đồng bộ hai chiều giữa các client. | `server.c`, `public/index.html`, `public/style.css`, `public/app.js`, `start_ngrok.sh`, `test_v2.sh`. | Đạt: Client A tạo task, Client B thấy sau 2.5s; Client B hoàn thành task, Client A thấy ngay trạng thái mới. |
| **V3** | **Modifiability** & **Separation of Concerns** (Tách Presentation, Business Logic, Data Access; hỗ trợ ACID database). | Áp dụng mô hình **N-Layer**: Tách `task_service` (nghiệp vụ) và `sqlite_repository` (Data Access SQLite3); chuyển đổi giao diện sang **Kanban 2 cột** (Drag & Drop); tự động migrate dữ liệu từ `tasks.json` sang `tasks.db`. | `task_repository.h`, `sqlite_repository.c`, `task_service.h`, `task_service.c`, `server.c`, `Makefile`, `public/index.html`, `public/style.css`, `public/app.js`, `test_v3.sh`. | Đạt: Toàn bộ task cũ từ V2 được chuyển sang SQLite không mất mát; kéo thả chuyển cột Kanban mượt mà; tắt mở lại server dữ liệu SQLite toàn vẹn. |
| **V3.5** | **Real-time Collaboration & Multi-User Awareness** (Cộng tác thời gian thực tức thì <50ms; giảm tải băng thông mạng; nhận biết người dùng online; tiền đề event stream cho P2P V4). | Thay thế HTTP Polling bằng **Server-Sent Events (SSE)** tại `GET /api/events` và `GET /api/clients`; xây dựng module `event_broadcast.c/.h` đa luồng (`pthread_mutex_t`) quản lý kết nối client và broadcast các sự kiện granular (`task_created`, `task_updated`, `task_deleted`, `client_joined`, `client_left`); Frontend cập nhật DOM trực tiếp theo event (không cần load lại toàn bộ danh sách); hỗ trợ tự động fallback sang polling nếu mất kết nối SSE. | `event_broadcast.h`, `event_broadcast.c`, `server.c`, `Makefile`, `public/app.js`, `public/index.html`, `public/style.css`, `test_v3_5.sh`. | Đạt: 11/11 bài test tự động (`test_v3_5.sh`). Client A thêm/sửa/xóa task thì Client B nhận event SSE tức thì; nhận biết chính xác số người dùng online; kiểm tra hồi quy V1, V2, V3 đều vượt qua 100%. |

---

## 📐 Sơ đồ kiến trúc Version 3.5 (N-Layer + SSE Real-time Broadcast)

```mermaid
graph TD
    subgraph Presentation ["Presentation Layer (V3.5)"]
        KanbanUI["Kanban Board UI + Online Users Panel (HTML5/CSS/JS)"]
        HTTPRouter["HTTP Router & Web Controller (server.c)"]
        SSEEndpoint["SSE Stream Endpoint: GET /api/events"]
        ClientsEndpoint["Online Users API: GET /api/clients"]
        KanbanUI <==>|"REST API (POST / PUT / DELETE / GET)"| HTTPRouter
        KanbanUI <-.->|"EventSource (SSE Stream)"| SSEEndpoint
        KanbanUI -.->|"Fetch Clients"| ClientsEndpoint
    end

    subgraph BusinessLogic ["Business Logic Layer"]
        TaskService["Task Service (task_service.c)<br/>- Validation rules<br/>- Task lifecycle management"]
        EventBroadcast["Event Broadcaster (event_broadcast.h/.c)<br/>- Client FD Registry<br/>- Thread-safe Mutex<br/>- SSE Granular Event Dispatcher"]
        HTTPRouter ==>|"1. Gọi hàm Service"| TaskService
        HTTPRouter ==>|"2. Broadcast sự kiện sau CRUD"| EventBroadcast
        EventBroadcast ==>|"Push Event frames (text/event-stream)"| SSEEndpoint
    end

    subgraph DataAccess ["Data Access Layer"]
        RepoInterface["Task Repository Interface (task_repository.h)"]
        SQLiteRepo["SQLite Repository (sqlite_repository.c)<br/>- Prepared Statements<br/>- Write-Ahead Logging (WAL)"]
        TaskService ==>|"CRUD Interface"| RepoInterface
        RepoInterface -.->|"Triển khai"| SQLiteRepo
    end

    subgraph DatabaseEngine ["Storage Engine"]
        SQLiteDB[("tasks.db (SQLite3 Database)")]
        SQLiteRepo <==>|"SQL Queries"| SQLiteDB
    end
```

---

## ⚡ Chi tiết kiến trúc Version 3.5: Cộng tác đa người dùng thời gian thực

### 1. Vấn đề nảy sinh và Động lực kiến trúc của Version 3.5
- **Hạn chế của Polling ở Version 2 & Version 3:**
  - Ở V2 và V3, các client đồng bộ dữ liệu bằng cơ chế **HTTP Polling định kỳ mỗi 2.5 giây** (`setInterval`).
  - Mỗi 2.5s, mọi client gửi `GET /api/tasks` kéo **toàn bộ mảng JSON** về máy, bất kể có dữ liệu mới hay không. Điều này gây lãng phí băng thông mạng, tăng tải CPU cho server khi số lượng client tăng.
  - Độ trễ phản hồi (latency) trung bình lên đến 1.25s - 2.5s, không mang lại trải nghiệm cộng tác tức thời (real-time).
  - Không có thông tin trạng thái người dùng (không biết ai đang cùng làm việc trên bảng công việc).
- **Mục tiêu của Version 3.5:**
  1. Chuyển sang mô hình **Push (Server-Sent Events)**: Server chủ động đẩy thông báo ngay khi có sự thay đổi. Độ trễ giảm xuống dưới 50ms.
  2. **Giao thức sự kiện rời rạc (Granular Event Protocol)**: Thay vì tải lại toàn bộ danh sách, server chỉ gửi một gói tin sự kiện nhỏ (`task_created`, `task_updated`, `task_deleted`) kèm dữ liệu task tương ứng. Client tự cập nhật DOM tương ứng.
  3. **Nhận biết cộng tác viên (Multi-User Awareness)**: Hiển thị số lượng và danh sách người dùng đang online trên giao diện.
  4. **Tiền đề kiến trúc cho Version 4 (P2P Direct Sync)**: Định dạng sự kiện JSON được thiết kế chuẩn hóa để khi chuyển sang Version 4 (P2P qua WebRTC DataChannel khi mất server), logic xử lý sự kiện ở client hoàn toàn được tái sử dụng mà không cần viết lại.

### 2. So sánh kiến trúc V3 (Polling) vs V3.5 (SSE) vs V4 (P2P Tiền đề)

```mermaid
graph LR
    subgraph V3["V3: Polling (Pull)"]
        A3["Client A"] -->|"GET /api/tasks (mỗi 2.5s)"| S3["Server"]
        B3["Client B"] -->|"GET /api/tasks (mỗi 2.5s)"| S3
    end

    subgraph V35["V3.5: SSE Real-time (Push)"]
        A35["Client A"] <-->|"SSE Event Stream"| S35["Server"]
        B35["Client B"] <-->|"SSE Event Stream"| S35
        S35 -->|"Push: task_created / updated"| A35
        S35 -->|"Push: task_created / updated"| B35
    end

    subgraph V4["V4: P2P Direct (Mất Server)"]
        A4["Peer A"] <-.->|"WebRTC DataChannel (cùng định dạng Event)"| B4["Peer B"]
    end

    V3 -->|"V3.5 nâng cấp giao thức"| V35
    V35 -->|"V4 kế thừa định dạng sự kiện"| V4
```

### 3. Minh chứng tách biệt: Các file thay đổi ở Version 3.5

| Thao tác | File | Trách nhiệm kiến trúc |
| :--- | :--- | :--- |
| **[TẠO MỚI]** | [event_broadcast.h](file:///home/cheems/Projects/CNPM-W7-TODO/event_broadcast.h) | Interface định nghĩa các loại sự kiện (`event_type_t`) và API quản lý SSE clients. |
| **[TẠO MỚI]** | [event_broadcast.c](file:///home/cheems/Projects/CNPM-W7-TODO/event_broadcast.c) | Cài đặt lưu trữ mảng file descriptor của client, bảo vệ tương tranh bằng `pthread_mutex_t`, phát hiện client disconnect và broadcast gói tin `text/event-stream`. |
| **[TẠO MỚI]** | [test_v3_5.sh](file:///home/cheems/Projects/CNPM-W7-TODO/test_v3_5.sh) | Script kiểm chứng tự động 11 kịch bản: SSE streaming, multi-client broadcast, CRUD event dispatch, online awareness. |
| **[CHỈNH SỬA]** | [server.c](file:///home/cheems/Projects/CNPM-W7-TODO/server.c) | Thêm route `GET /api/events` (giữ connection mở phục vụ SSE) và `GET /api/clients`; gọi `broadcast_event()` sau mỗi thao tác tạo/sửa/xóa thành công. |
| **[CHỈNH SỬA]** | [Makefile](file:///home/cheems/Projects/CNPM-W7-TODO/Makefile) | Thêm `event_broadcast.c` vào danh sách biên dịch backend. |
| **[CHỈNH SỬA]** | [public/app.js](file:///home/cheems/Projects/CNPM-W7-TODO/public/app.js) | Kết nối `EventSource`, lắng nghe 5 loại sự kiện SSE để patch state cục bộ tức thì; cơ chế tự động fallback về polling khi mất kết nối. |
| **[CHỈNH SỬA]** | [public/index.html](file:///home/cheems/Projects/CNPM-W7-TODO/public/index.html) | Bổ sung widget "Online Users Panel", cập nhật phiên bản hiển thị Version 3.5. |
| **[CHỈNH SỬA]** | [public/style.css](file:///home/cheems/Projects/CNPM-W7-TODO/public/style.css) | Styles hiệu ứng đèn xanh nhấp nháy (pulse), avatar chip cho danh sách người dùng đang online. |
| **[GIỮ NGUYÊN 100%]** | [task_service.c](file:///home/cheems/Projects/CNPM-W7-TODO/task_service.c) | **Tầng Business Logic hoàn toàn không bị ảnh hưởng.** Quy tắc nghiệp vụ và xác thực công việc giữ nguyên. |
| **[GIỮ NGUYÊN 100%]** | [sqlite_repository.c](file:///home/cheems/Projects/CNPM-W7-TODO/sqlite_repository.c) | **Tầng Data Access hoàn toàn không bị ảnh hưởng.** Cấu trúc bảng SQLite và các hàm thao tác database giữ nguyên. |

---

## 💡 Trả lời câu hỏi thảo luận kiến trúc (V3 & V3.5)

> **Câu hỏi 1:** *Đổi SQLite sang một nguồn lưu trữ khác sẽ ảnh hưởng file nào?*
- **Trả lời:** Chỉ ảnh hưởng duy nhất file cài đặt Repository trong tầng Data Access (ví dụ viết file mới `postgres_repository.c` hoặc `mysql_repository.c` kế thừa `task_repository.h`) và file `Makefile` (thêm thư viện liên kết).  
- Tầng nghiệp vụ (`task_service.c`), bộ điều khiển HTTP (`server.c`) và toàn bộ mã nguồn giao diện Web (`public/`) hoàn toàn **không cần thay đổi một dòng nào**.

> **Câu hỏi 2:** *Tầng nghiệp vụ có cần biết giao diện Kanban hoặc cơ chế SSE không?*
- **Trả lời:** **Hoàn toàn không**. Tầng nghiệp vụ (`task_service`) chỉ quan tâm đến các thuộc tính thực thể của công việc (`id`, `title`, `completed`, `created_at`) và các quy tắc xác thực (tiêu đề hợp lệ, ID hợp lệ). Việc dữ liệu hiển thị dạng danh sách hay Kanban, hoặc được đẩy qua SSE hay REST Polling là trách nhiệm riêng của tầng Presentation/Communication.

> **Câu hỏi 3:** *Có bằng chứng tách biệt giữa thay đổi UI, thay đổi Database và thay đổi cơ chế giao tiếp Real-time không?*
- **Trả lời:** Có. Bằng chứng rõ ràng qua lịch sử commit:
  - Khi thay đổi UI sang bảng Kanban (V3), chỉ các tệp trong thư mục [public/](file:///home/cheems/Projects/CNPM-W7-TODO/public) thay đổi.
  - Khi thay đổi lưu trữ từ JSON sang SQLite (V3), chỉ tạo mới [sqlite_repository.c](file:///home/cheems/Projects/CNPM-W7-TODO/sqlite_repository.c) và [task_repository.h](file:///home/cheems/Projects/CNPM-W7-TODO/task_repository.h).
  - Khi nâng cấp lên Real-time SSE (V3.5), tầng Business Logic (`task_service.c`) và tầng Data Access (`sqlite_repository.c`) được giữ nguyên 100%.

> **Câu hỏi 4:** *Version 3.5 đóng vai trò gì làm tiền đề cho Version 4 (P2P khi mất server)?*
- **Trả lời:** Version 3.5 chuẩn hóa **Event Protocol** (`task_created`, `task_updated`, `task_deleted`) với payload JSON đồng nhất. Trong Version 4, khi server trung tâm mất kết nối, hai máy trong cùng mạng LAN chỉ cần hoán đổi tầng truyền tải từ **SSE (Server Push)** sang **WebRTC DataChannel (Peer-to-Peer Direct)**. Tầng xử lý sự kiện và cập nhật giao diện Kanban ở client giữ nguyên hoàn toàn logic đã được kiểm chứng ở V3.5.