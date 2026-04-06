"""Generate persona tasks by asking the persona LLM what they'd try to do.

Reads a partial persona.md (background + environment + agent_instructions,
no Requirements section) and calls the persona LLM to generate core tasks
grounded in the persona's daily life.

Usage:
    uv run generate_tasks.py --cmd "claude -p" --app "tip calculator for restaurant servers"
    uv run generate_tasks.py --cmd "pi -p" --app "recipe finder" --write
"""

import argparse
import json
import os
import re
import sys
import textwrap

from persona_parser import parse_background


# ---------------------------------------------------------------------------
# LLM helpers (reuse from evaluate.py)
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


def _llm(prompt: str) -> str:
    """Send prompt to LLM via AUTOPROTO_EVAL_CMD. Returns response text."""
    import shlex
    import subprocess

    cmd = os.environ.get("AUTOPROTO_EVAL_CMD")
    if not cmd:
        print("Error: No persona agent command configured.", file=sys.stderr)
        print('Use --cmd "claude -p" or set AUTOPROTO_EVAL_CMD', file=sys.stderr)
        sys.exit(1)

    cmd_parts = shlex.split(cmd)
    try:
        result = subprocess.run(
            cmd_parts, input=prompt,
            capture_output=True, text=True, timeout=180,
        )
    except FileNotFoundError:
        print(f"Error: Command not found: {cmd_parts[0]}", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        raise RuntimeError("LLM command timed out after 180s")

    if result.returncode != 0:
        raise RuntimeError(f"LLM command failed (exit {result.returncode}): {result.stderr[:500]}")
    return result.stdout.strip()


def _try_parse_json(text: str) -> dict | None:
    """Try to extract and parse a JSON object from text."""
    cleaned = re.sub(r"```(?:json)?\s*\n?", "", text).strip()
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        pass
    match = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", cleaned, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def _llm_json(prompt: str) -> dict:
    """Send prompt to LLM, parse JSON. Retries once."""
    response = _llm(prompt)
    parsed = _try_parse_json(response)
    if parsed is not None:
        return parsed

    retry_prompt = (
        prompt
        + "\n\nIMPORTANT: Your previous response was not valid JSON. "
        "Reply with ONLY a JSON object — no markdown fences, no explanation."
    )
    response = _llm(retry_prompt)
    parsed = _try_parse_json(response)
    if parsed is not None:
        return parsed
    raise ValueError(f"Could not parse JSON from LLM response after retry: {response[:300]}")


# ---------------------------------------------------------------------------
# Task generation
# ---------------------------------------------------------------------------

def generate_tasks(persona_md_path: str, app_description: str) -> dict:
    """Read persona background, ask LLM to generate tasks. Returns parsed JSON."""
    info = parse_background(persona_md_path)

    prompt = f"""You are {info['name']}, {info['role']}.

{info['background']}

{info['agent_instructions']}

Someone is building an app for you: {app_description}

Based on your daily life, your current workarounds, and your pain points, what would you actually try to do with this app? Think about:
- A typical day when you'd reach for this app
- What you're doing right before and right after
- What would make you put it down and go back to your current workaround
- What would make you tell a coworker about it

Generate 5-8 tasks organized by priority:

**P0 (core — what you MUST be able to do or the app is useless):** 2-3 tasks
**P1 (important — makes the difference between "fine" and "love it"):** 2-3 tasks
**P2 (nice to have — you'd appreciate but wouldn't miss):** 1-2 tasks

Task requirements:
- At least 2 P0 tasks must end with you making a decision or forming an opinion, not just finding information
- At least 1 task must involve competing constraints from your life
- Include specific details from your background (names, amounts, situations you actually face)
- Each task needs a realistic goal (what you're trying to accomplish, in your own words) and 2-3 success criteria
- Use output_review evaluation for judgment/decision tasks, task_completion for mechanical ones
- Tasks must be achievable by clicking, typing, and scrolling in a web app

Also list 1-2 anti-tasks: things you would absolutely NOT do with this app.

Reply with a JSON object:
{{
  "tasks": [
    {{
      "tier": "P0",
      "name": "short descriptive name",
      "type": "computation|navigation|retrieval|generative",
      "goal": "what you'd actually try to do, in your voice, with specific details from your life",
      "success_criteria": ["criterion 1", "criterion 2", "criterion 3"],
      "evaluation_method": "output_review|task_completion"
    }}
  ],
  "anti_tasks": ["thing you would NOT do", "another thing"]
}}"""

    return _llm_json(prompt)


def format_requirements_markdown(result: dict) -> str:
    """Format the LLM's JSON response as persona.md Requirements + Scoring sections."""
    tasks = result.get("tasks", [])
    anti_tasks = result.get("anti_tasks", [])

    # Group by tier
    tiers: dict[str, list] = {"P0": [], "P1": [], "P2": []}
    for t in tasks:
        tier = t.get("tier", "P2").upper()
        if tier not in tiers:
            tier = "P2"
        tiers[tier].append(t)

    lines: list[str] = []
    lines.append("## Requirements")
    lines.append("")

    task_num = 0
    tier_labels = {
        "P0": "P0 — Core (weight: 0.60)",
        "P1": "P1 — Important (weight: 0.25)",
        "P2": "P2 — Nice to have (weight: 0.15)",
    }

    for tier in ["P0", "P1", "P2"]:
        tier_tasks = tiers[tier]
        if not tier_tasks:
            continue
        lines.append(f"### {tier_labels[tier]}")
        lines.append("")
        for t in tier_tasks:
            task_num += 1
            name = t.get("name", f"Task {task_num}")
            lines.append(f"#### Task {task_num}: {name}")
            lines.append("")
            lines.append(f"- type: {t.get('type', 'navigation')}")
            lines.append(f"- goal: {t.get('goal', '')}")
            lines.append("- success_criteria:")
            for c in t.get("success_criteria", []):
                lines.append(f"  - {c}")
            lines.append(f"- evaluation_method: {t.get('evaluation_method', 'output_review')}")
            lines.append("")

    # Anti-tasks
    if anti_tasks:
        lines.append("### Anti-tasks")
        lines.append("")
        for at in anti_tasks:
            lines.append(f"- {at}")
        lines.append("")

    # Scoring section
    lines.append("## Scoring")
    lines.append("")
    lines.append("composite = (p0_score * 0.60) + (p1_score * 0.25) + (p2_score * 0.15)")
    lines.append("If any P0 task scores 0: composite = min(composite, 40)")
    lines.append("")
    lines.append("Per-task scoring:")
    lines.append("")
    lines.append("- task_completion: 100 if completed, 0 if not. Penalty of -2 per step beyond 5.")
    lines.append("- output_review: 0-100 based on success_criteria met, evaluated by LLM.")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate persona tasks by asking the persona LLM what they'd try to do."
    )
    parser.add_argument("--persona", type=str, default="persona.md",
        help="Path to persona.md (background only, no tasks). Default: persona.md")
    parser.add_argument("--app", type=str, required=True,
        help="Short description of the app being built (e.g. 'tip calculator for restaurant servers')")
    parser.add_argument("--cmd", type=str, default=None,
        help="LLM command for persona agent (e.g. 'claude -p'). Falls back to AUTOPROTO_EVAL_CMD.")
    parser.add_argument("--write", action="store_true",
        help="Append generated tasks to persona.md instead of printing to stdout")
    parser.add_argument("--json", action="store_true",
        help="Output raw JSON instead of markdown")
    args = parser.parse_args()

    _load_env_file()

    if args.cmd:
        os.environ["AUTOPROTO_EVAL_CMD"] = args.cmd

    if not os.path.exists(args.persona):
        print(f"Error: {args.persona} not found.", file=sys.stderr)
        sys.exit(1)

    print(f"Generating tasks for persona in {args.persona}...", file=sys.stderr)
    print(f"App: {args.app}", file=sys.stderr)

    result = generate_tasks(args.persona, args.app)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    markdown = format_requirements_markdown(result)

    if args.write:
        with open(args.persona, "a") as f:
            f.write("\n" + markdown)
        task_count = len(result.get("tasks", []))
        print(f"✅ Appended {task_count} tasks to {args.persona}", file=sys.stderr)
    else:
        print(markdown)


if __name__ == "__main__":
    main()
