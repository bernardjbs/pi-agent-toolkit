/**
 * Session Observer — Silent workflow analyst
 *
 * Watches a Pi session and collects technical workflow signals:
 * tool usage, file read/edit ratios, reprompts, dispatch patterns.
 *
 * Commands:
 *   /observer evaluate  — run evaluator, surface pain points
 *   /observer fix       — show diff + confirm + apply suggestions
 *   /observer report    — save full markdown report
 *   /observer clear     — reset signals
 *   /observer history   — list recent reports
 *
 * Usage: pi -e extensions/session-observer.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

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
    toolCounts: Record<string, number>;
    turnCount: number;
    firstUserMessage: string;
    filesRead: string[];
    filesEdited: string[];
    startTime: number;
    endTime: number;
    totalTokens: number;
    totalCost: number;
    model: string;
    repromptCount: number;
    consecutiveInputsWithoutToolCall: number;
    dispatches: AgentDispatch[];
    dispatchCountByAgent: Record<string, number>;
    dispatchDurationByAgent: Record<string, number>;
}

// Evaluator instructions live in .pi/agents/session-evaluator.md — not here.
// Extension = plumbing. Agent file = instructions.

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
    lines.push(`- **Reprompts:** ${signals.repromptCount}`);
    lines.push(`- **Model:** ${signals.model}`);
    lines.push(`- **Total cost:** $${signals.totalCost.toFixed(4)}`);
    lines.push(`- **Total tokens:** ${signals.totalTokens}`);
    lines.push(``);

    lines.push(`### Tool Usage`);
    const toolEntries = Object.entries(signals.toolCounts).sort(([, a], [, b]) => b - a);
    if (toolEntries.length === 0) {
        lines.push(`No tools called.`);
    } else {
        toolEntries.forEach(([name, count]) => lines.push(`- ${name}: ${count}`));
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

    if (signals.dispatches.length > 0) {
        lines.push(``);
        lines.push(`### Agent Dispatches (${signals.dispatches.length})`);
        Object.entries(signals.dispatchCountByAgent).forEach(([agent, count]) => {
            const totalMs = signals.dispatchDurationByAgent[agent] ?? 0;
            const avgMs = Math.round(totalMs / count);
            lines.push(`- **${agent}**: called ${count}x — avg ${formatDuration(avgMs)} per call`);
        });
        lines.push(``);
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
        // Load evaluator instructions from .pi/agents/session-evaluator.md
        // Extension = plumbing. Agent file = instructions.
        const agentFile = path.join(ctx.cwd, ".pi", "agents", "session-evaluator.md");
        const systemPrompt = fs.existsSync(agentFile)
            ? fs.readFileSync(agentFile, "utf8")
            : "You are a workflow analyst. Analyse session signals and return JSON with efficiency score and pain points.";

        const loader = new DefaultResourceLoader({
            cwd: ctx.cwd,
            systemPromptOverride: () => systemPrompt,
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
            toolCounts: signals.toolCounts,
            turnCount: signals.turnCount,
            repromptCount: signals.repromptCount,
            filesRead: signals.filesRead.length,
            filesEdited: signals.filesEdited.length,
            filesEditedList: signals.filesEdited,
            duration: formatDuration(signals.endTime - signals.startTime),
            totalCost: signals.totalCost,
            firstUserMessage: signals.firstUserMessage,
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
            `Analyse this Pi coding session for technical workflow inefficiencies.\n\nSession data:\n\`\`\`json\n${signalJson}\n\`\`\``
        );

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

        const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
        return JSON.parse(cleaned) as EvaluationResult;

    } catch {
        return fallback;
    }
}

function writeReport(signals: SessionSignals, evaluation: EvaluationResult, observerDir: string) {
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

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            const msg = entry.message as AssistantMessage;
            signals.totalTokens += (msg.usage?.input ?? 0) + (msg.usage?.output ?? 0);
            signals.totalCost += msg.usage?.cost?.total ?? 0;
        }
    }

    const evaluation = await runEvaluator(signals, ctx);
    const reportPath = writeReport(signals, evaluation, observerDir);

    return { reportPath, evaluation };
}

function agentFilePath(cwd: string, target: string): string | null {
    const candidates = [
        path.join(cwd, ".pi", "agents", `${target}.md`),
        path.join(cwd, ".pi", "agents", target),
    ];
    return candidates.find(p => fs.existsSync(p)) ?? null;
}

function buildDiff(filePath: string | null, fix: string): string {
    if (!filePath || !fs.existsSync(filePath)) {
        return `[New content — no existing agent file found for this target]\n+ ${fix}`;
    }
    const current = fs.readFileSync(filePath, "utf8");
    return `File: ${filePath}\n\nCurrent (last 5 lines):\n${current.split("\n").slice(-5).map(l => `  ${l}`).join("\n")}\n\nWill append:\n+ ${fix}`;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let lastEvaluation: EvaluationResult | null = null;

    const emptySignals = (): SessionSignals => ({
        toolCounts: {},
        turnCount: 0,
        firstUserMessage: "",
        filesRead: [],
        filesEdited: [],
        startTime: Date.now(),
        endTime: 0,
        totalTokens: 0,
        totalCost: 0,
        model: "",
        repromptCount: 0,
        consecutiveInputsWithoutToolCall: 0,
        dispatches: [],
        dispatchCountByAgent: {},
        dispatchDurationByAgent: {},
    });

    let signals: SessionSignals = emptySignals();
    const inFlightDispatches = new Map<string, { agent: string; task: string; startTime: number }>();

    let toolCalledThisTurn = false;

    function resetSignals() {
        signals = emptySignals();
        inFlightDispatches.clear();
        toolCalledThisTurn = false;
    }

    function updateStatus(ctx: ExtensionContext) {
        const parts: string[] = [];
        const topTool = Object.entries(signals.toolCounts).sort(([, a], [, b]) => b - a)[0];
        if (topTool) parts.push(`${topTool[0]}:${topTool[1]}`);
        if (signals.repromptCount > 0) parts.push(`reprompts:${signals.repromptCount}`);
        if (signals.dispatches.length > 0) parts.push(`dispatches:${signals.dispatches.length}`);

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
        if (!signals.firstUserMessage) {
            signals.firstUserMessage = event.text;
        }

        // Reprompt: user sent input without the agent calling any tool in the previous turn
        if (!toolCalledThisTurn && signals.turnCount > 0) {
            signals.consecutiveInputsWithoutToolCall++;
            if (signals.consecutiveInputsWithoutToolCall >= 2) {
                signals.repromptCount++;
                updateStatus(ctx);
            }
        } else {
            signals.consecutiveInputsWithoutToolCall = 0;
        }

        return { action: "continue" as const };
    });

    // ── turn_start ────────────────────────────────────────────────────────────
    pi.on("turn_start", async (_event) => {
        toolCalledThisTurn = false;
    });

    // ── turn_end ──────────────────────────────────────────────────────────────
    pi.on("turn_end", async (_event, ctx) => {
        signals.turnCount++;
        updateStatus(ctx);
    });

    // ── tool_call ─────────────────────────────────────────────────────────────
    pi.on("tool_call", async (event, _ctx) => {
        toolCalledThisTurn = true;

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
            (input.queries ?? []).forEach((q, i) => {
                inFlightDispatches.set(`${event.toolCallId}-${i}`, {
                    agent: q.expert,
                    task: q.question,
                    startTime: Date.now(),
                });
            });
        }

        if (isToolCallEventType("read", event)) {
            const filePath = event.input.path;
            if (!signals.filesRead.includes(filePath)) signals.filesRead.push(filePath);
        }

        if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
            const filePath = event.input.path;
            if (!signals.filesEdited.includes(filePath)) signals.filesEdited.push(filePath);
        }
    });

    // ── tool_execution_end ────────────────────────────────────────────────────
    pi.on("tool_execution_end", async (event, ctx) => {
        signals.toolCounts[event.toolName] = (signals.toolCounts[event.toolName] || 0) + 1;

        if (event.toolName === "dispatch_agent") {
            const inflight = inFlightDispatches.get(event.toolCallId);
            if (inflight) {
                const durationMs = Date.now() - inflight.startTime;
                signals.dispatches.push({ ...inflight, endTime: Date.now(), durationMs, toolCallId: event.toolCallId });
                signals.dispatchCountByAgent[inflight.agent] = (signals.dispatchCountByAgent[inflight.agent] || 0) + 1;
                signals.dispatchDurationByAgent[inflight.agent] = (signals.dispatchDurationByAgent[inflight.agent] || 0) + durationMs;
                inFlightDispatches.delete(event.toolCallId);
            }
        }

        if (event.toolName === "query_experts") {
            const keys = Array.from(inFlightDispatches.keys()).filter(k => k.startsWith(event.toolCallId));
            keys.forEach(key => {
                const inflight = inFlightDispatches.get(key)!;
                const durationMs = Date.now() - inflight.startTime;
                signals.dispatches.push({ ...inflight, endTime: Date.now(), durationMs, toolCallId: key });
                signals.dispatchCountByAgent[inflight.agent] = (signals.dispatchCountByAgent[inflight.agent] || 0) + 1;
                signals.dispatchDurationByAgent[inflight.agent] = (signals.dispatchDurationByAgent[inflight.agent] || 0) + durationMs;
                inFlightDispatches.delete(key);
            });
        }

        updateStatus(ctx);
    });

    // ── session_shutdown ──────────────────────────────────────────────────────
    pi.on("session_shutdown", async (_event, _ctx) => {
        // Evaluation is explicit via /observer evaluate — nothing on exit
    });

    // ── Commands ──────────────────────────────────────────────────────────────

    pi.registerCommand("observer", {
        description: "Session observer: evaluate | fix | report | clear | history",
        handler: async (args, ctx) => {
            const cmd = (args ?? "").trim();

            // ── evaluate ──────────────────────────────────────────────────────
            if (cmd === "evaluate") {
                if (signals.turnCount === 0) {
                    ctx.ui.notify("No activity to evaluate yet.", "warning");
                    return;
                }

                const { evaluation } = await generateReport({ ...signals }, ctx);
                lastEvaluation = evaluation;

                if (evaluation.painPoints.length === 0) {
                    ctx.ui.notify(`👁 Session efficiency: ${evaluation.efficiency}/10 — no pain points detected.`, "info");
                    return;
                }

                const top = evaluation.painPoints[0];
                const more = evaluation.painPoints.length > 1
                    ? ` (+${evaluation.painPoints.length - 1} more)`
                    : "";

                ctx.ui.notify(
                    `👁 Efficiency: ${evaluation.efficiency}/10 — Pain point${more}: ${top.issue}\nType /observer fix to apply suggestions`,
                    "warning"
                );

            // ── fix ───────────────────────────────────────────────────────────
            } else if (cmd === "fix") {
                if (!lastEvaluation) {
                    ctx.ui.notify("Run /observer evaluate first.", "warning");
                    return;
                }
                if (lastEvaluation.painPoints.length === 0) {
                    ctx.ui.notify("👁 No pain points to fix — session was clean.", "info");
                    return;
                }

                for (const point of lastEvaluation.painPoints) {
                    const agentFile = agentFilePath(ctx.cwd, point.target);
                    const diff = buildDiff(agentFile, point.fix);

                    const confirmed = await ctx.ui.confirm(
                        `👁 Pain Point: ${point.issue}`,
                        `Root cause: ${point.rootCause}\n\n${diff}\n\nApply this fix?`
                    );

                    if (confirmed) {
                        if (agentFile && fs.existsSync(agentFile)) {
                            fs.appendFileSync(agentFile, `\n\n## Observer Suggestion\n${point.fix}\n`, "utf8");
                            ctx.ui.notify(`✅ Applied to ${path.basename(agentFile)}`, "info");
                        } else {
                            ctx.ui.notify(
                                `No agent file found for "${point.target}".\nCreate .pi/agents/${point.target}.md with:\n${point.fix}`,
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

            // ── help ──────────────────────────────────────────────────────────
            } else if (cmd === "help" || cmd === "") {
                ctx.ui.notify(
                    `👁 Session Observer — commands:\n\n` +
                    `  /observer evaluate  — analyse session, surface pain points\n` +
                    `  /observer fix       — show diff + confirm + apply suggestions\n` +
                    `  /observer report    — save full markdown report to .pi/observer/sessions/\n` +
                    `  /observer clear     — reset all signals for this session\n` +
                    `  /observer history   — list last 5 session reports\n` +
                    `  /observer help      — show this message`,
                    "info"
                );
            } else {
                ctx.ui.notify(`Unknown command: /observer ${cmd}\nType /observer help for usage.`, "warning");
            }
        }
    });
}
