"""Generate a comparative report across multiple prototype evaluations.

Usage:
    uv run generate_report.py results/<experiment>/
    uv run generate_report.py results/<experiment>/ --hypotheses hypotheses.md

Reads eval_results.json from each proto-* subdirectory and generates report.md.
"""

import argparse
import json
import os
import re
import sys

from persona_parser import parse_hypotheses


def _load_prototype_results(experiment_dir: str) -> list[dict]:
    """Load eval_results.json from each proto-* subdirectory.

    Prefers best/<branch>/eval_results.json over the latest iteration's
    results, since the latest may have been lost during iteration reverts.
    Falls back to proto-*/eval_results.json if best/ doesn't exist.
    """
    prototypes = []
    for entry in sorted(os.listdir(experiment_dir)):
        if not entry.startswith("proto-"):
            continue

        # Prefer archived best results (#5: prevent lost eval results)
        # best/ uses underscored branch slug: autocrit_<exp>_<proto>
        # but also try the raw proto-* name
        best_candidates = [
            os.path.join(experiment_dir, "best", entry, "eval_results.json"),
        ]
        # Also search for slugified variants (/ replaced with _)
        best_dir = os.path.join(experiment_dir, "best")
        if os.path.isdir(best_dir):
            for bentry in os.listdir(best_dir):
                if entry.replace("-", "_") in bentry or entry in bentry:
                    best_candidates.append(
                        os.path.join(best_dir, bentry, "eval_results.json")
                    )

        results_path = None
        for candidate in best_candidates:
            if os.path.exists(candidate):
                results_path = candidate
                break

        # Fall back to proto-*/eval_results.json
        if results_path is None:
            fallback = os.path.join(experiment_dir, entry, "eval_results.json")
            if os.path.exists(fallback):
                results_path = fallback

        if results_path is None:
            continue

        with open(results_path) as f:
            data = json.load(f)
        # Read approach.md if it exists in the prototype dir
        approach_path = os.path.join(experiment_dir, entry, "approach.md")
        approach_name = entry
        if os.path.exists(approach_path):
            with open(approach_path) as f:
                for line in f:
                    if line.startswith("# Approach:"):
                        approach_name = line.split(":", 1)[1].strip()
                        break
        data["_proto_id"] = entry
        data["_proto_name"] = approach_name
        data["_results_source"] = results_path
        prototypes.append(data)
    return prototypes


def _load_best_scores_from_history(experiment_dir: str) -> dict[str, float]:
    """Load the best kept composite score per branch from iteration_history.jsonl or autocrit.jsonl.

    Returns dict of proto_id -> best composite score. Used to cross-reference
    against eval_results.json scores which may be stale.
    """
    best_scores: dict[str, float] = {}

    # Try autocrit.jsonl first (in parent directory of experiment_dir — the project root)
    # autocrit.jsonl is at project root, experiment_dir is e.g. results/recipe/
    project_root = experiment_dir
    for _ in range(3):  # Walk up max 3 levels
        jsonl_path = os.path.join(project_root, "autocrit.jsonl")
        if os.path.exists(jsonl_path):
            try:
                with open(jsonl_path) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except (json.JSONDecodeError, ValueError):
                            continue
                        if entry.get("type") != "iteration":
                            continue
                        if not entry.get("kept", False):
                            continue
                        branch = entry.get("branch", "")
                        composite = entry.get("composite", 0)
                        # Extract proto id from branch name like "autocrit/recipe/proto-a"
                        for part in branch.split("/"):
                            if part.startswith("proto-"):
                                proto_id = part
                                if proto_id not in best_scores or composite > best_scores[proto_id]:
                                    best_scores[proto_id] = composite
                                break
            except (OSError, IOError):
                pass
            break
        parent = os.path.dirname(project_root)
        if parent == project_root:
            break
        project_root = parent

    # Also try iteration_history.jsonl in the experiment directory
    history_path = os.path.join(experiment_dir, "iteration_history.jsonl")
    if os.path.exists(history_path):
        try:
            with open(history_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except (json.JSONDecodeError, ValueError):
                        continue
                    if not entry.get("kept", False):
                        continue
                    composite = entry.get("composite", 0)
                    desc = entry.get("description", "")
                    # Try to extract proto id from description
                    for proto_match in re.finditer(r"proto-[a-z]", desc.lower()):
                        proto_id = proto_match.group()
                        if proto_id not in best_scores or composite > best_scores[proto_id]:
                            best_scores[proto_id] = composite
        except (OSError, IOError):
            pass

    return best_scores


def _load_requirements_versions(experiment_dir: str) -> list[tuple[str, str]]:
    """Load all requirements_v*.md versions from the experiment directory.

    Returns list of (filename, content) tuples sorted by version number.
    """
    versions = []
    for entry in sorted(os.listdir(experiment_dir)):
        if entry.startswith("requirements_v") and entry.endswith(".md"):
            path = os.path.join(experiment_dir, entry)
            with open(path) as f:
                versions.append((entry, f.read()))
    # Also check for requirements_final.md
    final_path = os.path.join(experiment_dir, "requirements_final.md")
    if os.path.exists(final_path):
        with open(final_path) as f:
            versions.append(("requirements_final.md", f.read()))
    return versions


def _get_task_feedback(task: dict) -> str:
    """Extract the best available feedback text for a task.

    Priority: persona_feedback > notes > stuck_points joined.
    Quick-mode evaluations only have notes and stuck_points (no persona_feedback).
    """
    fb = task.get("persona_feedback", "")
    if fb:
        return fb
    notes = task.get("notes", "")
    if notes:
        return notes
    stuck = task.get("stuck_points", [])
    if stuck:
        return "; ".join(stuck)
    return ""


def generate_report(
    experiment_dir: str,
    hypotheses_path: str | None = None,
) -> str:
    """Generate a comparative report markdown string."""
    prototypes = _load_prototype_results(experiment_dir)
    if not prototypes:
        return "# Error\n\nNo prototype results found in " + experiment_dir

    hypotheses = []
    if hypotheses_path:
        hypotheses = parse_hypotheses(hypotheses_path)

    experiment_name = os.path.basename(experiment_dir.rstrip("/"))
    has_variants = any("variants" in p for p in prototypes)

    # Cross-reference scores from iteration history
    history_best = _load_best_scores_from_history(experiment_dir)

    lines = []
    lines.append(f"# Comparative Report: {experiment_name}\n")

    # --- Summary ---
    lines.append("## Summary\n")
    variant_count = 0
    if has_variants and prototypes[0].get("variants"):
        variant_count = len(prototypes[0]["variants"])
    lines.append(
        f"Tested {len(prototypes)} prototype(s)"
        + (f" with {variant_count} persona variants each" if variant_count else "")
        + ".\n"
    )

    # --- Score discrepancy warnings ---
    discrepancies = []
    for p in prototypes:
        proto_id = p["_proto_id"]
        eval_score = p.get("composite_score", 0)
        hist_score = history_best.get(proto_id)
        if hist_score is not None and hist_score > eval_score + 0.5:
            discrepancies.append(
                f"- **{p['_proto_name']}**: eval_results.json shows {eval_score}, "
                f"but iteration history records a kept score of {hist_score}. "
                f"The higher score may have been lost during iteration reverts."
            )
    if discrepancies:
        lines.append("### ⚠️ Score Discrepancies\n")
        lines.append(
            "The following prototypes have higher scores in the iteration history "
            "than in their eval_results.json. This typically happens when a best "
            "iteration's results are lost during subsequent reverts.\n"
        )
        lines.extend(discrepancies)
        lines.append("")

    # --- Hypotheses ---
    if hypotheses:
        lines.append("## Hypotheses\n")
        for h in hypotheses:
            lines.append(f"### {h.id}: {h.title}\n")
            lines.append(f"- **Question:** {h.question}")
            lines.append(f"- **Measure:** {h.measure}")
            # Try to resolve based on data
            lines.append(f"- **Status:** {h.status}")
            # Add relevant data from prototypes
            lines.append(f"- **Evidence:** See prototype comparison below.\n")

    # --- Prototype Comparison Table ---
    lines.append("## Prototype Comparison\n")

    # Header
    headers = ["Metric"] + [f"{p['_proto_name']} ({p['_proto_id']})" for p in prototypes]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")

    # Composite — show history best in parentheses if different
    row = ["Composite score"]
    for p in prototypes:
        score_str = str(p.get("composite_score", "N/A"))
        hist_score = history_best.get(p["_proto_id"])
        if hist_score is not None and hist_score > p.get("composite_score", 0) + 0.5:
            score_str += f" (peak: {hist_score})"
        row.append(score_str)
    lines.append("| " + " | ".join(row) + " |")

    # P0/P1/P2
    for tier in ["p0_score", "p1_score", "p2_score"]:
        label = tier.replace("_score", "").upper() + " score"
        row = [label] + [str(p.get(tier, "N/A")) for p in prototypes]
        lines.append("| " + " | ".join(row) + " |")

    # Exploratory score (if any prototype has it)
    has_exploratory = any(p.get("exploratory_score") is not None for p in prototypes)
    if has_exploratory:
        row = ["Exploratory score (not in composite)"]
        for p in prototypes:
            ex_score = p.get("exploratory_score")
            row.append(str(ex_score) if ex_score is not None else "—")
        lines.append("| " + " | ".join(row) + " |")

    # Variant agreement (if available)
    if has_variants:
        row = ["Variant agreement"]
        for p in prototypes:
            conv = p.get("convergence", {})
            row.append(str(conv.get("overall_agreement", "N/A")))
        lines.append("| " + " | ".join(row) + " |")

    lines.append("")

    # --- Strongest Signals ---
    if has_variants:
        lines.append("## Strongest Signals\n")
        any_signals = False
        for p in prototypes:
            conv = p.get("convergence", {})
            signals = conv.get("strong_signals", [])
            if signals:
                any_signals = True
                lines.append(f"**{p['_proto_name']}:**")
                for sig in signals:
                    lines.append(f"- {sig}")
                lines.append("")
        if not any_signals:
            lines.append("No strong signals detected across prototypes.\n")

        # --- Interesting Disagreements ---
        lines.append("## Interesting Disagreements\n")
        any_disagreements = False
        for p in prototypes:
            conv = p.get("convergence", {})
            disagreements = conv.get("disagreements", [])
            if disagreements:
                any_disagreements = True
                lines.append(f"**{p['_proto_name']}:**")
                for dis in disagreements:
                    lines.append(f"- {dis}")
                lines.append("")
        if not any_disagreements:
            lines.append("No significant disagreements between variants.\n")

        # --- Bias Flags ---
        lines.append("## Bias Flags\n")
        any_flags = False
        for p in prototypes:
            conv = p.get("convergence", {})
            flags = conv.get("bias_flags", [])
            if flags:
                any_flags = True
                lines.append(f"**{p['_proto_name']}:**")
                for flag in flags:
                    lines.append(f"- {flag}")
                lines.append("")
        if not any_flags:
            lines.append("No bias flags detected.\n")

    # --- Verbatim Feedback ---
    lines.append("## Verbatim Feedback\n")
    any_feedback = False
    for p in prototypes:
        lines.append(f"### {p['_proto_name']} ({p['_proto_id']})\n")
        proto_has_feedback = False
        if has_variants and p.get("variants"):
            for variant in p["variants"]:
                label = variant.get("label", variant.get("variant_id", "?"))
                for task in variant.get("tasks", []):
                    fb = _get_task_feedback(task)
                    if fb:
                        proto_has_feedback = True
                        status = "PASS" if task.get("completed") else "FAIL"
                        lines.append(f'> "{fb}" — {label} (Task {task["number"]}: {task["name"]}, {status})\n')
        else:
            for task in p.get("tasks", []):
                fb = _get_task_feedback(task)
                if fb:
                    proto_has_feedback = True
                    status = "PASS" if task.get("completed") else "FAIL"
                    lines.append(f'**Task {task["number"]} [{task.get("tier", "?")}] "{task["name"]}" — {status} (score: {task.get("score", 0)})**\n')
                    lines.append(f'> {fb}\n')

        if not proto_has_feedback:
            lines.append("*No feedback available (evaluation may have used quick mode which skips feedback generation).*\n")
        else:
            any_feedback = True

    # --- Exploratory Tasks ---
    has_any_exploratory = any(p.get("exploratory_tasks") for p in prototypes)
    if has_any_exploratory:
        lines.append("## Exploratory Tasks\n")
        lines.append(
            "Exploratory tasks are generated by the persona agent based on "
            "what it sees in the app. They surface UX issues that core tasks "
            "don't cover. Scores are **not** included in the composite.\n"
        )
        for p in prototypes:
            ex_tasks = p.get("exploratory_tasks", [])
            if not ex_tasks:
                continue
            lines.append(f"### {p['_proto_name']} ({p['_proto_id']})\n")
            ex_score = p.get("exploratory_score")
            if ex_score is not None:
                lines.append(f"**Exploratory score: {ex_score}**\n")
            for task in ex_tasks:
                status = "PASS" if task.get("completed") else "FAIL"
                lines.append(f'**EX Task {task.get("number", "?")} "{task.get("name", "")}" — {status} (score: {task.get("score", 0)})**\n')
                fb = _get_task_feedback(task)
                if fb:
                    lines.append(f'> {fb}\n')
            lines.append("")

    # --- Session Wishlist ---
    has_any_wishlist = any(p.get("session_wishlist") for p in prototypes)
    if has_any_wishlist:
        lines.append("## Session Wishlist\n")
        lines.append(
            "After all tasks, the persona reflects on the whole experience. "
            "These wishes are grounded in the persona's daily life and test session.\n"
        )
        for p in prototypes:
            wl = p.get("session_wishlist")
            if not wl:
                continue
            lines.append(f"### {p['_proto_name']} ({p['_proto_id']})\n")
            wishes = wl.get("wishlist", [])
            if wishes:
                for wish in wishes:
                    lines.append(f"- {wish}")
                lines.append("")
            surprise = wl.get("surprise", "")
            if surprise:
                lines.append(f"**Surprise:** {surprise}\n")
            would_use = wl.get("would_use", "")
            if would_use:
                lines.append(f"**Would use:** {would_use}\n")

    # --- Requirements Evolution ---
    req_versions = _load_requirements_versions(experiment_dir)
    if len(req_versions) >= 2:
        lines.append("## Requirements Evolution\n")
        lines.append(f"Requirements went through {len(req_versions)} versions:\n")
        for filename, _ in req_versions:
            lines.append(f"- `{filename}`")
        lines.append("")
        lines.append("See the individual version files for full diffs.\n")

    # --- Why Others Didn't Win ---
    if len(prototypes) >= 2:
        # Use history_best for winner determination if available, to prevent
        # lost eval_results from changing the outcome
        def _best_score(p: dict) -> float:
            eval_score = p.get("composite_score", 0)
            hist_score = history_best.get(p["_proto_id"], 0)
            return max(eval_score, hist_score)

        best = max(prototypes, key=_best_score)
        best_composite = _best_score(best)
        losers = [p for p in prototypes if p["_proto_id"] != best["_proto_id"]]

        lines.append("## Why Other Prototypes Didn't Win\n")

        for loser in losers:
            lines.append(f"### {loser['_proto_name']} ({loser['_proto_id']})\n")

            # Score gap
            loser_composite = _best_score(loser)
            gap = best_composite - loser_composite
            lines.append(f"**Score gap:** {loser_composite} vs {best_composite} (−{gap:.1f} points)\n")

            # Tier breakdown (use eval_results tiers — history doesn't track per-tier)
            tier_issues = []
            for tier_key, tier_label in [("p0_score", "P0"), ("p1_score", "P1"), ("p2_score", "P2")]:
                best_tier = best.get(tier_key, 0)
                loser_tier = loser.get(tier_key, 0)
                delta = best_tier - loser_tier
                if delta > 5:
                    tier_issues.append(f"- **{tier_label}:** scored {loser_tier} vs winner's {best_tier} (−{delta:.1f})")
            if tier_issues:
                lines.append("**Weaker tiers:**")
                lines.extend(tier_issues)
                lines.append("")

            # Task-level analysis: find tasks where this prototype was weaker
            best_tasks = {t["number"]: t for t in best.get("tasks", [])}
            loser_tasks = {t["number"]: t for t in loser.get("tasks", [])}
            failing_tasks = []
            weaker_tasks = []
            for num, lt in loser_tasks.items():
                bt = best_tasks.get(num)
                if not lt.get("completed", False) and (bt and bt.get("completed", False)):
                    failing_tasks.append(
                        f"- Task {num} ({lt.get('tier', '?')}) \"{lt.get('name', '')}\" — "
                        f"**failed** (winner passed)"
                    )
                elif bt and lt.get("score", 0) < bt.get("score", 0) - 10:
                    weaker_tasks.append(
                        f"- Task {num} ({lt.get('tier', '?')}) \"{lt.get('name', '')}\" — "
                        f"scored {lt.get('score', 0)} vs winner's {bt.get('score', 0)}"
                    )

            if failing_tasks:
                lines.append("**Failed tasks that winner passed:**")
                lines.extend(failing_tasks)
                lines.append("")
            if weaker_tasks:
                lines.append("**Significantly weaker tasks (>10pt gap):**")
                lines.extend(weaker_tasks)
                lines.append("")

            # Stuck points unique to this prototype
            loser_stuck = set()
            for t in loser.get("tasks", []):
                for sp in t.get("stuck_points", []):
                    loser_stuck.add(sp)
            best_stuck = set()
            for t in best.get("tasks", []):
                for sp in t.get("stuck_points", []):
                    best_stuck.add(sp)
            unique_stuck = loser_stuck - best_stuck
            if unique_stuck:
                lines.append("**Unique stuck points (not seen in winner):**")
                for sp in sorted(unique_stuck):
                    lines.append(f"- {sp}")
                lines.append("")

            # Bias flags
            bias = loser.get("convergence", {}).get("bias_flags", [])
            if bias:
                lines.append("**Bias concerns:**")
                for flag in bias:
                    lines.append(f"- ⚠️ {flag}")
                lines.append("")

            # Variant agreement comparison
            if has_variants:
                loser_agreement = loser.get("convergence", {}).get("overall_agreement")
                best_agreement = best.get("convergence", {}).get("overall_agreement")
                if loser_agreement is not None and best_agreement is not None:
                    if loser_agreement < best_agreement - 0.05:
                        lines.append(
                            f"**Lower variant agreement:** {loser_agreement} vs winner's {best_agreement} "
                            f"— less consistent experience across persona variants.\n"
                        )

            # Key negative feedback — use _get_task_feedback for fallback
            neg_feedback = []
            for t in loser.get("tasks", []):
                fb = _get_task_feedback(t)
                if fb and not t.get("completed", False):
                    neg_feedback.append(f'- "{fb}" (Task {t["number"]}: {t.get("name", "")})')
            if neg_feedback:
                lines.append("**Key persona feedback on failures:**")
                lines.extend(neg_feedback[:5])  # Limit to 5
                lines.append("")

        lines.append("")

    # --- Recommendations ---
    lines.append("## Recommendations\n")
    if prototypes:
        def _best_score(p: dict) -> float:
            eval_score = p.get("composite_score", 0)
            hist_score = history_best.get(p["_proto_id"], 0)
            return max(eval_score, hist_score)

        best = max(prototypes, key=_best_score)
        best_composite = _best_score(best)
        eval_composite = best.get("composite_score", 0)
        score_note = ""
        if best_composite > eval_composite + 0.5:
            score_note = f", peak: {best_composite} from iteration history"
        lines.append(f"1. **Strongest prototype:** {best['_proto_name']} (composite: {eval_composite}{score_note})")
        lines.append("2. Review verbatim feedback above for elements worth combining from other prototypes")
        if has_variants:
            flagged = [p for p in prototypes if p.get("convergence", {}).get("bias_flags")]
            if flagged:
                names = ", ".join(p["_proto_name"] for p in flagged)
                lines.append(f"3. **Validate with real users:** {names} (flagged for possible positive bias)")
        lines.append(f"{4 if has_variants else 3}. Adopt the evolved requirements as the baseline for production development")
    lines.append("")
    lines.append("---\n")
    lines.append("*This report was generated by autocrit. All synthetic user feedback should be treated as hypotheses to validate with real users, not as conclusions.*")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate comparative report across prototypes")
    parser.add_argument("experiment_dir", help="Path to experiment results directory")
    parser.add_argument("--hypotheses", type=str, default=None,
        help="Path to hypotheses.md")
    parser.add_argument("--output", type=str, default=None,
        help="Output path for report (default: <experiment_dir>/report.md)")
    args = parser.parse_args()

    if not os.path.isdir(args.experiment_dir):
        print(f"Error: {args.experiment_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    report = generate_report(args.experiment_dir, args.hypotheses)

    output_path = args.output or os.path.join(args.experiment_dir, "report.md")
    with open(output_path, "w") as f:
        f.write(report)

    print(f"Report written to {output_path}")


if __name__ == "__main__":
    main()
