#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "=== TypeScript tests ==="
./node_modules/.bin/tsx --test tests/*.test.ts

echo ""
echo "=== Python tests ==="
cd python && uv run pytest tests/ -v
