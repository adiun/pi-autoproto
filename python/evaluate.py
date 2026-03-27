"""Autodev evaluation engine — persona agent drives agent-browser and scores the app."""

import argparse
import http.server
import json
import os
import re
import shlex
import shutil
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.request

from persona_parser import Persona, PersonaTask, PersonaVariant, TaskResult, compute_composite, parse

DEFAULT_MAX_STEPS = 15


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

def _load_env_file() -> None:
    """Load KEY=value pairs from .env file into os.environ (if file exists)."""
    try:
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                value = value.strip().strip('"').strip("'")
                os.environ.setdefault(key.strip(), value)
    except FileNotFoundError:
        pass


def _find_free_port() -> int:
    """Find and return an available TCP port."""
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def start_server(port: int, directory: str) -> http.server.HTTPServer:
    """Start a threaded HTTP server serving directory on port."""
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(
        *a, directory=directory, **k
    )
    server = http.server.HTTPServer(("", port), handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


def _use_pnpm() -> bool:
    """Return True if pnpm should be used (lock file exists or pnpm is on PATH)."""
    return os.path.exists("pnpm-lock.yaml") or shutil.which("pnpm") is not None


def ensure_packages_installed() -> None:
    """Run pnpm/npm install if node_modules/ is missing. Exit on failure."""
    if os.path.exists("node_modules"):
        return
    use_pnpm = _use_pnpm()
    cmd = ["pnpm", "install"] if use_pnpm else ["npm", "install"]
    print(f"Installing packages with {cmd[0]}...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"Error: {cmd[0]} install failed:\n{result.stderr[:500]}", file=sys.stderr)
        sys.exit(1)


def start_vite_server(port: int) -> subprocess.Popen:
    """Start Vite dev server on port, wait until ready, return the process handle."""
    runner = ["pnpm", "exec"] if _use_pnpm() else ["npx"]
    proc = subprocess.Popen(
        [*runner, "vp", "dev", "--port", str(port), "--strictPort", "--host", "localhost"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://localhost:{port}", timeout=1)
            return proc
        except Exception:
            if proc.poll() is not None:
                output = proc.stdout.read().decode() if proc.stdout else ""
                print(f"Error: Vite+ exited unexpectedly:\n{output[:500]}", file=sys.stderr)
                sys.exit(1)
            time.sleep(0.3)
    proc.terminate()
    print("Error: Vite+ dev server failed to start within 15s", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Browser helper
# ---------------------------------------------------------------------------

def run_browser(cmd: str, retry: bool = True) -> str:
    """Run an agent-browser command. Returns stdout. Retries once on failure."""
    try:
        result = subprocess.run(
            shlex.split(cmd), capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            if retry:
                return run_browser(cmd, retry=False)
            return f"[browser error] {result.stderr.strip()}"
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        if retry:
            return run_browser(cmd, retry=False)
        return "[browser error] timeout"
    except Exception as e:
        return f"[browser error] {e}"


def _wait_after_action(wait_ms: int | None = None, supplemental_ms: int = 200) -> None:
    """Wait for the page to settle after an action."""
    if wait_ms is not None:
        run_browser(f"agent-browser wait {wait_ms}")
    else:
        run_browser("agent-browser wait --load networkidle")
        if supplemental_ms > 0:
            run_browser(f"agent-browser wait {supplemental_ms}")


# ---------------------------------------------------------------------------
# LLM via CLI shell-out
# ---------------------------------------------------------------------------

def llm(prompt: str) -> str:
    """Send prompt to LLM via AUTOCRIT_EVAL_CMD. Returns response text."""
    cmd = os.environ.get("AUTOCRIT_EVAL_CMD")
    if not cmd:
        print("Error: No persona agent command configured.", file=sys.stderr)
        print("Options:", file=sys.stderr)
        print('  uv run evaluate.py --cmd "claude -p"', file=sys.stderr)
        print('  export AUTOCRIT_EVAL_CMD="claude -p"', file=sys.stderr)
        print("  echo 'AUTOCRIT_EVAL_CMD=\"claude -p\"' > .env", file=sys.stderr)
        sys.exit(1)

    cmd_parts = shlex.split(cmd)
    try:
        result = subprocess.run(
            cmd_parts,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError:
        print(f"Error: Command not found: {cmd_parts[0]}", file=sys.stderr)
        print(f"Is it installed? AUTOCRIT_EVAL_CMD={cmd}", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        raise RuntimeError("LLM command timed out after 120s")

    if result.returncode != 0:
        raise RuntimeError(
            f"LLM command failed (exit {result.returncode}): {result.stderr[:500]}"
        )
    return result.stdout.strip()


def _try_parse_json(text: str) -> dict | None:
    """Try to extract and parse a JSON object from text that may contain other content."""
    # Strip markdown fences
    cleaned = re.sub(r"```(?:json)?\s*\n?", "", text)
    cleaned = cleaned.strip()

    # Try parsing the whole thing first (cleanest case)
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        pass

    # Try to find a JSON object with regex (handles preamble/postamble)
    match = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", cleaned, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except (json.JSONDecodeError, ValueError):
            pass

    return None


def llm_json(prompt: str) -> dict:
    """Send prompt to LLM, parse JSON from response. Retries once if parsing fails."""
    response = llm(prompt)
    parsed = _try_parse_json(response)
    if parsed is not None:
        return parsed

    # Retry with correction
    retry_prompt = (
        prompt
        + "\n\nIMPORTANT: Your previous response was not valid JSON. "
        "Reply with ONLY a JSON object — no markdown fences, no explanation, just the raw JSON."
    )
    response = llm(retry_prompt)
    parsed = _try_parse_json(response)
    if parsed is not None:
        return parsed

    raise ValueError(
        f"Could not parse JSON from LLM response after retry: {response[:300]}"
    )


# ---------------------------------------------------------------------------
# Vision LLM via CLI shell-out
# ---------------------------------------------------------------------------

def llm_vision(prompt: str, image_path: str) -> str:
    """Send a prompt referencing an image to the LLM CLI.

    The CLI (e.g. claude -p) is multimodal and can read image files
    when given the absolute path.
    """
    abs_path = os.path.abspath(image_path)
    combined = f"Read and analyze this screenshot: {abs_path}\n\n{prompt}"
    return llm(combined)


def llm_vision_json(prompt: str, image_path: str) -> dict:
    """Send a prompt with an image, parse JSON from response. Retries once on parse failure."""
    response = llm_vision(prompt, image_path)
    parsed = _try_parse_json(response)
    if parsed is not None:
        return parsed

    retry_prompt = (
        prompt
        + "\n\nIMPORTANT: Your previous response was not valid JSON. "
        "Reply with ONLY a JSON object — no markdown fences, no explanation, just the raw JSON."
    )
    response = llm_vision(retry_prompt, image_path)
    parsed = _try_parse_json(response)
    if parsed is not None:
        return parsed

    raise ValueError(
        f"Could not parse JSON from vision LLM response after retry: {response[:300]}"
    )


# ---------------------------------------------------------------------------
# Annotated screenshot capture
# ---------------------------------------------------------------------------

def _capture_annotated_screenshot(step: int) -> tuple[str, str]:
    """Capture an annotated screenshot and return (png_path, legend_text).

    The legend maps [N] labels to element roles/names.
    """
    path = f"/tmp/autocrit_vision_step_{step}.png"
    output = run_browser(f"agent-browser screenshot --annotate {path}")
    # The legend is printed to stdout by agent-browser
    legend = output if not output.startswith("[browser error]") else ""
    return path, legend


# ---------------------------------------------------------------------------
# Vision-mode prompt builder
# ---------------------------------------------------------------------------

def _build_vision_prompt(
    persona: Persona, task: PersonaTask,
    legend: str, history: list[str],
) -> str:
    """Build the text portion of a vision-mode prompt."""
    history_text = ""
    if history:
        history_text = "\nYOUR PREVIOUS ACTIONS:\n"
        for i, h in enumerate(history, 1):
            history_text += f"Step {i}: {h}\n"

    return (
        f"You are {persona.name}, {persona.background}. {persona.agent_instructions}\n\n"
        f"You are testing a web app. You can see the actual screen in the screenshot.\n"
        f"Interactive elements have numbered labels [1], [2], etc. overlaid on them.\n"
        f"Use these as refs: [1] = @e1, [2] = @e2, and so on.\n\n"
        f"TASK: {task.goal}\n\n"
        f"ELEMENT LEGEND:\n{legend}\n"
        f"{history_text}\n"
        f"Look at the screenshot. Choose your next action. Reply with ONLY one JSON object:\n\n"
        f'{{"action": "click", "ref": "e3", "reasoning": "why"}}\n'
        f'{{"action": "fill", "ref": "e5", "text": "query", "reasoning": "why"}}\n'
        f'{{"action": "select", "ref": "e4", "value": "option_value", "reasoning": "why"}}\n'
        f'{{"action": "press", "key": "Enter", "reasoning": "why"}}\n'
        f'{{"action": "scroll", "direction": "down", "reasoning": "why"}}\n'
        f'{{"action": "done", "completed": true, "found_answer": "...", "notes": "..."}}\n'
        f'{{"action": "done", "completed": false, "stuck_reason": "what confused you"}}'
    )


# ---------------------------------------------------------------------------
# Interaction loop
# ---------------------------------------------------------------------------

def _build_prompt(
    persona: Persona, task: PersonaTask, snapshot: str, history: list[str]
) -> str:
    """Build a single combined prompt for the persona agent."""
    history_text = ""
    if history:
        history_text = "\nYOUR PREVIOUS ACTIONS:\n"
        for i, h in enumerate(history, 1):
            history_text += f"Step {i}: {h}\n"

    return (
        f"You are {persona.name}, {persona.background}. {persona.agent_instructions}\n\n"
        f"You are testing a web app. You can see the screen as an accessibility tree showing all visible content.\n"
        f"You interact by choosing actions.\n\n"
        f"TASK: {task.goal}\n\n"
        f"CURRENT SCREEN (accessibility tree):\n{snapshot}\n"
        f"{history_text}\n"
        f"Choose your next action. Reply with ONLY one JSON object:\n\n"
        f'To click an element:    {{"action": "click", "ref": "e3", "reasoning": "why"}}\n'
        f'To type into a field:   {{"action": "fill", "ref": "e5", "text": "query", "reasoning": "why"}}\n'
        f'To select a dropdown:   {{"action": "select", "ref": "e4", "value": "option_value", "reasoning": "why"}}\n'
        f'To press a key:         {{"action": "press", "key": "Enter", "reasoning": "why"}}\n'
        f'To scroll the page:     {{"action": "scroll", "direction": "down", "reasoning": "why"}}\n'
        f'To report success:      {{"action": "done", "completed": true, "found_answer": "...", "notes": "..."}}\n'
        f'To report giving up:    {{"action": "done", "completed": false, "stuck_reason": "what confused you"}}'
    )


def evaluate_task(
    task: PersonaTask, persona: Persona, port: int, verbose: bool,
    snapshot_flags: str = "-c",
    wait_after_action: bool = True,
    wait_ms: int | None = None,
    max_snapshot_chars: int = 25_000,
    screenshot_dir: str | None = None,
    vision: bool = False,
    max_steps: int = DEFAULT_MAX_STEPS,
    skip_feedback: bool = False,
    stats: bool = False,
) -> TaskResult:
    """Run one task through the persona agent interaction loop."""
    history: list[str] = []
    traces: list[dict] = []
    vision_tmp_files: list[str] = []
    timing: dict[str, float] = {}

    # Navigate to start page
    run_browser(f"agent-browser open http://localhost:{port}")

    completed = False
    found_answer = None
    stuck_points: list[str] = []
    notes = ""
    steps = 0
    total_prompt_chars = 0
    t_task_start = time.time()

    try:
        t_steps_start = time.time()
        for step in range(max_steps):
            steps = step + 1

            if vision:
                # Vision mode: annotated screenshot + legend
                # Only pre-wait on the first step; subsequent steps already waited after action
                if step == 0:
                    _wait_after_action(wait_ms=500)
                screenshot_path, legend = _capture_annotated_screenshot(steps)
                vision_tmp_files.append(screenshot_path)

                if screenshot_path.startswith("[browser error]") or not os.path.exists(screenshot_path):
                    stuck_points.append(f"Step {steps}: screenshot capture failed")
                    if verbose:
                        print(f"  Step {steps}: screenshot capture failed, retrying...")
                    continue

                if verbose:
                    print(f"  Step {steps}: screenshot captured ({len(legend)} chars legend)")

                prompt = _build_vision_prompt(persona, task, legend, history)
                total_prompt_chars += len(prompt)
                try:
                    action = llm_vision_json(prompt, screenshot_path)
                except Exception as e:
                    if verbose:
                        print(f"  Step {steps}: vision LLM error: {e}")
                    history.append(f"[LLM error] {e}")
                    traces.append({"step": steps, "error": str(e)})
                    continue
            else:
                # Text mode: full accessibility tree
                snapshot = run_browser(f"agent-browser snapshot {snapshot_flags}")
                if snapshot.startswith("[browser error]"):
                    stuck_points.append(f"Step {steps}: {snapshot}")
                    if verbose:
                        print(f"  Step {steps}: browser error, retrying...")
                    continue

                # Compress whitespace before truncation to reclaim snapshot budget
                snapshot = re.sub(r'\n{3,}', '\n\n', snapshot)
                snapshot = re.sub(r' +$', '', snapshot, flags=re.MULTILINE)

                if len(snapshot) > max_snapshot_chars:
                    snapshot = snapshot[:max_snapshot_chars] + f"\n[...truncated, {len(snapshot)} chars total]"

                if verbose:
                    snap_lines = snapshot.strip().split("\n")
                    print(f"  Step {steps}: snapshot ({len(snap_lines)} lines, {len(snapshot)} chars)")

                # Ask LLM what to do
                prompt = _build_prompt(persona, task, snapshot, history)
                total_prompt_chars += len(prompt)
                try:
                    action = llm_json(prompt)
                except Exception as e:
                    if verbose:
                        print(f"  Step {steps}: LLM error: {e}")
                    history.append(f"[LLM error] {e}")
                    traces.append({"step": steps, "error": str(e)})
                    continue

            act = action.get("action", "")
            reasoning = action.get("reasoning", "")
            traces.append({"step": steps, "action": action})

            if verbose:
                print(f"  Step {steps}: {act} — {reasoning}")

            if act == "done":
                completed = action.get("completed", False)
                found_answer = action.get("found_answer")
                notes = action.get("notes", action.get("stuck_reason", ""))
                if not completed:
                    stuck_points.append(notes)
                break
            elif act == "click":
                ref = action.get("ref", "")
                result = run_browser(f"agent-browser click @{ref}")
                if wait_after_action:
                    _wait_after_action(wait_ms)
                history.append(f"clicked @{ref} ({reasoning}) → {result[:80]}")
                if verbose:
                    print(f"    -> {result[:120]}")
            elif act == "fill":
                ref = action.get("ref", "")
                text = action.get("text", "")
                result = run_browser(f"agent-browser fill @{ref} '{text}'")
                if wait_after_action:
                    _wait_after_action(wait_ms)
                history.append(f"filled @{ref} with \"{text}\" ({reasoning}) → {result[:80]}")
                if verbose:
                    print(f"    -> {result[:120]}")
            elif act == "select":
                ref = action.get("ref", "")
                value = action.get("value", "")
                result = run_browser(f"agent-browser select @{ref} '{value}'")
                if wait_after_action:
                    _wait_after_action(wait_ms)
                history.append(f'selected @{ref} value "{value}" ({reasoning}) → {result[:80]}')
                if verbose:
                    print(f"    -> {result[:120]}")
            elif act == "press":
                key = action.get("key", "")
                result = run_browser(f"agent-browser press {key}")
                if wait_after_action:
                    _wait_after_action(wait_ms)
                history.append(f"pressed {key} ({reasoning}) → {result[:80]}")
                if verbose:
                    print(f"    -> {result[:120]}")
            elif act == "scroll":
                direction = action.get("direction", "down")
                result = run_browser(f"agent-browser scroll {direction}")
                history.append(f"scrolled {direction} ({reasoning}) → {result[:80]}")
                if verbose:
                    print(f"    -> {result[:120]}")
            else:
                history.append(f"[unknown action: {act}]")
        else:
            # Hit step limit
            stuck_points.append("Reached maximum step limit")

        timing["steps"] = time.time() - t_steps_start

        # Take screenshot if requested
        if screenshot_dir:
            os.makedirs(screenshot_dir, exist_ok=True)
            safe_name = re.sub(r'[^\w\-]', '_', task.name.lower())
            path = os.path.join(screenshot_dir, f"task_{task.number}_{safe_name}.png")
            run_browser(f"agent-browser screenshot {path}")

        # Score the task
        t_score_start = time.time()
        score = _score_task(task, persona, completed, steps, history, found_answer)
        timing["scoring"] = time.time() - t_score_start

        # Generate persona feedback and wishlist
        persona_feedback = ""
        wishlist: list[str] = []
        if not skip_feedback:
            t_feedback_start = time.time()
            persona_feedback, wishlist = _generate_persona_feedback(
                persona, task, history, completed
            )
            timing["feedback"] = time.time() - t_feedback_start

        timing["total"] = time.time() - t_task_start

        if stats:
            est_tokens = total_prompt_chars // 4
            parts = [f"{k}={v:.1f}s" for k, v in timing.items()]
            print(f"  [stats] Task {task.number}: {', '.join(parts)}, "
                  f"steps={steps}, ~{est_tokens} prompt tokens")

        return TaskResult(
            task=task,
            completed=completed,
            score=score,
            steps=steps,
            stuck_points=stuck_points,
            found_answer=found_answer,
            notes=notes,
            persona_feedback=persona_feedback,
            wishlist=wishlist,
        )
    finally:
        # Clean up vision temp files
        for tmp in vision_tmp_files:
            try:
                os.remove(tmp)
            except OSError:
                pass


def _score_task(
    task: PersonaTask,
    persona: Persona,
    completed: bool,
    steps: int,
    history: list[str],
    found_answer: str | None,
) -> float:
    """Score a completed task."""
    if task.evaluation_method == "task_completion":
        if not completed:
            return 0.0
        score = 100.0
        score -= max(0, (steps - 5) * 2)
        return max(0.0, score)

    elif task.evaluation_method == "output_review":
        criteria_text = "\n".join(f"- {c}" for c in task.success_criteria)
        history_text = "\n".join(history)
        try:
            result = llm_json(
                "You are an objective evaluator. Score how well a task was completed.\n\n"
                f"Success criteria:\n{criteria_text}\n\n"
                f"The user's interaction trace:\n{history_text}\n\n"
                f"The user found/saw: {found_answer}\n\n"
                f"Score 0-100 based on how many criteria are met.\n"
                f'Reply with ONLY a JSON object: {{"score": N, "criteria_met": [...], "criteria_missed": [...]}}'
            )
            return float(result.get("score", 0))
        except Exception:
            return 0.0

    return 0.0


def _generate_persona_feedback(
    persona: Persona,
    task: PersonaTask,
    history: list[str],
    completed: bool,
) -> tuple[str, list[str]]:
    """Ask the persona to reflect on their experience and express wishes.

    Returns (feedback_text, wishlist) in a single LLM call.
    """
    history_text = "\n".join(history) if history else "(no actions taken)"
    outcome = "completed the task" if completed else "gave up"
    try:
        result = llm_json(
            f"You are {persona.name}, {persona.background}\n\n"
            f"You just tried to: {task.goal}\n"
            f"Here's what happened:\n{history_text}\n\n"
            f"You {outcome}.\n\n"
            "Reply with a JSON object containing:\n"
            '1. "feedback": 2-4 sentences AS the persona. Explain your experience based on '
            "your daily life, job, and needs. What was good? What was frustrating? "
            "What would you tell the developer? Be specific. First person.\n"
            '2. "wishlist": 1-3 short "it would be nice if..." wishes from the persona\'s '
            "perspective. Things that would make this app fit better into your life. "
            "Be concrete and grounded in your daily routine, not generic feature requests.\n\n"
            'Example: {"feedback": "I liked that...", "wishlist": ["It would be nice if I could see my total before splitting the bill"]}'
        )
        feedback = result.get("feedback", "")
        wishlist = result.get("wishlist", [])
        if isinstance(wishlist, str):
            wishlist = [wishlist]
        return feedback, wishlist
    except Exception:
        # Fall back: try plain-text feedback, empty wishlist
        try:
            feedback = llm(
                f"You are {persona.name}, {persona.background}\n\n"
                f"You just tried to: {task.goal}\n"
                f"Here's what happened:\n{history_text}\n\n"
                f"You {outcome}.\n\n"
                "Write 2-4 sentences of feedback AS the persona. "
                "Explain your experience based on your daily life, job, and needs. "
                "What was good? What was frustrating? What would you tell the developer? "
                "Be specific. First person. Plain text, no JSON."
            )
            return feedback, []
        except Exception:
            return "", []


# ---------------------------------------------------------------------------
# Multi-run aggregation
# ---------------------------------------------------------------------------

def _aggregate_runs(all_runs: list[list[TaskResult]]) -> list[TaskResult]:
    """Aggregate multiple runs: majority vote for pass/fail, median for scores."""
    num_tasks = len(all_runs[0])
    aggregated = []
    for i in range(num_tasks):
        task_runs = [run[i] for run in all_runs]
        completions = [r.completed for r in task_runs]
        scores = [r.score for r in task_runs]
        majority_completed = sum(completions) > len(completions) / 2
        median_score = statistics.median(scores)

        # Merge stuck points and notes
        all_stuck = []
        for r in task_runs:
            all_stuck.extend(r.stuck_points)
        all_notes = [r.notes for r in task_runs if r.notes]

        # Take first non-empty persona feedback
        feedback = ""
        for r in task_runs:
            if r.persona_feedback:
                feedback = r.persona_feedback
                break

        # Merge wishlist items across runs with deduplication
        seen_wishes: set[str] = set()
        merged_wishlist: list[str] = []
        for r in task_runs:
            for wish in r.wishlist:
                normalized = wish.strip().lower()
                if normalized not in seen_wishes:
                    seen_wishes.add(normalized)
                    merged_wishlist.append(wish)

        aggregated.append(TaskResult(
            task=task_runs[0].task,
            completed=majority_completed,
            score=median_score,
            steps=round(statistics.median(r.steps for r in task_runs)),
            stuck_points=list(set(all_stuck)),
            found_answer=task_runs[0].found_answer,
            notes="; ".join(all_notes) if all_notes else "",
            persona_feedback=feedback,
            wishlist=merged_wishlist,
        ))
    return aggregated


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

def _calibrate(all_runs: list[list[TaskResult]], persona: Persona) -> dict:
    """Check scoring stability across runs."""
    composites = []
    for run in all_runs:
        result = compute_composite(run, persona)
        composites.append(result["composite"])

    mean = statistics.mean(composites)
    stdev = statistics.stdev(composites) if len(composites) > 1 else 0.0

    # Per-task agreement
    num_tasks = len(all_runs[0])
    agreements = {}
    for i in range(num_tasks):
        task_runs = [run[i] for run in all_runs]
        all_agree = len(set(r.completed for r in task_runs)) == 1
        task = task_runs[0].task
        agreements[f"Task {task.number}"] = "agree" if all_agree else "disagree"

    return {
        "mean": round(mean, 1),
        "stdev": round(stdev, 1),
        "composites": composites,
        "per_task_agreement": agreements,
    }


# ---------------------------------------------------------------------------
# Persona variants
# ---------------------------------------------------------------------------

def generate_variants(persona: Persona, n: int) -> list[PersonaVariant]:
    """Auto-generate N persona variants via LLM call.

    Each variant shares the core identity but differs in behavioral modifiers
    like patience, context, priorities, and tech comfort.
    """
    prompt = (
        f"You are designing user test participants based on this persona:\n\n"
        f"Name: {persona.name}\n"
        f"Role: {persona.role}\n"
        f"Background: {persona.background[:500]}\n"
        f"Tech savviness: {persona.tech_savviness}\n"
        f"Time pressure: {persona.time_pressure}\n"
        f"Context: {persona.context}\n\n"
        f"Generate {n} behavioral variants of this persona for user testing. "
        f"Each variant is the SAME person but in a different situation or mood "
        f"that affects how they use the app. Vary along these dimensions:\n"
        f"- Patience/time pressure (rushed vs relaxed)\n"
        f"- Exploration style (methodical vs impatient)\n"
        f"- Context (fresh vs exhausted, alone vs showing someone)\n"
        f"- Trust level (trusts the app vs double-checks everything)\n\n"
        f"Reply with ONLY a JSON object:\n"
        f'{{"variants": [\n'
        f'  {{"label": "Rushed {persona.name.split()[0]}", '
        f'"instruction_suffix": "2-3 sentences describing this variant\'s behavior...", '
        f'"trait_overrides": {{"time_pressure": "high"}}}},\n'
        f"  ...\n"
        f"]}}\n\n"
        f"Each instruction_suffix should be 2-3 sentences written as instructions "
        f"to the persona agent (e.g., 'You are exhausted after a double shift. "
        f"You want the answer NOW and will not explore menus.'). "
        f"Make variants genuinely different — they should produce different behavior."
    )
    result = llm_json(prompt)
    variants = []
    for i, v in enumerate(result.get("variants", [])[:n]):
        variants.append(PersonaVariant(
            variant_id=f"v{i + 1}",
            label=v.get("label", f"Variant {i + 1}"),
            instruction_suffix=v.get("instruction_suffix", ""),
            trait_overrides=v.get("trait_overrides", {}),
        ))
    return variants


# ---------------------------------------------------------------------------
# Convergence analysis
# ---------------------------------------------------------------------------

def analyze_convergence(
    variant_results: list[dict],
    persona: Persona,
) -> dict:
    """Analyze feedback convergence across persona variants.

    variant_results: list of per-variant result dicts, each containing
      "variant_id", "label", "composite_score", "tasks" (list of task result dicts)

    Returns convergence analysis dict.
    """
    num_variants = len(variant_results)
    if num_variants < 2:
        return {"note": "Convergence requires 2+ variants"}

    # Per-task analysis
    task_numbers = [t["number"] for t in variant_results[0]["tasks"]]
    per_task = {}
    all_feedback = []
    all_wishlist = []

    for task_num in task_numbers:
        task_data = []
        for vr in variant_results:
            for t in vr["tasks"]:
                if t["number"] == task_num:
                    task_data.append(t)
                    break

        completions = [t.get("completed", False) for t in task_data]
        scores = [t.get("score", 0) for t in task_data]
        feedbacks = [t.get("persona_feedback", "") for t in task_data if t.get("persona_feedback")]
        wishlists = []
        for t in task_data:
            wishlists.extend(t.get("wishlist", []))

        completion_rate = sum(completions) / len(completions)
        score_mean = statistics.mean(scores) if scores else 0
        score_stdev = statistics.stdev(scores) if len(scores) > 1 else 0

        # Completion agreement: 1.0 if all agree, 0.0 if perfect split
        completion_agreement = max(completion_rate, 1 - completion_rate)

        # Confidence score
        normalized_variance = score_stdev / 100 if score_stdev else 0
        confidence = (completion_agreement * 0.5) + ((1 - normalized_variance) * 0.5)

        task_name = task_data[0].get("name", f"Task {task_num}") if task_data else f"Task {task_num}"
        per_task[f"Task {task_num}: {task_name}"] = {
            "completion_rate": round(completion_rate, 2),
            "completion_agreement": round(completion_agreement, 2),
            "score_mean": round(score_mean, 1),
            "score_stdev": round(score_stdev, 1),
            "confidence": round(confidence, 2),
            "confidence_label": "high" if confidence >= 0.8 else "medium" if confidence >= 0.6 else "low",
        }

        all_feedback.extend(feedbacks)
        all_wishlist.extend(wishlists)

    # Overall agreement
    composites = [vr["composite_score"] for vr in variant_results]
    composite_mean = statistics.mean(composites)
    composite_stdev = statistics.stdev(composites) if len(composites) > 1 else 0
    overall_agreement = 1 - (composite_stdev / 100) if composite_stdev else 1.0

    # Bias detection: flag if all variants score high with no criticism
    bias_flags = []
    all_high = all(c > 80 for c in composites)
    if all_high and all_feedback:
        # Check for criticism keywords
        criticism_words = ["frustrat", "confus", "difficult", "hard to", "couldn't", "can't find",
                          "annoying", "slow", "broken", "wrong", "error", "unclear", "missing"]
        has_criticism = any(
            any(w in fb.lower() for w in criticism_words)
            for fb in all_feedback
        )
        if not has_criticism:
            bias_flags.append(
                "Possible positive bias: all variants scored >80 with no concrete criticism. "
                "Validate with real users."
            )

    # Vague feedback detection
    vague_indicators = ["nice", "good", "fine", "okay", "pretty good", "works well", "looks great"]
    vague_count = sum(
        1 for fb in all_feedback
        if any(v in fb.lower() for v in vague_indicators) and len(fb) < 100
    )
    if vague_count > len(all_feedback) * 0.5 and all_feedback:
        bias_flags.append(
            f"Low-signal feedback: {vague_count}/{len(all_feedback)} feedback items are vague. "
            "Consider more challenging tasks or more critical persona variants."
        )

    # Find strong signals (tasks where all or nearly all variants agree)
    strong_signals = []
    for task_key, task_analysis in per_task.items():
        if task_analysis["confidence_label"] == "high" and task_analysis["completion_rate"] < 0.5:
            strong_signals.append(f"{task_key}: {num_variants - round(task_analysis['completion_rate'] * num_variants)}/{num_variants} variants FAILED (high confidence)")
        elif task_analysis["confidence_label"] == "high" and task_analysis["completion_rate"] >= 0.8:
            strong_signals.append(f"{task_key}: {round(task_analysis['completion_rate'] * num_variants)}/{num_variants} variants PASSED (high confidence)")

    # Find interesting disagreements
    disagreements = []
    for task_key, task_analysis in per_task.items():
        if task_analysis["confidence_label"] == "low":
            disagreements.append(
                f"{task_key}: split signal (completion rate {task_analysis['completion_rate']}, "
                f"score stdev {task_analysis['score_stdev']})"
            )

    return {
        "overall_agreement": round(overall_agreement, 2),
        "composite_mean": round(composite_mean, 1),
        "composite_stdev": round(composite_stdev, 1),
        "per_task": per_task,
        "strong_signals": strong_signals,
        "disagreements": disagreements,
        "bias_flags": bias_flags,
        "wishlist_all": all_wishlist,
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def _print_results(
    task_results: list[TaskResult],
    scores: dict,
    quiet: bool,
    calibration: dict | None = None,
) -> None:
    """Print the evaluation results block."""
    print("\n--- EVALUATION RESULTS ---")
    print(f"composite_score: {scores['composite']}")
    print(f"p0_score: {scores['p0_score']}")
    print(f"p1_score: {scores['p1_score']}")
    print(f"p2_score: {scores['p2_score']}")
    print()
    print("TASK RESULTS:")
    for r in task_results:
        status = "PASS" if r.completed else "FAIL"
        detail = f"score={r.score}, steps={r.steps}"
        if r.stuck_points:
            detail += f", stuck_points={r.stuck_points}"
        print(f'Task {r.task.number} [{r.task.tier}] "{r.task.name}": {status} ({detail})')
        if r.persona_feedback:
            print(f'  Feedback: {r.persona_feedback}')
        if r.wishlist:
            for wish in r.wishlist:
                print(f'  Wish: {wish}')

    if calibration:
        print()
        if calibration["stdev"] > 5:
            print(
                f"WARNING: Evaluation unstable (stdev={calibration['stdev']}) "
                "— consider tightening success criteria in persona.md"
            )
        else:
            print(f"Calibration passed. Baseline: {calibration['mean']}")
        print(f"Per-task agreement: {calibration['per_task_agreement']}")

    print("--- END RESULTS ---")


def _write_json(
    task_results: list[TaskResult],
    scores: dict,
    calibration: dict | None = None,
    output_dir: str = ".",
) -> None:
    """Write detailed results to eval_results.json."""
    output = {
        "composite_score": scores["composite"],
        "p0_score": scores["p0_score"],
        "p1_score": scores["p1_score"],
        "p2_score": scores["p2_score"],
        "tasks": [],
    }
    for r in task_results:
        output["tasks"].append({
            "number": r.task.number,
            "name": r.task.name,
            "tier": r.task.tier,
            "completed": r.completed,
            "score": r.score,
            "steps": r.steps,
            "stuck_points": r.stuck_points,
            "found_answer": r.found_answer,
            "notes": r.notes,
            "persona_feedback": r.persona_feedback,
            "wishlist": r.wishlist,
        })
    if calibration:
        output["calibration"] = calibration

    with open(os.path.join(output_dir, "eval_results.json"), "w") as f:
        json.dump(output, f, indent=2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """CLI entry point: parse args, validate, run evaluation, output results."""
    parser = argparse.ArgumentParser(description="Autodev evaluation engine")
    parser.add_argument("--port", type=int, default=0, help="Port to serve src/ on (0 = random)")
    parser.add_argument("--runs", type=int, default=2, help="Number of evaluation passes (default: 2)")
    parser.add_argument("--calibrate", action="store_true", help="Run 3x and check stability")
    parser.add_argument("--task", type=int, default=None, help="Evaluate a single task by number")
    parser.add_argument("--verbose", action="store_true", help="Show persona reasoning")
    parser.add_argument("--quiet", action="store_true", help="Only print results block")
    parser.add_argument("--cmd", type=str, default=None,
        help="LLM command for persona agent (e.g. 'claude -p'). "
             "Falls back to AUTOCRIT_EVAL_CMD env var, then .env file.")
    parser.add_argument("--snapshot-flags", type=str, default="-c",
        help="Flags for agent-browser snapshot (default: '-c')")
    parser.add_argument("--max-snapshot", type=int, default=25_000,
        help="Max snapshot chars before truncation (default: 25000)")
    parser.add_argument("--no-wait", action="store_true",
        help="Skip networkidle wait after actions")
    parser.add_argument("--wait-ms", type=int, default=None,
        help="Fixed wait (ms) after actions instead of networkidle")
    parser.add_argument("--iteration", type=int, default=None,
        help="Iteration number (enables screenshot capture)")
    parser.add_argument("--screenshot-dir", type=str, default="screenshots",
        help="Base directory for screenshots (default: screenshots)")
    parser.add_argument("--output-dir", type=str, default=".",
        help="Directory for output files (default: current directory)")
    parser.add_argument("--vision", action="store_true", default=True,
        help="Use annotated screenshots instead of accessibility tree (default: on)")
    parser.add_argument("--text", action="store_true",
        help="Use accessibility tree instead of screenshots (overrides default vision mode)")
    parser.add_argument("--skip-feedback", action="store_true",
        help="Skip persona feedback/wishlist generation (saves 1 LLM call per task)")
    parser.add_argument("--tier", type=str, default=None,
        help="Only run tasks of this priority tier (e.g. P0, P1, P2)")
    parser.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS,
        help=f"Max steps per task (default: {DEFAULT_MAX_STEPS})")
    parser.add_argument("--quick", action="store_true",
        help="Iteration mode: --runs 1 + --skip-feedback + --max-steps 10")
    parser.add_argument("--stats", action="store_true",
        help="Show per-task timing breakdown and token estimates")
    parser.add_argument("--requirements", type=str, default=None,
        help="Path to separate requirements.md (tasks/scoring). If omitted, parsed from persona.md.")
    parser.add_argument("--variants", type=int, default=0,
        help="Number of persona variants to auto-generate and evaluate (0 = single persona, no variants)")
    args = parser.parse_args()

    # --quick sets constituent flags
    if args.quick:
        args.runs = 1
        args.skip_feedback = True
        if args.max_steps == DEFAULT_MAX_STEPS:
            args.max_steps = 10

    if args.output_dir != ".":
        os.makedirs(args.output_dir, exist_ok=True)

    if args.quiet and args.verbose:
        print("--quiet and --verbose are mutually exclusive, using --quiet", file=sys.stderr)
        args.verbose = False

    # --text overrides the default vision mode
    if args.text:
        args.vision = False

    # Load .env early so ANTHROPIC_API_KEY and AUTOCRIT_EVAL_CMD are available
    _load_env_file()

    # Resolve persona agent command
    if args.cmd:
        os.environ["AUTOCRIT_EVAL_CMD"] = args.cmd
    if not os.environ.get("AUTOCRIT_EVAL_CMD"):
        print("Error: No persona agent command configured.", file=sys.stderr)
        print("Options:", file=sys.stderr)
        print('  uv run evaluate.py --cmd "claude -p"', file=sys.stderr)
        print('  export AUTOCRIT_EVAL_CMD="claude -p"', file=sys.stderr)
        print("  echo 'AUTOCRIT_EVAL_CMD=\"claude -p\"' > .env", file=sys.stderr)
        sys.exit(1)

    if not shutil.which("agent-browser"):
        print("Error: agent-browser not found.")
        print("Install: npm install -g agent-browser && agent-browser install")
        sys.exit(1)

    use_vite = os.path.exists("package.json")
    if not use_vite and not os.path.exists("src/index.html"):
        print("Error: src/index.html not found. Create your app first.")
        sys.exit(1)

    # Parse persona
    if not os.path.exists("persona.md"):
        print("Error: persona.md not found. Create it or copy from examples/.")
        sys.exit(1)

    persona = parse("persona.md", requirements_path=args.requirements)
    tasks = persona.tasks

    if args.task is not None:
        tasks = [t for t in tasks if t.number == args.task]
        if not tasks:
            available = [str(t.number) for t in persona.tasks]
            print(f"Error: task {args.task} not found. Available: {', '.join(available)}")
            sys.exit(1)

    if args.tier is not None:
        tier = args.tier.upper()
        tasks = [t for t in tasks if t.tier == tier]
        if not tasks:
            available = sorted(set(t.tier for t in persona.tasks))
            print(f"Error: no tasks with tier {tier}. Available: {', '.join(available)}")
            sys.exit(1)

    # Compute screenshot directory
    screenshot_dir = None
    if args.iteration is not None:
        screenshot_dir = os.path.join(args.screenshot_dir, f"iter_{args.iteration}")

    # Determine number of runs
    num_runs = 3 if args.calibrate else args.runs

    # Start server — Vite if package.json exists, otherwise Python
    # If a port is provided, check if it's already serving (external server management).
    port = args.port or _find_free_port()
    vite_proc: subprocess.Popen | None = None
    server: http.server.HTTPServer | None = None
    external_server = False

    if args.port:
        # Check if the port is already serving (managed by the caller)
        try:
            urllib.request.urlopen(f"http://localhost:{port}", timeout=2)
            external_server = True
        except Exception:
            pass  # Port not serving, start our own server

    if not external_server:
        if use_vite:
            ensure_packages_installed()
            vite_proc = start_vite_server(port)
        else:
            try:
                server = start_server(port, "src")
            except OSError as e:
                print(f"Error starting server on port {port}: {e}")
                sys.exit(1)

    if not args.quiet:
        mode = "Vite+" if use_vite else "Python"
        flags = []
        flags.append("vision" if args.vision else "text")
        if args.quick:
            flags.append("quick")
        if args.skip_feedback:
            flags.append("skip-feedback")
        if args.max_steps != DEFAULT_MAX_STEPS:
            flags.append(f"max-steps={args.max_steps}")
        if args.stats:
            flags.append("stats")
        if args.variants > 0:
            flags.append(f"variants={args.variants}")
        flags_tag = f" | {', '.join(flags)}" if flags else ""
        print(f"Serving on http://localhost:{port} ({mode})")
        print(f"Persona: {persona.name}, {persona.role}")
        print(f"Tasks: {len(tasks)} | Runs: {num_runs}{flags_tag}")
        print()

    def _run_evaluation(eval_persona: Persona, label: str = "") -> tuple[list[TaskResult], dict, dict | None]:
        """Run the full evaluation loop for a single persona (or variant).

        Returns (final_results, scores, calibration).
        """
        all_runs: list[list[TaskResult]] = []

        for run_idx in range(num_runs):
            if num_runs > 1 and not args.quiet:
                prefix = f"[{label}] " if label else ""
                print(f"--- {prefix}Run {run_idx + 1}/{num_runs} ---")

            run_results: list[TaskResult] = []
            for task in tasks:
                if not args.quiet:
                    prefix = f"[{label}] " if label else ""
                    if args.verbose:
                        print(f"{prefix}Evaluating Task {task.number}: {task.name}...")
                    else:
                        print(f"{prefix}Evaluating Task {task.number}: {task.name}...", end="", flush=True)

                try:
                    result = evaluate_task(
                        task, eval_persona, port, args.verbose,
                        snapshot_flags=args.snapshot_flags,
                        wait_after_action=not args.no_wait,
                        wait_ms=args.wait_ms,
                        max_snapshot_chars=args.max_snapshot,
                        screenshot_dir=screenshot_dir if run_idx == 0 else None,
                        vision=args.vision,
                        max_steps=args.max_steps,
                        skip_feedback=args.skip_feedback,
                        stats=args.stats,
                    )
                except Exception as e:
                    if args.verbose:
                        print(f"  Error: {e}")
                    result = TaskResult(
                        task=task,
                        completed=False,
                        score=0.0,
                        steps=0,
                        stuck_points=[str(e)],
                        found_answer=None,
                        notes=f"Error: {e}",
                    )

                if not args.quiet and not args.verbose:
                    status = " PASS" if result.completed else " FAIL"
                    print(status)
                elif not args.quiet and args.verbose:
                    status = "PASS" if result.completed else "FAIL"
                    print(f"  -> {status} (score={result.score}, steps={result.steps})")

                run_results.append(result)

            all_runs.append(run_results)

        # Aggregate
        if num_runs > 1:
            final_results = _aggregate_runs(all_runs)
        else:
            final_results = all_runs[0]

        # Score
        scores = compute_composite(final_results, eval_persona)

        # Calibration
        calibration = _calibrate(all_runs, eval_persona) if args.calibrate else None

        return final_results, scores, calibration

    try:
        if args.variants > 0:
            # --- Multi-variant evaluation ---
            if not args.quiet:
                print(f"Generating {args.variants} persona variants...")
            variants = generate_variants(persona, args.variants)
            if not args.quiet:
                for v in variants:
                    print(f"  {v.variant_id}: {v.label}")
                print()

            variant_results_list = []
            for variant in variants:
                variant_persona = variant.apply(persona)
                if not args.quiet:
                    print(f"=== Variant: {variant.label} ({variant.variant_id}) ===")

                final_results, scores, calibration = _run_evaluation(variant_persona, label=variant.label)

                # Build per-variant result dict
                variant_tasks = []
                for r in final_results:
                    variant_tasks.append({
                        "number": r.task.number,
                        "name": r.task.name,
                        "tier": r.task.tier,
                        "completed": r.completed,
                        "score": r.score,
                        "steps": r.steps,
                        "stuck_points": r.stuck_points,
                        "found_answer": r.found_answer,
                        "notes": r.notes,
                        "persona_feedback": r.persona_feedback,
                        "wishlist": r.wishlist,
                    })
                variant_result = {
                    "variant_id": variant.variant_id,
                    "label": variant.label,
                    "instruction_suffix": variant.instruction_suffix,
                    "composite_score": scores["composite"],
                    "p0_score": scores["p0_score"],
                    "p1_score": scores["p1_score"],
                    "p2_score": scores["p2_score"],
                    "tasks": variant_tasks,
                }
                variant_results_list.append(variant_result)

                if not args.quiet:
                    print(f"  -> {variant.label}: composite={scores['composite']}")
                    print()

            # Close browser
            run_browser("agent-browser close")

            # Convergence analysis
            convergence = analyze_convergence(variant_results_list, persona)

            # Aggregate: median composite across variants as the final score
            all_composites = [vr["composite_score"] for vr in variant_results_list]
            aggregate_composite = statistics.median(all_composites)

            # Use the variant closest to median as the "representative" result
            representative = min(
                variant_results_list,
                key=lambda vr: abs(vr["composite_score"] - aggregate_composite)
            )

            # Print summary
            if not args.quiet:
                print("\n--- VARIANT EVALUATION RESULTS ---")
                print(f"aggregate_composite: {round(aggregate_composite, 1)} (median of {len(variants)} variants)")
                for vr in variant_results_list:
                    print(f"  {vr['label']}: {vr['composite_score']}")
                if convergence.get("strong_signals"):
                    print("\nSTRONG SIGNALS:")
                    for sig in convergence["strong_signals"]:
                        print(f"  {sig}")
                if convergence.get("disagreements"):
                    print("\nDISAGREEMENTS:")
                    for dis in convergence["disagreements"]:
                        print(f"  {dis}")
                if convergence.get("bias_flags"):
                    print("\nBIAS FLAGS:")
                    for flag in convergence["bias_flags"]:
                        print(f"  ⚠ {flag}")
                print("--- END RESULTS ---")

            # Write JSON output
            output = {
                "composite_score": round(aggregate_composite, 1),
                "p0_score": representative["p0_score"],
                "p1_score": representative["p1_score"],
                "p2_score": representative["p2_score"],
                "tasks": representative["tasks"],
                "variants": variant_results_list,
                "convergence": convergence,
            }
            with open(os.path.join(args.output_dir, "eval_results.json"), "w") as f:
                json.dump(output, f, indent=2)

        else:
            # --- Standard single-persona evaluation ---
            final_results, scores, calibration = _run_evaluation(persona)

            # Close browser
            run_browser("agent-browser close")

            if args.calibrate and calibration:
                with open(os.path.join(args.output_dir, "calibration_results.json"), "w") as f:
                    json.dump(calibration, f, indent=2)

            # Output
            _print_results(final_results, scores, args.quiet, calibration)
            _write_json(final_results, scores, calibration, output_dir=args.output_dir)

    finally:
        if not external_server:
            if vite_proc is not None:
                vite_proc.terminate()
                vite_proc.wait(timeout=5)
            if server is not None:
                server.shutdown()


if __name__ == "__main__":
    main()
