import { Page } from "puppeteer";
import { ToolResultMessage, Type } from "@mariozechner/pi-ai";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions } from "./base";
import { InteractionConfig } from "../state";
import type { CursorExtension } from "../extensions/cursor";

interface ScreenshotToolParameter {
    debug?: boolean;
}

interface ScreenshotContext {
    page: Page;
    config: InteractionConfig;
    cursorExtension?: CursorExtension;
}

export class ScreenshotTool extends OcrTool<ScreenshotContext> {
    constructor(ctx: ScreenshotContext, options?: OcrToolOptions) {
        super(
            {
                name: "screenshot",
                description:
                    "Take a screenshot of the current viewport. Returns the screenshot along with information about the current scroll position and page dimensions. Use debug=true to show a coordinate grid and cursor position when you're having trouble finding interactive elements.",
                promptSnippet: "screenshot - Capture current viewport (debug mode for grid)",
                promptGuidelines:
                    "## screenshot tool\n" +
                    "- Take a screenshot to see current page state\n" +
                    "- Returns scroll position and viewport dimensions\n" +
                    "- `debug=true`: overlay coordinate grid to help find positions\n" +
                    "  - Shows recent cursor positions and click history\n" +
                    "  - Use when having trouble finding interactive elements\n" +
                    "- Use after actions that don't auto-provide screenshots\n" +
                    "- Check scroll percentage to know if more content exists below",
                parameters: Type.Object({
                    debug: Type.Optional(
                        Type.Boolean({
                            description:
                                "Show coordinate grid overlay with cursor position. Use this when stuck finding interactive elements.",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: ScreenshotToolParameter): Promise<ToolResultMessage> {
        context.updateUI?.({ message: this.getUserMessage(args.debug) });

        const viewInfo = await this.ctx.page.evaluate(() => {
            const scrollY = window.scrollY;
            const scrollX = window.scrollX;
            const viewportHeight = window.innerHeight;
            const viewportWidth = window.innerWidth;
            const documentHeight = document.documentElement.scrollHeight;
            const documentWidth = document.documentElement.scrollWidth;

            const scrollPercent = Math.round((scrollY / (documentHeight - viewportHeight)) * 100) || 0;
            const atTop = scrollY === 0;
            const atBottom = scrollY + viewportHeight >= documentHeight - 10;

            return {
                scrollY,
                scrollX,
                viewportHeight,
                viewportWidth,
                documentHeight,
                documentWidth,
                scrollPercent,
                atTop,
                atBottom,
            };
        });

        let message = `Screenshot captured.`;

        if (args.debug) {
            message += ` (debug mode with coordinate grid)`;
            const recentActions = (await this.ctx.cursorExtension?.getRecentHistory(5)) ?? [];
            if (recentActions.length > 0) {
                message += `\n\n**Recent cursor positions (relative to view):**`;
                for (const action of recentActions) {
                    message += `\n- ${action.type}: (${action.x.toFixed(2)}, ${action.y.toFixed(2)})`;
                }
            }
        }

        message += `\n\n**View Position:**`;
        message += `\n- Scroll: ${viewInfo.scrollPercent}% down (${viewInfo.scrollY}px of ${viewInfo.documentHeight - viewInfo.viewportHeight}px)`;
        message += `\n- Viewport: ${viewInfo.viewportWidth}x${viewInfo.viewportHeight}px`;
        message += `\n- Page: ${viewInfo.documentWidth}x${viewInfo.documentHeight}px`;

        if (viewInfo.atTop) {
            message += `\n- At top of page`;
        } else if (viewInfo.atBottom) {
            message += `\n- At bottom of page`;
        } else {
            message += `\n- In middle of page (can scroll up or down)`;
        }

        return this.screenshotPlaceholderSuccessMessage(context, message, args.debug ? "debug" : "raw");
    }

    private getUserMessage(debug?: boolean): string {
        if (debug) {
            return "Taking debug screenshot...";
        }

        return "Taking screenshot...";
    }
}
