import { Type } from "@mariozechner/pi-ai";

import { OcrTool, type OcrToolExecutionContext } from "./base";

/**
 * Tool definition for dismiss-overlay (idle-mode variant).
 *
 * This variant is visible in the main conversation (idle mode). It only exposes
 * a `description` parameter for entering overlay handling mode.
 *
 * During handling mode, the OverlayExtension replaces this tool with
 * ReportOverlayResultTool via onFilterTools/onFilterExecutionTools hooks.
 * The report variant exposes `status`/`message` instead.
 *
 * Both tools use the same name (`dismiss-overlay`). Only one is present in the
 * tool list at a time. This prevents the model from calling with `status`
 * outside handling mode — the parameter doesn't exist in the schema it sees.
 *
 * The actual execution is handled by OverlayExtension.onToolCall,
 * which intercepts this tool call. This class exists only to:
 * 1. Register the tool definition so the model knows about it
 * 2. Provide prompt snippet and guidelines for the system prompt
 */
export class DismissOverlayTool extends OcrTool<Record<string, never>> {
    constructor() {
        super(
            {
                name: "dismiss-overlay",
                description:
                    "Dismiss an overlay (cookie banner, captcha, age verification, etc.) blocking the page content. " +
                    "Call this when you see an overlay to enter handling mode.",
                parameters: Type.Object({
                    description: Type.Optional(
                        Type.String({
                            description: "Description of the overlay you see",
                        }),
                    ),
                }),
                promptSnippet:
                    "dismiss-overlay - Dismiss a popup, cookie banner, captcha, or other overlay blocking the page. " +
                    "Call to enter handling mode and receive tools for dismissing the overlay.",
                promptGuidelines:
                    "## dismiss-overlay tool\n" +
                    "- Call when you see an overlay (popup, cookie banner, captcha, etc.) blocking page content\n" +
                    "- You will receive a screenshot and can use your normal tools (click, cursor, screenshot, wait) to dismiss the overlay\n" +
                    "- When the overlay is gone, call dismiss-overlay with status='success'\n" +
                    "- If the overlay cannot be dismissed, call dismiss-overlay with status='failure'\n" +
                    "- If dismissal fails, summarize whatever content is visible\n" +
                    "- After successful dismissal, take a screenshot to verify before continuing your main task",
            },
            {},
        );
    }

    async execute(_context: OcrToolExecutionContext): Promise<never> {
        // This should never be called because OverlayExtension.onToolCall intercepts it.
        // But if somehow it is (e.g., overlay extension not registered), throw.
        throw new Error("dismiss-overlay tool was not intercepted by OverlayExtension");
    }
}
