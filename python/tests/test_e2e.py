"""End-to-end tests with full mocking (no external dependencies)."""

import json
import os
import os.path as _real_os_path
import sys
import tempfile

import pytest
from unittest.mock import patch, MagicMock

from persona_parser import Persona, PersonaTask, PersonaVariant, TaskResult

# Capture the real os.path.exists before any mock can replace it
_original_exists = os.path.exists


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_task_result(task, completed=True, score=90.0, steps=3):
    """Build a TaskResult with sensible defaults."""
    return TaskResult(
        task=task,
        completed=completed,
        score=score,
        steps=steps,
        stuck_points=[] if completed else ["got stuck"],
        found_answer="$10" if completed else None,
        notes="ok" if completed else "failed",
        persona_feedback="That was easy." if completed else "I gave up.",
        wishlist=["bigger buttons"] if completed else [],
    )


def _minimal_persona():
    """Build a minimal Persona for e2e tests (no file I/O)."""
    tasks = [
        PersonaTask(
            number=1, name="Basic calc", tier="P0",
            type="computation", goal="Calculate 20% tip on $50",
            success_criteria=["Tip $10 shown"],
            evaluation_method="task_completion",
            correct_answer="Tip: $10, Total: $60",
        ),
        PersonaTask(
            number=2, name="Error handling", tier="P1",
            type="navigation", goal="Enter 'abc' as bill",
            success_criteria=["No crash", "Error shown"],
            evaluation_method="task_completion",
        ),
    ]
    return Persona(
        name="Alex Rivera",
        role="Restaurant Server",
        background="A server in Austin, TX.",
        device="phone",
        context="at a restaurant",
        time_pressure="medium",
        tech_savviness="medium",
        tasks=tasks,
        weights={"P0": 0.60, "P1": 0.25, "P2": 0.15},
        agent_instructions="You are Alex.",
        p0_cap=40.0,
    )


def _fake_exists_factory(*true_patterns):
    """Return a fake os.path.exists that returns True for paths matching patterns."""
    def fake_exists(path):
        path_str = str(path)
        for pattern in true_patterns:
            if pattern in path_str:
                return True
        return _original_exists(path_str)
    return fake_exists


# ---------------------------------------------------------------------------
# E2E 1: Single-persona CLI evaluation flow
# ---------------------------------------------------------------------------

@patch("evaluate.create_backend")
@patch("evaluate.start_vite_server")
@patch("evaluate.ensure_packages_installed")
@patch("evaluate.parse")
@patch("evaluate._load_env_file")
@patch("evaluate.shutil.which", return_value="/usr/bin/agent-browser")
@patch("evaluate.os.path.exists")
def test_e2e_single_persona(
    mock_exists, mock_which, mock_load_env,
    mock_parse, mock_ensure_pkg, mock_vite, mock_create_backend,
    tmp_path,
):
    """Single-persona evaluation writes eval_results.json with correct structure."""
    persona = _minimal_persona()
    mock_parse.return_value = persona

    mock_exists.side_effect = _fake_exists_factory("package.json", "persona.md")

    # Mock browser backend
    mock_backend = MagicMock()
    mock_backend.name = "agent-browser"
    mock_backend.supports_vision = True
    mock_backend.close.return_value = ""
    mock_create_backend.return_value = mock_backend

    # Mock vite server process
    mock_proc = MagicMock()
    mock_proc.terminate = MagicMock()
    mock_proc.wait = MagicMock()
    mock_vite.return_value = mock_proc

    output_dir = str(tmp_path)

    # Build fixed TaskResults for each task
    results_by_call = []
    for task in persona.tasks:
        results_by_call.append(_make_task_result(task))

    call_count = [0]

    def fake_evaluate_task(task, p, port, verbose, **kwargs):
        idx = call_count[0] % len(results_by_call)
        call_count[0] += 1
        return results_by_call[idx]

    with patch("evaluate.evaluate_task", side_effect=fake_evaluate_task):
        with patch("sys.argv", [
            "evaluate.py",
            "--port", "9999",
            "--runs", "1",
            "--quiet",
            "--skip-feedback",
            "--output-dir", output_dir,
            "--cmd", "echo test",
        ]):
            with patch.dict(os.environ, {"AUTOPROTO_EVAL_CMD": "echo test"}):
                import evaluate
                evaluate.main()

    # Verify eval_results.json was written
    results_path = os.path.join(output_dir, "eval_results.json")
    assert _original_exists(results_path), "eval_results.json should be written"

    with open(results_path) as f:
        data = json.load(f)

    # Check structure
    assert "composite_score" in data
    assert "p0_score" in data
    assert "p1_score" in data
    assert "p2_score" in data
    assert "tasks" in data
    assert len(data["tasks"]) == 2

    # Task entries have expected keys
    for t in data["tasks"]:
        assert "number" in t
        assert "name" in t
        assert "completed" in t
        assert "score" in t


# ---------------------------------------------------------------------------
# E2E 2: Multi-variant evaluation
# ---------------------------------------------------------------------------

@patch("evaluate.create_backend")
@patch("evaluate.start_vite_server")
@patch("evaluate.ensure_packages_installed")
@patch("evaluate.parse")
@patch("evaluate._load_env_file")
@patch("evaluate.shutil.which", return_value="/usr/bin/agent-browser")
@patch("evaluate.os.path.exists")
def test_e2e_multi_variant(
    mock_exists, mock_which, mock_load_env,
    mock_parse, mock_ensure_pkg, mock_vite, mock_create_backend,
    tmp_path,
):
    """Multi-variant evaluation (--variants 3) writes eval_results.json with variants and convergence."""
    persona = _minimal_persona()
    mock_parse.return_value = persona

    mock_exists.side_effect = _fake_exists_factory("package.json", "persona.md")

    # Mock browser backend
    mock_backend = MagicMock()
    mock_backend.name = "agent-browser"
    mock_backend.supports_vision = True
    mock_backend.close.return_value = ""
    mock_create_backend.return_value = mock_backend

    mock_proc = MagicMock()
    mock_proc.terminate = MagicMock()
    mock_proc.wait = MagicMock()
    mock_vite.return_value = mock_proc

    output_dir = str(tmp_path)

    # Fixed variants
    fixed_variants = [
        PersonaVariant(
            variant_id="v1", label="Rushed Alex",
            instruction_suffix="You are in a hurry.",
            trait_overrides={"time_pressure": "high"},
        ),
        PersonaVariant(
            variant_id="v2", label="Careful Alex",
            instruction_suffix="You double-check everything.",
            trait_overrides={"time_pressure": "low"},
        ),
        PersonaVariant(
            variant_id="v3", label="Skeptical Alex",
            instruction_suffix="You distrust the app.",
            trait_overrides={},
        ),
    ]

    # Return different scores per variant call
    variant_call = [0]
    variant_scores = [85.0, 70.0, 60.0]

    def fake_evaluate_task(task, p, port, verbose, **kwargs):
        # Cycle through scores based on which variant we're on
        variant_idx = variant_call[0] // len(persona.tasks)
        score = variant_scores[min(variant_idx, len(variant_scores) - 1)]
        variant_call[0] += 1
        return _make_task_result(task, completed=True, score=score, steps=3)

    with patch("evaluate.generate_variants", return_value=fixed_variants):
        with patch("evaluate.evaluate_task", side_effect=fake_evaluate_task):
            with patch("sys.argv", [
                "evaluate.py",
                "--port", "9999",
                "--runs", "1",
                "--quiet",
                "--skip-feedback",
                "--output-dir", output_dir,
                "--cmd", "echo test",
                "--variants", "3",
            ]):
                with patch.dict(os.environ, {"AUTOPROTO_EVAL_CMD": "echo test"}):
                    import evaluate
                    evaluate.main()

    results_path = os.path.join(output_dir, "eval_results.json")
    assert _original_exists(results_path), "eval_results.json should be written"

    with open(results_path) as f:
        data = json.load(f)

    # Multi-variant output has variants and convergence keys
    assert "variants" in data
    assert len(data["variants"]) == 3
    assert "convergence" in data
    assert "composite_score" in data

    # Each variant entry has expected keys
    for v in data["variants"]:
        assert "variant_id" in v
        assert "label" in v
        assert "composite_score" in v
        assert "tasks" in v

    # Convergence analysis has expected structure
    conv = data["convergence"]
    assert "overall_agreement" in conv
    assert "strong_signals" in conv
    assert "bias_flags" in conv


# ---------------------------------------------------------------------------
# E2E 3: Full report generation pipeline
# ---------------------------------------------------------------------------

def test_e2e_report_generation(tmp_experiment_dir):
    """generate_report.main() writes report.md with expected sections."""
    import generate_report

    report_path = os.path.join(tmp_experiment_dir, "report.md")

    with patch("sys.argv", [
        "generate_report.py",
        tmp_experiment_dir,
    ]):
        generate_report.main()

    assert os.path.exists(report_path), "report.md should be written"

    with open(report_path) as f:
        report = f.read()

    # Verify all major sections
    assert "# Comparative Report" in report
    assert "## Summary" in report
    assert "## Prototype Comparison" in report
    assert "## Verbatim Feedback" in report
    assert "## Recommendations" in report

    # Variant-dependent sections (fixture has variants)
    assert "## Strongest Signals" in report
    assert "## Bias Flags" in report

    # Proto data present
    assert "proto-a" in report
    assert "proto-b" in report
    assert "85.0" in report  # proto-a composite


def test_e2e_report_custom_output(tmp_experiment_dir, tmp_path):
    """generate_report.main() with --output writes to the specified path."""
    import generate_report

    custom_path = str(tmp_path / "custom_report.md")

    with patch("sys.argv", [
        "generate_report.py",
        tmp_experiment_dir,
        "--output", custom_path,
    ]):
        generate_report.main()

    assert os.path.exists(custom_path)
    with open(custom_path) as f:
        report = f.read()
    assert "# Comparative Report" in report


def test_e2e_report_with_hypotheses(tmp_experiment_dir):
    """generate_report.main() with --hypotheses includes the Hypotheses section."""
    import generate_report

    hyp_path = os.path.join(tmp_experiment_dir, "hypotheses.md")
    with open(hyp_path, "w") as f:
        f.write(
            "# Hypotheses\n\n"
            "## H1: Quick tip calculation\n"
            "- question: Can a user compute a tip in <30s?\n"
            "- measure: Task 1 time\n"
            "- status: unresolved\n"
        )

    report_path = os.path.join(tmp_experiment_dir, "report.md")

    with patch("sys.argv", [
        "generate_report.py",
        tmp_experiment_dir,
        "--hypotheses", hyp_path,
    ]):
        generate_report.main()

    with open(report_path) as f:
        report = f.read()
    assert "## Hypotheses" in report
    assert "H1" in report
    assert "Quick tip calculation" in report
