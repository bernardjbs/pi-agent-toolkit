/**
 * Session Observer — Silent workflow analyst
 *
 * Watches an entire Pi session for workflow signals:
 * corrections, tool excess, scope drift, reprompts.
 *
 * At session end, a Sonnet subagent synthesises the signals into
 * actionable agent improvement suggestions.
 *
 * Reports saved to .pi/observer/sessions/<date>.md
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

interface PainPoint {
    issue: string;
    rootCause: string;
    fix: string;
    target: string;
}

interface EvaluationResult {
    efficiency: number;
    painPoints: PainPoint[];
    summary: string;
}

interface AgentDispatch {
    agent: string;
    task: string;
    startTime: number;
    endTime?: number;
    durationMs?: number;
    toolCallId: string;
}

interface SessionSignals {
    corrections: Correction[];
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
    // Subagent dispatch tracking
    dispatches: AgentDispatch[];
    dispatchCountByAgent: Record<string, number>;
    dispatchDurationByAgent: Record<string, number>; // total ms per agent
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
- Tool usage patterns (excessive tool use = poor orientation or indecision)
- Turn counts (high turns for simple tasks = poor task decomposition)
- Files touched (scope drift = agent edited unrelated files)
- Reprompts (user sent multiple messages without agent acting)
- Agent dispatches (which subagents were called and how long they took)

Your job:
1. Identify pain points from the signals (if any)
2. Determine root cause for each
3. Suggest ONE specific, actionable fix per pain point — exact text to add/change in a system prompt
4. Rate overall session efficiency (1-10)

Be direct. Prioritise signal over noise. One correction might be nothing.
Three corrections on the same type of task = a pattern worth fixing.
If signals are low and the session was efficient, return an empty painPoints array.

You MUST respond with valid JSON only — no markdown, no explanation outside the JSON:

{
  "efficiency": 8,
  "painPoints": [
    {
      "issue": "Agent read 23 files before acting",
      "rootCause": "No codebase orientation in system prompt",
      "fix": "Add to system prompt: 'Before reading files, ask the user which directory or file is most relevant to the task.'",
      "target": "system prompt or agent name if known"
    }
  ],
  "summary": "2-3 sentence plain English summary. Empty string if session was clean."
}`;

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
    lines.push(``);

    if (signals.dispatches.length > 0) {
        lines.push(`### Agent Dispatches (${signals.dispatches.length})`);
        // Summary by agent
        Object.entries(signals.dispatchCountByAgent).forEach(([agent, count]) => {
            const totalMs = signals.dispatchDurationByAgent[agent] ?? 0;
            const avgMs = Math.round(totalMs / count);
            lines.push(`- **${agent}**: called ${count}x — avg ${formatDuration(avgMs)} per call`);
        });
        lines.push(``);
        // Individual dispatches
        signals.dispatches.forEach((d, i) => {
            const dur = d.durationMs ? ` (${formatDuration(d.durationMs)})` : "";
            lines.push(`${i + 1}. \`${d.agent}\`${dur} — "${d.task.slice(0, 80)}"`);
        });
    }

    return lines.join("\n");
}

async function runEvaluator(signals: SessionSignals, ctx: ExtensionContext): Promise<EvaluationResult> {
    const fallback: EvaluationResult = { efficiency: 10, painPoints: [], summary: "" };

    try {
        const loader = new DefaultResourceLoader({
            systemPromptOverride: () => EVALUATOR_SYSTEM_PROMPT,
            appendSystemPromptOverride: () => [],
        });
        await loader.reload();

        const { session } = await createAgentSession({
            cwd: ctx.cwd,
            model: ctx.model ?? undefined,
            tools: [],
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
        });

        const signalJson = JSON.stringify({
            corrections: signals.corrections,
            toolCounts: signals.toolCounts,
            toolExcess: signals.toolExcess,
            turnCount: signals.turnCount,
            firstUserMessage: signals.firstUserMessage,
            filesRead: signals.filesRead.length,
            filesEdited: signals.filesEdited,
            duration: formatDuration(signals.endTime - signals.startTime),
            repromptCount: signals.repromptCount,
            totalCost: signals.totalCost,
            agentDispatches: signals.dispatches.length > 0 ? {
                total: signals.dispatches.length,
                byAgent: signals.dispatchCountByAgent,
                durationByAgent: Object.fromEntries(
                    Object.entries(signals.dispatchDurationByAgent).map(
                        ([agent, ms]) => [agent, formatDuration(ms)]
                    )
                ),
            } : null,
        }, null, 2);

        await session.prompt(
            `Analyse this Pi coding session.\n\nSession data:\n\`\`\`json\n${signalJson}\n\`\`\``
        );

        // Extract last assistant message
        let raw = "";
        for (const entry of session.sessionManager.getBranch()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                const msg = entry.message as AssistantMessage;
                for (const block of msg.content) {
                    if (block.type === "text") raw = block.text;
                }
            }
        }

        if (!raw) return fallback;

        // Strip markdown code fences if model wrapped JSON in them
        const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
        return JSON.parse(cleaned) as EvaluationResult;

    } catch (err) {
        // Return fallback silently — don't crash the session shutdown
        return fallback;
    }
}

function writeReport(
    signals: SessionSignals,
    evaluation: EvaluationResult,
    observerDir: string
) {
    const sessionsDir = path.join(observerDir, "sessions");
    ensureDir(sessionsDir);

    const filename = `${formatFilename(signals.startTime)}.md`;
    const filepath = path.join(sessionsDir, filename);

    const evalLines = [
        `## Evaluation`,
        ``,
        `**Efficiency:** ${evaluation.efficiency}/10`,
        ``,
    ];

    if (evaluation.painPoints.length === 0) {
        evalLines.push(`No significant pain points detected.`);
    } else {
        evaluation.painPoints.forEach((p, i) => {
            evalLines.push(`### Pain Point ${i + 1}: ${p.issue}`);
            evalLines.push(`- **Root cause:** ${p.rootCause}`);
            evalLines.push(`- **Target:** ${p.target}`);
            evalLines.push(`- **Suggested fix:** ${p.fix}`);
            evalLines.push(``);
        });
    }

    if (evaluation.summary) {
        evalLines.push(`---`);
        evalLines.push(``);
        evalLines.push(`**Summary:** ${evaluation.summary}`);
    }

    const content = [
        `# Session Report — ${formatDate(signals.startTime)}`,
        ``,
        buildSignalSummary(signals),
        ``,
        `---`,
        ``,
        ...evalLines,
    ].join("\n");

    fs.writeFileSync(filepath, content, "utf8");
    return filepath;
}

async function generateReport(
    signals: SessionSignals,
    ctx: ExtensionContext
): Promise<{ reportPath: string; evaluation: EvaluationResult }> {
    const observerDir = path.join(ctx.cwd, ".pi", "observer");
    ensureDir(observerDir);

    ctx.ui.notify("👁 Analysing session...", "info");

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

    return { reportPath, evaluation };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function agentFilePath(cwd: string, target: string): string | null {
    // Try to resolve a target like "scout" → .pi/agents/scout.md
    const candidates = [
        path.join(cwd, ".pi", "agents", `${target}.md`),
        path.join(cwd, ".pi", "agents", target),
    ];
    return candidates.find(p => fs.existsSync(p)) ?? null;
}

function buildDiff(filePath: string | null, fix: string): string {
    if (!filePath || !fs.existsSync(filePath)) {
        return `[New content to add to system prompt]\n+ ${fix}`;
    }
    const current = fs.readFileSync(filePath, "utf8");
    return `File: ${filePath}\n\nCurrent (last 5 lines):\n${current.split("\n").slice(-5).map(l => `  ${l}`).join("\n")}\n\nWill append:\n+ ${fix}`;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let lastEvaluation: EvaluationResult | null = null;
    const emptySignals = (): SessionSignals => ({
        corrections: [],
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
        dispatches: [],
        dispatchCountByAgent: {},
        dispatchDurationByAgent: {},
    });

    let signals: SessionSignals = emptySignals();

    // Track in-flight dispatches by toolCallId → start time
    const inFlightDispatches = new Map<string, { agent: string; task: string; startTime: number }>();

    let currentTurn = 0;
    let toolCalledThisTurn = false;

    function resetSignals() {
        signals = emptySignals();
        inFlightDispatches.clear();
        currentTurn = 0;
        toolCalledThisTurn = false;
    }

    function updateStatus(ctx: ExtensionContext) {
        const parts = [];
        if (signals.corrections.length > 0) parts.push(`${signals.corrections.length} corrections`);

        const topTool = Object.entries(signals.toolCounts).sort(([, a], [, b]) => b - a)[0];
        if (topTool) parts.push(`${topTool[0]}:${topTool[1]}`);
        if (signals.dispatches.length > 0) parts.push(`${signals.dispatches.length} dispatches`);

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

        // Track agent dispatches (dispatch_agent or query_experts)
        if (event.toolName === "dispatch_agent") {
            const input = event.input as { agent: string; task: string };
            inFlightDispatches.set(event.toolCallId, {
                agent: input.agent,
                task: input.task,
                startTime: Date.now(),
            });
        }

        if (event.toolName === "query_experts") {
            const input = event.input as { queries: { expert: string; question: string }[] };
            // query_experts dispatches multiple in parallel — track each
            (input.queries ?? []).forEach((q, i) => {
                inFlightDispatches.set(`${event.toolCallId}-${i}`, {
                    agent: q.expert,
                    task: q.question,
                    startTime: Date.now(),
                });
            });
        }

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

        // Resolve in-flight dispatch_agent
        if (event.toolName === "dispatch_agent") {
            const inflight = inFlightDispatches.get(event.toolCallId);
            if (inflight) {
                const durationMs = Date.now() - inflight.startTime;
                const dispatch: AgentDispatch = {
                    ...inflight,
                    endTime: Date.now(),
                    durationMs,
                    toolCallId: event.toolCallId,
                };
                signals.dispatches.push(dispatch);
                signals.dispatchCountByAgent[inflight.agent] =
                    (signals.dispatchCountByAgent[inflight.agent] || 0) + 1;
                signals.dispatchDurationByAgent[inflight.agent] =
                    (signals.dispatchDurationByAgent[inflight.agent] || 0) + durationMs;
                inFlightDispatches.delete(event.toolCallId);
            }
        }

        // Resolve in-flight query_experts (parallel — match by prefix)
        if (event.toolName === "query_experts") {
            const keys = Array.from(inFlightDispatches.keys())
                .filter(k => k.startsWith(event.toolCallId));
            keys.forEach(key => {
                const inflight = inFlightDispatches.get(key)!;
                const durationMs = Date.now() - inflight.startTime;
                signals.dispatches.push({
                    ...inflight,
                    endTime: Date.now(),
                    durationMs,
                    toolCallId: key,
                });
                signals.dispatchCountByAgent[inflight.agent] =
                    (signals.dispatchCountByAgent[inflight.agent] || 0) + 1;
                signals.dispatchDurationByAgent[inflight.agent] =
                    (signals.dispatchDurationByAgent[inflight.agent] || 0) + durationMs;
                inFlightDispatches.delete(key);
            });
        }

        updateStatus(ctx);
    });

    // ── session_shutdown ──────────────────────────────────────────────────────
    pi.on("session_shutdown", async (_event, ctx) => {
        if (signals.turnCount === 0) return;

        try {
            const { evaluation } = await generateReport(signals, ctx);
            lastEvaluation = evaluation;

            if (evaluation.painPoints.length === 0) {
                // Clean session — stay silent
                return;
            }

            // Surface pain points
            const top = evaluation.painPoints[0];
            const more = evaluation.painPoints.length > 1
                ? ` (+${evaluation.painPoints.length - 1} more)`
                : "";

            ctx.ui.notify(
                `👁 Pain point detected${more}: ${top.issue}\nRun /observer fix to see suggestions`,
                "warning"
            );
        } catch (err) {
            ctx.ui.notify(`👁 Observer error: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
    });

    // ── Commands ──────────────────────────────────────────────────────────────

    pi.registerCommand("observer", {
        description: "Session observer: fix | report | clear | history",
        handler: async (args, ctx) => {
            const cmd = (args ?? "").trim();

            // ── fix ───────────────────────────────────────────────────────────
            if (cmd === "fix") {
                if (!lastEvaluation) {
                    ctx.ui.notify("No evaluation available. Run a session first.", "warning");
                    return;
                }

                if (lastEvaluation.painPoints.length === 0) {
                    ctx.ui.notify("👁 No pain points to fix — session was clean.", "info");
                    return;
                }

                // Walk through each pain point
                for (const point of lastEvaluation.painPoints) {
                    const agentFile = agentFilePath(ctx.cwd, point.target);
                    const diff = buildDiff(agentFile, point.fix);

                    const confirmed = await ctx.ui.confirm(
                        `👁 Pain Point: ${point.issue}`,
                        `Root cause: ${point.rootCause}\n\n${diff}\n\nApply this fix?`
                    );

                    if (confirmed) {
                        if (agentFile && fs.existsSync(agentFile)) {
                            // Append fix to existing agent file
                            fs.appendFileSync(agentFile, `\n\n## Observer Suggestion\n${point.fix}\n`, "utf8");
                            ctx.ui.notify(`✅ Applied to ${path.basename(agentFile)}`, "info");
                        } else if (agentFile === null) {
                            // No agent loaded — suggest creating one
                            ctx.ui.notify(
                                `No agent file found for "${point.target}".\nConsider creating .pi/agents/${point.target}.md with this instruction:\n${point.fix}`,
                                "info"
                            );
                        }
                    }
                }

            // ── report ────────────────────────────────────────────────────────
            } else if (cmd === "report") {
                if (signals.turnCount === 0) {
                    ctx.ui.notify("No activity to report yet.", "warning");
                    return;
                }
                const { reportPath, evaluation } = await generateReport({ ...signals }, ctx);
                lastEvaluation = evaluation;
                ctx.ui.notify(`👁 Report saved: ${reportPath}`);

            // ── clear ─────────────────────────────────────────────────────────
            } else if (cmd === "clear") {
                resetSignals();
                lastEvaluation = null;
                signals.model = ctx.model?.id ?? "unknown";
                ctx.ui.notify("👁 Observer signals cleared.", "info");
                updateStatus(ctx);

            // ── history ───────────────────────────────────────────────────────
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
                ctx.ui.notify("Usage: /observer fix | /observer report | /observer clear | /observer history", "info");
            }
        }
    });
}
