"""Parse persona.md, requirements.md, and hypotheses.md into structured dataclasses."""

import re
from dataclasses import dataclass, field


@dataclass
class PersonaTask:
    number: int
    name: str
    tier: str  # "P0", "P1", "P2"
    type: str  # "retrieval", "generative", "computation", "navigation"
    goal: str
    success_criteria: list[str]
    evaluation_method: str  # "task_completion", "output_review"
    correct_answer: str | None = None


@dataclass
class Persona:
    name: str
    role: str
    background: str
    device: str
    context: str
    time_pressure: str  # "low", "medium", "high"
    tech_savviness: str  # "low", "medium", "high"
    tasks: list[PersonaTask]
    weights: dict[str, float]  # {"P0": 0.60, "P1": 0.25, "P2": 0.15}
    agent_instructions: str
    p0_cap: float = 40.0


@dataclass
class PersonaVariant:
    """A behavioral variant of a base persona for multi-instance evaluation."""
    variant_id: str         # "v1", "v2", etc.
    label: str              # "Rushed Alex", "Skeptical Alex"
    instruction_suffix: str  # Appended to agent_instructions to shift behavior
    trait_overrides: dict = field(default_factory=dict)  # e.g. {"time_pressure": "high"}

    def apply(self, persona: Persona) -> Persona:
        """Create a new Persona with this variant's modifications applied."""
        overrides = {}
        for key, val in self.trait_overrides.items():
            if hasattr(persona, key):
                overrides[key] = val

        return Persona(
            name=persona.name,
            role=persona.role,
            background=persona.background,
            device=overrides.get("device", persona.device),
            context=overrides.get("context", persona.context),
            time_pressure=overrides.get("time_pressure", persona.time_pressure),
            tech_savviness=overrides.get("tech_savviness", persona.tech_savviness),
            tasks=persona.tasks,
            weights=persona.weights,
            agent_instructions=persona.agent_instructions + "\n\n" + self.instruction_suffix,
            p0_cap=persona.p0_cap,
        )


@dataclass
class TaskResult:
    task: PersonaTask
    completed: bool
    score: float  # 0-100
    steps: int
    stuck_points: list[str]
    found_answer: str | None
    notes: str
    persona_feedback: str = ""
    wishlist: list[str] = field(default_factory=list)


def _split_sections(text: str) -> dict[str, str]:
    """Split markdown text into sections by ## headers. Returns dict of section_name -> content."""
    sections: dict[str, str] = {}
    current = None
    for line in text.split("\n"):
        if line.startswith("## "):
            current = line.lstrip("# ").strip()
            sections[current] = ""
        elif current is not None:
            sections[current] += line + "\n"
    return sections


def _parse_tasks_and_scoring(sections: dict[str, str]) -> tuple[list[PersonaTask], dict[str, float], float]:
    """Parse Requirements and Scoring sections into tasks, weights, and p0_cap.

    Works with sections from either persona.md or a standalone requirements.md.
    In requirements.md, tasks may use ## tier headers and ### task headers (one level up).
    """
    # Try ## Requirements section first (embedded in persona.md)
    req_text = sections.get("Requirements", "")

    # Determine header levels: in standalone requirements.md, tiers are ## and tasks are ###
    # In persona.md, tiers are ### and tasks are ####
    if req_text.strip():
        tier_prefix = "###"
        task_prefix = "####"
    else:
        # Standalone requirements.md — tiers are ## headers, tasks are ### headers
        # Rebuild req_text from tier sections
        req_parts = []
        for key, val in sections.items():
            if re.match(r"P\d", key):
                req_parts.append(f"### {key}\n{val}")
        req_text = "\n".join(req_parts)
        tier_prefix = "###"
        task_prefix = "####"
        # But tasks inside ## P0/P1/P2 sections use ### headers
        if req_parts:
            # Re-parse: in standalone mode, ## P0 has ### Task headers inside
            return _parse_tasks_standalone(sections)

    tasks: list[PersonaTask] = []
    tier_blocks = re.split(rf"^{re.escape(tier_prefix)}\s+", req_text, flags=re.MULTILINE)
    for block in tier_blocks:
        if not block.strip():
            continue
        tier_header = block.split("\n", 1)[0]
        tier_match = re.match(r"(P\d)", tier_header)
        if not tier_match:
            continue
        tier = tier_match.group(1)

        task_blocks = re.split(rf"^{re.escape(task_prefix)}\s+", block, flags=re.MULTILINE)
        for tblock in task_blocks:
            task = _parse_single_task(tblock, tier)
            if task:
                tasks.append(task)

    if not tasks:
        raise ValueError("No tasks found in Requirements section")

    # Scoring
    scoring_text = sections.get("Scoring", "")
    weights = {}
    for m in re.finditer(r"(p\d)_score\s*\*\s*([\d.]+)", scoring_text):
        weights[m.group(1).upper()] = float(m.group(2))
    if not weights:
        weights = {"P0": 0.60, "P1": 0.25, "P2": 0.15}

    p0_cap = 40.0
    cap_match = re.search(r"composite\s*=\s*min\(composite,\s*(\d+)\)", scoring_text)
    if cap_match:
        p0_cap = float(cap_match.group(1))

    return tasks, weights, p0_cap


def _parse_tasks_standalone(sections: dict[str, str]) -> tuple[list[PersonaTask], dict[str, float], float]:
    """Parse tasks from standalone requirements.md where tiers are ## headers and tasks are ### headers."""
    tasks: list[PersonaTask] = []
    for key, val in sections.items():
        tier_match = re.match(r"(P\d)", key)
        if not tier_match:
            continue
        tier = tier_match.group(1)
        task_blocks = re.split(r"^###\s+", val, flags=re.MULTILINE)
        for tblock in task_blocks:
            task = _parse_single_task(tblock, tier)
            if task:
                tasks.append(task)

    if not tasks:
        raise ValueError("No tasks found in requirements file")

    # Scoring
    scoring_text = sections.get("Scoring", "")
    weights = {}
    for m in re.finditer(r"(p\d)_score\s*\*\s*([\d.]+)", scoring_text):
        weights[m.group(1).upper()] = float(m.group(2))
    if not weights:
        weights = {"P0": 0.60, "P1": 0.25, "P2": 0.15}

    p0_cap = 40.0
    cap_match = re.search(r"composite\s*=\s*min\(composite,\s*(\d+)\)", scoring_text)
    if cap_match:
        p0_cap = float(cap_match.group(1))

    return tasks, weights, p0_cap


def _parse_single_task(tblock: str, tier: str) -> PersonaTask | None:
    """Parse a single task block into a PersonaTask, or None if not a valid task."""
    if not tblock.strip():
        return None
    task_header = tblock.split("\n", 1)[0]
    task_match = re.match(r"Task\s+(\d+):\s*(.+)", task_header)
    if not task_match:
        return None
    task_num = int(task_match.group(1))
    task_name = task_match.group(2).strip()
    task_body = tblock.split("\n", 1)[1] if "\n" in tblock else ""

    def get_field(name):
        m = re.search(rf"^-\s*{name}:\s*(.+)$", task_body, re.MULTILINE)
        return m.group(1).strip() if m else None

    criteria = []
    in_criteria = False
    for tline in task_body.split("\n"):
        if re.match(r"^-\s*success_criteria:", tline):
            in_criteria = True
            continue
        if in_criteria:
            cm = re.match(r"^\s+-\s+(.+)", tline)
            if cm:
                criteria.append(cm.group(1).strip())
            else:
                in_criteria = False

    return PersonaTask(
        number=task_num,
        name=task_name,
        tier=tier,
        type=get_field("type") or "navigation",
        goal=get_field("goal") or "",
        success_criteria=criteria,
        evaluation_method=get_field("evaluation_method") or "task_completion",
        correct_answer=get_field("correct_answer"),
    )


def parse(path: str = "persona.md", requirements_path: str | None = None) -> Persona:
    """Parse persona.md into a Persona object.

    If requirements_path is provided, tasks and scoring are read from that file
    instead of from persona.md. This supports the split format where persona.md
    contains identity/background and requirements.md contains tasks/scoring.
    """
    with open(path) as f:
        text = f.read()

    sections = _split_sections(text)

    # Find persona header
    header_line = None
    for line in text.split("\n"):
        if line.startswith("# Persona:"):
            header_line = line
            break

    if not header_line:
        raise ValueError("Missing '# Persona:' header")
    header_text = header_line.split("# Persona:")[1].strip()
    parts = [p.strip() for p in header_text.split(",", 1)]
    persona_name = parts[0]
    persona_role = parts[1] if len(parts) > 1 else ""

    # Background
    background = sections.get("Background", "").strip()
    if not background:
        raise ValueError("Missing or empty ## Background section")

    # Environment
    env_text = sections.get("Environment", "")
    if not env_text.strip():
        raise ValueError("Missing or empty ## Environment section")
    env = {}
    for m in re.finditer(r"-\s*(\w[\w\s]*?):\s*(.+)", env_text):
        env[m.group(1).strip().lower().replace(" ", "_")] = m.group(2).strip()

    # Tasks and scoring — from requirements_path if provided, else from persona.md
    if requirements_path:
        with open(requirements_path) as f:
            req_text = f.read()
        req_sections = _split_sections(req_text)
        tasks, weights, p0_cap = _parse_tasks_and_scoring(req_sections)
    else:
        tasks, weights, p0_cap = _parse_tasks_and_scoring(sections)

    # Agent Instructions
    agent_instructions = sections.get("Agent Instructions", "").strip()

    return Persona(
        name=persona_name,
        role=persona_role,
        background=background,
        device=env.get("device", "desktop"),
        context=env.get("context", ""),
        time_pressure=env.get("time_pressure", "medium"),
        tech_savviness=env.get("tech_savviness", "medium"),
        tasks=tasks,
        weights=weights,
        agent_instructions=agent_instructions,
        p0_cap=p0_cap,
    )


@dataclass
class Hypothesis:
    """A testable hypothesis defined in hypotheses.md."""
    id: str          # "H1", "H2", etc.
    title: str       # Short description from header
    question: str    # What are we trying to learn
    measure: str     # How we'll measure it
    status: str      # "unresolved", "resolved", "partially_resolved"


def parse_hypotheses(path: str = "hypotheses.md") -> list[Hypothesis]:
    """Parse hypotheses.md into a list of Hypothesis objects.

    Returns empty list if file doesn't exist.
    """
    try:
        with open(path) as f:
            text = f.read()
    except FileNotFoundError:
        return []

    hypotheses = []
    # Split by ## headers
    blocks = re.split(r"^##\s+", text, flags=re.MULTILINE)
    for block in blocks:
        if not block.strip():
            continue
        header = block.split("\n", 1)[0]
        h_match = re.match(r"(H\d+):\s*(.+)", header)
        if not h_match:
            continue
        h_id = h_match.group(1)
        h_title = h_match.group(2).strip()
        body = block.split("\n", 1)[1] if "\n" in block else ""

        def get_field(name: str) -> str:
            m = re.search(rf"^-\s*{name}:\s*(.+)$", body, re.MULTILINE)
            return m.group(1).strip() if m else ""

        hypotheses.append(Hypothesis(
            id=h_id,
            title=h_title,
            question=get_field("question"),
            measure=get_field("measure"),
            status=get_field("status") or "unresolved",
        ))

    return hypotheses


def compute_composite(task_results: list[TaskResult], persona: Persona) -> dict:
    """Compute composite score from task results.

    Returns dict with keys: composite, p0_score, p1_score, p2_score, per_task
    """
    # Group by tier
    tier_scores: dict[str, list[float]] = {}
    for r in task_results:
        tier = r.task.tier
        tier_scores.setdefault(tier, []).append(r.score)

    # Per-tier averages
    tier_avgs = {}
    for tier, scores in tier_scores.items():
        tier_avgs[tier] = sum(scores) / len(scores) if scores else 0.0

    # Weighted composite
    composite = sum(
        tier_avgs.get(tier, 0.0) * weight
        for tier, weight in persona.weights.items()
    )

    # P0 cap: if any P0 task scored 0, cap composite
    p0_results = [r for r in task_results if r.task.tier == "P0"]
    if any(r.score == 0 for r in p0_results):
        composite = min(composite, persona.p0_cap)

    per_task = []
    for r in task_results:
        per_task.append({
            "task_number": r.task.number,
            "task_name": r.task.name,
            "tier": r.task.tier,
            "completed": r.completed,
            "score": r.score,
            "steps": r.steps,
        })

    return {
        "composite": round(composite, 1),
        "p0_score": round(tier_avgs.get("P0", 0.0), 1),
        "p1_score": round(tier_avgs.get("P1", 0.0), 1),
        "p2_score": round(tier_avgs.get("P2", 0.0), 1),
        "per_task": per_task,
    }
