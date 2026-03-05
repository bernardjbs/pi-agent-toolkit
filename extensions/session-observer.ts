/**
 * Session Observer — Silent workflow analyst
 *
 * Watches an entire Pi session for workflow signals:
 * corrections, aborts, tool excess, scope drift, reprompts.
 *
 * At session end, a Sonnet subagent synthesises the signals into
 * actionable agent improvement suggestions.
 *
 * Reports saved to .pi/observer/sessions/<date>.md
 * Cumulative patterns saved to .pi/observer/improvements.md
 *
 * Usage: pi -e extensions/session-observer.ts
 * Commands: /observer report | /observer clear | /observer history
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Correction {
    turn: number;
    phrase: string;
    userMessage: string;
}

interface Abort {
    turn: number;
    toolName: string;
    toolInput: string;
}

interface SessionSignals {
    corrections: Correction[];
    aborts: Abort[];
    toolCounts: Record<string, number>;
    toolExcess: string[];
    turnCount: number;
    firstUserMessage: string;
    filesRead: string[];
    filesEdited: string[];
    startTime: number;
    endTime: number;
    totalTokens: number;
    totalCost: number;
    model: string;
    consecutiveInputsWithoutToolCall: number;
    repromptCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CORRECTION_PHRASES = [
    "no wait", "actually", "ignore that", "that's wrong",
    "not what i meant", "stop", "forget that", "wrong file",
    "no that's not", "let me rephrase", "i meant", "no,",
    "that's not right", "nevermind", "never mind",
];

const TOOL_THRESHOLDS: Record<string, number> = {
    read: 30,
    bash: 20,
    edit: 15,
    write: 10,
};

const EVALUATOR_SYSTEM_PROMPT = `You are a workflow analyst for an AI coding assistant.
You analyse session signals to identify pain points and suggest improvements.

You receive structured data about a session:
- Course corrections (user had to rephrase or redirect the agent)
- Aborts (agent went off track mid-turn)
- Tool usage patterns (excessive tool use = poor orientation or indecision)
- Turn counts (high turns for simple tasks = poor task decomposition)
- Files touched (scope drift = agent edited unrelated files)
- Reprompts (user sent multiple messages without agent acting)

Your job:
1. Identify the top 3 pain points from this session
2. Determine their root cause (bad system prompt? wrong tools? unclear scope?)
3. Suggest specific, actionable system prompt improvements
4. Rate overall session efficiency (1-10)

Be direct. Prioritise signal over noise. One correction might be nothing.
Three corrections on the same type of task = a pattern worth fixing.
If signals are low, say so — a good session deserves a high score.

Output format (use exactly these headings):
## Session Efficiency: X/10

## Pain Points
1. [pain point] — [root cause]
2. [pain point] — [root cause]
3. [pain point] — [root cause]

## Suggested System Prompt Improvements
1. Add: "[exact text to add to system prompt]"
2. Remove: "[what to remove]"
3. Change: "[what to change] → [new version]"

## Summary
[2-3 sentence plain English summary of this session's main issue]`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

function formatDate(ts: number): string {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function formatFilename(ts: number): string {
    return new Date(ts).toISOString().replace(/:/g, "-").slice(0, 16);
}

function buildSignalSummary(signals: SessionSignals): string {
    const lines: string[] = [];

    lines.push(`## Session Signals\n`);
    lines.push(`- **Duration:** ${formatDuration(signals.endTime - signals.startTime)}`);
    lines.push(`- **Turns:** ${signals.turnCount}`);
    lines.push(`- **Model:** ${signals.model}`);
    lines.push(`- **Total cost:** $${signals.totalCost.toFixed(4)}`);
    lines.push(`- **Total tokens:** ${signals.totalTokens}`);
    lines.push(``);

    lines.push(`### Corrections (${signals.corrections.length})`);
    if (signals.corrections.length === 0) {
        lines.push(`None detected.`);
    } else {
        signals.corrections.forEach((c, i) => {
            lines.push(`${i + 1}. Turn ${c.turn} — triggered by "${c.phrase}": "${c.userMessage.slice(0, 80)}"`);
        });
    }
    lines.push(``);

    lines.push(`### Aborts (${signals.aborts.length})`);
    if (signals.aborts.length === 0) {
        lines.push(`None detected.`);
    } else {
        signals.aborts.forEach((a, i) => {
            lines.push(`${i + 1}. Turn ${a.turn} — ${a.toolName}: "${a.toolInput.slice(0, 80)}"`);
        });
    }
    lines.push(``);

    lines.push(`### Tool Usage`);
    const toolEntries = Object.entries(signals.toolCounts).sort(([, a], [, b]) => b - a);
    if (toolEntries.length === 0) {
        lines.push(`No tools called.`);
    } else {
        toolEntries.forEach(([name, count]) => {
            const excess = signals.toolExcess.includes(name) ? " ⚠️ excess" : "";
            lines.push(`- ${name}: ${count}${excess}`);
        });
    }
    lines.push(``);

    lines.push(`### Files Touched`);
    lines.push(`- Read: ${signals.filesRead.length} files`);
    lines.push(`- Edited: ${signals.filesEdited.length} files`);
    if (signals.filesEdited.length > 0) {
        signals.filesEdited.slice(0, 10).forEach(f => lines.push(`  - ${f}`));
    }
    lines.push(``);

    lines.push(`### First User Message`);
    lines.push(`> ${signals.firstUserMessage.slice(0, 200)}`);

    return lines.join("\n");
}

async function runEvaluator(signals: SessionSignals, ctx: ExtensionContext): Promise<string> {
    try {
        const loader = new DefaultResourceLoader({
            systemPromptOverride: () => EVALUATOR_SYSTEM_PROMPT,
            appendSystemPromptOverride: () => [],
        });
        await loader.reload();

        const { session } = await createAgentSession({
            cwd: ctx.cwd,
            model: ctx.model ?? undefined,
            tools: [], // read-only evaluator — no tools needed
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
        });

        const signalJson = JSON.stringify({
            corrections: signals.corrections,
            aborts: signals.aborts,
            toolCounts: signals.toolCounts,
            toolExcess: signals.toolExcess,
            turnCount: signals.turnCount,
            firstUserMessage: signals.firstUserMessage,
            filesRead: signals.filesRead.length,
            filesEdited: signals.filesEdited,
            duration: formatDuration(signals.endTime - signals.startTime),
            repromptCount: signals.repromptCount,
            totalCost: signals.totalCost,
        }, null, 2);

        let result = "";
        await session.prompt(
            `Analyse this Pi coding session and provide improvement suggestions.\n\nSession data:\n\`\`\`json\n${signalJson}\n\`\`\``
        );

        // Extract the last assistant message
        const entries = session.sessionManager.getBranch();
        for (const entry of entries) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                const msg = entry.message as AssistantMessage;
                for (const block of msg.content) {
                    if (block.type === "text") {
                        result = block.text;
                    }
                }
            }
        }

        return result || "Evaluator returned no output.";
    } catch (err) {
        return `Evaluator failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

function writeReport(
    signals: SessionSignals,
    evaluation: string,
    observerDir: string
) {
    const sessionsDir = path.join(observerDir, "sessions");
    ensureDir(sessionsDir);

    const filename = `${formatFilename(signals.startTime)}.md`;
    const filepath = path.join(sessionsDir, filename);

    const content = [
        `# Session Report — ${formatDate(signals.startTime)}`,
        ``,
        buildSignalSummary(signals),
        ``,
        `---`,
        ``,
        `## Evaluation`,
        ``,
        evaluation,
    ].join("\n");

    fs.writeFileSync(filepath, content, "utf8");
    return filepath;
}

async function generateReport(signals: SessionSignals, ctx: ExtensionContext): Promise<string> {
    const observerDir = path.join(ctx.cwd, ".pi", "observer");
    ensureDir(observerDir);

    ctx.ui.notify("👁 Session Observer: Analysing session...", "info");

    signals.endTime = Date.now();

    // Accumulate token/cost from session
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            const msg = entry.message as AssistantMessage;
            signals.totalTokens += (msg.usage?.input ?? 0) + (msg.usage?.output ?? 0);
            signals.totalCost += msg.usage?.cost?.total ?? 0;
        }
    }

    // Check tool excess
    for (const [tool, count] of Object.entries(signals.toolCounts)) {
        if (TOOL_THRESHOLDS[tool] && count > TOOL_THRESHOLDS[tool]) {
            signals.toolExcess.push(tool);
        }
    }

    const evaluation = await runEvaluator(signals, ctx);
    const reportPath = writeReport(signals, evaluation, observerDir);

    return reportPath;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let signals: SessionSignals = {
        corrections: [],
        aborts: [],
        toolCounts: {},
        toolExcess: [],
        turnCount: 0,
        firstUserMessage: "",
        filesRead: [],
        filesEdited: [],
        startTime: Date.now(),
        endTime: 0,
        totalTokens: 0,
        totalCost: 0,
        model: "",
        consecutiveInputsWithoutToolCall: 0,
        repromptCount: 0,
    };

    let currentTurn = 0;
    let toolCalledThisTurn = false;

    function resetSignals() {
        signals = {
            corrections: [],
            aborts: [],
            toolCounts: {},
            toolExcess: [],
            turnCount: 0,
            firstUserMessage: "",
            filesRead: [],
            filesEdited: [],
            startTime: Date.now(),
            endTime: 0,
            totalTokens: 0,
            totalCost: 0,
            model: "",
            consecutiveInputsWithoutToolCall: 0,
            repromptCount: 0,
        };
        currentTurn = 0;
        toolCalledThisTurn = false;
    }

    function updateStatus(ctx: ExtensionContext) {
        const parts = [];
        if (signals.corrections.length > 0) parts.push(`${signals.corrections.length} corrections`);
        if (signals.aborts.length > 0) parts.push(`${signals.aborts.length} aborts`);
        const topTool = Object.entries(signals.toolCounts).sort(([, a], [, b]) => b - a)[0];
        if (topTool) parts.push(`${topTool[0]}:${topTool[1]}`);

        const text = parts.length > 0
            ? ctx.ui.theme.fg("dim", `👁 ${parts.join(" · ")}`)
            : ctx.ui.theme.fg("dim", "👁 observing");

        ctx.ui.setStatus("observer", text);
    }

    // ── session_start ──────────────────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        signals.model = ctx.model?.id ?? "unknown";
        signals.startTime = Date.now();
        updateStatus(ctx);
    });

    // ── input ─────────────────────────────────────────────────────────────────
    pi.on("input", async (event, ctx) => {
        const text = event.text.toLowerCase().trim();

        // Capture first user message
        if (!signals.firstUserMessage) {
            signals.firstUserMessage = event.text;
        }

        // Detect corrections
        for (const phrase of CORRECTION_PHRASES) {
            if (text.startsWith(phrase) || text.includes(` ${phrase}`)) {
                signals.corrections.push({
                    turn: currentTurn,
                    phrase,
                    userMessage: event.text,
                });
                updateStatus(ctx);
                break;
            }
        }

        // Detect reprompts — consecutive inputs without a tool call
        if (!toolCalledThisTurn && signals.turnCount > 0) {
            signals.consecutiveInputsWithoutToolCall++;
            if (signals.consecutiveInputsWithoutToolCall >= 2) {
                signals.repromptCount++;
            }
        } else {
            signals.consecutiveInputsWithoutToolCall = 0;
        }
        toolCalledThisTurn = false;

        return { action: "continue" as const };
    });

    // ── turn_start ────────────────────────────────────────────────────────────
    pi.on("turn_start", async (event) => {
        currentTurn = event.turnIndex;
        toolCalledThisTurn = false;
    });

    // ── turn_end ──────────────────────────────────────────────────────────────
    pi.on("turn_end", async (_event, ctx) => {
        signals.turnCount++;
        updateStatus(ctx);
    });

    // ── tool_call ─────────────────────────────────────────────────────────────
    pi.on("tool_call", async (event, ctx) => {
        toolCalledThisTurn = true;

        // Track aborts — if ctx.abort() was called previously this fires after
        // Track file scope
        if (isToolCallEventType("read", event)) {
            const filePath = event.input.path;
            if (!signals.filesRead.includes(filePath)) {
                signals.filesRead.push(filePath);
            }
        }

        if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
            const filePath = event.input.path;
            if (!signals.filesEdited.includes(filePath)) {
                signals.filesEdited.push(filePath);
            }
        }
    });

    // ── tool_execution_end ────────────────────────────────────────────────────
    pi.on("tool_execution_end", async (event, ctx) => {
        signals.toolCounts[event.toolName] = (signals.toolCounts[event.toolName] || 0) + 1;
        updateStatus(ctx);
    });

    // ── agent_end ─────────────────────────────────────────────────────────────
    // Fired when agent turn is aborted or ends
    pi.on("agent_end", async (event, ctx) => {
        // Check if any messages indicate an abort happened
        // We track this via tool_call interception by damage-control or similar
        // The agent_end fires even on normal completion, so we use it to
        // detect if the last tool was blocked
    });

    // ── session_shutdown ──────────────────────────────────────────────────────
    pi.on("session_shutdown", async (_event, ctx) => {
        // Only generate report if there was meaningful activity
        if (signals.turnCount === 0) return;

        try {
            const reportPath = await generateReport(signals, ctx);
            ctx.ui.notify(`👁 Observer report saved: ${path.basename(path.dirname(reportPath))}/${path.basename(reportPath)}`);
        } catch (err) {
            ctx.ui.notify(`👁 Observer failed to generate report: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
    });

    // ── Commands ──────────────────────────────────────────────────────────────

    pi.registerCommand("observer", {
        description: "Session observer controls: report | clear | history",
        handler: async (args, ctx) => {
            const cmd = (args ?? "").trim();

            if (cmd === "report") {
                if (signals.turnCount === 0) {
                    ctx.ui.notify("No activity to report yet.", "warning");
                    return;
                }
                const reportPath = await generateReport({ ...signals }, ctx);
                ctx.ui.notify(`👁 Report saved: ${reportPath}`);

            } else if (cmd === "clear") {
                resetSignals();
                signals.model = ctx.model?.id ?? "unknown";
                ctx.ui.notify("👁 Observer signals cleared.", "info");
                updateStatus(ctx);

            } else if (cmd === "history") {
                const sessionsDir = path.join(ctx.cwd, ".pi", "observer", "sessions");
                if (!fs.existsSync(sessionsDir)) {
                    ctx.ui.notify("No session reports yet.", "info");
                    return;
                }
                const files = fs.readdirSync(sessionsDir)
                    .filter(f => f.endsWith(".md"))
                    .sort()
                    .reverse()
                    .slice(0, 5);

                if (files.length === 0) {
                    ctx.ui.notify("No session reports yet.", "info");
                    return;
                }

                ctx.ui.notify(`Last ${files.length} sessions:\n${files.join("\n")}`, "info");

            } else {
                ctx.ui.notify("Usage: /observer report | /observer clear | /observer history", "info");
            }
        }
    });
}
