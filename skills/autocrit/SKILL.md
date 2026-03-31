---
name: autocrit
description: >
  Persona-driven UX evaluation for web app prototypes. Builds prototypes,
  evaluates with synthetic users via agent-browser, and iterates based on
  structured feedback. Supports full mode (3 prototypes with comparative
  evaluation) or quick mode (single prototype). Use when building and
  evaluating web app prototypes, or when asked to "run autocrit", "evaluate
  this app with personas", or "set up UX testing".
---

# Autocrit

Persona-driven UX evaluation loop: build a prototype, let a synthetic user try it, iterate on their feedback, repeat.

## Tools

- **`init_autocrit`** — validate dependencies, set mode (full/quick), experiment name, persona command
- **`run_evaluation`** — run persona agent against the app, get structured scores and feedback
- **`log_iteration`** — record results, manage history, detect plateaus
- **`generate_report`** — comparative synthesis across prototypes (full mode only)

Dashboard: `ctrl+x` to expand/collapse. `/autocrit` for status.

### Evaluation Discipline

- **One evaluation per iteration.** Call `run_evaluation` once, then `log_iteration`. Do not re-run to "confirm" — trust the score.
- **Always run all tasks.** Never filter by tier. Tier-filtered evaluations produce misleading composite scores (unrun tiers show as 0).
- **Task filter is for debugging only.** Only use the `task` parameter after a full evaluation has identified a specific stuck task you need to investigate.
- **Bundle independent fixes.** If multiple failing tasks have independent fixes (e.g., add a nav item AND move a button), address them in one iteration. The keep/discard protocol handles failure — revert the whole bundle.
- **Timeouts are not failures.** If a task times out with no feedback, it's an infrastructure issue (LLM latency, agent-browser). Do not re-run. Log the iteration and move on.
- **Faster iteration with cheaper models.** For faster evaluation cycles, consider using a cheaper/faster model for the persona agent (e.g., `--cmd "claude -p --model haiku"`). The persona agent navigates and clicks — it doesn't need the most capable model.

## Quick Start

1. Create `persona.md` (see [persona guide](references/examples/persona_example.md))
2. `init_autocrit` — set mode, experiment name, persona command
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
4. Generate `persona.md` following the example format:
   - 4-8 tasks across P0/P1/P2 tiers
   - Include anti-tasks (things the persona would NOT do)
   - Write agent_instructions that capture the persona's personality and patience level
   - **Background must be 4-6 paragraphs** including: day-to-day activities, current workarounds, pain points (3-5 specific frustrations), and why this app matters to them
   - **Task design matters for UX quality.** Follow the task design principles below.
5. Show it to the user for review.

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

### 2. Verify Inputs

Check for these files:
- **`persona.md`** (required) — Who the user is
- **`requirements.md`** (optional) — Tasks and scoring separate from persona. See [example](references/examples/requirements_example.md)
- **`hypotheses.md`** (optional) — Unknowns to validate. See [example](references/examples/hypotheses_example.md)

### 3. Initialize

Ask the user: "Full experience (3 prototypes, comparative evaluation) or quick single prototype?"

Call `init_autocrit` with mode, experiment name, and persona command.

Determine the persona agent command: use `--cmd` with your own CLI. For example, if you are Claude Code, use `claude -p`. If you are pi, use `pi -p`. Ask the user if they want a different LLM.

### 4. Brainstorm Approaches (Full Mode)

Read `persona.md`, `requirements.md`, and `hypotheses.md` carefully.

**Brainstorm 3 genuinely different UX approaches** — not variations of the same idea. Examples:
- A dashboard with filters vs. a conversational flow vs. a visual workspace
- A wizard/step-by-step flow vs. a single-page calculator vs. a card-based explorer

For each approach:
1. **Name**: 2-3 words
2. **Core idea**: 1 sentence
3. **Why it fits**: 1 sentence connecting to the persona
4. **Hypothesis coverage** (if `hypotheses.md` exists)

### 5. Create Branches

**Full mode:**
1. Create branches: `autocrit/<experiment>/proto-a`, `proto-b`, `proto-c`
2. Write `approach.md` on each branch
3. Copy `persona.md`, `requirements.md`, `hypotheses.md` to each branch

**Quick mode:**
1. Pick the most promising approach
2. Create branch: `autocrit/<short-tag>`
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

1. **Read results.** Read the eval_results.json from the last `run_evaluation`. Identify the lowest-scoring P0 task. Note `stuck_points`, `persona_feedback`, and `wishlist`.

2. **Fresh start thinking.** Before planning, ask yourself:
   - "If I were building this from scratch, knowing what the persona struggles with... would I build anything like what exists?"
   - "What mental model is the persona actually using?"
   - "What's the most surprising thing from the persona's feedback?"

3. **Plan a change.** Based on eval results and feedback:
   - Fix failing P0 tasks first, then P1, then P2
   - Consider different UI patterns, not just incremental tweaks
   - Analyze wishlist items: what's the underlying need?

4. **Edit.** Make the change to files in `src/`. Keep changes small — one logical improvement per iteration.

5. **Check.** Run `npx vp check src/`. Fix lint/format errors. Always target `src/` to avoid linting `node_modules/`.

6. **Evaluate.** Call `run_evaluation` with the current iteration number. Use mode `quick` for fast iteration.

7. **Decide.** Compare scores:
   - Score improved or held → kept=true. Commit changes.
   - Score dropped → kept=false. Revert: `git checkout -- src/ package.json vite.config.js`

8. **Record.** Call `log_iteration` with the iteration number, description, and kept/discarded. Scores are auto-read from eval_results.json — no need to compute manually.

9. **Report.** Tell the user: "Iteration N: <description>. Score: X → Y. [Kept/Discarded]."

### Stopping Conditions

- Plateau: composite hasn't improved by >3 points in last 3 kept iterations
- 10 iterations completed
- All P0 tasks pass with composite > 85

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

- **Vision mode (default).** The evaluator sees actual screenshots with numbered labels on interactive elements.
- **Design for visual quality**: layout, color, typography, whitespace matter.
- **Don't shrink text for density.** The vision agent penalizes small text — keep font sizes ≥ 13px for body text, ≥ 11px for labels. Prefer layout changes (columns, dedicated views) over making everything smaller.
- **Use Vite+ for all apps.** `package.json` with `vite-plus`, `vite.config.js`. Install with `pnpm install` or `npm install`.
- **Only modify files in `src/`, `package.json`, and `vite.config.js`.**
- **Always create `.gitignore`** with `node_modules/` and `dist/` before committing.
- **Each iteration = one coherent change** with a clear thesis — but bundle independent fixes for different tasks into one iteration.
- **P0 first.** Never work on P1/P2 while P0 tasks fail.
- **Run `vp check src/` after every edit.** Always target `src/` to avoid linting `node_modules/`.
- **Score variance is real.** Single-run scores can swing 30+ points on the same code. Don't trust deltas under 15 points from a single quick run. If a task shows a surprising score change, re-run it before making a keep/discard decision.
- **Timeouts ≠ failures.** If a task times out but passed in a previous iteration with unchanged code, it's an infrastructure issue (LLM latency, agent-browser). Do not re-run evaluations because of timeouts. Log the iteration and move on.
- **log_iteration auto-reads scores.** You don't need to manually compute composite/P0/P1/P2 — just pass iteration number, description, and kept. Scores are read from eval_results.json.
- **Wishlist items are desires, not requirements.** Diagnose root causes.
- **approach.md is read-only during iteration.** Don't pivot mid-prototype.
- **All feedback is hypothesis-grade.** Treat as hypotheses for real users, not conclusions.
- **Take creative risks.** The keep/discard protocol exists to enable risk-taking.
- **Read the persona's background carefully.** Build UI that fits their mental model.
