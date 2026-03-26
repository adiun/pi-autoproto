"""Generate a comparative report across multiple prototype evaluations.

Usage:
    uv run generate_report.py results/<experiment>/
    uv run generate_report.py results/<experiment>/ --hypotheses hypotheses.md

Reads eval_results.json from each proto-* subdirectory and generates report.md.
"""

import argparse
import json
import os
import sys

from persona_parser import parse_hypotheses


def _load_prototype_results(experiment_dir: str) -> list[dict]:
    """Load eval_results.json from each proto-* subdirectory."""
    prototypes = []
    for entry in sorted(os.listdir(experiment_dir)):
        if not entry.startswith("proto-"):
            continue
        results_path = os.path.join(experiment_dir, entry, "eval_results.json")
        if not os.path.exists(results_path):
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
        prototypes.append(data)
    return prototypes


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

    # Composite
    row = ["Composite score"] + [str(p.get("composite_score", "N/A")) for p in prototypes]
    lines.append("| " + " | ".join(row) + " |")

    # P0/P1/P2
    for tier in ["p0_score", "p1_score", "p2_score"]:
        label = tier.replace("_score", "").upper() + " score"
        row = [label] + [str(p.get(tier, "N/A")) for p in prototypes]
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
    for p in prototypes:
        lines.append(f"### {p['_proto_name']} ({p['_proto_id']})\n")
        if has_variants and p.get("variants"):
            for variant in p["variants"]:
                label = variant.get("label", variant.get("variant_id", "?"))
                for task in variant.get("tasks", []):
                    fb = task.get("persona_feedback", "")
                    if fb:
                        lines.append(f'> "{fb}" — {label} (Task {task["number"]}: {task["name"]})\n')
        else:
            for task in p.get("tasks", []):
                fb = task.get("persona_feedback", "")
                if fb:
                    lines.append(f'> "{fb}" (Task {task["number"]}: {task["name"]})\n')

    # --- Requirements Evolution ---
    req_versions = _load_requirements_versions(experiment_dir)
    if len(req_versions) >= 2:
        lines.append("## Requirements Evolution\n")
        lines.append(f"Requirements went through {len(req_versions)} versions:\n")
        for filename, _ in req_versions:
            lines.append(f"- `{filename}`")
        lines.append("")
        lines.append("See the individual version files for full diffs.\n")

    # --- Recommendations ---
    lines.append("## Recommendations\n")
    if prototypes:
        best = max(prototypes, key=lambda p: p.get("composite_score", 0))
        lines.append(f"1. **Strongest prototype:** {best['_proto_name']} (composite: {best.get('composite_score', 'N/A')})")
        lines.append("2. Review verbatim feedback above for elements worth combining from other prototypes")
        if has_variants:
            flagged = [p for p in prototypes if p.get("convergence", {}).get("bias_flags")]
            if flagged:
                names = ", ".join(p["_proto_name"] for p in flagged)
                lines.append(f"3. **Validate with real users:** {names} (flagged for possible positive bias)")
        lines.append("4. Adopt the evolved requirements as the baseline for production development")
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
