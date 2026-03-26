<div align="center">

# pi-autocrit
### Persona-driven UX evaluation for pi
**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

</div>

*Build a prototype, let a synthetic user try it, iterate on their feedback, repeat.*

An extension for **[pi](https://pi.dev/)** — an AI coding agent that runs in your terminal. pi-autocrit gives pi the tools and workflow to run persona-driven UX evaluation loops: build a web app prototype, evaluate it with a synthetic user persona via [agent-browser](https://github.com/nicobailey/agent-browser), iterate based on structured feedback.

Based on [autocrit](https://github.com/YOUR_USERNAME/autocrit).

---

## Quick start

```bash
pi install https://github.com/YOUR_USERNAME/pi-autocrit
```

## What's included

| | |
|---|---|
| **Extension** | Tools + live widget + `/autocrit` command |
| **Skill** | Guided persona creation, approach brainstorming, iteration workflow |

### Extension tools

| Tool | Description |
|------|-------------|
| `init_autocrit` | Validate dependencies, set mode (full/quick), experiment name, persona command |
| `run_evaluation` | Run persona agent against the app — returns structured scores and feedback |
| `log_iteration` | Record iteration results, manage history, detect plateaus |
| `generate_report` | Comparative synthesis across prototypes (full mode) |

### `/autocrit` command

| Subcommand | Description |
|------------|-------------|
| `/autocrit` | Show current status (iteration, scores, branch) |
| `/autocrit start` | Start a new session (points to skill) |
| `/autocrit off` | Disable autocrit mode |

### Keyboard shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+X` | Toggle dashboard expand/collapse |

### UI

- **Status widget** — always visible above the editor: `🎯 tipcalc iter 5 │ composite: 72.0 (P0: 85.0 P1: 60.0 P2: 40.0) ▲+8.0 from iter 4`
- **Expanded dashboard** — `Ctrl+X` expands into a full iteration history table

### Skill

`autocrit` guides you through the full workflow:
1. **Persona creation** — interactive conversation to build a detailed persona
2. **Approach brainstorming** — 3 genuinely different UX approaches (full mode)
3. **Iteration loop** — build → evaluate → decide → record → repeat
4. **Synthesis** — comparative report across prototypes (full mode)

---

## Install

```bash
pi install https://github.com/YOUR_USERNAME/pi-autocrit
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

1. **[pi](https://pi.dev/)** installed
2. **[agent-browser](https://github.com/nicobailey/agent-browser)**: `npm install -g agent-browser && agent-browser install`
3. **[uv](https://docs.astral.sh/uv/)** (or python3): `curl -LsSf https://astral.sh/uv/install.sh | sh`
4. **An API key** for your preferred LLM provider (configured in pi)

Run `bash scripts/setup.sh` to verify all dependencies.

---

## Usage

### 1. Start autocrit

```
/skill:autocrit
```

The agent guides you through persona creation, then starts the evaluation loop.

### 2. The loop

The agent iterates autonomously:
1. **Edit** the app code
2. **Evaluate** with `run_evaluation` — a synthetic persona interacts with the app via agent-browser
3. **Decide** — score improved? Keep. Score dropped? Discard and revert.
4. **Record** with `log_iteration` — updates history files and dashboard
5. **Repeat**

### 3. Monitor progress

- **Widget** — always visible above the editor
- **`Ctrl+X`** — expand/collapse full iteration table
- **`/autocrit`** — detailed status

---

## Modes

### Quick mode (default)

Single prototype. Fast iteration. Good for exploring one UX direction.

### Full mode

3 prototypes with different UX approaches. Each goes through the iteration loop independently. After all prototypes are built, `generate_report` produces a comparative analysis with:
- Prototype comparison table
- Hypothesis resolution
- Strongest signals from persona variant convergence
- Bias flags
- Recommendations

---

## How it works

The **extension** provides domain-agnostic evaluation infrastructure. The **skill** encodes the UX evaluation workflow. This separation means the tools work for any web app domain.

```
┌────────────────────────────┐     ┌─────────────────────────────────┐
│  Extension (tools + UI)    │     │  Skill (workflow knowledge)     │
│                            │     │                                 │
│  init_autocrit             │◄────│  Persona creation guide         │
│  run_evaluation            │     │  Approach brainstorming         │
│  log_iteration             │     │  Iteration strategy             │
│  generate_report           │     │  Constraints & best practices   │
│  dashboard widget          │     │                                 │
└────────────────────────────┘     └─────────────────────────────────┘
```

Two file types keep state:

```
autocrit.jsonl       — append-only log of config + every iteration result
results/             — per-iteration eval_results.json, screenshots, history
```

---

## Controlling costs

Autocrit uses LLM calls in two places:
1. **The coding agent** (pi) — builds and modifies the app
2. **The persona agent** — evaluates the app by interacting with it

Each evaluation iteration involves multiple persona agent calls (one per task, plus scoring and feedback). To control costs:

- **Use `--quick` mode** in `run_evaluation` (1 run, no feedback, max 10 steps)
- **Focus on specific tasks** with the `task` or `tier` parameters
- **Set API key limits** on your provider's dashboard

---

## License

MIT
