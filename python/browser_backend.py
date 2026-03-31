"""Browser backend abstraction for evaluate.py.

Provides a Protocol that evaluate.py programs against, with two
concrete implementations:

- AgentBrowserBackend  — wraps agent-browser CLI (default)
- PlaywrightCLIBackend — wraps playwright-cli (alternative)

Select backend via --browser-backend flag or AUTOCRIT_BROWSER_BACKEND env var.
"""

import os
import re
import shlex
import subprocess
from typing import Protocol


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

class BrowserBackend(Protocol):
    """Abstraction over browser automation CLI tools."""

    name: str
    """Identifier: 'agent-browser' or 'playwright-cli'."""

    supports_vision: bool
    """True if the backend can produce annotated screenshots for vision mode."""

    def open(self, url: str) -> str: ...
    def snapshot(self, flags: str = "") -> str: ...
    def snapshot_scoped(self, ref: str) -> str: ...
    def click(self, ref: str) -> str: ...
    def fill(self, ref: str, text: str) -> str: ...
    def select(self, ref: str, value: str) -> str: ...
    def press(self, key: str) -> str: ...
    def scroll(self, direction: str, ref: str | None = None) -> str: ...
    def scrollintoview(self, ref: str) -> str: ...
    def screenshot(self, path: str) -> str: ...
    def screenshot_annotated(self, path: str) -> tuple[str, str]: ...
    def wait(self, ms: int | None = None) -> None: ...
    def close(self) -> str: ...
    def eval_js(self, js: str, ref: str | None = None) -> str: ...


# ---------------------------------------------------------------------------
# Shared shell-out helper
# ---------------------------------------------------------------------------

def _shell(cmd: str, retry: bool = True, timeout: int = 30) -> str:
    """Run a CLI command. Returns stdout. Retries once on failure."""
    try:
        result = subprocess.run(
            shlex.split(cmd), capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            if retry:
                return _shell(cmd, retry=False, timeout=timeout)
            return f"[browser error] {result.stderr.strip()}"
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        if retry:
            return _shell(cmd, retry=False, timeout=timeout)
        return "[browser error] timeout"
    except Exception as e:
        return f"[browser error] {e}"


# ---------------------------------------------------------------------------
# AgentBrowserBackend
# ---------------------------------------------------------------------------

class AgentBrowserBackend:
    """Backend wrapping the agent-browser CLI (https://github.com/vercel-labs/agent-browser)."""

    name = "agent-browser"
    supports_vision = True

    def __init__(self, session: str | None = None) -> None:
        self._session = f" --session {session}" if session else ""

    def _run(self, cmd: str, **kwargs) -> str:
        return _shell(f"agent-browser {cmd}{self._session}", **kwargs)

    # -- Navigation --

    def open(self, url: str) -> str:
        return self._run(f"open {url}")

    # -- Observation --

    def snapshot(self, flags: str = "") -> str:
        cmd = f"snapshot {flags}".strip()
        return self._run(cmd)

    def snapshot_scoped(self, ref: str) -> str:
        # agent-browser supports --selector with CSS selectors only, not refs.
        # Use the [role=dialog] heuristic for modals; for arbitrary refs we
        # fall back to a full snapshot (the caller should pass a CSS selector
        # string when possible).
        if ref.startswith("[") or ref.startswith(".") or ref.startswith("#"):
            return self._run(f'snapshot --selector "{ref}"')
        # For role-based scoping (e.g. "dialog") wrap in attribute selector
        return self._run(f'snapshot --selector "[role={ref}]"')

    def screenshot(self, path: str) -> str:
        return self._run(f"screenshot {path}")

    def screenshot_annotated(self, path: str) -> tuple[str, str]:
        output = self._run(f"screenshot --annotate {path}")
        legend = output if not output.startswith("[browser error]") else ""
        return path, legend

    # -- Actions --

    def click(self, ref: str) -> str:
        return self._run(f"click @{ref}")

    def fill(self, ref: str, text: str) -> str:
        escaped = text.replace("'", "'\\''")
        return self._run(f"fill @{ref} '{escaped}'")

    def select(self, ref: str, value: str) -> str:
        escaped = value.replace("'", "'\\''")
        return self._run(f"select @{ref} '{escaped}'")

    def press(self, key: str) -> str:
        return self._run(f"press {key}")

    def scroll(self, direction: str = "down", ref: str | None = None) -> str:
        if ref:
            # scrollintoview is more reliable for in-container scrolling
            return self.scrollintoview(ref)
        return self._run(f"scroll {direction}")

    def scrollintoview(self, ref: str) -> str:
        return self._run(f"scrollintoview @{ref}")

    # -- Waits --

    def wait(self, ms: int | None = None) -> None:
        if ms is not None:
            self._run(f"wait {ms}")
        else:
            self._run("wait --load networkidle")
            self._run("wait 200")

    # -- Utilities --

    def eval_js(self, js: str, ref: str | None = None) -> str:
        # agent-browser eval is page-level; no per-element targeting by ref
        return self._run(f'eval "{js}"')

    def close(self) -> str:
        return self._run("close")


# ---------------------------------------------------------------------------
# PlaywrightCLIBackend
# ---------------------------------------------------------------------------

class PlaywrightCLIBackend:
    """Backend wrapping playwright-cli (https://github.com/microsoft/playwright-cli).

    Always operates in text/snapshot mode — no annotated screenshots.
    playwright-cli is optimised for accessibility-tree-based agents.
    """

    name = "playwright-cli"
    supports_vision = False

    def __init__(self, session: str = "autocrit") -> None:
        self._session = session

    def _run(self, cmd: str, **kwargs) -> str:
        return _shell(f"playwright-cli -s={self._session} {cmd}", **kwargs)

    # -- Navigation --

    def open(self, url: str) -> str:
        return self._run(f"open {url} --headless")

    # -- Observation --

    def snapshot(self, flags: str = "") -> str:
        # playwright-cli emits snapshot to stdout and also saves to a file.
        # We read from stdout like agent-browser.
        result = self._run("snapshot")
        # playwright-cli output includes a metadata header (Page URL, Title)
        # followed by a file reference.  When output is on stdout the full
        # snapshot is printed.  If it instead only contains a file ref, read it.
        snapshot_path = self._parse_snapshot_path(result)
        if snapshot_path and os.path.exists(snapshot_path):
            with open(snapshot_path) as f:
                return f.read()
        return result

    def snapshot_scoped(self, ref: str) -> str:
        """Snapshot a specific element by ref — killer feature for modals."""
        result = self._run(f"snapshot {ref}")
        snapshot_path = self._parse_snapshot_path(result)
        if snapshot_path and os.path.exists(snapshot_path):
            with open(snapshot_path) as f:
                return f.read()
        return result

    def screenshot(self, path: str) -> str:
        return self._run(f"screenshot --filename={path}")

    def screenshot_annotated(self, path: str) -> tuple[str, str]:
        # Vision mode not supported.  Provide a plain screenshot and the
        # accessibility snapshot as a pseudo-legend for fallback callers.
        self._run(f"screenshot --filename={path}")
        legend = self._run("snapshot")
        return path, legend

    # -- Actions --

    def click(self, ref: str) -> str:
        return self._run(f"click {ref}")

    def fill(self, ref: str, text: str) -> str:
        escaped = text.replace('"', '\\"')
        return self._run(f'fill {ref} "{escaped}"')

    def select(self, ref: str, value: str) -> str:
        escaped = value.replace('"', '\\"')
        return self._run(f'select {ref} "{escaped}"')

    def press(self, key: str) -> str:
        return self._run(f"press {key}")

    def scroll(self, direction: str = "down", ref: str | None = None) -> str:
        if ref:
            # Scroll inside a specific element via eval on its ref
            delta = 300 if direction in ("down", "right") else -300
            if direction in ("up", "down"):
                return self._run(f'eval "el => el.scrollBy(0, {delta})" {ref}')
            return self._run(f'eval "el => el.scrollBy({delta}, 0)" {ref}')
        # Page-level scroll via mousewheel
        dy = 300 if direction == "down" else -300 if direction == "up" else 0
        dx = 300 if direction == "right" else -300 if direction == "left" else 0
        return self._run(f"mousewheel {dx} {dy}")

    def scrollintoview(self, ref: str) -> str:
        # playwright-cli doesn't have a dedicated scrollintoview; use eval
        return self._run(f'eval "el => el.scrollIntoView({{block: \'center\'}})" {ref}')

    # -- Waits --

    def wait(self, ms: int | None = None) -> None:
        if ms is not None:
            # playwright-cli wait takes seconds
            secs = max(ms / 1000, 0.1)
            self._run(f"wait {secs}")
        # playwright-cli auto-waits after commands; explicit networkidle
        # is rarely needed.

    # -- Utilities --

    def eval_js(self, js: str, ref: str | None = None) -> str:
        if ref:
            return self._run(f'eval "{js}" {ref}')
        return self._run(f'eval "{js}"')

    def close(self) -> str:
        return self._run("close")

    # -- Internal helpers --

    @staticmethod
    def _parse_snapshot_path(output: str) -> str | None:
        """Extract a snapshot file path from playwright-cli output."""
        # playwright-cli emits lines like:
        #   [Snapshot](.playwright-cli/page-2026-03-31T12-00-00-000Z.yml)
        match = re.search(r"\[Snapshot\]\(([^)]+)\)", output)
        if match:
            return match.group(1)
        return None


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

BACKENDS: dict[str, type] = {
    "agent-browser": AgentBrowserBackend,
    "playwright-cli": PlaywrightCLIBackend,
}

def create_backend(name: str | None = None, **kwargs) -> BrowserBackend:
    """Create a browser backend by name.

    Falls back to AUTOCRIT_BROWSER_BACKEND env var, then 'agent-browser'.
    """
    name = name or os.environ.get("AUTOCRIT_BROWSER_BACKEND", "agent-browser")
    cls = BACKENDS.get(name)
    if cls is None:
        available = ", ".join(BACKENDS)
        raise ValueError(f"Unknown browser backend: {name!r}. Available: {available}")
    return cls(**kwargs)
