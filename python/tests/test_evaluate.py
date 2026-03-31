"""Comprehensive tests for evaluate.py."""

import json
import os
import sys
import tempfile

import pytest

# Ensure project root is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import patch

from persona_parser import Persona, PersonaTask, PersonaVariant, TaskResult


# ---------------------------------------------------------------------------
# 1. _try_parse_json() tests
# ---------------------------------------------------------------------------

class TestTryParseJson:
    """Pure-function tests for _try_parse_json."""

    def test_clean_json(self):
        from evaluate import _try_parse_json
        result = _try_parse_json('{"key": "value", "num": 42}')
        assert result == {"key": "value", "num": 42}

    def test_json_in_markdown_fences(self):
        from evaluate import _try_parse_json
        text = '```json\n{"action": "click", "ref": "e3"}\n```'
        result = _try_parse_json(text)
        assert result == {"action": "click", "ref": "e3"}

    def test_json_in_plain_fences(self):
        from evaluate import _try_parse_json
        text = '```\n{"foo": "bar"}\n```'
        result = _try_parse_json(text)
        assert result == {"foo": "bar"}

    def test_json_with_text_preamble(self):
        from evaluate import _try_parse_json
        text = 'Here is my response:\n{"score": 85, "notes": "good"}'
        result = _try_parse_json(text)
        assert result is not None
        assert result["score"] == 85

    def test_non_json_text_returns_none(self):
        from evaluate import _try_parse_json
        result = _try_parse_json("This is just plain text with no JSON at all.")
        assert result is None

    def test_empty_string_returns_none(self):
        from evaluate import _try_parse_json
        result = _try_parse_json("")
        assert result is None

    def test_nested_json_objects(self):
        from evaluate import _try_parse_json
        text = '{"outer": {"inner": "value"}, "list": [1, 2]}'
        result = _try_parse_json(text)
        assert result is not None
        assert result["outer"]["inner"] == "value"
        assert result["list"] == [1, 2]

    def test_json_with_trailing_text(self):
        from evaluate import _try_parse_json
        text = '{"key": "val"}\nSome trailing explanation.'
        result = _try_parse_json(text)
        assert result is not None
        assert result["key"] == "val"

    def test_json_with_boolean_values(self):
        from evaluate import _try_parse_json
        text = '{"completed": true, "stuck": false}'
        result = _try_parse_json(text)
        assert result == {"completed": True, "stuck": False}


# ---------------------------------------------------------------------------
# 2. _build_prompt() tests
# ---------------------------------------------------------------------------

class TestBuildPrompt:
    """Pure-function tests for _build_prompt."""

    def test_contains_persona_name(self, sample_persona):
        from evaluate import _build_prompt
        task = sample_persona.tasks[0]
        prompt = _build_prompt(sample_persona, task, "snapshot text", [])
        assert sample_persona.name in prompt

    def test_contains_task_goal(self, sample_persona):
        from evaluate import _build_prompt
        task = sample_persona.tasks[0]
        prompt = _build_prompt(sample_persona, task, "snapshot text", [])
        assert task.goal in prompt

    def test_contains_snapshot(self, sample_persona):
        from evaluate import _build_prompt
        task = sample_persona.tasks[0]
        snapshot = "<button>Calculate</button>"
        prompt = _build_prompt(sample_persona, task, snapshot, [])
        assert snapshot in prompt

    def test_empty_history_no_previous_actions(self, sample_persona):
        from evaluate import _build_prompt
        task = sample_persona.tasks[0]
        prompt = _build_prompt(sample_persona, task, "snapshot", [])
        assert "PREVIOUS ACTIONS" not in prompt

    def test_with_history_numbered_steps(self, sample_persona):
        from evaluate import _build_prompt
        task = sample_persona.tasks[0]
        history = ["clicked @e1 (start)", "filled @e2 with '50'"]
        prompt = _build_prompt(sample_persona, task, "snapshot", history)
        assert "PREVIOUS ACTIONS" in prompt
        assert "Step 1:" in prompt
        assert "Step 2:" in prompt
        assert "clicked @e1" in prompt
        assert "filled @e2" in prompt

    def test_contains_action_instructions(self, sample_persona):
        from evaluate import _build_prompt
        task = sample_persona.tasks[0]
        prompt = _build_prompt(sample_persona, task, "snapshot", [])
        assert '"action": "click"' in prompt
        assert '"action": "done"' in prompt


# ---------------------------------------------------------------------------
# 3. _build_vision_prompt() tests
# ---------------------------------------------------------------------------

class TestBuildVisionPrompt:
    """Pure-function tests for _build_vision_prompt."""

    def test_contains_persona_name(self, sample_persona):
        from evaluate import _build_vision_prompt
        task = sample_persona.tasks[0]
        prompt = _build_vision_prompt(sample_persona, task, "legend text", [])
        assert sample_persona.name in prompt

    def test_contains_task_goal(self, sample_persona):
        from evaluate import _build_vision_prompt
        task = sample_persona.tasks[0]
        prompt = _build_vision_prompt(sample_persona, task, "legend text", [])
        assert task.goal in prompt

    def test_contains_legend(self, sample_persona):
        from evaluate import _build_vision_prompt
        task = sample_persona.tasks[0]
        legend = "[1] button 'Submit'\n[2] input 'Amount'"
        prompt = _build_vision_prompt(sample_persona, task, legend, [])
        assert legend in prompt

    def test_references_numbered_labels(self, sample_persona):
        from evaluate import _build_vision_prompt
        task = sample_persona.tasks[0]
        prompt = _build_vision_prompt(sample_persona, task, "legend", [])
        # The prompt explains that [N] labels map to @eN refs
        assert "[1]" in prompt or "@e1" in prompt

    def test_empty_history_no_previous_actions(self, sample_persona):
        from evaluate import _build_vision_prompt
        task = sample_persona.tasks[0]
        prompt = _build_vision_prompt(sample_persona, task, "legend", [])
        assert "PREVIOUS ACTIONS" not in prompt

    def test_with_history(self, sample_persona):
        from evaluate import _build_vision_prompt
        task = sample_persona.tasks[0]
        history = ["clicked @e3 (submit button)"]
        prompt = _build_vision_prompt(sample_persona, task, "legend", history)
        assert "PREVIOUS ACTIONS" in prompt
        assert "Step 1:" in prompt


# ---------------------------------------------------------------------------
# 4. _aggregate_runs() tests
# ---------------------------------------------------------------------------

class TestAggregateRuns:
    """Pure-function tests for _aggregate_runs."""

    def _make_result(self, task, completed, score, steps=3,
                     stuck_points=None, feedback="", wishlist=None):
        return TaskResult(
            task=task,
            completed=completed,
            score=score,
            steps=steps,
            stuck_points=stuck_points or [],
            found_answer="answer" if completed else None,
            notes="some notes" if completed else "failed",
            persona_feedback=feedback,
            wishlist=wishlist or [],
        )

    def test_majority_pass(self, sample_tasks):
        """3 runs where 2/3 pass -> aggregated completed=True."""
        from evaluate import _aggregate_runs
        task = sample_tasks[0]
        run1 = [self._make_result(task, True, 100)]
        run2 = [self._make_result(task, True, 90)]
        run3 = [self._make_result(task, False, 0)]
        result = _aggregate_runs([run1, run2, run3])
        assert len(result) == 1
        assert result[0].completed is True

    def test_majority_fail(self, sample_tasks):
        """3 runs where 2/3 fail -> aggregated completed=False."""
        from evaluate import _aggregate_runs
        task = sample_tasks[0]
        run1 = [self._make_result(task, False, 0)]
        run2 = [self._make_result(task, True, 80)]
        run3 = [self._make_result(task, False, 0)]
        result = _aggregate_runs([run1, run2, run3])
        assert result[0].completed is False

    def test_median_score_selected(self, sample_tasks):
        """Median of [0, 80, 100] = 80."""
        from evaluate import _aggregate_runs
        task = sample_tasks[0]
        run1 = [self._make_result(task, True, 100)]
        run2 = [self._make_result(task, True, 80)]
        run3 = [self._make_result(task, False, 0)]
        result = _aggregate_runs([run1, run2, run3])
        assert result[0].score == 80

    def test_wishlist_deduplicated(self, sample_tasks):
        """Duplicate wishes across runs are deduplicated (case-insensitive)."""
        from evaluate import _aggregate_runs
        task = sample_tasks[0]
        run1 = [self._make_result(task, True, 100, wishlist=["Add dark mode"])]
        run2 = [self._make_result(task, True, 90, wishlist=["add dark mode", "Split bill"])]
        run3 = [self._make_result(task, True, 95, wishlist=["Split bill"])]
        result = _aggregate_runs([run1, run2, run3])
        # "Add dark mode" and "add dark mode" should be deduplicated
        wish_lower = [w.lower() for w in result[0].wishlist]
        assert wish_lower.count("add dark mode") == 1
        assert "split bill" in wish_lower

    def test_first_nonempty_feedback(self, sample_tasks):
        """First non-empty persona_feedback is selected."""
        from evaluate import _aggregate_runs
        task = sample_tasks[0]
        run1 = [self._make_result(task, True, 100, feedback="")]
        run2 = [self._make_result(task, True, 90, feedback="Great experience!")]
        run3 = [self._make_result(task, True, 95, feedback="Also good")]
        result = _aggregate_runs([run1, run2, run3])
        assert result[0].persona_feedback == "Great experience!"

    def test_stuck_points_merged_and_deduplicated(self, sample_tasks):
        """Stuck points from all runs are merged and deduplicated."""
        from evaluate import _aggregate_runs
        task = sample_tasks[0]
        run1 = [self._make_result(task, False, 0, stuck_points=["Can't find button"])]
        run2 = [self._make_result(task, False, 0, stuck_points=["Can't find button", "Timeout"])]
        run3 = [self._make_result(task, False, 0, stuck_points=["Timeout"])]
        result = _aggregate_runs([run1, run2, run3])
        # set() dedup in the function
        assert len(result[0].stuck_points) == 2
        assert set(result[0].stuck_points) == {"Can't find button", "Timeout"}

    def test_multiple_tasks_aggregated(self, sample_tasks):
        """Multiple tasks are each aggregated independently."""
        from evaluate import _aggregate_runs
        t1, t2 = sample_tasks[0], sample_tasks[1]
        run1 = [self._make_result(t1, True, 100), self._make_result(t2, False, 0)]
        run2 = [self._make_result(t1, True, 90), self._make_result(t2, False, 0)]
        run3 = [self._make_result(t1, False, 0), self._make_result(t2, True, 80)]
        result = _aggregate_runs([run1, run2, run3])
        assert len(result) == 2
        assert result[0].completed is True   # 2/3 pass
        assert result[1].completed is False   # 1/3 pass


# ---------------------------------------------------------------------------
# 5. _calibrate() tests
# ---------------------------------------------------------------------------

class TestCalibrate:
    """Pure-function tests for _calibrate."""

    def _make_run(self, tasks, scores):
        """Helper: build a list of TaskResults with the given scores (all completed)."""
        results = []
        for task, score in zip(tasks, scores):
            results.append(TaskResult(
                task=task,
                completed=score > 0,
                score=score,
                steps=3,
                stuck_points=[],
                found_answer="ans",
                notes="",
            ))
        return results

    def test_stable_runs_low_stdev(self, sample_tasks, sample_persona):
        """Identical runs should produce stdev=0."""
        from evaluate import _calibrate
        run = self._make_run(sample_tasks, [100, 90, 75, 50])
        result = _calibrate([run, run, run], sample_persona)
        assert result["stdev"] == 0.0

    def test_unstable_runs_high_stdev(self, sample_tasks, sample_persona):
        """Widely varying runs should produce high stdev."""
        from evaluate import _calibrate
        run1 = self._make_run(sample_tasks, [100, 100, 100, 100])
        run2 = self._make_run(sample_tasks, [0, 0, 0, 0])
        run3 = self._make_run(sample_tasks, [50, 50, 50, 50])
        result = _calibrate([run1, run2, run3], sample_persona)
        assert result["stdev"] > 10

    def test_single_run_stdev_zero(self, sample_tasks, sample_persona):
        """A single run should have stdev=0."""
        from evaluate import _calibrate
        run = self._make_run(sample_tasks, [100, 80, 60, 40])
        result = _calibrate([run], sample_persona)
        assert result["stdev"] == 0.0

    def test_per_task_agreement_all_agree(self, sample_tasks, sample_persona):
        """When all runs agree on pass/fail, per_task_agreement says 'agree'."""
        from evaluate import _calibrate
        run1 = self._make_run(sample_tasks, [100, 80, 60, 0])
        run2 = self._make_run(sample_tasks, [90, 70, 50, 0])
        result = _calibrate([run1, run2], sample_persona)
        for key, val in result["per_task_agreement"].items():
            assert val == "agree"

    def test_per_task_agreement_disagree(self, sample_tasks, sample_persona):
        """When runs disagree on pass/fail for a task, that task is 'disagree'."""
        from evaluate import _calibrate
        run1 = self._make_run(sample_tasks, [100, 80, 60, 0])
        # Task 4 passes in run2 (score>0 -> completed=True) but fails in run1 (score=0)
        run2 = self._make_run(sample_tasks, [90, 70, 50, 80])
        result = _calibrate([run1, run2], sample_persona)
        assert result["per_task_agreement"]["Task 4"] == "disagree"

    def test_calibrate_returns_composites_list(self, sample_tasks, sample_persona):
        """Result should contain a 'composites' list matching the number of runs."""
        from evaluate import _calibrate
        run1 = self._make_run(sample_tasks, [100, 80, 60, 40])
        run2 = self._make_run(sample_tasks, [90, 70, 50, 30])
        result = _calibrate([run1, run2], sample_persona)
        assert len(result["composites"]) == 2
        assert all(isinstance(c, float) for c in result["composites"])


# ---------------------------------------------------------------------------
# 6. analyze_convergence() tests
# ---------------------------------------------------------------------------

class TestAnalyzeConvergence:
    """Pure-function tests for analyze_convergence."""

    def _make_variant_result(self, variant_id, label, composite, tasks_data):
        """Build a variant result dict."""
        return {
            "variant_id": variant_id,
            "label": label,
            "composite_score": composite,
            "tasks": tasks_data,
        }

    def _make_task_data(self, number, name, tier, completed, score,
                        feedback="", wishlist=None):
        return {
            "number": number,
            "name": name,
            "tier": tier,
            "completed": completed,
            "score": score,
            "steps": 3,
            "stuck_points": [],
            "found_answer": "ans" if completed else None,
            "notes": "",
            "persona_feedback": feedback,
            "wishlist": wishlist or [],
        }

    def test_fewer_than_two_variants(self, sample_persona):
        from evaluate import analyze_convergence
        result = analyze_convergence([], sample_persona)
        assert result == {"note": "Convergence requires 2+ variants"}

    def test_single_variant(self, sample_persona):
        from evaluate import analyze_convergence
        vr = self._make_variant_result("v1", "Only", 85.0, [
            self._make_task_data(1, "Task A", "P0", True, 90),
        ])
        result = analyze_convergence([vr], sample_persona)
        assert result == {"note": "Convergence requires 2+ variants"}

    def test_high_agreement_all_pass(self, sample_persona):
        """All variants pass all tasks -> high confidence, high agreement."""
        from evaluate import analyze_convergence
        tasks = [
            self._make_task_data(1, "Calc", "P0", True, 95, feedback="Loved it."),
            self._make_task_data(2, "Split", "P0", True, 90, feedback="Frustrating at first."),
        ]
        vr1 = self._make_variant_result("v1", "Rushed", 92, tasks)
        vr2 = self._make_variant_result("v2", "Careful", 93, tasks)
        vr3 = self._make_variant_result("v3", "Relaxed", 91, tasks)
        result = analyze_convergence([vr1, vr2, vr3], sample_persona)
        assert result["overall_agreement"] > 0.95
        # All tasks should have high confidence
        for task_key, task_analysis in result["per_task"].items():
            assert task_analysis["confidence_label"] == "high"
            assert task_analysis["completion_rate"] == 1.0

    def test_split_signal_low_confidence(self, sample_persona):
        """2 pass, 2 fail -> low confidence and disagreement flagged."""
        from evaluate import analyze_convergence
        t_pass = self._make_task_data(1, "Calc", "P0", True, 90)
        t_fail = self._make_task_data(1, "Calc", "P0", False, 10)
        vr1 = self._make_variant_result("v1", "A", 85, [t_pass])
        vr2 = self._make_variant_result("v2", "B", 30, [t_fail])
        vr3 = self._make_variant_result("v3", "C", 80, [t_pass])
        vr4 = self._make_variant_result("v4", "D", 25, [t_fail])
        result = analyze_convergence([vr1, vr2, vr3, vr4], sample_persona)
        # 50% completion rate -> completion_agreement = 0.5 -> low confidence
        task_analysis = list(result["per_task"].values())[0]
        assert task_analysis["completion_rate"] == 0.5
        assert task_analysis["confidence_label"] == "low"
        assert len(result["disagreements"]) > 0

    def test_bias_detection_all_high_no_criticism(self, sample_persona):
        """All scores >80 with no criticism keywords -> bias flag."""
        from evaluate import analyze_convergence
        tasks = [
            self._make_task_data(1, "Calc", "P0", True, 95,
                                 feedback="Everything was wonderful and smooth."),
        ]
        vr1 = self._make_variant_result("v1", "A", 95, tasks)
        vr2 = self._make_variant_result("v2", "B", 92, tasks)
        result = analyze_convergence([vr1, vr2], sample_persona)
        assert len(result["bias_flags"]) > 0
        assert "positive bias" in result["bias_flags"][0].lower()

    def test_no_bias_when_criticism_present(self, sample_persona):
        """High scores but with criticism keywords -> no bias flag."""
        from evaluate import analyze_convergence
        tasks = [
            self._make_task_data(1, "Calc", "P0", True, 95,
                                 feedback="It was frustrating to find the button."),
        ]
        vr1 = self._make_variant_result("v1", "A", 95, tasks)
        vr2 = self._make_variant_result("v2", "B", 92, tasks)
        result = analyze_convergence([vr1, vr2], sample_persona)
        bias_msgs = [f for f in result["bias_flags"] if "positive bias" in f.lower()]
        assert len(bias_msgs) == 0

    def test_vague_feedback_flagged(self, sample_persona):
        """Short generic feedback -> flagged as low-signal."""
        from evaluate import analyze_convergence
        tasks = [
            self._make_task_data(1, "Calc", "P0", True, 70,
                                 feedback="It was nice."),
        ]
        vr1 = self._make_variant_result("v1", "A", 70, tasks)
        vr2 = self._make_variant_result("v2", "B", 72, tasks)
        result = analyze_convergence([vr1, vr2], sample_persona)
        vague_flags = [f for f in result["bias_flags"] if "vague" in f.lower() or "low-signal" in f.lower()]
        assert len(vague_flags) > 0

    def test_strong_signals_high_confidence_pass(self, sample_persona):
        """High-confidence pass generates a strong signal."""
        from evaluate import analyze_convergence
        tasks = [
            self._make_task_data(1, "Calc", "P0", True, 95,
                                 feedback="I found it confusing at times."),
        ]
        vr1 = self._make_variant_result("v1", "A", 92, tasks)
        vr2 = self._make_variant_result("v2", "B", 94, tasks)
        vr3 = self._make_variant_result("v3", "C", 91, tasks)
        result = analyze_convergence([vr1, vr2, vr3], sample_persona)
        assert len(result["strong_signals"]) > 0
        assert "PASSED" in result["strong_signals"][0]

    def test_strong_signals_high_confidence_fail(self, sample_persona):
        """High-confidence fail generates a strong signal about failure."""
        from evaluate import analyze_convergence
        tasks = [
            self._make_task_data(1, "Calc", "P0", False, 5,
                                 feedback="Couldn't do it."),
        ]
        vr1 = self._make_variant_result("v1", "A", 10, tasks)
        vr2 = self._make_variant_result("v2", "B", 8, tasks)
        vr3 = self._make_variant_result("v3", "C", 12, tasks)
        result = analyze_convergence([vr1, vr2, vr3], sample_persona)
        assert len(result["strong_signals"]) > 0
        assert "FAILED" in result["strong_signals"][0]

    def test_wishlist_collected(self, sample_persona):
        """Wishlist items from all variants are collected."""
        from evaluate import analyze_convergence
        t1 = self._make_task_data(1, "Calc", "P0", True, 90,
                                  feedback="It was confusing.", wishlist=["Dark mode"])
        t2 = self._make_task_data(1, "Calc", "P0", True, 88,
                                  feedback="Hard to find.", wishlist=["Bigger buttons"])
        vr1 = self._make_variant_result("v1", "A", 90, [t1])
        vr2 = self._make_variant_result("v2", "B", 88, [t2])
        result = analyze_convergence([vr1, vr2], sample_persona)
        assert "Dark mode" in result["wishlist_all"]
        assert "Bigger buttons" in result["wishlist_all"]


# ---------------------------------------------------------------------------
# 7. Mocked LLM tests
# ---------------------------------------------------------------------------

class TestLlmJson:
    """Tests for llm_json with mocked llm() calls."""

    @patch("evaluate.llm")
    def test_valid_json_response(self, mock_llm):
        mock_llm.return_value = '{"key": "value"}'
        from evaluate import llm_json
        result = llm_json("test prompt")
        assert result == {"key": "value"}
        mock_llm.assert_called_once()

    @patch("evaluate.llm")
    def test_retry_on_invalid_then_valid(self, mock_llm):
        """First call returns garbage, second returns valid JSON -> success."""
        mock_llm.side_effect = [
            "Sorry, I can't do that",
            '{"score": 42}',
        ]
        from evaluate import llm_json
        result = llm_json("test prompt")
        assert result == {"score": 42}
        assert mock_llm.call_count == 2

    @patch("evaluate.llm")
    def test_raises_after_two_failures(self, mock_llm):
        """Two invalid JSON responses -> raises ValueError."""
        mock_llm.side_effect = [
            "Not JSON at all",
            "Still not JSON",
        ]
        from evaluate import llm_json
        with pytest.raises(ValueError, match="Could not parse JSON"):
            llm_json("test prompt")
        assert mock_llm.call_count == 2

    @patch("evaluate.llm")
    def test_json_in_markdown_fences(self, mock_llm):
        mock_llm.return_value = '```json\n{"action": "click"}\n```'
        from evaluate import llm_json
        result = llm_json("test prompt")
        assert result == {"action": "click"}


class TestGenerateVariants:
    """Tests for generate_variants with mocked llm_json."""

    @patch("evaluate.llm_json")
    def test_generates_variant_list(self, mock_llm_json, sample_persona):
        from evaluate import generate_variants
        mock_llm_json.return_value = {
            "variants": [
                {
                    "label": "Rushed Alex",
                    "instruction_suffix": "You are in a hurry after a long shift.",
                    "trait_overrides": {"time_pressure": "high"},
                },
                {
                    "label": "Careful Alex",
                    "instruction_suffix": "You double-check everything carefully.",
                    "trait_overrides": {"time_pressure": "low"},
                },
            ]
        }
        variants = generate_variants(sample_persona, 2)
        assert len(variants) == 2
        assert isinstance(variants[0], PersonaVariant)
        assert variants[0].variant_id == "v1"
        assert variants[0].label == "Rushed Alex"
        assert variants[1].variant_id == "v2"
        assert variants[1].label == "Careful Alex"

    @patch("evaluate.llm_json")
    def test_truncates_to_n(self, mock_llm_json, sample_persona):
        """If LLM returns more variants than requested, truncate to n."""
        from evaluate import generate_variants
        mock_llm_json.return_value = {
            "variants": [
                {"label": f"Variant {i}", "instruction_suffix": "...", "trait_overrides": {}}
                for i in range(5)
            ]
        }
        variants = generate_variants(sample_persona, 2)
        assert len(variants) == 2

    @patch("evaluate.llm_json")
    def test_handles_missing_fields(self, mock_llm_json, sample_persona):
        """Variants with missing optional fields get defaults."""
        from evaluate import generate_variants
        mock_llm_json.return_value = {
            "variants": [
                {"label": "Minimal"},
            ]
        }
        variants = generate_variants(sample_persona, 1)
        assert len(variants) == 1
        assert variants[0].instruction_suffix == ""
        assert variants[0].trait_overrides == {}


# ---------------------------------------------------------------------------
# 8. _write_json() tests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 7b. Exploratory task generation tests
# ---------------------------------------------------------------------------

class TestGenerateExploratoryTasks:
    """Tests for _generate_exploratory_tasks with mocked LLM."""

    @patch("evaluate.llm_json")
    def test_generates_ex_tasks(self, mock_llm_json, sample_persona):
        from evaluate import _generate_exploratory_tasks
        mock_llm_json.return_value = {
            "tasks": [
                {
                    "name": "Try huge bill",
                    "type": "navigation",
                    "goal": "Enter $10,000 and see what happens",
                    "success_criteria": ["No overflow"],
                    "evaluation_method": "output_review",
                },
                {
                    "name": "Empty submit",
                    "type": "navigation",
                    "goal": "Submit without entering anything",
                    "success_criteria": ["Error shown"],
                    "evaluation_method": "output_review",
                },
            ]
        }
        tasks = _generate_exploratory_tasks(
            sample_persona, sample_persona.tasks, "<snapshot>")
        assert len(tasks) == 2
        assert tasks[0].number == 101
        assert tasks[1].number == 102
        assert tasks[0].tier == "EX"
        assert tasks[1].tier == "EX"
        assert tasks[0].name == "Try huge bill"
        assert tasks[0].evaluation_method == "output_review"

    @patch("evaluate.llm_json")
    def test_caps_at_3_tasks(self, mock_llm_json, sample_persona):
        from evaluate import _generate_exploratory_tasks
        mock_llm_json.return_value = {
            "tasks": [
                {"name": f"Task {i}", "goal": f"Do thing {i}",
                 "success_criteria": [], "evaluation_method": "output_review"}
                for i in range(5)
            ]
        }
        tasks = _generate_exploratory_tasks(
            sample_persona, sample_persona.tasks, "<snapshot>")
        assert len(tasks) == 3

    @patch("evaluate.llm_json")
    def test_empty_response(self, mock_llm_json, sample_persona):
        from evaluate import _generate_exploratory_tasks
        mock_llm_json.return_value = {"tasks": []}
        tasks = _generate_exploratory_tasks(
            sample_persona, sample_persona.tasks, "<snapshot>")
        assert len(tasks) == 0

    @patch("evaluate.llm_json")
    def test_ex_tasks_excluded_from_composite(self, mock_llm_json, sample_persona):
        """EX-tier tasks should not affect compute_composite."""
        from evaluate import _generate_exploratory_tasks
        mock_llm_json.return_value = {
            "tasks": [{"name": "Explore", "goal": "Poke around",
                       "success_criteria": [], "evaluation_method": "output_review"}]
        }
        ex_tasks = _generate_exploratory_tasks(
            sample_persona, sample_persona.tasks, "<snapshot>")

        # Create a result for the EX task
        ex_result = TaskResult(
            task=ex_tasks[0], completed=True, score=50.0,
            steps=3, stuck_points=[], found_answer=None, notes="",
        )
        # compute_composite should ignore EX tier
        from persona_parser import compute_composite
        scores = compute_composite([ex_result], sample_persona)
        # No P0/P1/P2 tasks -> all zeros
        assert scores["composite"] == 0.0


# ---------------------------------------------------------------------------
# 7c. Session wishlist tests
# ---------------------------------------------------------------------------

class TestGenerateSessionWishlist:
    """Tests for _generate_session_wishlist with mocked LLM."""

    @patch("evaluate.llm_json")
    def test_generates_wishlist(self, mock_llm_json, sample_persona, sample_task_results):
        from evaluate import _generate_session_wishlist
        mock_llm_json.return_value = {
            "wishlist": [
                "Save my usual 3-way split so I don't re-enter after every shift",
                "Show per-person difference when changing tip %",
            ],
            "surprise": "Didn't expect the preset buttons — that was nice.",
            "would_use": "Yes, faster than my calculator app for the usual post-shift split.",
        }
        result = _generate_session_wishlist(sample_persona, sample_task_results)
        assert len(result["wishlist"]) == 2
        assert "3-way split" in result["wishlist"][0]
        assert "surprise" in result
        assert "would_use" in result

    @patch("evaluate.llm_json")
    def test_includes_ex_task_context(self, mock_llm_json, sample_persona):
        """Session wishlist receives both core and exploratory results."""
        from evaluate import _generate_session_wishlist
        from persona_parser import PersonaTask

        core_result = TaskResult(
            task=sample_persona.tasks[0], completed=True, score=90,
            steps=3, stuck_points=[], found_answer="$34",
            notes="", persona_feedback="Quick and easy.",
        )
        ex_task = PersonaTask(
            number=101, name="Break it", tier="EX", type="navigation",
            goal="Enter negative number", success_criteria=[],
            evaluation_method="output_review",
        )
        ex_result = TaskResult(
            task=ex_task, completed=False, score=20,
            steps=5, stuck_points=["App showed NaN"],
            found_answer=None, notes="Broken",
            persona_feedback="Entering -50 broke everything.",
        )

        mock_llm_json.return_value = {
            "wishlist": ["Handle negative numbers"],
            "surprise": "Negative bill broke the app.",
            "would_use": "Maybe, if they fix the edge cases.",
        }

        result = _generate_session_wishlist(sample_persona, [core_result, ex_result])
        # Verify the prompt included both results
        call_args = mock_llm_json.call_args[0][0]
        assert "Quick and easy" in call_args
        assert "Entering -50" in call_args or "negative" in call_args.lower()
        assert "[exploratory]" in call_args


# ---------------------------------------------------------------------------
# 7d. Per-task feedback (simplified, no wishlist)
# ---------------------------------------------------------------------------

class TestSimplifiedPersonaFeedback:
    """Verify _generate_persona_feedback no longer produces wishlist."""

    @patch("evaluate.llm_json")
    def test_returns_empty_wishlist(self, mock_llm_json, sample_persona):
        from evaluate import _generate_persona_feedback
        mock_llm_json.return_value = {
            "feedback": "The split was fast but I couldn't do uneven amounts.",
        }
        feedback, wishlist = _generate_persona_feedback(
            sample_persona, sample_persona.tasks[0],
            ["clicked e1", "filled e2"], completed=True,
        )
        assert feedback == "The split was fast but I couldn't do uneven amounts."
        assert wishlist == []


# ---------------------------------------------------------------------------
# 8. _write_json() tests
# ---------------------------------------------------------------------------

class TestWriteJson:
    """Tests for _write_json output."""

    def test_writes_eval_results_json(self, sample_task_results):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, output_dir=tmpdir)
            path = os.path.join(tmpdir, "eval_results.json")
            assert os.path.exists(path)
            with open(path) as f:
                data = json.load(f)
            assert data["composite_score"] == 72.5
            assert data["p0_score"] == 90.0
            assert data["p1_score"] == 75.0
            assert data["p2_score"] == 0.0
            assert len(data["tasks"]) == 4

    def test_includes_task_details(self, sample_task_results):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, output_dir=tmpdir)
            path = os.path.join(tmpdir, "eval_results.json")
            with open(path) as f:
                data = json.load(f)
            task0 = data["tasks"][0]
            assert task0["number"] == 1
            assert task0["name"] == "Basic calc"
            assert task0["completed"] is True
            assert task0["score"] == 100.0
            assert task0["persona_feedback"] == "That was easy to find."
            assert "pre-tax total" in task0["wishlist"][0].lower()

    def test_includes_calibration_when_provided(self, sample_task_results):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        calibration = {"mean": 72.5, "stdev": 2.3, "composites": [71.0, 72.5, 74.0]}
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, calibration=calibration, output_dir=tmpdir)
            path = os.path.join(tmpdir, "eval_results.json")
            with open(path) as f:
                data = json.load(f)
            assert "calibration" in data
            assert data["calibration"]["mean"] == 72.5
            assert data["calibration"]["stdev"] == 2.3

    def test_no_calibration_key_when_none(self, sample_task_results):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, output_dir=tmpdir)
            path = os.path.join(tmpdir, "eval_results.json")
            with open(path) as f:
                data = json.load(f)
            assert "calibration" not in data

    def test_includes_exploratory_tasks(self, sample_task_results, sample_tasks):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        ex_task = PersonaTask(
            number=101, name="Explore edge", tier="EX",
            type="navigation", goal="Try something weird",
            success_criteria=[], evaluation_method="output_review",
        )
        ex_result = TaskResult(
            task=ex_task, completed=True, score=65.0,
            steps=4, stuck_points=[], found_answer=None,
            notes="Interesting", persona_feedback="That was unexpected.",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, output_dir=tmpdir,
                        exploratory_results=[ex_result])
            path = os.path.join(tmpdir, "eval_results.json")
            with open(path) as f:
                data = json.load(f)
            assert "exploratory_tasks" in data
            assert len(data["exploratory_tasks"]) == 1
            assert data["exploratory_tasks"][0]["tier"] == "EX"
            assert data["exploratory_tasks"][0]["number"] == 101
            assert data["exploratory_score"] == 65.0
            # Core composite should NOT include exploratory
            assert data["composite_score"] == 72.5

    def test_includes_session_wishlist(self, sample_task_results):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        wishlist = {
            "wishlist": ["Save my usual split", "Show tip difference"],
            "surprise": "Preset buttons were nice.",
            "would_use": "Yes, faster than calculator.",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, output_dir=tmpdir,
                        session_wishlist=wishlist)
            path = os.path.join(tmpdir, "eval_results.json")
            with open(path) as f:
                data = json.load(f)
            assert "session_wishlist" in data
            assert len(data["session_wishlist"]["wishlist"]) == 2
            assert data["session_wishlist"]["would_use"] == "Yes, faster than calculator."

    def test_no_exploratory_or_wishlist_when_none(self, sample_task_results):
        from evaluate import _write_json
        scores = {
            "composite": 72.5,
            "p0_score": 90.0,
            "p1_score": 75.0,
            "p2_score": 0.0,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_json(sample_task_results, scores, output_dir=tmpdir)
            path = os.path.join(tmpdir, "eval_results.json")
            with open(path) as f:
                data = json.load(f)
            assert "exploratory_tasks" not in data
            assert "session_wishlist" not in data


# ---------------------------------------------------------------------------
# 9. _score_task() scoring logic tests
# ---------------------------------------------------------------------------

class TestScoreTaskLogic:
    """Test the scoring logic implemented in _score_task.

    _score_task is a module-level function in evaluate.py.
    For task_completion evaluation_method:
      - not completed -> 0
      - completed in <=5 steps -> 100
      - completed in >5 steps -> 100 - max(0, (steps-5)*2)
    """

    def _make_task(self, method="task_completion"):
        return PersonaTask(
            number=1, name="Test", tier="P0",
            type="computation", goal="Do something",
            success_criteria=["Done"],
            evaluation_method=method,
            correct_answer="42",
        )

    def _make_persona(self):
        return Persona(
            name="Test User", role="Tester",
            background="A test persona.", device="desktop",
            context="testing", time_pressure="medium",
            tech_savviness="medium",
            tasks=[self._make_task()],
            weights={"P0": 0.60, "P1": 0.25, "P2": 0.15},
            agent_instructions="You are a tester.",
            p0_cap=40.0,
        )

    def test_completed_in_5_steps_scores_100(self):
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=5,
                            history=[], found_answer="42")
        assert score == 100.0

    def test_completed_in_3_steps_scores_100(self):
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=3,
                            history=[], found_answer="42")
        assert score == 100.0

    def test_completed_in_8_steps_scores_94(self):
        """100 - max(0, (8-5)*2) = 100 - 6 = 94."""
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=8,
                            history=[], found_answer="42")
        assert score == 94.0

    def test_completed_in_15_steps(self):
        """100 - max(0, (15-5)*2) = 100 - 20 = 80."""
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=15,
                            history=[], found_answer="42")
        assert score == 80.0

    def test_not_completed_scores_zero(self):
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=False, steps=10,
                            history=[], found_answer=None)
        assert score == 0.0

    def test_completed_in_1_step_scores_100(self):
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=1,
                            history=[], found_answer="42")
        assert score == 100.0

    def test_completed_in_55_steps_scores_zero(self):
        """100 - max(0, (55-5)*2) = 100 - 100 = 0."""
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=55,
                            history=[], found_answer="42")
        assert score == 0.0

    def test_score_never_negative(self):
        """Even with absurd step counts, score should not go below 0."""
        from evaluate import _score_task
        task = self._make_task()
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=200,
                            history=[], found_answer="42")
        assert score >= 0.0

    def test_unknown_evaluation_method_scores_zero(self):
        """An unknown evaluation_method returns 0."""
        from evaluate import _score_task
        task = self._make_task(method="unknown_method")
        persona = self._make_persona()
        score = _score_task(task, persona, completed=True, steps=3,
                            history=[], found_answer="42")
        assert score == 0.0
