#!/bin/bash
# =============================================================================
# test_v3_5.sh — Kiểm chứng tự động Version 3.5: SSE Real-time Collaboration
# =============================================================================

set -euo pipefail

BASE_URL="http://localhost:8080"
PASS=0
FAIL=0
SERVER_PID=""

cleanup() {
    echo ""
    echo "--- Dọn dẹp ---"
    kill "$SERVER_PID" 2>/dev/null && echo "Đã tắt server (PID $SERVER_PID)" || true
    rm -f /tmp/sse_a.log /tmp/sse_b.log /tmp/task_created.json
    echo "=== Kết quả: PASS=$PASS  FAIL=$FAIL ==="
}
trap cleanup EXIT

pass() { echo "  ✅  $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌  $1"; FAIL=$((FAIL+1)); }

echo "========================================================"
echo "  CNPM Tuần 7 — Test V3.5: SSE Real-time Collaboration"
echo "========================================================"

# --------------------------------------------------------------------------
# 1. Build
# --------------------------------------------------------------------------
echo ""
echo "[1/6] Build..."
if make clean > /dev/null 2>&1 && make > /dev/null 2>&1; then
    pass "make clean && make thành công"
else
    fail "Build thất bại — dừng test"
    exit 1
fi

# --------------------------------------------------------------------------
# 2. Start server
# --------------------------------------------------------------------------
echo ""
echo "[2/6] Khởi động server..."
./server &
SERVER_PID=$!
sleep 1.2   # wait for it to bind

if kill -0 "$SERVER_PID" 2>/dev/null; then
    pass "Server đã khởi động (PID $SERVER_PID)"
else
    fail "Server không khởi động được"
    exit 1
fi

# --------------------------------------------------------------------------
# 3. Basic API sanity (inherited from V3)
# --------------------------------------------------------------------------
echo ""
echo "[3/6] Kiểm tra API cơ bản (V3 backward compatibility)..."

INFO=$(curl -sf "$BASE_URL/api/info")
if echo "$INFO" | grep -q -E '"version":"(V3\.5|V4)"'; then
    pass "/api/info trả về version V3.5 hoặc V4 (Backward Compatible)"
else
    fail "/api/info không chứa V3.5 — nhận được: $INFO"
fi

# Create a task via REST
CREATED=$(curl -sf -X POST "$BASE_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"SSE Test Task"}')
if echo "$CREATED" | grep -q '"title":"SSE Test Task"'; then
    pass "POST /api/tasks → task tạo thành công"
    TASK_ID=$(echo "$CREATED" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
    fail "POST /api/tasks thất bại — nhận được: $CREATED"
    TASK_ID=1
fi

# --------------------------------------------------------------------------
# 4. SSE Connection test — Client A & B connect
# --------------------------------------------------------------------------
echo ""
echo "[4/6] Kiểm tra kết nối SSE..."

# Start Client A SSE listener in background (collect 6 seconds of events)
curl -N -s --max-time 6 \
  "$BASE_URL/api/events?name=Client+A+Test" > /tmp/sse_a.log 2>&1 &
SSE_A_PID=$!

# Start Client B SSE listener
curl -N -s --max-time 6 \
  "$BASE_URL/api/events?name=Client+B+Test" > /tmp/sse_b.log 2>&1 &
SSE_B_PID=$!

sleep 1.5  # let SSE connections establish

# Check /api/clients
CLIENTS_JSON=$(curl -sf "$BASE_URL/api/clients")
# Extract numeric online_count regardless of whitespace in JSON
ONLINE_COUNT=$(echo "$CLIENTS_JSON" | tr -d ' \t\r\n' | grep -o '"online_count":[0-9]*' | cut -d: -f2)
if [ "${ONLINE_COUNT:-0}" -ge 2 ]; then
    pass "/api/clients thấy ${ONLINE_COUNT} client SSE online"
else
    fail "/api/clients chưa đủ 2 client — nhận được: $CLIENTS_JSON"
fi

# Verify SSE headers / stream started for A
if [ -s /tmp/sse_a.log ]; then
    pass "Client A nhận được SSE stream data"
else
    fail "Client A không nhận được dữ liệu SSE"
fi

# --------------------------------------------------------------------------
# 5. Broadcast events — create, update, delete via REST → check SSE logs
# --------------------------------------------------------------------------
echo ""
echo "[5/6] Kiểm tra broadcast event SSE..."

# Create second task — both listeners should get task_created
NEW_TASK=$(curl -sf -X POST "$BASE_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"Broadcast SSE task"}')
NEW_ID=$(echo "$NEW_TASK" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
sleep 0.6

if grep -q "task_created" /tmp/sse_a.log 2>/dev/null; then
    pass "Client A nhận event task_created"
else
    fail "Client A không nhận task_created — log: $(cat /tmp/sse_a.log | head -10)"
fi

if grep -q "task_created" /tmp/sse_b.log 2>/dev/null; then
    pass "Client B nhận event task_created"
else
    fail "Client B không nhận task_created — log: $(cat /tmp/sse_b.log | head -10)"
fi

# Update task → task_updated
if [ -n "${NEW_ID:-}" ] && [ "$NEW_ID" -gt 0 ] 2>/dev/null; then
    curl -sf -X PUT "$BASE_URL/api/tasks/$NEW_ID" \
      -H "Content-Type: application/json" \
      -d '{"completed":true}' > /dev/null
    sleep 0.6
    if grep -q "task_updated" /tmp/sse_b.log 2>/dev/null; then
        pass "Client B nhận event task_updated"
    else
        fail "Client B không nhận task_updated"
    fi

    # Delete task → task_deleted
    curl -sf -X DELETE "$BASE_URL/api/tasks/$NEW_ID" > /dev/null
    sleep 0.6
    if grep -q "task_deleted" /tmp/sse_a.log 2>/dev/null || \
       grep -q "task_deleted" /tmp/sse_b.log 2>/dev/null; then
        pass "Nhận event task_deleted"
    else
        fail "Không nhận task_deleted event"
    fi
else
    fail "Không lấy được NEW_ID để test update/delete"
fi

# --------------------------------------------------------------------------
# 6. client_joined event check
# --------------------------------------------------------------------------
echo ""
echo "[6/6] Kiểm tra client_joined/left event..."

if grep -q "client_joined" /tmp/sse_a.log 2>/dev/null || \
   grep -q "client_joined" /tmp/sse_b.log 2>/dev/null; then
    pass "SSE phát event client_joined khi client mới kết nối"
else
    fail "Không nhận được client_joined event"
fi

# Wait for curl listeners to finish
wait "$SSE_A_PID" 2>/dev/null || true
wait "$SSE_B_PID" 2>/dev/null || true

echo ""
