---
name: autoproto
description: >
  Persona-driven UX evaluation for web app prototypes. Builds prototypes,
  evaluates with synthetic users via agent-browser, and iterates based on
  structured feedback. Supports full mode (3 prototypes with comparative
  evaluation) or quick mode (single prototype). Use when building and
  evaluating web app prototypes, or when asked to "run autoproto", "evaluate
  this app with personas", or "set up UX testing".
---

# Autoproto

Persona-driven UX evaluation loop: build a prototype, let a synthetic user try it, iterate on their feedback, repeat.

## Tools

- **`init_autoproto`** — validate dependencies, set mode (full/quick), experiment name, persona command
- **`run_evaluation`** — run persona agent against the app, get structured scores and feedback
- **`log_iteration`** — record results, manage history, detect plateaus
- **`generate_report`** — comparative synthesis across prototypes (full mode only)

Dashboard: `ctrl+x` to expand/collapse. `/autoproto` for status.

### Evaluation Discipline

- **One evaluation per iteration.** Call `run_evaluation` once, then `log_iteration`. Do not re-run to "confirm" — trust the score.
- **Always run all tasks.** Never filter by tier. Tier-filtered evaluations produce misleading composite scores (unrun tiers show as 0).
- **Task filter is for debugging only.** Only use the `task` parameter after a full evaluation has identified a specific stuck task you need to investigate.
- **Stuck tasks are surfaced automatically.** If `log_iteration` flags a task as structurally untestable (scored 0 in 3+ consecutive kept iterations with step-limit stuck points), investigate with the `task` parameter and a higher `max_steps`. If the task passes with more steps, add `max_steps` to the task definition in persona.md. If it still fails, the task may need to be redesigned or marked as blocked.
- **Blocked tasks are excluded from scoring.** Tasks marked as blocked in the autoproto state are still evaluated for feedback but excluded from the composite score. This prevents a single untestable task from capping the composite at 40.
- **Bundle independent fixes.** If multiple failing tasks have independent fixes (e.g., add a nav item AND move a button), address them in one iteration. The keep/discard protocol handles failure — revert the whole bundle.
- **Timeouts are not failures.** If a task times out with no feedback, it's an infrastructure issue (LLM latency, agent-browser). Do not re-run. Log the iteration and move on.
- **Faster iteration with cheaper models.** For faster evaluation cycles, consider using a cheaper/faster model for the persona agent (e.g., `--cmd "claude -p --model haiku"`). The persona agent navigates and clicks — it doesn't need the most capable model.
- **Core vs. exploratory tasks.** Core tasks (in persona.md) are fixed and drive the keep/discard composite score. Exploratory tasks are generated fresh each full-mode evaluation and scored separately. Don't optimize for exploratory scores — they change every iteration. But read exploratory feedback for UX issues you didn't know about.
- **Session wishlist is cumulative.** After all tasks (core + exploratory), the persona reflects on the whole experience. Read `session_wishlist` in eval_results.json for grounded wishes. Diagnose root causes, don't implement literally.

## Quick Start

1. Create `persona.md` (see [persona guide](references/examples/persona_example.md))
2. `init_autoproto` — set mode, experiment name, persona command
3. Build seed app (Vite project with `.gitignore`)
4. `run_evaluation` with mode `quick` for baseline
5. Iterate: edit → `run_evaluation` → `log_iteration` → repeat

## Setup

### 1. Create Persona

If `persona.md` does NOT exist:

1. Read [the persona example](references/examples/persona_example.md) to understand the format.
2. Ask the user: "What kind of app do you want to build? Who is the target user?"
3. Have a brief conversation (3-5 exchanges) to understand:
   - Who the user is and what problem they're solving
   - The core function of the app
   - Device and context (phone on the go? desktop at work?)
   - What would make the target user love this app
4. Generate `persona.md` with **only these sections** (no tasks yet):
   - `# Persona: Name, Role`
   - `## Background` (4-6 paragraphs) — day-to-day activities, current workarounds, pain points (3-5 specific frustrations), why this app matters
   - `## Environment` — device, context, time pressure, tech savviness
   - `## Agent Instructions` — personality, patience level, behavior
   - **Do NOT write tasks** — the persona agent generates those in the next step.
5. Show the background to the user for review.

### 1b. Generate Tasks

After the persona background is approved, the persona agent (not you) generates the tasks. This creates a healthy adversarial dynamic: you build the prototype, the persona defines success.

1. Run task generation:
   ```
   uv run python/generate_tasks.py --cmd "<persona_cmd>" --app "<app description>" --write
   ```
   This appends Requirements + Scoring sections to `persona.md`.
2. Review the generated tasks. Check for:
   - At least 1 P0 and 1 P1 task at complexity Level 4-5 (synthesis/decision)
   - Tasks grounded in the persona's specific life details (names, amounts, situations)
   - Success criteria that require judgment, not just navigation
   - Anti-tasks that match the persona's patience/context
3. Show tasks to user for approval.
4. If tasks are weak (too many "find X" / "see Y" tasks), regenerate.

These are the **core tasks** — fixed for the entire experiment. Scores are comparable across iterations because core tasks never change.

**Exploratory tasks** are generated automatically each evaluation run (in full mode) by the persona agent looking at the current app. They surface UX issues that core tasks don't cover. See Evaluation Discipline below.

#### Task Design Principles

Tasks are the most important part of the persona file. Weak tasks produce false confidence — any reasonable prototype will score 90+ if the tasks only check whether information is displayed. Strong tasks surface real UX problems.

1. **Tasks should require judgment, not just navigation.** If the success criterion is "is X displayed?", the task is too easy and any prototype will pass. At least 2 P0 tasks should end with the persona making a decision or forming an opinion.
   - Weak: "See total spending broken down by category."
   - Strong: "You're $800 shorter than expected this month. Figure out what happened and what you'd cut."

2. **Embed competing constraints.** Real users juggle multiple goals simultaneously. Single-axis tasks ("filter by X") always pass. Tasks with 2-3 constraints surface whether the app helps resolve tradeoffs.
   - Weak: "Filter recipes to under 30 minutes."
   - Strong: "Find a recipe under 30 minutes that uses your chicken before it goes bad and that your picky kid will eat."

3. **Use the persona's backstory as task context.** The background section exists for a reason — reference it in tasks. "Your kid is picky," "your income is irregular," "your partner disagrees." This grounds feedback in the persona's reality.

4. **Include at least one 'what would you do?' task.** Not "can you find X?" but "given what you see, what's your next move?" This tests whether the app empowers action, not just displays information.
   - Weak: "See a list of all subscriptions."
   - Strong: "You need to cut $50/month from subscriptions. Netflix and Spotify stay. What do you cancel?"

5. **Ambiguity is a feature.** If there's exactly one correct answer verifiable by string matching, the task is a unit test, not a UX evaluation. The most valuable feedback comes from tasks where the "right answer" depends on the persona's priorities and the app's framing.

6. **Use `output_review` for judgment tasks.** `task_completion` (binary pass/fail) works for mechanical tasks like "calculate 20% of $50." For synthesis/decision tasks, `output_review` with qualitative success criteria ("the persona articulated a clear recommendation with reasoning") produces richer signal.

A useful complexity spectrum:
- **Level 1-2 (Find/Filter):** "See the chart," "filter by time" → any prototype passes these
- **Level 3 (Compare):** "Compare two options side by side" → tests layout
- **Level 4 (Synthesize):** "Figure out why X happened" → tests information flow
- **Level 5 (Decide):** "Given your constraints, choose what to do" → tests whether the app is actually useful

Aim for at least 1 P0 and 1 P1 task at Level 4-5.

7. **Use per-task step budgets for complex tasks.** Tasks that require multi-step data entry (typing ingredients, filling forms) before evaluation should specify `max_steps: 15` or higher. The default quick-mode budget (10 steps) is appropriate for tasks that start from an already-populated state or require minimal input. Without this, the step limit forces all prototypes toward the simplest possible input method (e.g., a single textarea), which may not be the best UX.
   ```markdown
   #### Task 1: Tuesday night chicken search
   - type: computation
   - max_steps: 15
   - goal: Enter 6 ingredients, apply constraints, pick a recipe...
   ```

### 2. Verify Inputs

Check for these files:
- **`persona.md`** (required) — Who the user is
- **`requirements.md`** (optional) — Tasks and scoring separate from persona. See [example](references/examples/requirements_example.md)
- **`hypotheses.md`** (optional) — Unknowns to validate. See [example](references/examples/hypotheses_example.md)

### 3. Initialize

Ask the user: "Full experience (3 prototypes, comparative evaluation) or quick single prototype?"

Call `init_autoproto` with mode, experiment name, and persona command.

Determine the persona agent command: use `--cmd` with your own CLI. For example, if you are Claude Code, use `claude -p`. If you are pi, use `pi -p`. Ask the user if they want a different LLM.

For browser backend: default is `agent-browser` (vision mode — annotated screenshots). If the user's app uses modals/overlays heavily, or if they want lower token costs, suggest `playwright-cli` (text/snapshot mode). Only ask about this if the user brings it up or if `agent-browser` is not installed — don't overwhelm with options by default.

### 4. Brainstorm Approaches (Full Mode)

Read `persona.md`, `requirements.md`, and `hypotheses.md` carefully.

**Brainstorm 3 genuinely different UX approaches** — not variations of the same idea. Examples:
- A dashboard with filters vs. a conversational flow vs. a visual workspace
- A wizard/step-by-step flow vs. a single-page calculator vs. a card-based explorer

**Differentiate on results, not input.** Since the evaluation uses a synthetic agent, complex input patterns (autocomplete, chip grids, multi-step wizards) may be penalized by step limits even when they're good UX for humans. Differentiate prototypes on results presentation, information architecture, filtering UX, and decision support — not on data entry method. All prototypes can share the same efficient input method.

**If the agent can't use your prototype's distinctive pattern**, that's a finding — don't replace it with the same thing that works for the agent. Note it as a limitation in your iteration plan and focus on the parts of the approach that *can* be tested.

For each approach:
1. **Name**: 2-3 words
2. **Core idea**: 1 sentence
3. **Why it fits**: 1 sentence connecting to the persona
4. **Hypothesis coverage** (if `hypotheses.md` exists)

### 5. Create Branches

**Full mode:**
1. Create branches: `autoproto/<experiment>/proto-a`, `proto-b`, `proto-c`
2. Write `approach.md` on each branch
3. Copy `persona.md`, `requirements.md`, `hypotheses.md` to each branch

**Quick mode:**
1. Pick the most promising approach
2. Create branch: `autoproto/<short-tag>`
3. Write `approach.md`

Show approaches to user and confirm.

## Iteration Loop

For each prototype branch:

### Build Seed App

1. Switch to the branch
2. Read `approach.md` for UX direction
3. Set up a Vite project:
   - `package.json` with `vite-plus` as devDependency
   - `vite.config.js`
   - `.gitignore` with `node_modules/` and `dist/`
   - Install deps: `pnpm install` or `npm install` (whichever is available)
   - Organize code: `src/index.html`, `src/main.js`, `src/styles.css`, `src/data.js`
4. Run baseline: `run_evaluation` with iteration=0, mode="quick"
5. Call `log_iteration` with the baseline scores (scores auto-read from eval_results.json if omitted)

### Iterate

Repeat until a stopping condition:

1. **Read results.** Read the eval_results.json from the last `run_evaluation`.
   - **Core tasks:** Identify lowest-scoring P0 task. Note `stuck_points` and `persona_feedback`. The composite score from core tasks drives keep/discard.
   - **Exploratory tasks:** Read for UX issues you didn't know about. Don't optimize for exploratory scores — they change every iteration. But if the persona found a dead-end or broken flow, that's real signal.
   - **Session wishlist:** Cumulative reflections grounded in the persona's experience. Diagnose root causes, don't implement literally.

2. **Fresh start thinking.** Before planning, ask yourself:
   - "If I were building this from scratch, knowing what the persona struggles with... would I build anything like what exists?"
   - "What mental model is the persona actually using?"
   - "What's the most surprising thing from the persona's feedback?"

3. **Plan a change.** Based on eval results and feedback:
   - Fix failing P0 tasks first, then P1, then P2
   - Consider different UI patterns, not just incremental tweaks
   - Analyze `session_wishlist`: what's the underlying need behind each wish?
   - If exploratory tasks surfaced a problem, factor it in even though it's not scored

4. **Write plan.** Create `results/iter_N/plan.md` (where N is the upcoming iteration number) with:
   - **Score summary:** Per-task scores from the previous iteration — task number, tier, score, pass/fail
   - **Feedback analysis:** Key persona feedback and stuck points for each failing or low-scoring task
   - **Changes planned:** What you're changing and why, connecting each change to specific persona feedback
   - **Expected impact:** Which tasks should improve and by roughly how much
   - This plan is written *before* making any code changes. It documents your reasoning and serves as a record of intent for each iteration.

5. **Edit.** Make the change to files in `src/`. Keep changes small — one logical improvement per iteration.

6. **Check.** Run `npx vp check src/`. Fix lint/format errors. Always target `src/` to avoid linting `node_modules/`.

7. **Evaluate.** Call `run_evaluation` with the current iteration number. Use mode `quick` for fast iteration.

8. **Decide.** Compare scores:
   - Score improved or held → kept=true. Commit changes.
   - Score dropped → kept=false. Revert: `git checkout -- src/ package.json vite.config.js`

9. **Record.** Call `log_iteration` with the iteration number, description, and kept/discarded. Scores are auto-read from eval_results.json — no need to compute manually.

10. **Report.** Tell the user: "Iteration N: <description>. Score: X → Y. [Kept/Discarded]."

### Stopping Conditions

- Plateau: composite hasn't improved by >3 points in last 3 kept iterations
- 10 iterations completed
- All P0 tasks pass with composite > 85
- Per-prototype iteration cap reached (full mode, default 5). In full mode, aim for roughly equal iteration budgets per prototype. If you hit the cap, move on — even if the prototype is still improving. A fair comparison requires comparable effort on each approach.

### Final Evaluation

Run `run_evaluation` with mode `variants` and variant_count=4.

### Evolve Requirements (Full Mode)

After each prototype, update `requirements.md` based on convergent feedback:
- Convergent wishes (3/4+ variants) → new P2 tasks
- Tasks all variants fail → reassess if realistic
- Tasks all variants pass easily → tighten criteria

Move to next prototype branch.

## Synthesis (Full Mode)

After all prototypes are built and evaluated:

Call `generate_report` with the experiment directory and hypotheses file.

Present to the user: comparative report, recommendations, bias flags.

## Constraints

- **Browser backends.** Two backends are available, set via `init_autoproto`:
  - **agent-browser** (default) — vision mode with annotated screenshots. The persona sees numbered labels on interactive elements. Design for visual quality: layout, color, typography, whitespace matter. Don't shrink text for density — the vision agent penalizes small text (keep font sizes ≥ 13px body, ≥ 11px labels).
  - **playwright-cli** — text/snapshot mode using Playwright's accessibility tree. The persona sees structured text, not pixels. Better for apps with modals/overlays. Lower token cost, no vision model needed. Visual polish matters less; semantic structure and ARIA roles matter more.
- **Use Vite+ for all apps.** `package.json` with `vite-plus`, `vite.config.js`. Install with `pnpm install` or `npm install`.
- **Only modify files in `src/`, `package.json`, and `vite.config.js`.**
- **Always create `.gitignore`** with `node_modules/` and `dist/` before committing.
- **Each iteration = one coherent change** with a clear thesis — but bundle independent fixes for different tasks into one iteration.
- **P0 first.** Never work on P1/P2 while P0 tasks fail.
- **Run `vp check src/` after every edit.** Always target `src/` to avoid linting `node_modules/`.
- **Score variance is real.** Single-run scores can swing 30+ points on the same code. Don't trust deltas under 15 points from a single quick run. When `log_iteration` flags a score change as "likely noise" (within historical stdev), weight the qualitative feedback more heavily than the number. If the persona feedback suggests improvement but the score dropped within variance, lean toward keeping.
- **Timeouts ≠ failures.** If a task times out but passed in a previous iteration with unchanged code, it's an infrastructure issue (LLM latency, browser backend). Do not re-run evaluations because of timeouts. Log the iteration and move on.
- **log_iteration auto-reads scores.** You don't need to manually compute composite/P0/P1/P2 — just pass iteration number, description, and kept. Scores are read from eval_results.json.
- **Wishlist items are desires, not requirements.** The `session_wishlist` is grounded in the persona's experience, but still: diagnose root causes, don't implement literally.
- **approach.md is read-only during iteration.** Don't pivot mid-prototype.
- **All feedback is hypothesis-grade.** Treat as hypotheses for real users, not conclusions.
- **Take creative risks.** The keep/discard protocol exists to enable risk-taking.
- **Read the persona's background carefully.** Build UI that fits their mental model.
