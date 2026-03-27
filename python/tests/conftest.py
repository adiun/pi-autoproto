"""Shared fixtures for autocrit tests."""

import json
import os
import sys
import tempfile

import pytest

# Add project root to path so we can import modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from persona_parser import Persona, PersonaTask, PersonaVariant, TaskResult


EXAMPLES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "skills", "autocrit", "references", "examples")


@pytest.fixture
def sample_tasks():
    """Minimal set of tasks covering P0, P1, P2."""
    return [
        PersonaTask(
            number=1, name="Basic calc", tier="P0",
            type="computation", goal="Calculate 20% tip on $50",
            success_criteria=["Tip $10 shown", "Total $60 shown"],
            evaluation_method="task_completion",
            correct_answer="Tip: $10, Total: $60",
        ),
        PersonaTask(
            number=2, name="Bill split", tier="P0",
            type="computation", goal="Split $85 bill with 20% tip 3 ways",
            success_criteria=["Per-person amount shown", "~$34"],
            evaluation_method="task_completion",
            correct_answer="$34 per person",
        ),
        PersonaTask(
            number=3, name="Bad input", tier="P1",
            type="navigation", goal="Enter 'abc' as bill amount",
            success_criteria=["No crash", "Error shown"],
            evaluation_method="output_review",
        ),
        PersonaTask(
            number=4, name="Custom tip", tier="P2",
            type="computation", goal="Calculate 25% tip on $40",
            success_criteria=["Tip $10 shown"],
            evaluation_method="task_completion",
            correct_answer="Tip: $10, Total: $50",
        ),
    ]


@pytest.fixture
def sample_persona(sample_tasks):
    """A complete Persona for testing."""
    return Persona(
        name="Alex Rivera",
        role="Restaurant Server",
        background="Alex is a 28-year-old server at a restaurant in Austin, TX.",
        device="phone",
        context="at a restaurant after a meal",
        time_pressure="medium",
        tech_savviness="medium",
        tasks=sample_tasks,
        weights={"P0": 0.60, "P1": 0.25, "P2": 0.15},
        agent_instructions="You are Alex, a tired server who wants quick answers.",
        p0_cap=40.0,
    )


@pytest.fixture
def sample_task_results(sample_tasks):
    """Pre-built TaskResult list for scoring tests."""
    return [
        TaskResult(
            task=sample_tasks[0], completed=True, score=100.0,
            steps=3, stuck_points=[], found_answer="$10",
            notes="Found it quickly",
            persona_feedback="That was easy to find.",
            wishlist=["It would be nice to see pre-tax total"],
        ),
        TaskResult(
            task=sample_tasks[1], completed=True, score=80.0,
            steps=7, stuck_points=[], found_answer="$34",
            notes="Took a while",
            persona_feedback="The split feature was a bit hidden.",
            wishlist=["Wish I could split unevenly"],
        ),
        TaskResult(
            task=sample_tasks[2], completed=True, score=75.0,
            steps=2, stuck_points=[], found_answer=None,
            notes="Error message shown",
            persona_feedback="Good error handling.",
            wishlist=[],
        ),
        TaskResult(
            task=sample_tasks[3], completed=False, score=0.0,
            steps=10, stuck_points=["Couldn't find custom tip input"],
            found_answer=None, notes="Gave up",
            persona_feedback="I couldn't figure out how to enter a custom percentage.",
            wishlist=["A clear custom tip input would help"],
        ),
    ]


@pytest.fixture
def tmp_experiment_dir():
    """Temp directory structured as a multi-prototype experiment."""
    with tempfile.TemporaryDirectory() as d:
        for proto_id, composite in [("proto-a", 85.0), ("proto-b", 72.0)]:
            proto_dir = os.path.join(d, proto_id)
            os.makedirs(proto_dir)
            data = {
                "composite_score": composite,
                "p0_score": composite + 5,
                "p1_score": 75.0,
                "p2_score": 60.0,
                "tasks": [
                    {
                        "number": 1, "name": "Basic calc", "tier": "P0",
                        "completed": True, "score": composite + 5,
                        "steps": 3, "stuck_points": [],
                        "found_answer": "$10", "notes": "",
                        "persona_feedback": "Quick and easy!" if proto_id == "proto-a" else "Took a moment to find.",
                        "wishlist": ["pre-tax total"],
                    },
                ],
                "variants": [
                    {
                        "variant_id": "v1", "label": "Rushed Alex",
                        "composite_score": composite - 3,
                        "p0_score": composite, "p1_score": 70.0, "p2_score": 55.0,
                        "tasks": [
                            {
                                "number": 1, "name": "Basic calc", "tier": "P0",
                                "completed": True, "score": composite,
                                "steps": 4, "stuck_points": [],
                                "found_answer": "$10", "notes": "",
                                "persona_feedback": "Fast enough for after my shift.",
                                "wishlist": ["bigger buttons"],
                            },
                        ],
                    },
                    {
                        "variant_id": "v2", "label": "Careful Alex",
                        "composite_score": composite + 3,
                        "p0_score": composite + 10, "p1_score": 80.0, "p2_score": 65.0,
                        "tasks": [
                            {
                                "number": 1, "name": "Basic calc", "tier": "P0",
                                "completed": True, "score": composite + 10,
                                "steps": 2, "stuck_points": [],
                                "found_answer": "$10", "notes": "",
                                "persona_feedback": "I double-checked and the math is correct.",
                                "wishlist": ["history of recent calculations"],
                            },
                        ],
                    },
                ],
                "convergence": {
                    "overall_agreement": 0.92 if proto_id == "proto-a" else 0.85,
                    "composite_mean": composite,
                    "composite_stdev": 3.0,
                    "strong_signals": ["Task 1: 2/2 variants PASSED (high confidence)"],
                    "disagreements": [],
                    "bias_flags": (
                        []
                        if proto_id == "proto-a"
                        else ["Possible positive bias: all variants scored >80 with no concrete criticism."]
                    ),
                    "wishlist_all": ["bigger buttons", "history of recent calculations"],
                },
            }
            with open(os.path.join(proto_dir, "eval_results.json"), "w") as f:
                json.dump(data, f)

        # Add a requirements version
        with open(os.path.join(d, "requirements_v0.md"), "w") as f:
            f.write("# Requirements v0\n## P0\n### Task 1: Basic calc\n")

        yield d
