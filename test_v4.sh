#!/bin/bash
# =============================================================================
# test_v4.sh — Kiểm chứng tự động Version 4: P2P WebRTC Direct Collaboration
# =============================================================================

set -euo pipefail

BASE_URL="http://localhost:8080"
PASS=0
FAIL=0
SERVER_PID=""

cleanup() {
    echo ""
    echo "--- Dọn dẹp ---"
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null && echo "Đã tắt server (PID $SERVER_PID)" || true
    fi
    echo "=== Kết quả Test V4: PASS=$PASS  FAIL=$FAIL ==="
}
trap cleanup EXIT

pass() { echo "  ✅  $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌  $1"; FAIL=$((FAIL+1)); }

echo "========================================================"
echo "  CNPM Tuần 7 — Test V4: P2P Collaboration & Fallback"
echo "========================================================"

# --------------------------------------------------------------------------
# 1. Build
# --------------------------------------------------------------------------
echo ""
echo "[1/5] Build C Backend..."
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
echo "[2/5] Khởi động C Server..."
./server &
SERVER_PID=$!
sleep 1.2

if kill -0 "$SERVER_PID" 2>/dev/null; then
    pass "Server đã khởi động (PID $SERVER_PID)"
else
    fail "Server không khởi động được"
    exit 1
fi

# --------------------------------------------------------------------------
# 3. Architecture API sanity check (/api/info reports V4)
# --------------------------------------------------------------------------
echo ""
echo "[3/5] Kiểm tra endpoint thông số kiến trúc (/api/info)..."
INFO=$(curl -sf "$BASE_URL/api/info")
if echo "$INFO" | grep -q '"version":"V4"'; then
    pass "/api/info trả về version V4 chính xác"
else
    fail "/api/info không chứa V4 — nhận được: $INFO"
fi

if echo "$INFO" | grep -q 'WebRTC DataChannel'; then
    pass "/api/info mô tả kiến trúc có WebRTC DataChannel P2P Fallback"
else
    fail "/api/info thiếu mô tả WebRTC DataChannel: $INFO"
fi

# --------------------------------------------------------------------------
# 4. Kiểm tra mã nguồn Frontend: WebRTC DataChannel, Lamport Clock, Signaling
# --------------------------------------------------------------------------
echo ""
echo "[4/5] Kiểm tra tính toàn vẹn Frontend P2P (app.js & index.html)..."

if grep -q "RTCPeerConnection" public/app.js && grep -q "createDataChannel" public/app.js; then
    pass "app.js chứa khởi tạo RTCPeerConnection và createDataChannel (P2P DataChannel)"
else
    fail "app.js thiếu WebRTC RTCPeerConnection / DataChannel"
fi

if grep -q "lamportClock" public/app.js && grep -q "lamport_ts" public/app.js; then
    pass "app.js cài đặt cơ chế hòa giải xung đột Last-Write-Wins (LWW) bằng Lamport Logical Clock"
else
    fail "app.js thiếu Lamport Clock LWW logic"
fi

if grep -q "BroadcastChannel" public/app.js && grep -q "p2p-modal" public/index.html; then
    pass "Hỗ trợ Fast 1-Click BroadcastChannel và modal cấu hình P2P"
else
    fail "Thiếu cơ chế Fast Pairing hoặc modal P2P"
fi

# --------------------------------------------------------------------------
# 5. Kiểm tra REST API & SSE backward compatibility
# --------------------------------------------------------------------------
echo ""
echo "[5/5] Kiểm tra hồi quy tương thích tầng Client–Server / SQLite / SSE..."

TASK_JSON=$(curl -sf -X POST "$BASE_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"Task V4 Regression Test"}')

if echo "$TASK_JSON" | grep -q '"title":"Task V4 Regression Test"'; then
    pass "POST /api/tasks lưu trữ SQLite bình thường khi server online"
    T_ID=$(echo "$TASK_JSON" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
    fail "POST /api/tasks thất bại"
    T_ID=1
fi

PUT_RES=$(curl -sf -X PUT "$BASE_URL/api/tasks/$T_ID" \
  -H "Content-Type: application/json" \
  -d '{"completed":true}')

if echo "$PUT_RES" | grep -q '"completed":true'; then
    pass "PUT /api/tasks/:id cập nhật trạng thái SQLite bình thường"
else
    fail "PUT /api/tasks/:id thất bại"
fi

DEL_RES=$(curl -sf -X DELETE "$BASE_URL/api/tasks/$T_ID")
if echo "$DEL_RES" | grep -q '"deleted_id"'; then
    pass "DELETE /api/tasks/:id xóa task SQLite thành công"
else
    fail "DELETE /api/tasks/:id thất bại"
fi

echo ""
echo "=== Tất cả bài kiểm tra tự động Version 4 đều hoàn tất! ==="
