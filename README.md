# pi-agent-toolkit

A curated collection of [Pi](https://shittycodingagent.ai) extensions, agent patterns, and workflow tools — built through hands-on exploration of the Pi agent extension API.

> Pi is a minimal terminal coding agent. Unlike closed tools, Pi exposes its entire agent loop — input hooks, tool interception, UI control, subagents — as a TypeScript extension API. This repo is what I built while learning that API.

---

## Extensions

### `my-footer.ts` — Custom Footer
Replaces Pi's default footer with a two-part display: model name + git branch in accent colour on the left, 10-block context meter on the right.

**Concepts:** `setFooter`, `theme.fg()`, `ctx.getContextUsage()`, `visibleWidth`, `truncateToWidth`

```bash
pi -e extensions/my-footer.ts
```

---

### `my-gate.ts` — Session Gate
Asks "Which feature are you working on today?" before the session starts. Injects the answer into the system prompt on every turn. Blocks all input until the question is answered. Shows the active feature in the footer status.

**Concepts:** `session_start` void pattern, `before_agent_start` dynamic system prompt, `input` hook with `action: handled/continue`, `setStatus` with theme colours

```bash
pi -e extensions/my-gate.ts
```

---

### `my-checkpoint.ts` — Bash Checkpoint Gate
Requires the agent to call a `checkpoint` tool and log its intent before every bash command. If checkpoint is skipped, bash is blocked.

**Concepts:** `pi.registerTool()`, `tool_call` interception, parallel tool call timing (tool_call fires before execute), `block: true`

```bash
pi -e extensions/my-checkpoint.ts
```

---

## Specs

Work-in-progress designs for extensions not yet built.

### `specs/session-observer.md`
A silent observer that watches an entire Pi session for workflow signals — course corrections, aborts, tool excess, scope drift — and at session end uses a Sonnet subagent to synthesise actionable agent improvement suggestions.

**Why it matters:** Self-eval scores the answer. The observer watches your behaviour — reprompts, aborts, corrections — which is the real ground truth for whether the agent is working well.

### `specs/pi-agent-forge.md`
A framework that brings Laravel's developer experience to Pi — convention over configuration, `/make:agent` scaffolding wizard, agent anatomy template, session observer integration, and self-eval loop.

---

## Key Concepts Learned

### The Pi event loop
```
user input
    → input hook (gate/transform/block)
    → before_agent_start (inject system prompt)
    → model thinks
    → tool_call (intercept/block before tool runs)
    → tool executes
    → tool_result (observe after tool completes)
    → model responds
```

Every stage is hookable. You control what the model sees, what tools it can run, and what the UI shows.

### Critical: tool_call fires before execute
When the model calls multiple tools in one response block, **all `tool_call` events fire before any `execute` runs**. State you need for blocking decisions must be set in `tool_call`, not `execute`.

```typescript
// ❌ Wrong — execute runs too late for blocking decisions
pi.registerTool({ name: "checkpoint", execute: async (_, params) => {
    lastCheckpoint = params.intent; // bash tool_call already fired
}});

// ✅ Correct — set state in tool_call
pi.on("tool_call", async (event) => {
    if (event.toolName === "checkpoint") {
        lastCheckpoint = (event.input as { intent: string }).intent;
    }
});
```

### session_start async pattern
Awaiting inside `session_start` prevents the session from completing startup. Use `void` to fire async work without blocking:

```typescript
// ❌ Blocks session startup
pi.on("session_start", async (_event, ctx) => {
    feature = await ctx.ui.input("Which feature?", "");
});

// ✅ Fires without blocking
pi.on("session_start", async (_event, ctx) => {
    void (async () => {
        feature = await ctx.ui.input("Which feature?", "");
        ctx.ui.setStatus("gate", ctx.ui.theme.fg("accent", feature));
    })();
});
```

### registerTool signature
```typescript
pi.registerTool({
    name: "my_tool",
    label: "My Tool",        // required by type
    description: "...",
    parameters: Type.Object({ ... }),
    async execute(_id, params) {
        return {
            content: [{ type: "text", text: "result" }],
            details: {},     // required by type
        };
    }
});
```

---

## Pi vs Claude Code

The extensions in this repo cannot be built for Claude Code. Claude Code is a closed binary — its agent loop is not accessible.

| Pi capability | Claude Code |
|--------------|-------------|
| Intercept + block any tool call | ❌ |
| Dynamic system prompt per turn | ❌ |
| Custom footer / widgets | ❌ |
| Block user input programmatically | ❌ |
| Spawn subagent sessions | ❌ |

Pi requires you to build what you want. The payoff is complete control over the agent loop.

---

## LLM Security Insight

The mental model from Pi's damage control (`tool_call` interception → enforce at the handler) maps directly to securing AI features in production SaaS:

> **The model is an untrusted client.** Treat every tool call like an HTTP request — authenticate and authorise at the handler, not at the prompt.

For Laravel developers: the LLM touches your controllers/services. Your Policies, Middleware, and Global Scopes fire as normal. You don't need a new permission system — treat the LLM like any other authenticated HTTP client.

---

## Related Projects

- **[pi-agent-forge](https://github.com/bernardjbs/pi-agent-forge)** *(coming soon)* — Laravel-style scaffolding framework for Pi agents

---

## Setup

```bash
# Install Pi globally
npm install -g @mariozechner/pi-coding-agent

# Install types locally for editor support
npm install @mariozechner/pi-coding-agent

# Run an extension
pi -e extensions/my-footer.ts
```

---

## Author

[bernardjbs](https://github.com/bernardjbs)
