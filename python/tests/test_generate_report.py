"""Tests for generate_report.py using the tmp_experiment_dir fixture."""

import json
import os
import tempfile

import pytest

from generate_report import (
    _load_prototype_results,
    _load_best_scores_from_history,
    _load_requirements_versions,
    _get_task_feedback,
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
# 1b. "Why Others Didn't Win" section
# ---------------------------------------------------------------------------

class TestWhyOthersDidntWin:
    def test_section_present_with_multiple_prototypes(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        assert "## Why Other Prototypes Didn't Win" in report

    def test_section_names_losing_prototype(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        # proto-b is the loser (72.0 < 85.0)
        assert "proto-b" in report.split("Why Other Prototypes Didn't Win")[1]

    def test_shows_score_gap(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        section = report.split("Why Other Prototypes Didn't Win")[1]
        # Gap is 85.0 - 72.0 = 13.0
        assert "13.0" in section

    def test_shows_bias_concerns_for_loser(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        section = report.split("Why Other Prototypes Didn't Win")[1]
        # proto-b has bias flags
        assert "Bias concerns" in section
        assert "Possible positive bias" in section

    def test_shows_lower_variant_agreement(self, tmp_experiment_dir):
        report = generate_report(tmp_experiment_dir)
        section = report.split("Why Other Prototypes Didn't Win")[1]
        # proto-b agreement 0.85 < proto-a 0.92
        assert "Lower variant agreement" in section

    def test_not_present_with_single_prototype(self):
        """Section should not appear with only one prototype."""
        with tempfile.TemporaryDirectory() as d:
            proto_dir = os.path.join(d, "proto-x")
            os.makedirs(proto_dir)
            data = {
                "composite_score": 70.0,
                "p0_score": 80.0, "p1_score": 60.0, "p2_score": 50.0,
                "tasks": [{
                    "number": 1, "name": "Test", "tier": "P0",
                    "completed": True, "score": 80.0, "steps": 2,
                    "stuck_points": [], "found_answer": "42",
                    "notes": "", "persona_feedback": "OK.",
                    "wishlist": [],
                }],
            }
            with open(os.path.join(proto_dir, "eval_results.json"), "w") as f:
                json.dump(data, f)

            report = generate_report(d)
            assert "Why Other Prototypes Didn't Win" not in report


class TestWhyOthersTaskLevel:
    """Test task-level analysis in the 'Why Others Didn't Win' section."""

    def test_shows_failed_tasks_that_winner_passed(self):
        with tempfile.TemporaryDirectory() as d:
            # Winner: proto-a passes task 1
            proto_a = os.path.join(d, "proto-a")
            os.makedirs(proto_a)
            with open(os.path.join(proto_a, "eval_results.json"), "w") as f:
                json.dump({
                    "composite_score": 90.0, "p0_score": 100.0,
                    "p1_score": 80.0, "p2_score": 70.0,
                    "tasks": [{
                        "number": 1, "name": "Core task", "tier": "P0",
                        "completed": True, "score": 100.0, "steps": 2,
                        "stuck_points": [], "found_answer": "yes",
                        "notes": "", "persona_feedback": "Great!",
                        "wishlist": [],
                    }],
                }, f)

            # Loser: proto-b fails task 1
            proto_b = os.path.join(d, "proto-b")
            os.makedirs(proto_b)
            with open(os.path.join(proto_b, "eval_results.json"), "w") as f:
                json.dump({
                    "composite_score": 40.0, "p0_score": 0.0,
                    "p1_score": 80.0, "p2_score": 70.0,
                    "tasks": [{
                        "number": 1, "name": "Core task", "tier": "P0",
                        "completed": False, "score": 0.0, "steps": 10,
                        "stuck_points": ["Couldn't find the button"],
                        "found_answer": None,
                        "notes": "Gave up",
                        "persona_feedback": "I couldn't figure it out.",
                        "wishlist": [],
                    }],
                }, f)

            report = generate_report(d)
            section = report.split("Why Other Prototypes Didn't Win")[1]
            assert "failed" in section.lower()
            assert "Core task" in section

    def test_shows_unique_stuck_points(self):
        with tempfile.TemporaryDirectory() as d:
            proto_a = os.path.join(d, "proto-a")
            os.makedirs(proto_a)
            with open(os.path.join(proto_a, "eval_results.json"), "w") as f:
                json.dump({
                    "composite_score": 80.0, "p0_score": 90.0,
                    "p1_score": 70.0, "p2_score": 60.0,
                    "tasks": [{
                        "number": 1, "name": "Task", "tier": "P0",
                        "completed": True, "score": 90.0, "steps": 3,
                        "stuck_points": [], "found_answer": "yes",
                        "notes": "", "persona_feedback": "", "wishlist": [],
                    }],
                }, f)

            proto_b = os.path.join(d, "proto-b")
            os.makedirs(proto_b)
            with open(os.path.join(proto_b, "eval_results.json"), "w") as f:
                json.dump({
                    "composite_score": 50.0, "p0_score": 60.0,
                    "p1_score": 40.0, "p2_score": 30.0,
                    "tasks": [{
                        "number": 1, "name": "Task", "tier": "P0",
                        "completed": True, "score": 60.0, "steps": 8,
                        "stuck_points": ["Navigation was confusing"],
                        "found_answer": "yes",
                        "notes": "", "persona_feedback": "", "wishlist": [],
                    }],
                }, f)

            report = generate_report(d)
            section = report.split("Why Other Prototypes Didn't Win")[1]
            assert "Unique stuck points" in section
            assert "Navigation was confusing" in section


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


def test_load_prototype_results_prefers_best_dir(tmp_path):
    """When best/<proto>/eval_results.json exists, it should be preferred over proto-*/eval_results.json."""
    exp = tmp_path / "exp"
    exp.mkdir()

    # Create proto-a with a lower-score result
    proto = exp / "proto-a"
    proto.mkdir()
    (proto / "eval_results.json").write_text(json.dumps({
        "composite_score": 50.0,
        "p0_score": 60,
        "p1_score": 40,
        "p2_score": 30,
        "tasks": [],
    }))

    # Create best/proto-a with a higher-score result
    best = exp / "best" / "proto-a"
    best.mkdir(parents=True)
    (best / "eval_results.json").write_text(json.dumps({
        "composite_score": 79.3,
        "p0_score": 82,
        "p1_score": 63.3,
        "p2_score": 95,
        "tasks": [],
    }))

    results = _load_prototype_results(str(exp))
    assert len(results) == 1
    assert results[0]["composite_score"] == 79.3
    assert "best" in results[0]["_results_source"]


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


# ---------------------------------------------------------------------------
# 7. Verbatim feedback fallback to notes/stuck_points
# ---------------------------------------------------------------------------

def test_feedback_fallback_to_notes():
    """When persona_feedback is empty, the report should use notes and stuck_points."""
    with tempfile.TemporaryDirectory() as d:
        proto = os.path.join(d, "proto-a")
        os.makedirs(proto)
        with open(os.path.join(proto, "eval_results.json"), "w") as f:
            json.dump({
                "composite_score": 70.0,
                "p0_score": 80.0, "p1_score": 60.0, "p2_score": 50.0,
                "tasks": [
                    {
                        "number": 1, "name": "Task with notes", "tier": "P0",
                        "completed": True, "score": 80.0, "steps": 3,
                        "stuck_points": [], "found_answer": "42",
                        "notes": "The persona found the answer after some exploration",
                        "persona_feedback": "",
                        "wishlist": [],
                    },
                    {
                        "number": 2, "name": "Task with stuck", "tier": "P0",
                        "completed": False, "score": 0.0, "steps": 10,
                        "stuck_points": ["Reached maximum step limit", "Couldn't find search button"],
                        "found_answer": None,
                        "notes": "",
                        "persona_feedback": "",
                        "wishlist": [],
                    },
                ],
            }, f)

        report = generate_report(d)
        assert "The persona found the answer" in report
        assert "Reached maximum step limit" in report
        assert "Couldn't find search button" in report
        # Should NOT show the "no feedback available" message since we have notes/stuck
        assert "quick mode which skips feedback" not in report


def test_feedback_shows_no_feedback_message_when_truly_empty():
    """When all feedback sources are empty, show an explanatory message."""
    with tempfile.TemporaryDirectory() as d:
        proto = os.path.join(d, "proto-a")
        os.makedirs(proto)
        with open(os.path.join(proto, "eval_results.json"), "w") as f:
            json.dump({
                "composite_score": 70.0,
                "p0_score": 80.0, "p1_score": 60.0, "p2_score": 50.0,
                "tasks": [
                    {
                        "number": 1, "name": "Silent task", "tier": "P0",
                        "completed": True, "score": 80.0, "steps": 3,
                        "stuck_points": [], "found_answer": "42",
                        "notes": "", "persona_feedback": "", "wishlist": [],
                    },
                ],
            }, f)

        report = generate_report(d)
        assert "quick mode which skips feedback" in report


def test_get_task_feedback_priority():
    """_get_task_feedback should prefer persona_feedback > notes > stuck_points."""
    # persona_feedback wins
    assert _get_task_feedback({"persona_feedback": "Great!", "notes": "ok", "stuck_points": ["stuck"]}) == "Great!"
    # notes is fallback
    assert _get_task_feedback({"persona_feedback": "", "notes": "Agent notes", "stuck_points": ["stuck"]}) == "Agent notes"
    # stuck_points is last resort
    assert _get_task_feedback({"persona_feedback": "", "notes": "", "stuck_points": ["stuck1", "stuck2"]}) == "stuck1; stuck2"
    # empty everything
    assert _get_task_feedback({"persona_feedback": "", "notes": "", "stuck_points": []}) == ""


# ---------------------------------------------------------------------------
# 8. Score discrepancy detection from iteration history
# ---------------------------------------------------------------------------

def test_score_discrepancy_from_autoproto_jsonl(tmp_path):
    """When autoproto.jsonl has a higher kept score than eval_results.json, flag it."""
    exp = tmp_path / "results" / "recipe"
    exp.mkdir(parents=True)

    # Proto-a eval_results shows 71.4 (lost the 79.3 result)
    proto = exp / "proto-a"
    proto.mkdir()
    (proto / "eval_results.json").write_text(json.dumps({
        "composite_score": 71.4,
        "p0_score": 82, "p1_score": 60, "p2_score": 48,
        "tasks": [{"number": 1, "name": "T1", "tier": "P0", "completed": True,
                   "score": 82, "steps": 3, "stuck_points": [], "found_answer": "yes",
                   "notes": "ok", "persona_feedback": "", "wishlist": []}],
    }))

    # autoproto.jsonl in project root has the actual best
    jsonl_path = tmp_path / "autoproto.jsonl"
    lines = [
        json.dumps({"type": "config", "mode": "full", "experiment": "recipe"}),
        json.dumps({"type": "iteration", "iteration": 5, "composite": 71.4,
                    "p0": 82, "p1": 60, "p2": 48, "kept": True,
                    "branch": "autoproto/recipe/proto-a"}),
        json.dumps({"type": "iteration", "iteration": 6, "composite": 79.3,
                    "p0": 82, "p1": 63.3, "p2": 95, "kept": True,
                    "branch": "autoproto/recipe/proto-a"}),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n")

    report = generate_report(str(exp))
    assert "Score Discrepancies" in report
    assert "79.3" in report
    # Recommendations should also reflect the higher score
    assert "peak: 79.3" in report


def test_winner_uses_history_best_score(tmp_path):
    """The 'strongest prototype' should use the best score from history, not just eval_results."""
    exp = tmp_path / "results" / "recipe"
    exp.mkdir(parents=True)

    # Proto-a: eval shows 71.4, history has 79.3
    proto_a = exp / "proto-a"
    proto_a.mkdir()
    (proto_a / "eval_results.json").write_text(json.dumps({
        "composite_score": 71.4,
        "p0_score": 82, "p1_score": 60, "p2_score": 48,
        "tasks": [{"number": 1, "name": "T1", "tier": "P0", "completed": True,
                   "score": 82, "steps": 3, "stuck_points": [], "found_answer": "yes",
                   "notes": "", "persona_feedback": "", "wishlist": []}],
    }))

    # Proto-c: eval shows 74.9
    proto_c = exp / "proto-c"
    proto_c.mkdir()
    (proto_c / "eval_results.json").write_text(json.dumps({
        "composite_score": 74.9,
        "p0_score": 79.7, "p1_score": 50.7, "p2_score": 96,
        "tasks": [{"number": 1, "name": "T1", "tier": "P0", "completed": True,
                   "score": 79.7, "steps": 3, "stuck_points": [], "found_answer": "yes",
                   "notes": "", "persona_feedback": "", "wishlist": []}],
    }))

    # autoproto.jsonl has proto-a's actual peak at 79.3
    jsonl_path = tmp_path / "autoproto.jsonl"
    lines = [
        json.dumps({"type": "config", "mode": "full", "experiment": "recipe"}),
        json.dumps({"type": "iteration", "iteration": 6, "composite": 79.3,
                    "p0": 82, "p1": 63.3, "p2": 95, "kept": True,
                    "branch": "autoproto/recipe/proto-a"}),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n")

    report = generate_report(str(exp))
    # Proto-a should be the winner (79.3 > 74.9)
    rec_section = report.split("## Recommendations")[1]
    assert "proto-a" in rec_section
    assert "Strongest prototype" in rec_section


# ---------------------------------------------------------------------------
# 9. Exploratory tasks and session wishlist in report
# ---------------------------------------------------------------------------

def test_exploratory_tasks_in_report():
    """Exploratory tasks should appear in their own section."""
    with tempfile.TemporaryDirectory() as d:
        proto = os.path.join(d, "proto-a")
        os.makedirs(proto)
        with open(os.path.join(proto, "eval_results.json"), "w") as f:
            json.dump({
                "composite_score": 70.0,
                "p0_score": 80.0, "p1_score": 60.0, "p2_score": 50.0,
                "tasks": [{"number": 1, "name": "Core task", "tier": "P0",
                           "completed": True, "score": 80.0, "steps": 3,
                           "stuck_points": [], "found_answer": "42",
                           "notes": "", "persona_feedback": "ok", "wishlist": []}],
                "exploratory_tasks": [
                    {"number": 101, "name": "What if I clear everything?", "tier": "EX",
                     "completed": True, "score": 60.0, "steps": 4,
                     "stuck_points": [], "found_answer": "reset works",
                     "notes": "The reset button worked but there was no confirmation",
                     "persona_feedback": "I accidentally cleared my data once",
                     "wishlist": []},
                ],
                "exploratory_score": 60.0,
            }, f)

        report = generate_report(d)
        assert "## Exploratory Tasks" in report
        assert "What if I clear everything?" in report
        assert "accidentally cleared" in report
        # Exploratory score in comparison table
        assert "Exploratory score" in report
        assert "60.0" in report


def test_session_wishlist_in_report():
    """Session wishlist should appear in its own section."""
    with tempfile.TemporaryDirectory() as d:
        proto = os.path.join(d, "proto-a")
        os.makedirs(proto)
        with open(os.path.join(proto, "eval_results.json"), "w") as f:
            json.dump({
                "composite_score": 70.0,
                "p0_score": 80.0, "p1_score": 60.0, "p2_score": 50.0,
                "tasks": [{"number": 1, "name": "Core task", "tier": "P0",
                           "completed": True, "score": 80.0, "steps": 3,
                           "stuck_points": [], "found_answer": "42",
                           "notes": "", "persona_feedback": "ok", "wishlist": []}],
                "session_wishlist": {
                    "wishlist": [
                        "I wish I could save my favorite recipes",
                        "A weekly meal planner would change my Tuesday nights",
                    ],
                    "surprise": "I was surprised by how fast it found recipes",
                    "would_use": "Yes, this is faster than scrolling through my usual recipe apps",
                },
            }, f)

        report = generate_report(d)
        assert "## Session Wishlist" in report
        assert "save my favorite recipes" in report
        assert "weekly meal planner" in report
        assert "Surprise" in report
        assert "faster than scrolling" in report
        assert "Would use" in report


def test_no_exploratory_section_when_absent():
    """No exploratory section when no prototypes have exploratory tasks."""
    with tempfile.TemporaryDirectory() as d:
        proto = os.path.join(d, "proto-a")
        os.makedirs(proto)
        with open(os.path.join(proto, "eval_results.json"), "w") as f:
            json.dump({
                "composite_score": 70.0,
                "p0_score": 80.0, "p1_score": 60.0, "p2_score": 50.0,
                "tasks": [{"number": 1, "name": "T", "tier": "P0",
                           "completed": True, "score": 80.0, "steps": 3,
                           "stuck_points": [], "found_answer": "42",
                           "notes": "", "persona_feedback": "ok", "wishlist": []}],
            }, f)

        report = generate_report(d)
        assert "## Exploratory Tasks" not in report
        assert "## Session Wishlist" not in report


def test_requirements_evolution_section_with_multiple_versions(tmp_experiment_dir):
    """Report shows Requirements Evolution when 2+ versions exist."""
    # Fixture already has requirements_v0.md; add a second version
    with open(os.path.join(tmp_experiment_dir, "requirements_v1.md"), "w") as f:
        f.write("# Requirements v1\n## P0\n### Task 1: Basic calc (updated)\n")

    report = generate_report(tmp_experiment_dir)
    assert "## Requirements Evolution" in report
    assert "requirements_v0.md" in report
    assert "requirements_v1.md" in report
