#!/usr/bin/env bash
set -e

PORT=8088
SERVER_BIN="./server"
URL="http://127.0.0.1:$PORT"

echo "==========================================================="
echo "  CNPM Week 7 - Verification Script for Version 2 (Client-Server)"
echo "==========================================================="

# Ensure clean build
echo "[1/8] Rebuilding C server..."
make clean > /dev/null
make > /dev/null

# Clean old tasks.json for fresh test
rm -f tasks.json tasks.json.tmp

echo "[2/8] Starting C server on port $PORT..."
$SERVER_BIN $PORT &
SERVER_PID=$!
sleep 0.8

cleanup() {
    if kill -0 $SERVER_PID 2>/dev/null; then
        echo "Cleaning up server PID $SERVER_PID..."
        kill -SIGINT $SERVER_PID 2>/dev/null || kill -9 $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Verify server connectivity and V2 API info
echo "[3/8] Checking V2 server connectivity and /api/info..."
INFO_RESP=$(curl -s -f "$URL/api/info")
echo "  -> Server Info: $INFO_RESP"
echo "$INFO_RESP" | grep -q '"version":"V2"' || { echo "FAILED: Server version should be V2!"; exit 1; }

# Step 1 in V2 Rubric: Client A creates a task
echo "[4/8] [Client A (Máy tính)] Tạo task mới..."
CLIENT_A_RESP=$(curl -s -X POST "$URL/api/tasks" \
    -H "Content-Type: application/json" \
    -H "User-Agent: Client-A-Desktop" \
    -d '{"title": "Task do Client A tạo: Họp thiết kế kiến trúc Client-Server"}')
echo "  -> Client A tạo thành công: $CLIENT_A_RESP"
TASK_ID=$(echo "$CLIENT_A_RESP" | grep -o '"id":[[:space:]]*[0-9]*' | grep -o '[0-9]*$')

# Step 2 in V2 Rubric: Client B reads the task from server
echo "[5/8] [Client B (Điện thoại)] Đọc danh sách task từ server trung tâm..."
CLIENT_B_VIEW=$(curl -s "$URL/api/tasks" -H "User-Agent: Client-B-Mobile")
echo "  -> Client B quan sát thấy:"
echo "$CLIENT_B_VIEW"
echo "$CLIENT_B_VIEW" | grep -q "Task do Client A tạo" || {
    echo "FAILED: Client B không thấy task của Client A!";
    exit 1;
}
echo "  [PASS] Client B đã quan sát thấy task của Client A."

# Step 3 in V2 Rubric: Client B updates the task to completed
echo "[6/8] [Client B (Điện thoại)] Đánh dấu hoàn thành task ID #$TASK_ID..."
CLIENT_B_UPDATE=$(curl -s -X PUT "$URL/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" \
    -H "User-Agent: Client-B-Mobile" \
    -d '{"completed": true}')
echo "  -> Client B cập nhật thành công: $CLIENT_B_UPDATE"

# Step 4 in V2 Rubric: Client A reads the updated status
echo "[7/8] [Client A (Máy tính)] Tải lại / nhận dữ liệu polling từ server..."
CLIENT_A_POLL=$(curl -s "$URL/api/tasks" -H "User-Agent: Client-A-Desktop")
echo "  -> Client A quan sát thấy:"
echo "$CLIENT_A_POLL"
echo "$CLIENT_A_POLL" | grep -q '"completed":.*true' || {
    echo "FAILED: Client A không thấy trạng thái completed=true do Client B cập nhật!";
    exit 1;
}
echo "  [PASS] Client A đã thấy trạng thái mới (completed: true) do Client B thực hiện."

# Step 5: Client B creates another task and Client A verifies
echo "[8/8] [Client B] Tạo thêm task phản hồi và Client A xác nhận đồng bộ..."
curl -s -X POST "$URL/api/tasks" \
    -H "Content-Type: application/json" \
    -H "User-Agent: Client-B-Mobile" \
    -d '{"title": "Task do Client B tạo: Kiểm thử qua Ngrok Tunnel"}' > /dev/null

FINAL_TASKS=$(curl -s "$URL/api/tasks" -H "User-Agent: Client-A-Desktop")
echo "$FINAL_TASKS" | grep -q "Kiểm thử qua Ngrok Tunnel" || {
    echo "FAILED: Client A không nhận được task thứ 2 từ Client B!";
    exit 1;
}

echo "  [PASS] Đồng bộ hai chiều giữa Client A và Client B hoạt động hoàn hảo trên server trung tâm!"
echo "==========================================================="
echo "  SUCCESS: Version 2 verification PASSED all rubric checks!"
echo "==========================================================="
