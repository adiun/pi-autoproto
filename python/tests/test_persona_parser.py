"""Tests for persona_parser.py."""

import os
import tempfile

import pytest

from conftest import EXAMPLES_DIR
from persona_parser import (
    Persona,
    PersonaTask,
    PersonaVariant,
    TaskResult,
    _parse_single_task,
    _split_sections,
    compute_composite,
    parse,
    parse_hypotheses,
)


# ---------------------------------------------------------------------------
# _split_sections
# ---------------------------------------------------------------------------

class TestSplitSections:

    def test_empty_text(self):
        assert _split_sections("") == {}

    def test_no_headers(self):
        assert _split_sections("Just some text\nwith no headers\n") == {}

    def test_multiple_sections(self):
        text = "## Alpha\nline1\nline2\n## Beta\nline3\n"
        result = _split_sections(text)
        assert set(result.keys()) == {"Alpha", "Beta"}
        assert "line1" in result["Alpha"]
        assert "line2" in result["Alpha"]
        assert "line3" in result["Beta"]

    def test_section_content_until_next_header(self):
        text = "## First\na\nb\nc\n## Second\nd\n"
        result = _split_sections(text)
        lines = result["First"].strip().split("\n")
        assert lines == ["a", "b", "c"]

    def test_ignores_text_before_first_header(self):
        text = "preamble\n## Only\nbody\n"
        result = _split_sections(text)
        assert list(result.keys()) == ["Only"]
        assert "preamble" not in result["Only"]

    def test_h1_headers_ignored(self):
        text = "# Title\n## Section\ncontent\n"
        result = _split_sections(text)
        assert "Section" in result
        assert len(result) == 1


# ---------------------------------------------------------------------------
# _parse_single_task
# ---------------------------------------------------------------------------

class TestParseSingleTask:

    def test_valid_task(self):
        block = (
            "Task 1: Basic tip\n"
            "- type: computation\n"
            "- goal: Calculate 20% tip\n"
            "- success_criteria:\n"
            "  - Tip shown\n"
            "  - Total shown\n"
            "- evaluation_method: task_completion\n"
            "- correct_answer: $10\n"
        )
        task = _parse_single_task(block, "P0")
        assert task is not None
        assert task.number == 1
        assert task.name == "Basic tip"
        assert task.tier == "P0"
        assert task.type == "computation"
        assert task.goal == "Calculate 20% tip"
        assert task.success_criteria == ["Tip shown", "Total shown"]
        assert task.evaluation_method == "task_completion"
        assert task.correct_answer == "$10"

    def test_empty_block(self):
        assert _parse_single_task("", "P0") is None
        assert _parse_single_task("   \n  ", "P0") is None

    def test_non_task_header(self):
        block = "Some random heading\n- goal: do something\n"
        assert _parse_single_task(block, "P1") is None

    def test_missing_optional_fields_use_defaults(self):
        block = "Task 5: Minimal\n- goal: Navigate somewhere\n"
        task = _parse_single_task(block, "P2")
        assert task is not None
        assert task.type == "navigation"
        assert task.evaluation_method == "task_completion"
        assert task.correct_answer is None

    def test_success_criteria_parsed_as_list(self):
        block = (
            "Task 3: Multi criteria\n"
            "- type: navigation\n"
            "- goal: Test error handling\n"
            "- success_criteria:\n"
            "  - No crash\n"
            "  - Error message visible\n"
            "  - Input cleared\n"
            "- evaluation_method: output_review\n"
        )
        task = _parse_single_task(block, "P1")
        assert task is not None
        assert task.success_criteria == ["No crash", "Error message visible", "Input cleared"]

    def test_task_with_no_criteria(self):
        block = "Task 7: No criteria\n- type: retrieval\n- goal: Find info\n"
        task = _parse_single_task(block, "P0")
        assert task is not None
        assert task.success_criteria == []


# ---------------------------------------------------------------------------
# compute_composite
# ---------------------------------------------------------------------------

class TestComputeComposite:

    def _make_task(self, number, tier):
        return PersonaTask(
            number=number, name=f"Task {number}", tier=tier,
            type="computation", goal="goal",
            success_criteria=[], evaluation_method="task_completion",
        )

    def _make_persona(self, weights=None, p0_cap=40.0):
        return Persona(
            name="Test", role="Tester", background="bg",
            device="desktop", context="ctx",
            time_pressure="low", tech_savviness="high",
            tasks=[], weights=weights or {"P0": 0.60, "P1": 0.25, "P2": 0.15},
            agent_instructions="instr", p0_cap=p0_cap,
        )

    def _make_result(self, task, score, completed=True):
        return TaskResult(
            task=task, completed=completed, score=score,
            steps=3, stuck_points=[], found_answer=None, notes="",
        )

    def test_all_pass_full_scores(self):
        persona = self._make_persona()
        results = [
            self._make_result(self._make_task(1, "P0"), 100.0),
            self._make_result(self._make_task(2, "P0"), 100.0),
            self._make_result(self._make_task(3, "P1"), 100.0),
            self._make_result(self._make_task(4, "P2"), 100.0),
        ]
        out = compute_composite(results, persona)
        # 100*0.60 + 100*0.25 + 100*0.15 = 100.0
        assert out["composite"] == 100.0
        assert out["p0_score"] == 100.0
        assert out["p1_score"] == 100.0
        assert out["p2_score"] == 100.0

    def test_p0_cap_applied(self):
        persona = self._make_persona(p0_cap=40.0)
        results = [
            self._make_result(self._make_task(1, "P0"), 100.0),
            self._make_result(self._make_task(2, "P0"), 0.0),  # P0 scores 0
            self._make_result(self._make_task(3, "P1"), 100.0),
            self._make_result(self._make_task(4, "P2"), 100.0),
        ]
        out = compute_composite(results, persona)
        # P0 avg = 50.0, uncapped = 50*0.60 + 100*0.25 + 100*0.15 = 70.0
        # But P0 has a 0 score, so capped at 40.0
        assert out["composite"] == 40.0

    def test_single_tier_only_p0(self):
        persona = self._make_persona()
        results = [
            self._make_result(self._make_task(1, "P0"), 80.0),
            self._make_result(self._make_task(2, "P0"), 60.0),
        ]
        out = compute_composite(results, persona)
        # P0 avg = 70, P1 avg = 0, P2 avg = 0
        # composite = 70*0.60 + 0*0.25 + 0*0.15 = 42.0
        assert out["composite"] == 42.0
        assert out["p0_score"] == 70.0
        assert out["p1_score"] == 0.0
        assert out["p2_score"] == 0.0

    def test_mixed_scores_across_tiers(self):
        persona = self._make_persona()
        results = [
            self._make_result(self._make_task(1, "P0"), 90.0),
            self._make_result(self._make_task(2, "P1"), 60.0),
            self._make_result(self._make_task(3, "P2"), 40.0),
        ]
        out = compute_composite(results, persona)
        # 90*0.60 + 60*0.25 + 40*0.15 = 54 + 15 + 6 = 75.0
        assert out["composite"] == 75.0

    def test_rounding_to_one_decimal(self):
        persona = self._make_persona()
        results = [
            self._make_result(self._make_task(1, "P0"), 33.3),
            self._make_result(self._make_task(2, "P0"), 66.7),
            self._make_result(self._make_task(3, "P1"), 55.5),
            self._make_result(self._make_task(4, "P2"), 44.4),
        ]
        out = compute_composite(results, persona)
        # P0 avg = 50.0, P1 avg = 55.5, P2 avg = 44.4
        # 50.0*0.60 + 55.5*0.25 + 44.4*0.15 = 30.0 + 13.875 + 6.66 = 50.535
        assert out["composite"] == 50.5

    def test_per_task_structure(self):
        persona = self._make_persona()
        t = self._make_task(1, "P0")
        results = [self._make_result(t, 80.0)]
        out = compute_composite(results, persona)
        assert len(out["per_task"]) == 1
        assert out["per_task"][0]["task_number"] == 1
        assert out["per_task"][0]["score"] == 80.0
        assert out["per_task"][0]["completed"] is True

    def test_p0_cap_not_applied_when_all_p0_nonzero(self):
        persona = self._make_persona(p0_cap=40.0)
        results = [
            self._make_result(self._make_task(1, "P0"), 50.0),
            self._make_result(self._make_task(2, "P1"), 100.0),
            self._make_result(self._make_task(3, "P2"), 100.0),
        ]
        out = compute_composite(results, persona)
        # 50*0.60 + 100*0.25 + 100*0.15 = 30+25+15 = 70.0 — no cap
        assert out["composite"] == 70.0


# ---------------------------------------------------------------------------
# PersonaVariant.apply
# ---------------------------------------------------------------------------

class TestPersonaVariantApply:

    def _base_persona(self):
        return Persona(
            name="Alex Rivera",
            role="Restaurant Server",
            background="A server in Austin.",
            device="phone",
            context="restaurant",
            time_pressure="medium",
            tech_savviness="medium",
            tasks=[],
            weights={"P0": 0.60, "P1": 0.25, "P2": 0.15},
            agent_instructions="You are Alex.",
            p0_cap=40.0,
        )

    def test_trait_override_applied(self):
        variant = PersonaVariant(
            variant_id="v1", label="Rushed Alex",
            instruction_suffix="You are in a huge rush.",
            trait_overrides={"time_pressure": "high"},
        )
        result = variant.apply(self._base_persona())
        assert result.time_pressure == "high"

    def test_instruction_suffix_appended(self):
        variant = PersonaVariant(
            variant_id="v1", label="Rushed",
            instruction_suffix="Act quickly.",
            trait_overrides={},
        )
        result = variant.apply(self._base_persona())
        assert result.agent_instructions.endswith("Act quickly.")
        assert "You are Alex." in result.agent_instructions

    def test_base_identity_unchanged(self):
        variant = PersonaVariant(
            variant_id="v2", label="Changed",
            instruction_suffix="Be skeptical.",
            trait_overrides={"time_pressure": "high", "device": "desktop"},
        )
        result = variant.apply(self._base_persona())
        assert result.name == "Alex Rivera"
        assert result.role == "Restaurant Server"
        assert result.background == "A server in Austin."

    def test_empty_overrides(self):
        base = self._base_persona()
        variant = PersonaVariant(
            variant_id="v3", label="Same",
            instruction_suffix="Extra note.",
            trait_overrides={},
        )
        result = variant.apply(base)
        assert result.time_pressure == base.time_pressure
        assert result.tech_savviness == base.tech_savviness
        assert result.device == base.device
        assert result.context == base.context
        assert "Extra note." in result.agent_instructions

    def test_nonexistent_trait_key_ignored(self):
        variant = PersonaVariant(
            variant_id="v4", label="Bad key",
            instruction_suffix="Suffix.",
            trait_overrides={"nonexistent_field": "value"},
        )
        base = self._base_persona()
        result = variant.apply(base)
        # Should not raise; persona stays the same for known fields
        assert result.time_pressure == base.time_pressure
        assert not hasattr(result, "nonexistent_field")

    def test_multiple_trait_overrides(self):
        variant = PersonaVariant(
            variant_id="v5", label="Multi",
            instruction_suffix="",
            trait_overrides={"time_pressure": "low", "tech_savviness": "high", "device": "desktop"},
        )
        result = variant.apply(self._base_persona())
        assert result.time_pressure == "low"
        assert result.tech_savviness == "high"
        assert result.device == "desktop"


# ---------------------------------------------------------------------------
# parse
# ---------------------------------------------------------------------------

class TestParse:

    def test_parse_persona_example(self):
        path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        persona = parse(path)
        assert persona.name == "Alex Rivera"
        assert persona.role == "Restaurant Server"
        assert len(persona.tasks) == 6
        assert persona.tasks[0].number == 1
        assert persona.tasks[0].tier == "P0"
        assert persona.tasks[5].number == 6
        assert persona.tasks[5].tier == "P2"

    def test_parse_split_format(self):
        persona_path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        req_path = os.path.join(EXAMPLES_DIR, "requirements_example.md")
        persona = parse(persona_path, requirements_path=req_path)
        assert persona.name == "Alex Rivera"
        assert persona.role == "Restaurant Server"
        assert len(persona.tasks) == 6

    def test_split_format_same_tasks_as_embedded(self):
        persona_path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        req_path = os.path.join(EXAMPLES_DIR, "requirements_example.md")
        embedded = parse(persona_path)
        split = parse(persona_path, requirements_path=req_path)
        assert len(embedded.tasks) == len(split.tasks)
        for a, b in zip(embedded.tasks, split.tasks):
            assert a.number == b.number
            assert a.name == b.name
            assert a.tier == b.tier

    def test_missing_persona_header(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("## Background\nSome background.\n## Environment\n- Device: phone\n")
            f.flush()
            with pytest.raises(ValueError, match="Missing.*Persona"):
                parse(f.name)
        os.unlink(f.name)

    def test_missing_background(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Persona: Test User, Tester\n## Environment\n- Device: phone\n")
            f.flush()
            with pytest.raises(ValueError, match="Background"):
                parse(f.name)
        os.unlink(f.name)

    def test_parsed_weights(self):
        path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        persona = parse(path)
        assert persona.weights.get("P0") is not None
        assert persona.weights.get("P1") is not None
        assert persona.weights.get("P2") is not None

    def test_parsed_environment(self):
        path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        persona = parse(path)
        assert persona.device == "phone"
        assert persona.time_pressure == "medium"
        assert persona.tech_savviness == "medium"

    def test_agent_instructions_present(self):
        path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        persona = parse(path)
        assert len(persona.agent_instructions) > 0
        assert "Alex" in persona.agent_instructions


# ---------------------------------------------------------------------------
# parse_hypotheses
# ---------------------------------------------------------------------------

class TestParseHypotheses:

    def test_parse_hypotheses_example(self):
        path = os.path.join(EXAMPLES_DIR, "hypotheses_example.md")
        hyps = parse_hypotheses(path)
        assert len(hyps) == 3
        assert hyps[0].id == "H1"
        assert hyps[1].id == "H2"
        assert hyps[2].id == "H3"

    def test_hypothesis_fields(self):
        path = os.path.join(EXAMPLES_DIR, "hypotheses_example.md")
        hyps = parse_hypotheses(path)
        h1 = hyps[0]
        assert h1.title == "Visual tip comparison vs manual switching"
        assert "side-by-side" in h1.question
        assert "Task 6" in h1.measure
        assert h1.status == "unresolved"

    def test_nonexistent_file_returns_empty(self):
        result = parse_hypotheses("/tmp/this_file_does_not_exist_ever.md")
        assert result == []

    def test_all_hypotheses_have_required_fields(self):
        path = os.path.join(EXAMPLES_DIR, "hypotheses_example.md")
        hyps = parse_hypotheses(path)
        for h in hyps:
            assert h.id
            assert h.title
            assert h.question
            assert h.measure
            assert h.status
