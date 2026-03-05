import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
    let lastCheckpoint = "";

    pi.registerTool({
        name: "checkpoint",
        label: "Checkpoint",
        description: "You MUST call this before running any bash command. Log what you are about to do.",
        parameters: Type.Object({
            intent: Type.String({ description: "What you are about to do and why" })
        }),
        async execute(_id, params) {
            return {
                content: [{ type: "text", text: `Checkpoint logged: ${params.intent}` }],
                details: {},
            };
        }
    });

    pi.on("tool_call", async (event) => {
        // Set lastCheckpoint HERE (in tool_call), not in execute.
        // When the model calls checkpoint + bash in the same block, all tool_call
        // events fire before any execute runs — so execute is too late.
        if (event.toolName === "checkpoint") {
            lastCheckpoint = (event.input as { intent: string }).intent;
        }

        if (isToolCallEventType("bash", event) && !lastCheckpoint) {
            return { block: true, reason: "You must call checkpoint() before running bash commands." };
        }

        if (isToolCallEventType("bash", event)) {
            lastCheckpoint = ""; // reset so next bash needs a new checkpoint
        }
    });
}
