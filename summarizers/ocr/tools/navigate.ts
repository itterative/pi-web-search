import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions, OcrToolValidationError } from "./base";
import { InteractionConfig } from "../state";

interface NavigateToolParameters {
    url?: string;
    delta?: number;
}

interface NavigateToolContext {
    page: Page;
    config: InteractionConfig;
    onPageChange?: () => Promise<void>;
}

export class NavigateTool extends OcrTool<NavigateToolContext> {
    constructor(ctx: NavigateToolContext, options?: OcrToolOptions) {
        super(
            {
                name: "navigate",
                description:
                    "Navigate to a URL or move through browser history. Use url to visit a new page, or use delta to go back/forward in history (e.g., -1 = back, 1 = forward, -2 = back two pages).",
                promptSnippet: "navigate - Go to URL or navigate history (back/forward)",
                promptGuidelines:
                    "## navigate tool\n" +
                    "- Navigate to new pages or go back/forward in browser history\n" +
                    '- `url`: navigate to a specific URL (e.g., "https://example.com")\n' +
                    "- `delta`: navigate history by offset\n" +
                    "  - `-1`: go back one page\n" +
                    "  - `1`: go forward one page\n" +
                    "  - `-2`: go back two pages\n" +
                    "  - `0`: reload current page\n" +
                    "- Use delta when you clicked a link and want to return to previous page\n" +
                    "- After navigation, a new screenshot is provided",
                parameters: Type.Object({
                    url: Type.Optional(
                        Type.String({
                            description: "The URL to navigate to (mutually exclusive with delta)",
                        }),
                    ),
                    delta: Type.Optional(
                        Type.Number({
                            description:
                                "History delta: negative to go back, positive to go forward (e.g., -1 = back, 1 = forward). Mutually exclusive with url.",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: NavigateToolParameters): Promise<ToolResultMessage> {
        const { url, delta } = args;

        // Validate that exactly one of url or delta is provided
        if (!url && delta === undefined) {
            throw new OcrToolValidationError("Either 'url' or 'delta' must be provided");
        }

        if (url && delta !== undefined) {
            throw new OcrToolValidationError("Provide either 'url' or 'delta', not both");
        }

        // Handle history navigation (delta)
        if (delta !== undefined) {
            return this.executeHistoryNavigation(context, delta);
        }

        // Handle URL navigation
        if (url !== undefined) {
            return this.executeUrlNavigation(context, url!);
        }

        throw new OcrToolValidationError("Invalid argument combination, provide either 'url' or 'delta'");
    }

    private async executeHistoryNavigation(
        context: OcrToolExecutionContext,
        delta: number,
    ): Promise<ToolResultMessage> {
        const direction = delta < 0 ? "back" : delta > 0 ? "forward" : "reload";
        const steps = Math.abs(delta);

        context.updateUI?.({
            message: `Going ${direction}${steps > 1 ? ` ${steps} steps` : ""}...`,
        });

        try {
            if (delta === 0) {
                await this.ctx.page.reload({
                    waitUntil: "domcontentloaded",
                    timeout: 30000,
                    signal: context.signal,
                });
            } else if (delta < 0) {
                // Go back
                for (let i = 0; i < steps; i++) {
                    await this.ctx.page.goBack({
                        waitUntil: "domcontentloaded",
                        timeout: 30000,
                        signal: context.signal,
                    });
                }
            } else {
                // Go forward
                for (let i = 0; i < steps; i++) {
                    await this.ctx.page.goForward({
                        waitUntil: "domcontentloaded",
                        timeout: 30000,
                        signal: context.signal,
                    });
                }
            }

            await this.waitForNetworkIdleAfterInteraction(context);

            // Notify context of page change
            await this.ctx.onPageChange?.();

            const navContext = await this.getNavigationContext();

            return this.screenshotPlaceholderSuccessMessage(
                context,
                `Went ${direction}${steps > 1 ? ` ${steps} steps` : ""} in history\n\n${navContext}`,
            );
        } catch (error) {
            return this.simpleTextFailureMessage(
                context,
                `History navigation failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
                    `**Current Page**: ${this.ctx.page.title()}\n` +
                    `**URL**: ${this.ctx.page.url()}\n\n` +
                    `Suggestion: use the screenshot tool to validate the content is loaded or not.`,
            );
        }
    }

    private async executeUrlNavigation(context: OcrToolExecutionContext, url: string): Promise<ToolResultMessage> {
        context.updateUI?.({ message: `Navigating to ${url}...` });

        try {
            // Validate URL
            const parsedUrl = new URL(url);

            await this.ctx.page.goto(parsedUrl.href, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
            });

            await this.waitForNetworkIdleAfterInteraction(context);

            // Notify context of page change
            await this.ctx.onPageChange?.();

            const navContext = await this.getNavigationContext();

            return this.screenshotPlaceholderSuccessMessage(context, `Navigated to ${parsedUrl.href}\n\n${navContext}`);
        } catch (error) {
            return this.simpleTextFailureMessage(
                context,
                `Navigation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async getNavigationContext(): Promise<string> {
        try {
            return `**Current page:** ${await this.ctx.page.title()}\n**URL:** ${this.ctx.page.url()}`;
        } catch {
            return `**URL:** ${this.ctx.page.url()}`;
        }
    }
}
