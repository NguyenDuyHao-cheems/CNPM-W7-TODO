#!/usr/bin/env bash
set -e

PORT=8080
NGROK_BIN="$HOME/.local/bin/ngrok"

if [ ! -f "$NGROK_BIN" ]; then
    NGROK_BIN=$(which ngrok 2>/dev/null || true)
fi

if [ -z "$NGROK_BIN" ] || [ ! -x "$NGROK_BIN" ]; then
    echo "ERROR: ngrok binary not found at $HOME/.local/bin/ngrok or in PATH."
    exit 1
fi

echo "==========================================================="
echo "  CNPM Week 7 - Starting Version 2 Server & Ngrok Tunnel"
echo "==========================================================="

# Ensure backend server is compiled
if [ ! -f "./server" ]; then
    echo "Compiling C backend server..."
    make
fi

# Check if server is already running on PORT
if ! curl -s "http://127.0.0.1:$PORT/api/info" > /dev/null 2>&1; then
    echo "Starting C server on port $PORT..."
    ./server $PORT &
    SERVER_PID=$!
    sleep 0.8
else
    echo "C server is already running on port $PORT."
    SERVER_PID=""
fi

# Kill any existing ngrok process
killall ngrok 2>/dev/null || true
sleep 0.5

echo "Starting ngrok tunnel for port $PORT..."
"$NGROK_BIN" http $PORT --log=stdout > /tmp/ngrok.log 2>&1 &
NGROK_PID=$!

cleanup() {
    echo ""
    echo "Shutting down ngrok tunnel and server..."
    kill -SIGINT $NGROK_PID 2>/dev/null || true
    if [ -n "$SERVER_PID" ]; then
        kill -SIGINT $SERVER_PID 2>/dev/null || true
    fi
    echo "Exited cleanly."
}
trap cleanup EXIT INT TERM

# Wait for ngrok API to become available
echo "Waiting for ngrok public tunnel..."
PUBLIC_URL=""
for i in {1..20}; do
    sleep 0.5
    TUNNELS=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null || true)
    PUBLIC_URL=$(echo "$TUNNELS" | grep -o 'https://[^"]*ngrok-free.dev' | head -n 1 || true)
    if [ -z "$PUBLIC_URL" ]; then
        PUBLIC_URL=$(echo "$TUNNELS" | grep -o 'https://[^"]*ngrok.app' | head -n 1 || true)
    fi
    if [ -z "$PUBLIC_URL" ]; then
        PUBLIC_URL=$(echo "$TUNNELS" | grep -o 'https://[^"]*ngrok.io' | head -n 1 || true)
    fi
    if [ -n "$PUBLIC_URL" ]; then
        break
    fi
done

if [ -z "$PUBLIC_URL" ]; then
    echo "Failed to retrieve public URL from ngrok API."
    echo "Check log at /tmp/ngrok.log"
    cat /tmp/ngrok.log | tail -n 15
    exit 1
fi

echo ""
echo "================================================================"
echo "  🎉 PHIÊN BẢN 2 (VERSION 2) - CLIENT-SERVER ĐÃ SẴN SÀNG!"
echo "================================================================"
echo "  Truy cập cục bộ (Localhost):"
echo "  👉  http://localhost:$PORT"
echo ""
echo "  Truy cập công khai qua Internet (Ngrok Multi-Client):"
echo "  👉  $PUBLIC_URL"
echo ""
echo "  HƯỚNG DẪN KIỂM CHỨNG THEO ĐỀ BÀI:"
echo "  1. Mở '$PUBLIC_URL' trên trình duyệt máy tính (Client A)."
echo "  2. Mở '$PUBLIC_URL' trên điện thoại hoặc trình duyệt khác (Client B)."
echo "  3. Máy A thêm task -> Sau 2.5s máy B sẽ tự động nhận được task."
echo "  4. Máy B bấm hoàn thành -> Máy A sẽ tự động cập nhật trạng thái."
echo "================================================================"
echo "  Nhấn Ctrl+C để dừng ngrok và server."
echo "================================================================"

# Wait indefinitely
wait $NGROK_PID
