/**
 * Feature Gate — Focus guard for Pi sessions
 *
 * Prompts for a feature name at session start and:
 * - Injects the feature context into every agent system prompt
 * - Blocks input until a feature is specified
 * - Shows the active feature in the status bar
 *
 * Usage: pi -e extensions/my-gate.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    let feature = "";

    pi.on("session_start", async (_event, ctx) => {
        void (async () => {
            feature = (await ctx.ui.input("Which feature are you working on today?", "e.g. login form")) ?? "";
            const theme = ctx.ui.theme;
            ctx.ui.setStatus("my-gate", theme.fg("accent", "⬡ ") + theme.fg("dim", `Working on: ${feature}`));
        })();
    });

    pi.on("before_agent_start", async (event, _ctx) => {
        if (!feature) {
            return { systemPrompt: event.systemPrompt + `\n\nNo feature specified.` };
        }
        return {
            systemPrompt: event.systemPrompt + `\n\nYou are helping implement: ${feature}`,
        };
    });

    pi.on("input", async (_event, ctx) => {
        if (!feature) {
            ctx.ui.notify("Please specify a feature to work on.", "warning");
            return { action: "handled" as const };
        }
        return { action: "continue" as const };
    });
}
