#!/bin/bash
set -euo pipefail

# pi-autocrit dependency checker and installer
# Run this to verify all required dependencies are available.

echo "Checking pi-autocrit dependencies..."
echo ""

MISSING=0

# git
if command -v git &>/dev/null; then
    echo "✅ git $(git --version | head -1)"
else
    echo "❌ git — install from https://git-scm.com/"
    MISSING=1
fi

# agent-browser
if command -v agent-browser &>/dev/null; then
    echo "✅ agent-browser"
else
    echo "❌ agent-browser — install: npm install -g agent-browser && agent-browser install"
    MISSING=1
fi

# uv (preferred Python runner)
if command -v uv &>/dev/null; then
    echo "✅ uv $(uv --version 2>/dev/null || echo '(version unknown)')"
else
    # Fallback: python3
    if command -v python3 &>/dev/null; then
        echo "⚠️  uv not found, but python3 is available ($(python3 --version))"
        echo "   For best experience: curl -LsSf https://astral.sh/uv/install.sh | sh"
    else
        echo "❌ uv or python3 — install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
        MISSING=1
    fi
fi

# Node.js (for Vite dev server)
if command -v node &>/dev/null; then
    echo "✅ node $(node --version)"
else
    echo "❌ node — install from https://nodejs.org/ or use fnm/nvm"
    MISSING=1
fi

# pnpm (preferred, optional)
if command -v pnpm &>/dev/null; then
    echo "✅ pnpm $(pnpm --version)"
else
    echo "ℹ️  pnpm not found (optional, npm will be used instead)"
fi

echo ""

if [ $MISSING -eq 0 ]; then
    echo "All dependencies satisfied! ✅"
    echo ""
    echo "To use pi-autocrit:"
    echo "  pi install /path/to/pi-autocrit"
    echo "  # or"
    echo "  pi -e /path/to/pi-autocrit"
    echo ""
    echo "Then in pi:"
    echo "  /skill:autocrit"
else
    echo "Some dependencies are missing. Install them and run this script again."
    exit 1
fi
