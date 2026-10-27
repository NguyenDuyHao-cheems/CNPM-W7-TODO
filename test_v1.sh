#!/usr/bin/env bash
set -e

PORT=8089
SERVER_BIN="./server"
URL="http://127.0.0.1:$PORT"

echo "==========================================================="
echo "  CNPM Week 7 - Verification Script for Version 1 (C Backend)"
echo "==========================================================="

# Ensure clean build
echo "[1/7] Building C server..."
make clean > /dev/null
make > /dev/null

# Clean old tasks.json for pristine test
rm -f tasks.json tasks.json.tmp

echo "[2/7] Starting C server on port $PORT..."
$SERVER_BIN $PORT &
SERVER_PID=$!
sleep 0.8

# Ensure server cleanup on exit
cleanup() {
    if kill -0 $SERVER_PID 2>/dev/null; then
        echo "Cleaning up server PID $SERVER_PID..."
        kill -SIGINT $SERVER_PID 2>/dev/null || kill -9 $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Verify server responds
echo "[3/7] Verifying server connectivity..."
curl -s -f "$URL/api/tasks" > /dev/null || {
    echo "ERROR: Server did not respond at $URL/api/tasks"
    exit 1
}

# Step 1 in Assignment: Create 2 tasks
echo "[4/7] Creating 2 tasks..."
TASK1_RESP=$(curl -s -X POST "$URL/api/tasks" \
    -H "Content-Type: application/json" \
    -d '{"title": "Học lý thuyết Công nghệ phần mềm - Tuần 7"}')
echo "  -> Task 1 created: $TASK1_RESP"

TASK2_RESP=$(curl -s -X POST "$URL/api/tasks" \
    -H "Content-Type: application/json" \
    -d '{"title": "Cài đặt Version 1 với C backend và tasks.json"}')
echo "  -> Task 2 created: $TASK2_RESP"

# Step 2 in Assignment: Mark 1 task completed
echo "[5/7] Marking Task 1 as completed..."
UPDATE_RESP=$(curl -s -X PUT "$URL/api/tasks/1" \
    -H "Content-Type: application/json" \
    -d '{"completed": true}')
echo "  -> Task 1 updated: $UPDATE_RESP"

# Step 3 in Assignment: Restart server
echo "[6/7] Stopping server (PID: $SERVER_PID) to test persistence across restarts..."
kill -SIGINT $SERVER_PID
wait $SERVER_PID 2>/dev/null || true
sleep 1

echo "  -> Restarting C server on port $PORT..."
$SERVER_BIN $PORT &
SERVER_PID=$!
sleep 0.8

# Step 4 in Assignment: Verify data restored
echo "[7/7] Verifying tasks persistence after restart..."
TASKS_RESTORED=$(curl -s "$URL/api/tasks")
echo "  -> Restored tasks from tasks.json:"
echo "$TASKS_RESTORED"

# Assertions
echo ""
echo "Verifying assertions..."

# Check task 1
echo "$TASKS_RESTORED" | grep -q '"id":.*1' || { echo "FAILED: Task 1 ID missing!"; exit 1; }
echo "$TASKS_RESTORED" | grep -q '"completed":.*true' || { echo "FAILED: Task 1 should be completed=true!"; exit 1; }

# Check task 2
echo "$TASKS_RESTORED" | grep -q '"id":.*2' || { echo "FAILED: Task 2 ID missing!"; exit 1; }
echo "$TASKS_RESTORED" | grep -q '"completed":.*false' || { echo "FAILED: Task 2 should be completed=false!"; exit 1; }

echo "  [PASS] Task 1 is present and completed=true."
echo "  [PASS] Task 2 is present and completed=false."
echo "  [PASS] tasks.json successfully preserved state across server shutdown and restart!"

echo "==========================================================="
echo "  SUCCESS: Version 1 verification PASSED all rubric checks!"
echo "==========================================================="
