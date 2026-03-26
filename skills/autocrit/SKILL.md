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

## Quick Start

1. Create `persona.md` (see [persona guide](references/examples/persona_example.md))
2. `init_autocrit` — set mode, experiment name, persona command
3. Build seed app (Vite project with `.gitignore`)
4. `run_evaluation` with mode `quick` for baseline (mode `calibrate` for ≤4 tasks)
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
   - **Task design matters for UX quality.** At least 2 P0 tasks should require the persona to _do something_ with the data — make a decision, compare options, adjust parameters — not just find and read information
5. Show it to the user for review.

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
4. Run baseline: `run_evaluation` with iteration=0, mode="quick" (for ≤4 tasks, mode="calibrate" is also fine)
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

6. **Evaluate.** Call `run_evaluation` with the current iteration number. Use mode `quick` for fast iteration, or add task/tier filters to focus.

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
- **Each iteration = one coherent change** with a clear thesis.
- **P0 first.** Never work on P1/P2 while P0 tasks fail.
- **Run `vp check src/` after every edit.** Always target `src/` to avoid linting `node_modules/`.
- **Score variance is real.** Single-run scores can swing 30+ points on the same code. Don't trust deltas under 15 points from a single quick run. If a task shows a surprising score change, re-run it before making a keep/discard decision.
- **Timeouts ≠ failures.** If a task times out but passed in a previous iteration with unchanged code, use the previous score. Infrastructure timeouts (LLM latency, agent-browser issues) are flagged separately from UX failures.
- **log_iteration auto-reads scores.** You don't need to manually compute composite/P0/P1/P2 — just pass iteration number, description, and kept. Scores are read from eval_results.json.
- **Wishlist items are desires, not requirements.** Diagnose root causes.
- **approach.md is read-only during iteration.** Don't pivot mid-prototype.
- **All feedback is hypothesis-grade.** Treat as hypotheses for real users, not conclusions.
- **Take creative risks.** The keep/discard protocol exists to enable risk-taking.
- **Read the persona's background carefully.** Build UI that fits their mental model.
