/**
 * AppExtensionProvider — Single entry point for all extensions
 *
 * Inspired by Laravel's AppServiceProvider — one file that boots
 * all registered extensions with the same Pi instance.
 *
 * Instead of juggling multiple -e flags:
 *   pi -e extensions/my-footer.ts -e extensions/session-observer.ts -e extensions/blog-writer.ts
 *
 * Just run:
 *   pi -e extensions/providers/AppExtensionProvider.ts
 *
 * To add or remove an extension, comment it in/out here.
 * Each extension remains a standalone file — this is just the wiring.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import myFooter from "../my-footer.js";
import sessionObserver from "../session-observer.js";
import blogWriter from "../blog-writer.js";
import progressTracker from "../progress-tracker.js";

export default function (pi: ExtensionAPI) {
    myFooter(pi);
    sessionObserver(pi);
    blogWriter(pi);
    progressTracker(pi);
}
