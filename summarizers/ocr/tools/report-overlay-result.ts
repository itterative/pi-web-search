import { Type } from "@mariozechner/pi-ai";

import { OcrTool, type OcrToolExecutionContext } from "./base";

/**
 * Tool definition for reporting overlay handling results.
 *
 * This is the handling-mode variant of dismiss-overlay. It replaces the normal
 * DismissOverlayTool during overlay handling mode via the OverlayExtension's
 * onFilterTools/onFilterExecutionTools hooks.
 *
 * Only visible when the overlay extension is in handling mode. The model sees
 * only `status` and `message` parameters — no `description` — which prevents
 * misuse outside handling mode.
 *
 * The actual execution is handled by OverlayExtension.onToolCall,
 * which intercepts this tool call.
 */
export class ReportOverlayResultTool extends OcrTool<Record<string, never>> {
    constructor() {
        super(
            {
                name: "dismiss-overlay",
                description:
                    "Report the result of overlay handling. " +
                    "Call with status='success' when the overlay is gone. " +
                    "Call with status='failure' if it cannot be dismissed.",
                parameters: Type.Object({
                    status: Type.Union([Type.Literal("success"), Type.Literal("failure")], {
                        description: "Report whether the overlay was dismissed.",
                    }),
                    message: Type.Optional(
                        Type.String({
                            description: "Explanation of the result",
                        }),
                    ),
                }),
                promptSnippet: "dismiss-overlay - Report overlay handling result (success/failure).",
                promptGuidelines:
                    "## dismiss-overlay tool\n" +
                    "- Call with status='success' when the overlay is gone and main content is visible\n" +
                    "- Call with status='failure' if the overlay cannot be dismissed\n" +
                    "- Always include a message explaining what happened",
            },
            {},
        );
    }

    async execute(_context: OcrToolExecutionContext): Promise<never> {
        throw new Error("report-overlay-result tool was not intercepted by OverlayExtension");
    }
}
