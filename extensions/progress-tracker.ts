/**
 * Progress Tracker — Session close prompt
 *
 * On session shutdown, prompts you to update PROGRESS.md if there
 * was meaningful activity. Opens the file in Pi's built-in editor
 * so you can jot down where you left off before closing.
 *
 * Keeps your resume context fresh without making it a manual habit.
 *
 * Usage: pi -e extensions/progress-tracker.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

export default function (pi: ExtensionAPI) {
    let turnCount = 0;

    pi.on("turn_end", async () => {
        turnCount++;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        // Only prompt if there was meaningful activity
        if (turnCount === 0) return;

        const progressPath = path.join(ctx.cwd, "PROGRESS.md");

        // Create PROGRESS.md if it doesn't exist
        if (!fs.existsSync(progressPath)) {
            fs.writeFileSync(
                progressPath,
                `# Progress\n\n## Where I left off\n\n- \n\n## Next steps\n\n- \n`,
                "utf8"
            );
        }

        const confirmed = await ctx.ui.confirm(
            "📋 Update PROGRESS.md?",
            "Jot down where you left off before closing."
        );

        if (confirmed) {
            const current = fs.readFileSync(progressPath, "utf8");
            const updated = await ctx.ui.editor("📋 PROGRESS.md", current);
            if (updated != null && updated !== current) {
                fs.writeFileSync(progressPath, updated, "utf8");
                ctx.ui.notify("📋 PROGRESS.md updated.", "info");
            }
        }
    });
}
