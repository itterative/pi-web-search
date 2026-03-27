import { Type } from "@mariozechner/pi-ai";

import { OcrTool, type OcrToolExecutionContext } from "./base";

/**
 * Tool definition for dismiss-overlay.
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
                    "Call WITHOUT status to start handling. Call WITH status to report result.",
                parameters: Type.Object({
                    description: Type.Optional(
                        Type.String({
                            description: "Description of the overlay you see",
                        }),
                    ),
                    status: Type.Optional(
                        Type.Union([Type.Literal("success"), Type.Literal("failure")], {
                            description:
                                "Report the result of overlay handling. Use after you have finished handling the overlay.",
                        }),
                    ),
                    message: Type.Optional(
                        Type.String({
                            description: "Optional explanation of the result",
                        }),
                    ),
                }),
                promptSnippet:
                    "dismiss-overlay - Dismiss a popup, cookie banner, captcha, or other overlay blocking the page. " +
                    "Call without status to start, call with status='success'/'failure' to report result.",
                promptGuidelines:
                    "## dismiss-overlay tool\n" +
                    "- Call WITHOUT status when you see an overlay to enter handling mode\n" +
                    "- You will receive a screenshot and can use your normal tools (click, cursor, screenshot, wait) to dismiss the overlay\n" +
                    "- Call WITH status='success' when the overlay is gone and the main content is visible\n" +
                    "- Call WITH status='failure' if the overlay cannot be dismissed\n" +
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
