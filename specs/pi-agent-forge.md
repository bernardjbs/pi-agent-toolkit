# Specification: pi-agent-forge

## Overview

A Pi extension framework that brings Laravel's developer experience to Pi agent development. Convention over configuration, artisan-style scaffolding commands, and opinionated structure — so building Pi extensions and agents feels familiar and fast.

## Motivation

Pi is powerful but has no scaffolding layer. Every project starts from scratch — blank `.ts` files, hand-written agent markdown, manually structured `.pi/` folders. `pi-agent-forge` fixes that by providing:

- Conventional folder structure (drop files in the right place, they just work)
- `/make:*` commands that scaffold correct, well-structured files
- Agent anatomy template — 7 questions → production-ready agent
- Session observer integration for continuous improvement
- Self-eval loop for agent quality assurance

---

## Conventional Folder Structure

```
.pi/
  extensions/
    gates/          ← input gates (purpose-gate, session-gate)
    safety/         ← damage control rules + extensions
    ui/             ← footer and widget extensions
    workflows/      ← chains, teams, subagent configs
  agents/
    specialists/    ← domain expert agents
    reviewers/      ← code/output review agents
    orchestrators/  ← dispatcher agents
  themes/           ← custom themes per workflow mode
  observer/         ← session observer reports (gitignored)
    sessions/       ← per-session reports
    improvements.md ← cumulative improvement log
  chains/           ← agent chain YAML definitions
  teams/            ← agent team YAML definitions
```

Drop a file in the right folder — Pi discovers it automatically. No registration needed.

---

## `/make:*` Commands

### `/make:agent <name>`

Interactive wizard — 7 questions → well-structured agent file.

**Questions:**
1. What is the agent's domain/specialisation?
2. Complete: "Your job is to..." (single responsibility)
3. What is it NOT allowed to do? (constraints)
4. What input will it receive?
5. What should its output look like? (format + length)
6. Which tools does it need? (read / write / edit / bash)
7. What tone/persona? (direct, thorough, concise, etc.)

**Output:** `.pi/agents/<category>/<name>.md`

```markdown
# {name}

You are a {domain} specialist.

## Objective
{one_job}

## Constraints
{constraints}

## Input
{input_description}

## Output Format
{output_format}

## Tools
Allowed: {tools}

## Tone
{tone}
```

**Optional:** After generating, spawn a Sonnet subagent to self-eval the agent against a sample task and suggest improvements before saving.

---

### `/make:extension <name>`

Scaffolds a typed Pi extension with correct boilerplate.

**Questions:**
1. What does this extension do?
2. Which hooks does it need? (session_start / input / tool_call / tool_result / before_agent_start)
3. Does it need a footer? widget? status?
4. Does it register a custom tool?
5. Does it register a command?

**Output:** `extensions/<category>/<name>.ts`

```typescript
/**
 * {name} — {description}
 *
 * Hooks: {hooks}
 * Usage: pi -e extensions/{name}.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
    // State
    
    // Hooks
    pi.on("session_start", async (_event, ctx) => {
        
    });
    
    // Tools (if needed)
    
    // Commands (if needed)
}
```

---

### `/make:chain <name>`

Scaffolds an agent chain YAML definition.

**Questions:**
1. Chain name and description?
2. How many steps?
3. For each step: which agent? what prompt template?
4. Should steps use $INPUT and/or $ORIGINAL?

**Output:** `.pi/chains/<name>.yaml`

---

### `/make:team <name>`

Scaffolds a team YAML definition.

**Questions:**
1. Team name and purpose?
2. Which agents are in the team?

**Output:** `.pi/teams/<name>.yaml`

---

### `/make:theme <name>`

Scaffolds a theme JSON with sensible defaults.

**Questions:**
1. Base: dark or light?
2. Accent colour (hex)?
3. What mode is this theme for? (daily dev / focused / multi-agent)

**Output:** `.pi/themes/<name>.json`

---

### `/make:rules <name>`

Scaffolds a damage-control YAML rules file.

**Questions:**
1. Which bash commands should be blocked?
2. Which should require confirmation?
3. Which paths are zero-access?
4. Which paths are read-only?
5. Which paths cannot be deleted?

**Output:** `.pi/safety/<name>.yaml`

---

## Agent Anatomy — The 7 Questions

Every good agent answers these:

| # | Question | Maps to |
|---|----------|---------|
| 1 | Who are you? | Identity + domain |
| 2 | What is your ONE job? | Objective — single responsibility |
| 3 | What are you NOT allowed to do? | Constraints — prevent scope creep |
| 4 | What will you receive? | Input description |
| 5 | What should you return? | Output format |
| 6 | Which tools can you use? | Tool allowlist |
| 7 | What tone/persona? | Communication style |

This is the consistent anatomy enforced by `/make:agent`. Any agent missing one of these sections is incomplete.

---

## Agent Testing

### Structural tests
Assert the output has the required format sections.

### Constraint tests
Assert the agent never calls disallowed tools:
```typescript
const toolsCalled = [];
// run agent, collect tool calls
assert(!toolsCalled.includes("write")); // read-only agent
```

### Behavioural tests
Fixed known inputs → check for expected signals in output:
```typescript
const result = await session.send(KNOWN_BUG_SAMPLE);
assert(result.toLowerCase().includes("division by zero"));
```

### `/test:agent <name>`
Run all three test types against an agent file. Report pass/fail per test.

---

## Session Observer Integration

See `specs/session-observer.md` for full spec.

`pi-agent-forge` ships with session-observer built in. Every session accumulates signals. Every session end produces a report. Cumulative patterns feed back into `/make:agent` suggestions.

The improvement loop:
```
build agent (/make:agent)
    → use it in sessions (observer watches)
    → session ends (evaluator synthesises)
    → patterns emerge (improvements.md)
    → refine agent (/make:agent update <name>)
    → repeat
```

---

## Self-Eval Loop

After `/make:agent` creates an agent, optionally run:

```
/eval:agent <name> <sample-task>
```

Spawns two subagents:
1. **Worker** — runs the agent against the sample task
2. **Evaluator** — scores the output, suggests prompt improvements

If score < 7, suggests specific changes. You approve, the file is updated.

---

## Justfile Integration

`pi-agent-forge` generates a `justfile` entry for every new configuration:

```makefile
# Auto-generated by pi-agent-forge

# Daily development
dev:
    pi -e .pi/extensions/safety/damage-control.ts \
       -e .pi/extensions/ui/my-footer.ts \
       -e .pi/extensions/ui/tool-counter.ts

# Focused feature work
focus:
    pi -e .pi/extensions/gates/session-gate.ts \
       -e .pi/extensions/workflows/tilldone.ts \
       -e .pi/extensions/ui/pure-focus.ts

# Multi-agent pipeline
team:
    pi -e .pi/extensions/workflows/agent-chain.ts \
       -e .pi/extensions/workflows/subagent-widget.ts \
       -e .pi/extensions/ui/minimal.ts
```

---

## Implementation Plan

### Phase 1 — Scaffolding (MVP)
- `/make:agent` wizard with 7-question template
- `/make:extension` with hook selection
- Conventional folder structure enforced
- Basic justfile generation

### Phase 2 — Quality
- `/test:agent` structural + constraint tests
- `/eval:agent` self-eval loop
- Session observer integration

### Phase 3 — Intelligence
- Cross-session pattern recognition
- `/make:agent update` — refine existing agents from observer data
- Pi-Pi integration — use expert subagents to generate richer scaffolding

---

## Repo

`github.com/bernardjbs/pi-agent-forge`

Separate from `pi-agent-toolkit` — this is a framework for the community, not a personal portfolio.

---

## Related Specs
- `specs/session-observer.md` — the observer that feeds improvement data back
- `specs/agent-forge.md` — original evolutionary tooling concept (different scope)
