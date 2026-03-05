/**
 * My Footer — Model + context meter + git branch
 *
 * Extends minimal.ts with the current git branch in the footer.
 *
 * Usage: pi -e extensions/my-footer.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { applyExtensionDefaults } from "./themeMap.ts";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "child_process";
import path from "path/win32";

function getGitBranch(cwd: string): string {
	try {
		return execSync("git branch --show-current", { cwd }).toString().trim();
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model?.id || "no-model";
				const branch = getGitBranch(ctx.cwd);
				const dir = path.basename(ctx.cwd)
				const usage = ctx.getContextUsage();
				const pct = usage && usage.percent !== null ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				// Left: model + branch + dir (branch in accent colour if present)
				const modelPart = theme.fg("dim", ` ${model}`);
				const branchPart = branch ? theme.fg("accent", `  ${branch}`) : "";
				const dirPart = theme.fg("dim", `  ${dir}`);
				const left = modelPart + branchPart + dirPart;

				// Right: context bar
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);

				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
