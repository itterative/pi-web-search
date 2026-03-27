import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { ElementHandle, Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions, OcrToolValidationError } from "./base";
import { formatMatchText, sleep } from "../../../common/utils";
import { InteractionConfig, InteractionPositioning } from "../state";
import type { CursorExtension } from "../extensions/cursor";
import { NavigationExtension } from "../extensions/navigation";

interface ClickToolParameters {
    x?: number;
    y?: number;
    description?: string;
    text?: string;
    exact?: boolean;
}

interface ClickToolContext {
    page: Page;
    config: InteractionConfig;
    cursorExtension: CursorExtension;
    positioning: InteractionPositioning;
    navigationExtension: NavigationExtension;
}

export class ClickTool extends OcrTool<ClickToolContext> {
    constructor(ctx: ClickToolContext, options?: OcrToolOptions) {
        // Register this tool as capable of causing navigation
        ctx.navigationExtension.registerNavigationTool("click");

        const coordDescX =
            ctx.positioning.type === "absolute"
                ? "Absolute X coordinate in pixels."
                : `Relative X coordinate (0.0 = left edge, ${ctx.positioning.x} = right edge). For center, use ${(ctx.positioning.x / 2).toFixed(1)}.`;

        const coordDescY =
            ctx.positioning.type === "absolute"
                ? "Absolute Y coordinate in pixels."
                : `Relative Y coordinate (0.0 = top edge, ${ctx.positioning.y} = bottom edge). For center, use ${(ctx.positioning.y / 2).toFixed(1)}.`;

        super(
            {
                name: "click",
                description:
                    "Click on an element on the page to reveal hidden content, expand accordions, open tabs, etc. If x/y coordinates are provided, clicks at that position. Otherwise, if text is provided, finds and clicks an element with that text. If neither is provided, clicks at the current cursor position (set by cursor tool).",
                promptSnippet: "click - Click at coordinates, by text, or at cursor position",
                promptGuidelines:
                    "## click tool\n" +
                    "- Click to interact with elements: buttons, links, accordions, tabs, etc.\n" +
                    "- Three ways to specify target:\n" +
                    "  1. **Coordinates** (`x`, `y`): Click at exact position\n" +
                    "  2. **Text** (`text`, `exact`): Find and click element by text content\n" +
                    "  3. **Cursor**: Click at position set by previous cursor tool call\n" +
                    "- Use `exact=true` for precise text matching; default is partial match\n" +
                    "- If multiple elements match text (without exact), returns list of matches\n" +
                    "- Always check if page changed after click; if not, element may not be interactive\n" +
                    "- Use cursor tool first to discover element positions",
                parameters: Type.Object({
                    x: Type.Optional(
                        Type.Number({
                            description: coordDescX,
                        }),
                    ),
                    y: Type.Optional(
                        Type.Number({
                            description: coordDescY,
                        }),
                    ),
                    description: Type.Optional(
                        Type.String({
                            description:
                                "A description of the element to click (e.g., 'Read more button in the pricing section', 'FAQ accordion about shipping')",
                        }),
                    ),
                    text: Type.Optional(
                        Type.String({
                            description:
                                "The text content of the element to click. Use exact=true for exact match, or exact=false (default) for partial match.",
                        }),
                    ),
                    exact: Type.Optional(
                        Type.Boolean({
                            description:
                                "Whether to match text exactly (default: false). If true, returns error when element not found. If false and multiple elements match, returns failure with list of matches.",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: ClickToolParameters): Promise<ToolResultMessage> {
        const action = this.parseAction(args);

        context.updateUI?.({ message: this.getUserMessage(action) });

        // Handle coordinate-based click (explicit or cursor)
        if (action.type === "coordinates") {
            return this.executeCoordinateClick(context, action.x, action.y);
        }

        // Handle text-based click
        if (action.type === "text") {
            return this.executeTextClick(context, action.text, action.exact ?? false);
        }

        // Handle description-based click (expand patterns, etc.)
        if (action.type === "description") {
            return this.executeDescriptionClick(context, action.description);
        }

        return this.simpleTextFailureMessage(context, "No valid click target specified.");
    }

    private parseAction(args: ClickToolParameters): ClickAction {
        // Explicit coordinates provided
        if (args.x !== undefined && args.y !== undefined) {
            return { type: "coordinates", x: args.x, y: args.y };
        }

        // Text-based click
        if (args.text) {
            return { type: "text", text: args.text, exact: args.exact ?? false };
        }

        // Use cursor position
        if (this.ctx.cursorExtension.isCursorSet()) {
            const pos = this.ctx.cursorExtension.getCursorPosition()!;
            return { type: "coordinates", x: pos.x, y: pos.y };
        }

        // Description-based click
        if (args.description) {
            return { type: "description", description: args.description };
        }

        throw new OcrToolValidationError(
            "No click target specified. Provide x/y coordinates, text, or use cursor tool first to set cursor position.",
        );
    }

    private async executeCoordinateClick(
        context: OcrToolExecutionContext,
        x: number,
        y: number,
    ): Promise<ToolResultMessage> {
        const viewport = this.ctx.page.viewport();
        if (!viewport) {
            return this.simpleTextFailureMessage(context, "Could not get viewport dimensions");
        }

        let pageX =
            this.ctx.positioning.type === "absolute"
                ? Math.max(0, Math.min(x, viewport.width))
                : (Math.max(0, Math.min(x, this.ctx.positioning.x)) * viewport.width) / this.ctx.positioning.x;

        let pageY =
            this.ctx.positioning.type === "absolute"
                ? Math.max(0, Math.min(y, viewport.height))
                : (Math.max(0, Math.min(y, this.ctx.positioning.y)) * viewport.height) / this.ctx.positioning.y;

        // Record click in cursor history (use page coordinates)
        await this.ctx.cursorExtension.addHistoryEntry("click", pageX, pageY);

        // Capture screenshot before click for comparison
        const beforeScreenshot = await this.ctx.page.screenshot({
            encoding: "base64",
        });

        await this.ctx.page.mouse.click(pageX, pageY);
        await this.waitForNetworkIdleAfterInteraction(context);

        // Capture screenshot after click and compare
        const afterScreenshot = await this.ctx.page.screenshot({
            encoding: "base64",
        });

        if (afterScreenshot === beforeScreenshot) {
            return this.simpleTextSuccessMessage(
                context,
                `Clicked at (${x.toFixed(2)}, ${y.toFixed(2)})\n\nWARNING: The page did not change after clicking. The click may have missed or the element is not interactive. Use the screenshot tool with debug=true to see a coordinate grid and verify your click position.`,
            );
        }

        return this.screenshotPlaceholderSuccessMessage(context, `Clicked at (${x.toFixed(2)}, ${y.toFixed(2)})`);
    }

    private async executeTextClick(
        context: OcrToolExecutionContext,
        text: string,
        exact: boolean,
    ): Promise<ToolResultMessage> {
        const viewport = this.ctx.page.viewport();

        // Find all clickable elements and filter for visibility + text match
        const elements = await this.ctx.page.$$("button, a, [role='button'], summary, [tabindex]");
        const matchingElements: Array<{
            element: ElementHandle;
            text: string;
            pageX: number;
            pageY: number;
            x: number;
            y: number;
        }> = [];

        for (const el of elements) {
            const info = await el.evaluate((e) => {
                // Check visibility
                const style = window.getComputedStyle(e);
                const rect = e.getBoundingClientRect();
                const isVisible =
                    style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    style.opacity !== "0" &&
                    rect.width > 0 &&
                    rect.height > 0;

                if (!isVisible) {
                    return null;
                }

                return {
                    text: e.textContent?.trim() ?? "",
                    tagName: e.tagName,
                    centerX: rect.x + rect.width / 2,
                    centerY: rect.y + rect.height / 2,
                };
            });

            if (!info) continue;

            // Check text match
            const isMatch = exact ? info.text === text : info.text.toLowerCase().includes(text.toLowerCase());

            if (isMatch) {
                const coords = this.convertToPositioningCoords(info.centerX, info.centerY, viewport);
                matchingElements.push({
                    element: el,
                    text: formatMatchText(info.text),
                    pageX: info.centerX,
                    pageY: info.centerY,
                    x: coords.x,
                    y: coords.y,
                });
            }
        }

        // No matches found
        if (matchingElements.length === 0) {
            return this.simpleTextFailureMessage(
                context,
                exact
                    ? `Could not find visible element with exact text "${text}"`
                    : `Could not find visible element containing text "${text}"`,
            );
        }

        // Multiple matches found
        if (matchingElements.length > 1) {
            const maxResults = this.ctx.config.maxTextMatchResults;
            const displayedMatches = matchingElements.slice(0, maxResults);
            const hasMore = matchingElements.length > maxResults;

            const matchList = displayedMatches
                .map(
                    (m, i) =>
                        `${i + 1}. "${m.text}" at (${m.x.toFixed(this.getCoordinatePrecision())}, ${m.y.toFixed(this.getCoordinatePrecision())})`,
                )
                .join("\n");

            return this.simpleTextFailureMessage(
                context,
                `Found ${matchingElements.length} visible elements ${exact ? "with exact text" : "containing text"} "${text}". Please be more specific or use coordinates.\n\n${matchList}${hasMore ? `\n... and ${matchingElements.length - maxResults} more` : ""}`,
            );
        }

        // Single match - click it
        const target = matchingElements[0];

        return this.clickElementAndCompare(
            context,
            target.element,
            target.pageX,
            target.pageY,
            `element with text "${target.text}"`,
            target.x,
            target.y,
        );
    }

    private async executeDescriptionClick(
        context: OcrToolExecutionContext,
        description: string,
    ): Promise<ToolResultMessage> {
        const expandPatterns = [
            /read\s*more/i,
            /show\s*more/i,
            /view\s*more/i,
            /expand/i,
            /see\s*more/i,
            /details/i,
            /learn\s*more/i,
            /continue\s*reading/i,
        ];

        // Check if description matches expand patterns
        if (expandPatterns.some((p) => p.test(description))) {
            // Capture screenshot before clicks
            const beforeScreenshot = await this.ctx.page.screenshot({
                encoding: "base64",
            });

            // Click details/summary elements
            const details = await this.ctx.page.$$("details:not([open])");
            for (const detail of details) {
                const summary = await detail.$("summary");
                if (summary) {
                    await summary.click();
                    await sleep(this.ctx.config.delayMillis / 2, context.signal);
                }
            }

            // Click expand buttons
            const buttons = await this.ctx.page.$$("button, [role='button']");
            for (const btn of buttons) {
                const btnText = await btn.evaluate((e) => e.textContent?.trim() ?? "");
                if (expandPatterns.some((p) => p.test(btnText))) {
                    await btn.click();
                    await sleep(this.ctx.config.delayMillis, context.signal);
                }
            }

            // Capture screenshot after clicks and compare
            const afterScreenshot = await this.ctx.page.screenshot({
                encoding: "base64",
            });

            if (afterScreenshot === beforeScreenshot) {
                return this.simpleTextSuccessMessage(
                    context,
                    `Expanded content matching "${description}"\n\nWARNING: The page did not change. No matching expandable elements found.`,
                );
            }

            return this.screenshotPlaceholderSuccessMessage(context, `Expanded content matching "${description}"`);
        }

        // Generic click by aria-label or title
        const selector = `[aria-label*="${description}" i], [title*="${description}" i]`;
        const el = await this.ctx.page.$(selector);

        if (!el) {
            return this.simpleTextFailureMessage(context, `Could not find element matching "${description}"`);
        }

        const boundingBox = await el.evaluate((e) => {
            const rect = e.getBoundingClientRect();
            return {
                centerX: rect.x + rect.width / 2,
                centerY: rect.y + rect.height / 2,
            };
        });

        return this.clickElementAndCompare(
            context,
            el,
            boundingBox.centerX,
            boundingBox.centerY,
            `element matching "${description}"`,
        );
    }

    private getUserMessage(action: ClickAction): string {
        if (action.type === "coordinates") {
            return `Clicking at (${action.x.toFixed(2)}, ${action.y.toFixed(2)})...`;
        }
        if (action.type === "text") {
            return `Clicking element with ${action.exact ? "exact " : ""}text "${action.text}"...`;
        }
        if (action.type === "description") {
            return `Clicking ${action.description}...`;
        }
        return "Clicking...";
    }

    /**
     * Click an element and compare screenshots before/after.
     * Returns appropriate success/failure message with coordinates.
     */
    private async clickElementAndCompare(
        context: OcrToolExecutionContext,
        element: import("puppeteer").ElementHandle,
        pageX: number,
        pageY: number,
        description: string,
        positioningX?: number,
        positioningY?: number,
    ): Promise<ToolResultMessage> {
        const viewport = this.ctx.page.viewport();
        const coords =
            positioningX !== undefined && positioningY !== undefined
                ? { x: positioningX, y: positioningY }
                : this.convertToPositioningCoords(pageX, pageY, viewport);

        // Record click in cursor history (use page coordinates)
        await this.ctx.cursorExtension.addHistoryEntry("click", pageX, pageY);

        // Capture screenshot before click for comparison
        const beforeScreenshot = await this.ctx.page.screenshot({
            encoding: "base64",
        });

        await element.click();
        await this.waitForNetworkIdleAfterInteraction(context);

        // Capture screenshot after click and compare
        const afterScreenshot = await this.ctx.page.screenshot({
            encoding: "base64",
        });

        const coordInfo = `Coordinates: (${coords.x.toFixed(this.getCoordinatePrecision())}, ${coords.y.toFixed(this.getCoordinatePrecision())})`;

        if (afterScreenshot === beforeScreenshot) {
            return this.simpleTextSuccessMessage(
                context,
                `Clicked ${description}\n${coordInfo}\n\nWARNING: The page did not change after clicking. The click may have missed or the element is not interactive.\nTIP: use screenshot tool if available.`,
            );
        }

        return this.screenshotPlaceholderSuccessMessage(context, `Clicked ${description}\n${coordInfo}`);
    }

    /**
     * Convert absolute page coordinates to the positioning system coordinates.
     */
    private convertToPositioningCoords(
        pageX: number,
        pageY: number,
        viewport: { width: number; height: number } | null,
    ): { x: number; y: number } {
        if (!viewport) {
            return { x: pageX, y: pageY };
        }

        if (this.ctx.positioning.type === "absolute") {
            return { x: pageX, y: pageY };
        } else {
            // Relative: convert from page pixels to positioning range
            const normalizedX = pageX / viewport.width;
            const normalizedY = pageY / viewport.height;
            return {
                x: normalizedX * this.ctx.positioning.x,
                y: normalizedY * this.ctx.positioning.y,
            };
        }
    }

    /**
     * Get the coordinate precision for display based on positioning type.
     */
    private getCoordinatePrecision(): number {
        if (this.ctx.positioning.type === "absolute") {
            return this.ctx.config.coordinatePrecision ?? 0;
        } else {
            return this.ctx.config.coordinatePrecision ?? 2;
        }
    }
}

type ClickAction =
    | { type: "coordinates"; x: number; y: number }
    | { type: "text"; text: string; exact: boolean }
    | { type: "description"; description: string };
