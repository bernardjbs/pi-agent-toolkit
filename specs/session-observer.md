# Specification: Session Observer

## Overview

A Pi extension that silently watches an entire session for workflow signals — reprompts, aborts, corrections, tool excess, scope drift — and at session end synthesises them into actionable agent improvement suggestions.

Unlike self-eval (agent scores its own output), the observer watches **your behaviour** as the ground truth. Your frustration, corrections and aborts don't lie.

---

## Core Concept

```
session runs
    → observer accumulates signals silently
    → session ends
    → evaluator subagent synthesises signals
    → report written to .pi/observer/sessions/<date>.md
    → summary appended to .pi/observer/improvements.md
```

---

## Signals to Track

### 1. Course corrections (input hook)
User phrases that indicate the agent went wrong:

```typescript
const CORRECTION_PHRASES = [
    "no wait", "actually", "ignore that", "no,", "that's wrong",
    "not what i meant", "stop", "forget that", "wrong file",
    "no that's not", "let me rephrase", "i meant"
];
```

Each correction = agent misunderstood intent.

### 2. Aborts (session event)
Every time `ctx.abort()` is called — agent went off track mid-turn.

### 3. Reprompts (input hook)
Consecutive inputs with similar intent (semantic similarity) before the agent succeeded. Requires keeping last N inputs and comparing.

Simple heuristic: user sends 3+ messages in a row without a tool call in between = agent not acting, just talking.

### 4. Tool excess (tool_execution_end)
Tools called more than threshold per session:
```typescript
const THRESHOLDS = {
    read: 30,   // reading too many files = poor orientation
    bash: 20,   // too many shell calls = inefficient
    edit: 15,   // too many edits = indecision
};
```

### 5. Turn count vs task complexity
High turn count for simple tasks = poor task decomposition or unclear system prompt.

Simple heuristic: track what the user asked in turn 1, count total turns. Flag if > 15 turns for a single-sentence request.

### 6. Scope drift (tool_call hook)
Files edited that are far from the initial task's scope. Track which files were read/edited and compare to files mentioned in the first user message.

### 7. Session metadata
- Total duration
- Total tokens used
- Total cost
- Models used

---

## Data Structure

```typescript
interface SessionSignals {
    // Corrections
    corrections: {
        turn: number;
        phrase: string;
        userMessage: string;
        agentLastOutput: string; // what triggered the correction
    }[];

    // Aborts
    aborts: {
        turn: number;
        toolName: string;
        toolInput: string;
    }[];

    // Tool usage
    toolCounts: Record<string, number>;
    toolExcess: string[]; // tools that exceeded threshold

    // Turns
    turnCount: number;
    firstUserMessage: string;

    // Files touched
    filesRead: string[];
    filesEdited: string[];

    // Metadata
    startTime: number;
    endTime: number;
    totalTokens: number;
    totalCost: number;
    model: string;

    // Raw conversation (last N turns for context)
    recentTurns: {
        role: "user" | "assistant";
        content: string;
        toolCalls?: string[];
    }[];
}
```

---

## Evaluator Subagent

At session end, spawn a Sonnet subagent with the signal log:

### System prompt
```markdown
You are a workflow analyst for an AI coding assistant. 
You analyse session signals to identify pain points and suggest improvements.

You receive structured data about a session:
- Course corrections (user had to rephrase or redirect)
- Aborts (agent went off track)
- Tool usage patterns
- Turn counts
- Files touched

Your job:
1. Identify the top 3 pain points from this session
2. Determine their root cause (bad system prompt? wrong tools? unclear scope?)
3. Suggest specific, actionable system prompt improvements
4. Rate overall session efficiency (1-10)

Be direct. Prioritise signal over noise. One correction might be nothing. 
Three corrections on the same type of task = a pattern worth fixing.

Output format:
## Session Efficiency: X/10

## Pain Points
1. [pain point] — [root cause]
2. ...
3. ...

## Suggested System Prompt Improvements
1. Add: "[exact text to add]"
2. Remove: "[what to remove]"
3. Change: "[what to change] → [new version]"

## Pattern (if seen before)
[note if this matches patterns from previous sessions]
```

---

## Output Files

### Per-session report
`.pi/observer/sessions/2026-03-03T19-45.md`
```markdown
# Session Report — 2026-03-03 19:45

**Duration:** 42 minutes  
**Turns:** 23  
**Cost:** $0.18  
**Model:** claude-sonnet-4-6

## Session Efficiency: 6/10

## Pain Points
1. Agent read 47 files before starting — no codebase orientation in system prompt
2. 3 course corrections around file scope — agent didn't confirm which files to touch
3. 2 aborts when agent tried to run docker commands — damage control working but agent keeps trying

## Suggested Improvements
1. Add: "Before reading files, ask the user which directory is most relevant"
2. Add: "Confirm the list of files you plan to edit before making any changes"
3. Remove: docker-related tool access from this agent's allowed tools

## Raw Signals
- Corrections: 3
- Aborts: 2  
- Tool excess: read (47), bash (22)
- Turn count: 23 for single-feature request
```

### Cumulative improvements log
`.pi/observer/improvements.md`
```markdown
# Agent Improvement Log

## Recurring patterns (seen 3+ sessions)
- Agent reads too many files before acting → needs orientation prompt
- Agent doesn't confirm scope → needs explicit scope-confirmation instruction

## Applied improvements
- [2026-03-03] Added file orientation prompt to scout.md
- [2026-03-03] Added scope confirmation to worker.md

## Pending (not yet applied)
- Docker tool removal from daily-dev config
```

---

## Extension Structure

File: `extensions/session-observer.ts`

### Hooks used
- `session_start` — initialise signal log, capture first user message
- `input` — detect correction phrases, track reprompts
- `tool_call` — track aborts, log tool inputs, detect scope drift
- `tool_execution_end` — count tool usage, check thresholds
- `turn_start` / `turn_end` — track turn count, capture recent turns
- `session_shutdown` — trigger evaluator subagent, write reports

### Widget (optional)
Small status indicator showing live signal counts:
```
👁 obs: 2 corrections · 1 abort · read:23
```
Updates in real time so you're aware signals are being collected.

### Commands
- `/observer report` — generate report for current session without ending it
- `/observer clear` — reset signals (useful if you started a new task mid-session)
- `/observer history` — show last 5 session reports

---

## Implementation Notes

### Sonnet is the right model for the evaluator because:
- Pattern recognition across structured data — Sonnet handles well
- Synthesis across multiple signal types — not just one output
- Cheap enough to run on every session end without cost concern
- Fast enough to not feel like it's blocking shutdown

### Privacy
Signal log contains your actual messages. Keep `.pi/observer/` in `.gitignore`.

### Threshold tuning
Start conservative — only flag genuine excess. False positives (flagging efficient sessions) erode trust in the tool faster than missed signals.

### Cross-session patterns
The real value emerges over 5–10 sessions. Single session reports are useful. Patterns across sessions are actionable.

---

## Justfile entry

```just
# Standard Pi with session observer
dev-observe:
    pi -e extensions/session-observer.ts \
       -e extensions/minimal.ts \
       -e extensions/damage-control.ts
```

---

## Future Extensions

- **Diff view** — show which files changed this session vs what the user originally asked about
- **Cost attribution** — which agent/task cost the most tokens
- **Comparison mode** — compare efficiency across different extension stacks
- **Auto-apply** — with user confirmation, directly edit agent .md files with suggested improvements
