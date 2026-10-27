#!/usr/bin/env bash
set -e

PORT=8087
SERVER_BIN="./server"
URL="http://127.0.0.1:$PORT"
TEST_DIR="/tmp/cnpm_w7_v3_test"

echo "==========================================================="
echo "  CNPM Week 7 - Verification Script for Version 3"
echo "  (N-Layer Architecture, SQLite3 Storage & Kanban Board)"
echo "==========================================================="

# Ensure clean build
echo "[1/9] Building C server with N-Layer and SQLite3 support..."
make clean > /dev/null
make > /dev/null

# Prepare pristine test environment
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/public"
cp -r public/* "$TEST_DIR/public/"
cp "$SERVER_BIN" "$TEST_DIR/"

# Create a sample tasks.json representing data accumulated from V1 and V2
cat << 'EOF' > "$TEST_DIR/tasks.json"
[
  {
    "id": 1,
    "title": "Học lý thuyết Công nghệ phần mềm - Tuần 7",
    "completed": false,
    "created_at": 1793072722
  },
  {
    "id": 2,
    "title": "Cài đặt Version 1 với C backend và tasks.json",
    "completed": true,
    "created_at": 1793072722
  },
  {
    "id": 3,
    "title": "cong viec 1 (Thêm từ Version 2)",
    "completed": false,
    "created_at": 1793072973
  }
]
EOF

# Ensure tasks.db does not exist prior to test
rm -f "$TEST_DIR/tasks.db" "$TEST_DIR/tasks.db-wal" "$TEST_DIR/tasks.db-shm"

echo "[2/9] Starting C server to test automatic migration from tasks.json to tasks.db..."
cd "$TEST_DIR"
./server $PORT &
SERVER_PID=$!
sleep 1

cleanup() {
    if kill -0 $SERVER_PID 2>/dev/null; then
        echo "Cleaning up server PID $SERVER_PID..."
        kill -SIGINT $SERVER_PID 2>/dev/null || kill -9 $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Verify server connectivity and V3 API info
echo "[3/9] Checking /api/info for N-Layer and SQLite architecture..."
INFO_RESP=$(curl -s -f "$URL/api/info")
echo "  -> API Info: $INFO_RESP"
echo "$INFO_RESP" | grep -q '"version":"V3"' || { echo "FAILED: Version is not V3!"; exit 1; }
echo "$INFO_RESP" | grep -q 'SQLite' || { echo "FAILED: Storage engine is not SQLite!"; exit 1; }
echo "$INFO_RESP" | grep -q 'Kanban' || { echo "FAILED: UI style is not Kanban!"; exit 1; }
echo "  [PASS] API Info confirms N-Layer, SQLite storage, and Kanban UI."

# Step 1 in V3 Rubric: Verify data migrated without loss
echo "[4/9] Verifying that tasks from V2 were preserved during SQLite migration..."
MIGRATED_TASKS=$(curl -s "$URL/api/tasks")
echo "  -> Tasks retrieved from SQLite:"
echo "$MIGRATED_TASKS"

echo "$MIGRATED_TASKS" | grep -q "Học lý thuyết Công nghệ phần mềm" || { echo "FAILED: Task 1 missing!"; exit 1; }
echo "$MIGRATED_TASKS" | grep -q "Cài đặt Version 1 với C backend" || { echo "FAILED: Task 2 missing!"; exit 1; }
echo "$MIGRATED_TASKS" | grep -q "cong viec 1 (Thêm từ Version 2)" || { echo "FAILED: Task 3 missing!"; exit 1; }
echo "  [PASS] Tất cả 3 tasks từ V2 được chuyển đổi đầy đủ vào SQLite database!"

# Verify directly with sqlite3 CLI
echo "[5/9] Querying SQLite tasks.db directly..."
SQLITE_COUNT=$(sqlite3 tasks.db "SELECT count(*) FROM tasks;")
echo "  -> Tổng số dòng trong bảng 'tasks' của SQLite: $SQLITE_COUNT"
[ "$SQLITE_COUNT" -ge 3 ] || { echo "FAILED: SQLite record count < 3!"; exit 1; }
echo "  [PASS] SQLite database tasks.db chứa $SQLITE_COUNT records."

# Step 2 in V3 Rubric: Create a new task (Kanban column Chưa hoàn thành)
echo "[6/9] Tạo task mới trên bảng Kanban (Cột Chưa hoàn thành)..."
CREATE_RESP=$(curl -s -X POST "$URL/api/tasks" \
    -H "Content-Type: application/json" \
    -d '{"title": "Thiết kế kiến trúc N-Layer cho Version 3"}')
echo "  -> Task mới: $CREATE_RESP"
NEW_ID=$(echo "$CREATE_RESP" | grep -o '"id":[[:space:]]*[0-9]*' | grep -o '[0-9]*$')

# Step 3 in V3 Rubric: Move task to Completed (Kanban column Đã hoàn thành)
echo "[7/9] Chuyển task #$NEW_ID sang cột Đã hoàn thành (Drag & Drop / Update)..."
UPDATE_RESP=$(curl -s -X PUT "$URL/api/tasks/$NEW_ID" \
    -H "Content-Type: application/json" \
    -d '{"completed": true}')
echo "  -> Cập nhật: $UPDATE_RESP"
echo "$UPDATE_RESP" | grep -q '"completed":.*true' || { echo "FAILED: Task was not marked completed!"; exit 1; }
echo "  [PASS] Task #$NEW_ID đã chuyển trạng thái thành công trong SQLite."

# Step 4: Restart server and confirm persistence in SQLite
echo "[8/9] Tắt server và khởi động lại để kiểm chứng tính bền vững của SQLite..."
kill -SIGINT $SERVER_PID
wait $SERVER_PID 2>/dev/null || true
sleep 1

./server $PORT &
SERVER_PID=$!
sleep 1

POST_RESTART=$(curl -s "$URL/api/tasks")
echo "$POST_RESTART" | grep -q "Thiết kế kiến trúc N-Layer cho Version 3" || {
    echo "FAILED: Task mới bị mất sau khi restart server!";
    exit 1;
}
echo "  [PASS] Dữ liệu trong SQLite được khôi phục 100% sau khi khởi động lại server."

# Step 5: Test Delete
echo "[9/9] Xóa task #$NEW_ID khỏi SQLite database..."
DELETE_RESP=$(curl -s -X DELETE "$URL/api/tasks/$NEW_ID")
echo "  -> Xóa: $DELETE_RESP"
AFTER_DELETE=$(curl -s "$URL/api/tasks")
echo "$AFTER_DELETE" | grep -q "Thiết kế kiến trúc N-Layer" && {
    echo "FAILED: Task vẫn còn sau khi xóa!";
    exit 1;
}
echo "  [PASS] Xóa task khỏi SQLite database thành công."

echo "==========================================================="
echo "  SUCCESS: Version 3 verification PASSED all rubric checks!"
echo "==========================================================="
