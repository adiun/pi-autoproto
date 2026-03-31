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

# Browser backend (agent-browser or playwright-cli)
BROWSER_BACKEND=${AUTOCRIT_BROWSER_BACKEND:-agent-browser}
if [ "$BROWSER_BACKEND" = "playwright-cli" ]; then
    if command -v playwright-cli &>/dev/null; then
        echo "✅ playwright-cli"
        # Verify chromium is installed for the CLI's bundled Playwright version.
        # @playwright/cli bundles its own Playwright, which may differ from any
        # project-local version. chromium must be installed for the CLI's version.
        CLI_PKG=$(node -e "console.log(require.resolve('@playwright/cli/package.json'))" 2>/dev/null)
        if [ -n "$CLI_PKG" ]; then
            CLI_DIR=$(dirname "$CLI_PKG")
            PW_CLI="$CLI_DIR/node_modules/playwright/cli.js"
            if [ -f "$PW_CLI" ]; then
                # Check if chromium is already installed by looking at the registry
                CHROMIUM_CHECK=$(PLAYWRIGHT_MCP_BROWSER=chromium playwright-cli -s=__setup_check open about:blank 2>&1 || true)
                playwright-cli -s=__setup_check close 2>/dev/null || true
                if echo "$CHROMIUM_CHECK" | grep -qi "not found\|Run \"npx playwright install"; then
                    echo "⚠️  chromium not installed for playwright-cli's Playwright version"
                    echo "   Installing chromium via $PW_CLI ..."
                    if node "$PW_CLI" install chromium; then
                        echo "✅ chromium installed for playwright-cli"
                    else
                        echo "❌ chromium install failed. Manual fix:"
                        echo "   node $PW_CLI install chromium"
                        MISSING=1
                    fi
                else
                    echo "✅ chromium (for playwright-cli)"
                fi
            else
                echo "⚠️  Could not find playwright/cli.js in playwright-cli's node_modules"
                echo "   Expected at: $PW_CLI"
                echo "   chromium may not be installed for the correct version"
            fi
        else
            echo "⚠️  Could not resolve @playwright/cli package path"
        fi
    else
        echo "❌ playwright-cli — install: npm install -g @playwright/cli@latest"
        MISSING=1
    fi
else
    if command -v agent-browser &>/dev/null; then
        echo "✅ agent-browser"
    else
        echo "❌ agent-browser — install: npm install -g agent-browser && agent-browser install"
        MISSING=1
    fi
    # Also check if playwright-cli is available as an alternative
    if command -v playwright-cli &>/dev/null; then
        echo "ℹ️  playwright-cli also available (use AUTOCRIT_BROWSER_BACKEND=playwright-cli to switch)"
    fi
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
