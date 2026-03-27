"""Tests for generate_report.py using the tmp_experiment_dir fixture."""

import json
import os
import tempfile

import pytest

from generate_report import (
    _load_prototype_results,
    _load_requirements_versions,
    generate_report,
)


# ---------------------------------------------------------------------------
# 1. generate_report() with 2 prototypes + variants
# ---------------------------------------------------------------------------

class TestGenerateReportFull:
    def test_report_header(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "# Comparative Report" in report

    def test_prototype_comparison_table(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "## Prototype Comparison" in report
        assert "proto-a" in report
        assert "proto-b" in report
        assert "Composite score" in report

    def test_verbatim_feedback_section(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "## Verbatim Feedback" in report
        # Variant-level feedback should appear as quotes
        assert "Fast enough for after my shift." in report
        assert "I double-checked and the math is correct." in report

    def test_bias_flags_section(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "## Bias Flags" in report
        # proto-b has a bias flag; proto-a does not
        assert "Possible positive bias" in report

    def test_recommendations_section(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "## Recommendations" in report
        # proto-a has the highest composite (85.0 > 72.0)
        assert "Strongest prototype" in report
        assert "proto-a" in report

    def test_strongest_signals_section(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "## Strongest Signals" in report

    def test_variant_agreement_in_table(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "Variant agreement" in report
        # proto-a agreement is 0.92
        assert "0.92" in report

    def test_recommendations_flag_biased_prototypes(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        # Recommendations should call out proto-b for bias validation
        assert "Validate with real users" in report


# ---------------------------------------------------------------------------
# 2. generate_report() with empty dir (no proto-* dirs)
# ---------------------------------------------------------------------------

def test_empty_dir_returns_error():
    with tempfile.TemporaryDirectory() as d:
        report = generate_report(d)
        assert "# Error" in report
        assert "No prototype results found" in report


# ---------------------------------------------------------------------------
# 3. generate_report() without variants key
# ---------------------------------------------------------------------------

def test_no_variants_skips_convergence_sections():
    with tempfile.TemporaryDirectory() as d:
        proto_dir = os.path.join(d, "proto-x")
        os.makedirs(proto_dir)
        data = {
            "composite_score": 70.0,
            "p0_score": 80.0,
            "p1_score": 60.0,
            "p2_score": 50.0,
            "tasks": [
                {
                    "number": 1,
                    "name": "Test task",
                    "tier": "P0",
                    "completed": True,
                    "score": 80.0,
                    "steps": 2,
                    "stuck_points": [],
                    "found_answer": "42",
                    "notes": "",
                    "persona_feedback": "It was fine.",
                    "wishlist": [],
                },
            ],
        }
        with open(os.path.join(proto_dir, "eval_results.json"), "w") as f:
            json.dump(data, f)

        report = generate_report(d)
        # No variant-specific sections
        assert "Strongest Signals" not in report
        assert "Interesting Disagreements" not in report
        assert "Bias Flags" not in report
        # Basic sections still present
        assert "## Prototype Comparison" in report
        assert "## Verbatim Feedback" in report
        assert "## Recommendations" in report


# ---------------------------------------------------------------------------
# 4. generate_report() with hypotheses file
# ---------------------------------------------------------------------------

def test_hypotheses_section_appears(tmp_experiment_dir):
    hyp_path = os.path.join(tmp_experiment_dir, "hypotheses.md")
    with open(hyp_path, "w") as f:
        f.write(
            "# Hypotheses\n\n"
            "## H1: Users can calculate tips quickly\n"
            "- question: Can users compute a tip in under 30 seconds?\n"
            "- measure: Task 1 completion time\n"
            "- status: unresolved\n\n"
            "## H2: Error handling is intuitive\n"
            "- question: Do users understand error messages?\n"
            "- measure: Task 3 completion rate\n"
            "- status: unresolved\n"
        )

    report = generate_report(tmp_experiment_dir, hypotheses_path=hyp_path)
    assert "## Hypotheses" in report
    assert "H1" in report
    assert "Users can calculate tips quickly" in report
    assert "H2" in report
    assert "Error handling is intuitive" in report


# ---------------------------------------------------------------------------
# 5. _load_prototype_results()
# ---------------------------------------------------------------------------

def test_load_prototype_results(tmp_experiment_dir):
    results = _load_prototype_results(tmp_experiment_dir)
    assert len(results) == 2
    ids = [r["_proto_id"] for r in results]
    assert "proto-a" in ids
    assert "proto-b" in ids
    # Check that composite scores match fixture data
    by_id = {r["_proto_id"]: r for r in results}
    assert by_id["proto-a"]["composite_score"] == 85.0
    assert by_id["proto-b"]["composite_score"] == 72.0


def test_load_prototype_results_reads_approach_md(tmp_experiment_dir):
    """When approach.md exists, _proto_name comes from its header."""
    approach_path = os.path.join(tmp_experiment_dir, "proto-a", "approach.md")
    with open(approach_path, "w") as f:
        f.write("# Approach: Minimal Calculator\n\nA simple calculator app.\n")

    results = _load_prototype_results(tmp_experiment_dir)
    by_id = {r["_proto_id"]: r for r in results}
    assert by_id["proto-a"]["_proto_name"] == "Minimal Calculator"
    # proto-b has no approach.md, so _proto_name falls back to dir name
    assert by_id["proto-b"]["_proto_name"] == "proto-b"


# ---------------------------------------------------------------------------
# 6. _load_requirements_versions()
# ---------------------------------------------------------------------------

def test_load_requirements_versions(tmp_experiment_dir):
    versions = _load_requirements_versions(tmp_experiment_dir)
    assert len(versions) >= 1
    filenames = [v[0] for v in versions]
    assert "requirements_v0.md" in filenames
    # Content should match what the fixture wrote
    v0_content = next(content for name, content in versions if name == "requirements_v0.md")
    assert "# Requirements v0" in v0_content


def test_load_requirements_versions_includes_final(tmp_experiment_dir):
    """requirements_final.md should be picked up if it exists."""
    final_path = os.path.join(tmp_experiment_dir, "requirements_final.md")
    with open(final_path, "w") as f:
        f.write("# Requirements Final\n## P0\n### Task 1: Basic calc\n")

    versions = _load_requirements_versions(tmp_experiment_dir)
    filenames = [v[0] for v in versions]
    assert "requirements_final.md" in filenames


def test_requirements_evolution_section_with_multiple_versions(tmp_experiment_dir):
    """Report shows Requirements Evolution when 2+ versions exist."""
    # Fixture already has requirements_v0.md; add a second version
    with open(os.path.join(tmp_experiment_dir, "requirements_v1.md"), "w") as f:
        f.write("# Requirements v1\n## P0\n### Task 1: Basic calc (updated)\n")

    report = generate_report(tmp_experiment_dir)
    assert "## Requirements Evolution" in report
    assert "requirements_v0.md" in report
    assert "requirements_v1.md" in report
