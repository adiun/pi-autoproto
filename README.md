# pi-autocrit

Persona-driven UX evaluation for [pi](https://pi.dev/), inspired by ideas from [autoresearch](https://github.com/karpathy/autoresearch).

For your earliest stages of product development: build a prototype, define your end-user persona, let synthetic users try it, iterate on their feedback, repeat.

## Why

AI coding agents have made building software super cheap. You can generate a working prototype in minutes. But the traditional product development sequence (research, spec, build, test, ship, get feedback) was designed around the assumption that building is expensive. The huge functional spec existed to reduce the risk of building the wrong thing. When building costs nearly nothing, you can prototype something in 20 minutes and get real feedback on it. That feedback is higher signal than any spec could be.

But the bottleneck has shifted, from production to evaluation. You can generate ten prototypes in the time it used to take to build one, but how do you know which one is good? Human evaluation doesn't scale to that pace. 

A **'crit'** in design and software development is a collaborative session aimed to get constructive feedback for prototypes to find flaws and changes in requirements early. **Autocrit** automates the evaluation side. A synthetic persona, defined with enough behavioral detail to produce realistic interaction patterns, actually uses the app in a real browser and reports what worked, what didn't, and why. The coding agent reads that feedback and iterates. The loop can run autonomously overnight. In the morning, you have an app that's been through dozens of critique cycles, each one targeted at a specific task failure or UX friction point.

The main value here is a structured, repeatable critique.

## An important note

Autocrit is a tool for early-stage exploration and validation. It is not a replacement for the full product development lifecycle.

A synthetic persona is not a real user. It's a behavioral sketch with a backstory, some tasks, and personality traits. It produces plausible interaction patterns, but it lacks actual prior experience, social context, emotional variability, and the ability to learn and adapt over time. In the future I'd love to set up a digital twin infra where the definition of the user improves over time. But that's not this right now! 

What autocrit tells you is which design hypotheses survived contact with a simulated user. The appropriate response to its results is "this gives us confidence to invest deeper in approach A" or "this suggests we should test the feasibility-first model with real users." Not "ship it."

Use it to:
- Rapidly explore whether an idea has legs before committing engineering resources
- Compare fundamentally different UX approaches against the same user definition
- Surface behavioral friction points that are hard to spot by just looking at a UI
- Generate structured hypotheses to bring into real user research

Do not use it to:
- Skip user research entirely
- Make final product decisions based solely on synthetic feedback
- Assume high scores mean the product is ready for real users

To me, this is a new "inner loop" within a potentially new take on the SDLC. But it doesn't replace the entire SDLC. 

## Install

```bash
pi install https://github.com/adiun/pi-autocrit
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-autocrit ~/.pi/agent/extensions/
cp -r skills/autocrit ~/.pi/agent/skills/
cp -r python ~/.pi/agent/extensions/pi-autocrit/../../python
```

Then `/reload` in pi.

</details>

### Prerequisites

1. [pi](https://pi.dev/)
2. A browser backend (one of):
   - [agent-browser](https://github.com/vercel-labs/agent-browser): `npm install -g agent-browser && agent-browser install` (default, vision mode)
   - [playwright-cli](https://github.com/microsoft/playwright-cli): `npm install -g @playwright/cli@latest` (text/snapshot mode). After installing, run `bash scripts/setup.sh` with `AUTOCRIT_BROWSER_BACKEND=playwright-cli` to auto-install chromium for the correct Playwright version. Alternatively, `init_autocrit` will auto-install chromium on first use.
3. [uv](https://docs.astral.sh/uv/): `curl -LsSf https://astral.sh/uv/install.sh | sh`
4. An API key for your preferred LLM provider (configured in pi)

Run `bash scripts/setup.sh` to verify all dependencies.

## Usage

### 1. Start autocrit

```
/skill:autocrit
```

The agent guides you through creating a persona, then starts the evaluation loop.

### 2. Create the persona

The coding agent writes the persona's identity (background, environment, agent instructions) but does **not** write the tasks. A separate `generate_tasks.py` script calls the persona LLM *as the persona* to generate core tasks grounded in their daily life. This separation means the agent building the app doesn't also define what success looks like. The persona thinks from the user's life context: "what would I actually try to do with this app?"

Tasks are split into two categories:
- **Core tasks** — generated once, fixed for the experiment. These are the stable benchmark that drives keep/discard decisions.
- **Exploratory tasks** — generated fresh each evaluation by the persona looking at the current app. These surface UX problems that fixed tasks miss, preventing the coding agent from overfitting to a known test suite.

### 3. The loop

1. The agent edits the app code
2. `run_evaluation` launches the synthetic persona, who interacts with the app via a browser backend (agent-browser or playwright-cli) in a real browser
3. Core task scores determine keep/discard. Exploratory task feedback surfaces blind spots.
4. After all tasks, the persona reflects on the whole experience and produces a grounded **session wishlist** — specific wishes tied to their daily routine and the friction they hit during testing.
5. `log_iteration` records the result and updates the dashboard
6. Repeat

### 4. Monitor progress

- The status widget is always visible above the editor
- `Ctrl+X` cycles through compact → expanded → fullscreen (with per-task feedback and variance stats)
- `/autocrit` shows detailed status

## Modes

### Quick mode (default)

Single prototype — meant for fast iteration. It's good for exploring one UX direction.

### Full mode

Three prototypes with fundamentally different UX approaches, each going through the iteration loop independently. After all prototypes stabilize, `generate_report` produces a comparative analysis.

The most important product design questions are not so much "should this button be blue or green?" but more like "should this be a dashboard or an entity browser?" or "should navigation be portfolio-first or study-first?" These questions can't be answered by iterating on a single prototype, because iteration converges on a local optimum within that prototype criteria. Judging multiple criteria / prototypes side by side is best — but it does take a while!

The final comparative report shows:
- Where all prototypes agreed (based on a strong signal, independent of the prototypes knowing about each other)
- Where they diverged 
- Which hypotheses were resolved and which remain open
- Exploratory task findings and session wishlist per prototype
- Score discrepancy warnings when iteration history diverges from stored results

## How it works

The package has two parts: an **extension** (tools, state, UI) and a **skill** (workflow knowledge). The extension provides domain-agnostic evaluation infrastructure. The skill encodes the UX evaluation workflow, persona creation methodology, and iteration discipline.

### Extension tools

| Tool              | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `init_autocrit`   | Validates dependencies, sets mode (full/quick), configures experiment                          |
| `run_evaluation`  | Runs the persona agent against the app, returns structured scores and feedback                 |
| `log_iteration`   | Records results, manages history, archives best results, detects plateaus/stuck tasks/variance |
| `generate_report` | Produces comparative synthesis across prototypes (full mode)                                   |

### Persona-driven task generation

The coding agent writes the persona's identity (background, environment, agent instructions) but does **not** write the tasks. A separate `generate_tasks.py` script calls the persona LLM *as the persona* to generate core tasks grounded in their daily life. This simulates how some user research is gathered initially to define a hypothesis around user goals. But when put in front of a user they can do anything they want.

Core tasks go through a user review gate before evaluation begins.

### Per-task step budgets

Tasks can specify their own step budget via `max_steps` in the persona file. The default quick-mode budget (10 steps) works for simple tasks, but complex tasks that require multi-step data entry (typing ingredients, filling forms, applying multiple filters) can request more steps. Without this, the flat step limit forces all prototypes toward the simplest possible input method — a single textarea — which may not be the best UX for real humans.

```markdown
#### Task 1: Tuesday night chicken search
- type: computation
- max_steps: 15
- goal: Enter 6 ingredients, apply constraints, pick a recipe...
```

### Core vs. exploratory tasks

A fixed task set invites overfitting. Core tasks are the stable benchmark (fixed for the experiment, drive keep/discard decisions), but each full-mode evaluation also generates **exploratory tasks** — 2-3 ad-hoc tasks the persona invents by looking at the current app. These are scored separately (tier `EX`, not in the composite) and produce qualitative feedback that surfaces edge cases, dead ends, and confusing affordances the core tasks miss.

The coding agent can't game exploratory tasks because it doesn't know what they'll be until after the code is committed.

Exploratory tasks and their scores appear in the comparative report alongside core tasks, giving visibility into UX issues that the fixed task set doesn't cover.

### Session wishlist

After all tasks (core + exploratory) complete, the persona reflects on the entire experience in a single cumulative pass. Instead of per-task "it would be nice if..." items, the session wishlist produces wishes grounded in the persona's daily routine and the specific friction they hit during testing. It also includes a "would you actually use this?" honest signal.

Session wishlists are included in the comparative report for each prototype.

### Evaluation

The persona agent runs in a completely separate `pi -p` process. It has no access to the coding agent's conversation, the source code, or any context about what was built or why. It can only see what a real user would see: the running app in a browser. This is black-box testing — prevents the evaluation from being contaminated by knowledge of the implementation.

Two browser backends are supported:
- **agent-browser** (default) — uses annotated screenshots (vision mode). The persona "sees" numbered labels overlaid on the page.
- **playwright-cli** — uses Playwright's accessibility tree (text/snapshot mode). The persona "sees" structured text like a screen reader. Better for modals/overlays, lower token cost, no vision model required.

Set the backend in `init_autocrit` or via `AUTOCRIT_BROWSER_BACKEND=playwright-cli`.

Via the browser backend, the persona navigates pages, clicks buttons, fills forms, gets confused, tries alternatives, succeeds or fails. Each step produces a reasoning trace. The evaluation captures whether a task was completed but also how many steps it took, where the persona got stuck, and verbatim feedback explaining their experience in their own words.

Core tasks are organized by priority tier and scored by weighted composite:

```
composite = (mean(P0 scores) * 0.60) + (mean(P1 scores) * 0.25) + (mean(P2 scores) * 0.15)
```

If any P0 (core functionality) task scores 0, the composite is capped at 40, regardless of other scores. Exploratory task scores are reported separately and do not affect this composite. Tasks marked as blocked (structurally untestable) are excluded from scoring entirely.

In full mode, four behavioral variants of the same persona (e.g. Rushed, Careful, Skeptical, Confident) evaluate each prototype independently. Where 3 of 4 agree, that's a strong signal. Where they diverge, that's also useful info: it means the app's quality depends on user mood or approach. Verbatim feedback from each variant is preserved and attributed, so you can trace exactly which persona said what. If the variant evaluation crashes partway through, completed variant results are preserved — partial data is better than no data.

### Task design

Tasks are the most important part of the persona file. Weak tasks produce false confidence — any reasonable prototype will score 90+ if the tasks only check whether information is displayed. The system enforces task quality through the persona-driven generation and through design principles baked into the skill:

- Tasks should require judgment by the end-user and should be simple tasks like navigation
- At least 2 P0 tasks must end with the persona making a decision or forming an opinion
- Tasks should embed competing constraints from the persona's life
- Ambiguity is a feature — the best feedback comes from tasks where the "right answer" depends on the persona's priorities
- Complex tasks that need multi-step data entry should set `max_steps` higher than the default

### Durability

Several mechanisms protect against data loss and make the iteration loop more reliable:

**Best result archival.** When an iteration achieves a new best score for its branch, `log_iteration` copies `eval_results.json` and screenshots to a protected `best/` directory and git-tags the commit. This prevents the common scenario where a best iteration's results are overwritten or lost during subsequent reverts. The comparative report prefers archived best results over potentially stale proto-level files.

**Score discrepancy detection.** The report cross-references `eval_results.json` scores against the iteration history in `autocrit.jsonl`. If a prototype's actual best kept score is higher than what's in its results file (e.g., because results were lost during reverts), the report flags the discrepancy, shows the peak score, and uses the higher score for winner determination.

**Incremental variant writes.** In variant evaluation mode, results are written to disk after each variant completes. If the process crashes at variant 4 of 4, the first three variants' data is preserved and reported, rather than losing everything.

**Stuck task detection.** If a task scores 0 in three or more consecutive kept iterations with "step limit" stuck points, `log_iteration` flags it as structurally untestable and suggests remedies: increase `max_steps`, mark as blocked, or debug in isolation. Blocked tasks are excluded from the composite score so a single untestable task doesn't cap the entire score.

**Score variance tracking.** Single-run scores can swing 30+ points on identical code. The system tracks per-task score history and, when a score change falls within the historical standard deviation, flags it as "likely noise." This helps the agent (and you) distinguish genuine improvements from random variance when making keep/discard decisions.

**Per-prototype iteration caps.** In full mode, each prototype has a configurable iteration budget (default 5). Warnings appear at 60% and 100% of the budget to prevent the common failure mode of spending all iterations polishing one prototype while others get only a baseline evaluation.

**Feedback fallback.** Quick-mode evaluations skip the persona feedback generation step (for speed), but task notes and stuck-point descriptions still contain rich signal. The report uses a fallback chain — `persona_feedback` → `notes` → `stuck_points` — so verbatim feedback sections are never empty when the persona had something to say.

### State

All state is stored in an append-only `autocrit.jsonl` file. Each entry is a config record, an iteration record, or a per-task score record. If you close the terminal and come back later, the agent reconstructs full state from this log and picks up where it left off. Per-task score history enables variance tracking and stuck task detection across sessions.

## The comparative report

In full mode, `generate_report` produces a structured comparison across prototypes. The report includes:

| Section                   | What it shows                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Prototype Comparison**  | Side-by-side scores (composite, P0/P1/P2, exploratory) with peak scores from iteration history                       |
| **Score Discrepancies**   | Warnings when eval_results.json scores diverge from actual best scores in the iteration log                          |
| **Verbatim Feedback**     | Per-task feedback from each prototype, with fallback to notes and stuck points                                       |
| **Exploratory Tasks**     | Ad-hoc tasks the persona invented, their scores, and feedback                                                        |
| **Session Wishlist**      | Cumulative persona reflections: wishes, surprises, and "would I use this?"                                           |
| **Why Others Didn't Win** | Task-level analysis of where each losing prototype fell short — failed tasks, unique stuck points, negative feedback |
| **Recommendations**       | Strongest prototype (using best available score), bias flags for validation                                          |

When persona variants are used, the report also includes strongest signals, interesting disagreements, and bias detection.

## How autocrit compares

### vs. traditional user testing

Recruiting participants, scheduling sessions, synthesizing notes.

- **Speed:** Overnight autonomous runs vs. weeks of recruiting and scheduling
- **Cost:** LLM tokens vs. user incentives and researcher time
- **Repeatability:** Versioned, comparable across iterations vs. qualitative and one-shot
- **Tradeoff:** Synthetic behavior — plausible but not real human judgment. Autocrit generates hypotheses for user research, not conclusions that replace it.

### vs. screenshot-based UI evaluation

Showing an LLM a screenshot and asking it to rate the design.

- **Interaction:** Real browser sessions (click, fill, scroll, get confused, try alternatives) vs. static image assessment
- **Signal type:** Behavioral data (steps taken, where stuck, what paths tried) vs. aesthetic ratings ("the layout is clean")
- **Failure modes:** The persona gives up, gets lost, misreads a label — the same things real users do. A screenshot judge only sees what's on screen, not what happens when you use it.

### vs. automated testing (Cypress, Playwright)

Functional test suites that assert correctness.

- **What's tested:** UX quality and decision support vs. functional correctness
- **Task type:** Judgment-based ("what would you cancel?") vs. assertion-based (`expect(button).toBeVisible()`)
- **Feedback:** Qualitative and grounded in a persona's life context vs. pass/fail with stack traces

### vs. A/B testing

Splitting production traffic between variants and measuring conversion.

- **Timing:** Pre-production (tests prototypes before building the real thing) vs. post-ship (requires production traffic)
- **Scope:** Compares fundamentally different UX approaches vs. incremental variations (button colors, copy changes)
- **Infrastructure:** Runs on a dev machine vs. requires production deployment and traffic volume

### vs. LLM-as-judge (direct scoring)

Asking an LLM to score an app description, spec, or screenshot directly.

- **Evidence basis:** The persona actually uses the app in a browser vs. rating a description or image
- **Transparency:** Full interaction traces — you can see exactly what happened at every step vs. a single score with rationale
- **Output richness:** Scores + per-task feedback + stuck points + session wishlist vs. a number and a paragraph

## Cost and performance

Autocrit uses LLM calls in two places: the coding agent (pi) builds and modifies the app, and the persona agent evaluates it by interacting with it in a browser. Cost and time scale with the number of tasks, steps per task, and iterations.

### Rough estimates

| Configuration                                             | Token cost | Wall-clock time |
| --------------------------------------------------------- | ---------- | --------------- |
| Quick mode, 8 tasks                                       | ~$2–5      | 10–20 min       |
| Full mode, 8 tasks                                        | ~$5–10     | 20–40 min       |
| Variant evaluation, 8 tasks × 4 variants                  | ~$15–25    | 60–120 min      |
| Full session (3 prototypes, 5 iters each, final variants) | ~$80–150   | 6–10 hours      |

Costs depend on model, provider pricing, and vision vs. text mode.

### What drives cost

- **Tasks × steps × LLM calls per step.** Each step is one LLM call. More tasks and higher `max_steps` = more calls.
- **Vision mode.** Annotated screenshots (agent-browser) include image tokens. Text mode (playwright-cli) is cheaper.
- **Feedback generation.** Full mode adds 1 LLM call per task for persona feedback, plus exploratory tasks and session wishlist.
- **Variant mode.** Multiplies everything by the variant count (default 4).

### Managing costs

- Start with quick mode and fewer tasks while getting a feel for things
- Use a cheaper model for the persona agent (e.g., `--model haiku`) — it navigates and clicks, it doesn't need the most capable model
- Use text mode instead of vision mode for lower per-call token cost
- Set spending limits on your LLM provider's dashboard
- Full mode with four persona variants across three prototypes is the most expensive configuration — save it for when the persona and tasks are dialed in

## License

MIT
