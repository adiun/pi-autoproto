"""Tests for generate_tasks.py and persona_parser.parse_background()."""

import json
import os
import tempfile

import pytest

from conftest import EXAMPLES_DIR
from persona_parser import parse, parse_background
from generate_tasks import format_requirements_markdown


# ---------------------------------------------------------------------------
# parse_background() tests
# ---------------------------------------------------------------------------

class TestParseBackground:

    def test_parse_full_persona_example(self):
        """parse_background works on a full persona.md (ignores tasks)."""
        path = os.path.join(EXAMPLES_DIR, "persona_example.md")
        info = parse_background(path)
        assert info["name"] == "Alex Rivera"
        assert info["role"] == "Restaurant Server"
        assert "28-year-old" in info["background"]
        assert info["device"] == "phone"
        assert info["time_pressure"] == "medium"
        assert info["tech_savviness"] == "medium"
        assert "Alex" in info["agent_instructions"]

    def test_parse_partial_persona_no_tasks(self):
        """parse_background works on persona.md without Requirements section."""
        content = (
            "# Persona: Dana Kim, Freelance Designer\n\n"
            "## Background\n\n"
            "Dana is a 32-year-old freelance UI designer in Brooklyn.\n\n"
            "**Day-to-day:** Works from coffee shops and home studio.\n\n"
            "## Environment\n\n"
            "- Device: laptop\n"
            "- Context: working from a coffee shop\n"
            "- Time pressure: low\n"
            "- Tech savviness: high\n\n"
            "## Agent Instructions\n\n"
            "You are Dana, a meticulous designer who notices visual details.\n"
        )
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write(content)
            f.flush()
            info = parse_background(f.name)
        os.unlink(f.name)

        assert info["name"] == "Dana Kim"
        assert info["role"] == "Freelance Designer"
        assert "32-year-old" in info["background"]
        assert info["device"] == "laptop"
        assert info["time_pressure"] == "low"
        assert info["tech_savviness"] == "high"
        assert "Dana" in info["agent_instructions"]

    def test_missing_persona_header_raises(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("## Background\nSome text.\n")
            f.flush()
            with pytest.raises(ValueError, match="Missing.*Persona"):
                parse_background(f.name)
        os.unlink(f.name)

    def test_missing_background_raises(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Persona: Test, Role\n## Environment\n- Device: phone\n")
            f.flush()
            with pytest.raises(ValueError, match="Background"):
                parse_background(f.name)
        os.unlink(f.name)

    def test_defaults_for_missing_environment(self):
        """Missing environment fields get sensible defaults."""
        content = (
            "# Persona: Min, Student\n\n"
            "## Background\n\nA college student.\n\n"
            "## Agent Instructions\n\nYou are Min.\n"
        )
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write(content)
            f.flush()
            info = parse_background(f.name)
        os.unlink(f.name)

        assert info["device"] == "desktop"
        assert info["time_pressure"] == "medium"
        assert info["tech_savviness"] == "medium"


# ---------------------------------------------------------------------------
# format_requirements_markdown() tests
# ---------------------------------------------------------------------------

class TestFormatRequirementsMarkdown:

    def test_basic_formatting(self):
        """Formatted markdown can be parsed back by persona_parser."""
        result = {
            "tasks": [
                {
                    "tier": "P0",
                    "name": "Quick split",
                    "type": "computation",
                    "goal": "Split $85 bill 3 ways with 20% tip",
                    "success_criteria": ["Per-person amount shown", "~$34"],
                    "evaluation_method": "output_review",
                },
                {
                    "tier": "P1",
                    "name": "Handle bad input",
                    "type": "navigation",
                    "goal": "Enter abc as bill amount",
                    "success_criteria": ["No crash", "Error shown"],
                    "evaluation_method": "task_completion",
                },
            ],
            "anti_tasks": ["I would NOT create an account"],
        }
        md = format_requirements_markdown(result)

        assert "## Requirements" in md
        assert "## Scoring" in md
        assert "Task 1: Quick split" in md
        assert "Task 2: Handle bad input" in md
        assert "P0" in md
        assert "P1" in md
        assert "anti_tasks" in md.lower() or "Anti-tasks" in md

    def test_roundtrip_with_parser(self):
        """Tasks formatted as markdown can be parsed by persona_parser.parse()."""
        persona_header = (
            "# Persona: Test User, Tester\n\n"
            "## Background\n\nA test persona for validation.\n\n"
            "## Environment\n\n"
            "- Device: phone\n"
            "- Context: testing\n"
            "- Time pressure: medium\n"
            "- Tech savviness: medium\n\n"
            "## Agent Instructions\n\nYou are a tester.\n\n"
        )
        result = {
            "tasks": [
                {
                    "tier": "P0",
                    "name": "Core task",
                    "type": "computation",
                    "goal": "Do the main thing",
                    "success_criteria": ["Thing done", "Result shown"],
                    "evaluation_method": "output_review",
                },
                {
                    "tier": "P1",
                    "name": "Secondary task",
                    "type": "navigation",
                    "goal": "Navigate to settings",
                    "success_criteria": ["Settings visible"],
                    "evaluation_method": "task_completion",
                },
                {
                    "tier": "P2",
                    "name": "Nice to have",
                    "type": "navigation",
                    "goal": "Check dark mode",
                    "success_criteria": ["Toggle exists"],
                    "evaluation_method": "output_review",
                },
            ],
            "anti_tasks": [],
        }
        md = format_requirements_markdown(result)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write(persona_header + md)
            f.flush()
            persona = parse(f.name)
        os.unlink(f.name)

        assert len(persona.tasks) == 3
        assert persona.tasks[0].name == "Core task"
        assert persona.tasks[0].tier == "P0"
        assert persona.tasks[0].evaluation_method == "output_review"
        assert persona.tasks[1].name == "Secondary task"
        assert persona.tasks[1].tier == "P1"
        assert persona.tasks[2].name == "Nice to have"
        assert persona.tasks[2].tier == "P2"

    def test_empty_tasks(self):
        md = format_requirements_markdown({"tasks": [], "anti_tasks": []})
        assert "## Requirements" in md
        assert "## Scoring" in md

    def test_tier_distribution(self):
        """Tasks are grouped by tier in the correct order."""
        result = {
            "tasks": [
                {"tier": "P2", "name": "Last", "type": "navigation", "goal": "g",
                 "success_criteria": [], "evaluation_method": "output_review"},
                {"tier": "P0", "name": "First", "type": "navigation", "goal": "g",
                 "success_criteria": [], "evaluation_method": "output_review"},
                {"tier": "P1", "name": "Middle", "type": "navigation", "goal": "g",
                 "success_criteria": [], "evaluation_method": "output_review"},
            ],
            "anti_tasks": [],
        }
        md = format_requirements_markdown(result)
        p0_pos = md.index("P0")
        p1_pos = md.index("P1")
        p2_pos = md.index("P2")
        assert p0_pos < p1_pos < p2_pos
