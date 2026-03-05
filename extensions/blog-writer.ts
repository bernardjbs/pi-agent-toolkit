/**
 * Blog Writer — Draft blog posts from SUMMARY.md sections
 *
 * Reads your learning journal (SUMMARY.md) and drafts polished blog posts
 * from any section using a subagent writer.
 *
 * Commands:
 *   /blog list           — list all draftable sections from SUMMARY.md
 *   /blog draft <topic>  — draft a blog post from the matching section
 *   /blog drafts         — list saved drafts
 *   /blog help           — show this help
 *
 * Drafts saved to: .pi/blog/drafts/<slug>.md
 *
 * Usage: pi -e extensions/blog-writer.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import * as fs from "fs";
import * as path from "path";

// ─── Writer prompt ────────────────────────────────────────────────────────────

const WRITER_SYSTEM_PROMPT = `You are a technical blogger writing for an audience of experienced developers.

Your style:
- Conversational but precise — write how a senior dev explains things to a peer
- No fluff, no "In this post we will..." intros — get straight to the point
- Use short paragraphs and code examples where relevant
- Concrete over abstract — show the thing, don't just describe it
- Honest — if something was confusing or took time to figure out, say so

You receive raw learning notes from a developer's journal. Your job is to turn them into a polished blog post that:
1. Opens with a hook — the key insight or surprising thing
2. Explains the concept clearly with concrete examples
3. Ends with a takeaway — what would you do differently, or what does this unlock

Format:
- Title as # heading
- Use ## for sections if needed
- Code blocks with language tags
- Keep it under 800 words unless the topic genuinely needs more

Do not add meta-commentary like "Here is the blog post:" — just write the post.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60);
}

interface Section {
    title: string;
    slug: string;
    content: string;
    lineStart: number;
}

function parseSections(summaryPath: string): Section[] {
    if (!fs.existsSync(summaryPath)) return [];

    const lines = fs.readFileSync(summaryPath, "utf8").split("\n");
    const sections: Section[] = [];
    let current: Section | null = null;
    let contentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^## (.+)$/);

        if (match) {
            if (current) {
                current.content = contentLines.join("\n").trim();
                sections.push(current);
            }
            current = {
                title: match[1],
                slug: slugify(match[1]),
                content: "",
                lineStart: i + 1,
            };
            contentLines = [];
        } else if (current) {
            contentLines.push(line);
        }
    }

    if (current) {
        current.content = contentLines.join("\n").trim();
        sections.push(current);
    }

    return sections;
}

function findSection(sections: Section[], query: string): Section | null {
    const q = query.toLowerCase();
    // Exact slug match first
    const exact = sections.find(s => s.slug === q);
    if (exact) return exact;
    // Partial title match
    return sections.find(s => s.title.toLowerCase().includes(q)) ?? null;
}

async function draftPost(
    section: Section,
    ctx: { cwd: string; model?: import("@mariozechner/pi-coding-agent").ExtensionContext["model"] }
): Promise<string> {
    const loader = new DefaultResourceLoader({
        systemPromptOverride: () => WRITER_SYSTEM_PROMPT,
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

    await session.prompt(
        `Write a blog post from these developer learning notes.\n\nSection: ${section.title}\n\n---\n\n${section.content}`
    );

    let result = "";
    for (const entry of session.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
            const msg = entry.message as AssistantMessage;
            for (const block of msg.content) {
                if (block.type === "text") result = block.text;
            }
        }
    }

    return result || "Writer returned no output.";
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let lastDraft: { title: string; slug: string; content: string } | null = null;
    let sourceFile: string | null = null; // set via /blog set <file>

    function resolveSourceFile(cwd: string): string {
        if (sourceFile) return sourceFile;
        // Default fallback
        return path.join(cwd, "SUMMARY.md");
    }

    pi.registerCommand("blog", {
        description: "Blog writer: set <file> | list | draft <topic> | drafts | help",
        handler: async (args, ctx) => {
            const input = (args ?? "").trim();
            const [cmd, ...rest] = input.split(/\s+/);
            const topic = rest.join(" ").trim();

            const summaryPath = resolveSourceFile(ctx.cwd);

            // ── set ───────────────────────────────────────────────────────────
            if (cmd === "set") {
                if (!topic) {
                    ctx.ui.notify("Usage: /blog set <path-to-file.md>", "warning");
                    return;
                }
                const resolved = path.isAbsolute(topic)
                    ? topic
                    : path.join(ctx.cwd, topic);

                if (!fs.existsSync(resolved)) {
                    ctx.ui.notify(`File not found: ${resolved}`, "warning");
                    return;
                }
                sourceFile = resolved;
                ctx.ui.notify(`📝 Source set to: ${resolved}`, "info");

            // ── list ──────────────────────────────────────────────────────────
            } else if (cmd === "list") {
                const sections = parseSections(summaryPath);
                if (sections.length === 0) {
                    ctx.ui.notify("No SUMMARY.md found or no ## sections in it.", "warning");
                    return;
                }
                const lines = sections.map((s, i) => `  ${String(i + 1).padStart(2)}. ${s.title}`);
                ctx.ui.notify(`📝 Draftable sections (${sections.length}):\n\n${lines.join("\n")}\n\nUse: /blog draft <title or number>`, "info");

            // ── draft ─────────────────────────────────────────────────────────
            } else if (cmd === "draft") {
                if (!topic) {
                    ctx.ui.notify("Usage: /blog draft <topic>\nRun /blog list to see available sections.", "warning");
                    return;
                }

                const sections = parseSections(summaryPath);
                if (sections.length === 0) {
                    ctx.ui.notify("No SUMMARY.md found.", "warning");
                    return;
                }

                // Support numeric index
                let section: Section | null = null;
                const num = parseInt(topic, 10);
                if (!isNaN(num) && num >= 1 && num <= sections.length) {
                    section = sections[num - 1];
                } else {
                    section = findSection(sections, topic);
                }

                if (!section) {
                    ctx.ui.notify(`No section found matching "${topic}".\nRun /blog list to see available sections.`, "warning");
                    return;
                }

                ctx.ui.notify(`📝 Drafting: "${section.title}"...`, "info");

                const draft = await draftPost(section, ctx);
                lastDraft = { title: section.title, slug: section.slug, content: draft };

                const draftsDir = path.join(ctx.cwd, ".pi", "blog", "drafts");
                ensureDir(draftsDir);
                const filepath = path.join(draftsDir, `${section.slug}.md`);
                fs.writeFileSync(filepath, draft, "utf8");

                // Open draft in editor — read full content, optionally refine inline
                const edited = await ctx.ui.editor(`📝 Draft: ${section.title}`, draft);
                const finalDraft = edited ?? draft;

                // Save (possibly edited) draft
                fs.writeFileSync(filepath, finalDraft, "utf8");
                ctx.ui.notify(`✅ Draft saved: .pi/blog/drafts/${section.slug}.md`, "info");

            // ── drafts ────────────────────────────────────────────────────────
            } else if (cmd === "drafts") {
                const draftsDir = path.join(ctx.cwd, ".pi", "blog", "drafts");
                if (!fs.existsSync(draftsDir)) {
                    ctx.ui.notify("No drafts yet. Run /blog draft <topic> to create one.", "info");
                    return;
                }
                const files = fs.readdirSync(draftsDir).filter(f => f.endsWith(".md")).sort();
                if (files.length === 0) {
                    ctx.ui.notify("No drafts yet.", "info");
                    return;
                }
                ctx.ui.notify(`📝 Saved drafts (${files.length}):\n\n${files.map(f => `  - ${f}`).join("\n")}`, "info");

            // ── help ──────────────────────────────────────────────────────────
            } else if (cmd === "help" || !cmd) {
                const current = sourceFile ?? path.join(ctx.cwd, "SUMMARY.md");
                ctx.ui.notify(
                    `📝 Blog Writer — commands:\n\n` +
                    `  /blog set <file>     — point to any markdown file as source\n` +
                    `  /blog list           — list all draftable ## sections in source file\n` +
                    `  /blog draft <topic>  — draft a post from the matching section\n` +
                    `  /blog draft <number> — draft by section number from /blog list\n` +
                    `  /blog drafts         — list saved drafts\n` +
                    `  /blog help           — show this message\n\n` +
                    `Current source: ${current}\n` +
                    `Drafts saved to: .pi/blog/drafts/<slug>.md`,
                    "info"
                );

            } else {
                ctx.ui.notify(`Unknown command: /blog ${cmd}\nType /blog help for usage.`, "warning");
            }
        },
    });
}
