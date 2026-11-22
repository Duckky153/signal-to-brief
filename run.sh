#!/bin/sh
# Start Signal to Brief on this computer. It is a static page; this only serves the site folder locally.
set -eu
cd "$(dirname "$0")"
PORT="${PORT:-5112}"
echo "Signal to Brief: http://127.0.0.1:$PORT/  (Control-C stops it)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory site
