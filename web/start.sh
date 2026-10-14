#!/bin/sh
cd "$(dirname "$0")"
echo "Berk Engine: http://localhost:8902"
(command -v xdg-open >/dev/null && xdg-open http://localhost:8902 >/dev/null 2>&1 &) || (command -v open >/dev/null && open http://localhost:8902 &) || true
exec python3 -m http.server 8902
