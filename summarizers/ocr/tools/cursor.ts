import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions } from "./base";
import { hashString, sleep } from "../../../common/utils";
import { InteractionConfig, InteractionPositioning } from "../state";
import type { CursorExtension } from "../extensions/cursor";

interface CursorToolParameters {
    x: number;
    y: number;
    description?: string;
}

interface CursorToolContext {
    page: Page;
    config: InteractionConfig;
    cursorExtension: CursorExtension;
    positioning: InteractionPositioning;
}

export class CursorTool extends OcrTool<CursorToolContext> {
    constructor(ctx: CursorToolContext, options?: OcrToolOptions) {
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
                name: "cursor",
                description:
                    "Move the cursor to a specific position on the page to discover interactive elements: links, inputs, buttons, and selects. Returns details about any elements found at that position. Use this to inspect elements before clicking or typing.",
                promptSnippet: "cursor - Move cursor to inspect elements at a position",
                promptGuidelines:
                    "## cursor tool\n" +
                    "- Move cursor to a position to discover what's there before interacting\n" +
                    "- Returns info about interactive elements at that position:\n" +
                    "  - **Links**: text and href\n" +
                    "  - **Inputs**: type, label, placeholder\n" +
                    "  - **Buttons**: text and type\n" +
                    "  - **Selects**: label and options\n" +
                    "- Position is remembered for subsequent click/type calls\n" +
                    "- Use this to explore the page and find correct coordinates\n" +
                    "- If no elements found, position may be empty or non-interactive",
                parameters: Type.Object({
                    x: Type.Number({
                        description: coordDescX,
                    }),
                    y: Type.Number({
                        description: coordDescY,
                    }),
                    description: Type.Optional(
                        Type.String({
                            description:
                                "A description of what you're hovering over (e.g., 'navigation link', 'button in header')",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: CursorToolParameters): Promise<ToolResultMessage> {
        const { x, y, description } = args;

        context.updateUI?.({
            message: `Moving cursor to (${x.toFixed(2)}, ${y.toFixed(2)})...`,
        });

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

        // Move cursor
        await this.ctx.page.mouse.move(pageX, pageY);
        await sleep(100, context.signal);

        // Store cursor position for click/type tools
        this.ctx.cursorExtension.setCursor(x, y);

        // Record hover in cursor history (use page coordinates)
        await this.ctx.cursorExtension.addHistoryEntry("hover", pageX, pageY);

        // Gather information about hovered elements
        const hoverInfo = await this.ctx.page.evaluate(() => {
            const result: {
                links: Array<{ text: string; href: string }>;
                inputs: Array<{
                    type: string;
                    placeholder?: string;
                    name?: string;
                    ariaLabel?: string;
                    label?: string;
                }>;
                buttons: Array<{ text: string; type?: string; ariaLabel?: string }>;
                selects: Array<{
                    placeholder?: string;
                    ariaLabel?: string;
                    label?: string;
                    options?: string[];
                }>;
            } = {
                links: [],
                inputs: [],
                buttons: [],
                selects: [],
            };

            // Get hovered links
            document.querySelectorAll("a:hover").forEach((el) => {
                const link = el as HTMLAnchorElement;
                result.links.push({
                    href: link.href,
                    text: link.textContent?.trim() || "",
                });
            });

            // Get hovered inputs and textareas
            document.querySelectorAll("input:hover, textarea:hover").forEach((el) => {
                const input = el as HTMLInputElement | HTMLTextAreaElement;
                const label = input.labels?.[0]?.textContent?.trim();
                result.inputs.push({
                    type: input.type || "text",
                    placeholder: input.placeholder || undefined,
                    name: input.name || undefined,
                    ariaLabel: input.getAttribute("aria-label") || undefined,
                    label,
                });
            });

            // Get hovered selects
            document.querySelectorAll("select:hover").forEach((el) => {
                const select = el as HTMLSelectElement;
                const label = select.labels?.[0]?.textContent?.trim();
                const options = Array.from(select.options)
                    .slice(0, 10)
                    .map((opt) => opt.text)
                    .filter(Boolean);
                result.selects.push({
                    placeholder: select.getAttribute("placeholder") || undefined,
                    ariaLabel: select.getAttribute("aria-label") || undefined,
                    label,
                    options: options.length > 0 ? options : undefined,
                });
            });

            // Get hovered buttons
            document
                .querySelectorAll(
                    "button:hover, [role='button']:hover, input[type='submit']:hover, input[type='button']:hover",
                )
                .forEach((el) => {
                    const button = el as HTMLButtonElement;
                    result.buttons.push({
                        text: button.textContent?.trim() || button.value || "",
                        type: button.type || undefined,
                        ariaLabel: button.getAttribute("aria-label") || undefined,
                    });
                });

            return result;
        });

        // Build response message
        const parts: string[] = [];
        const coordStr = `(${x.toFixed(2)}, ${y.toFixed(2)})`;

        if (hoverInfo.links.length > 0) {
            const linksText = hoverInfo.links.map((link, i) => `${i + 1}. "${link.text}" -> ${link.href}`).join("\n");
            parts.push(`**Links (${hoverInfo.links.length}):**\n${linksText}`);
        }

        if (hoverInfo.inputs.length > 0) {
            const inputsText = hoverInfo.inputs
                .map((input, i) => {
                    const desc = input.label || input.placeholder || input.ariaLabel || input.name || "unlabeled";
                    return `${i + 1}. [${input.type}] "${desc}"`;
                })
                .join("\n");
            parts.push(`**Inputs (${hoverInfo.inputs.length}):**\n${inputsText}`);
        }

        if (hoverInfo.selects.length > 0) {
            const selectsText = hoverInfo.selects
                .map((select, i) => {
                    const desc = select.label || select.ariaLabel || select.placeholder || "unlabeled";
                    const opts = select.options
                        ? ` (${select.options.slice(0, 5).join(", ")}${select.options.length > 5 ? "..." : ""})`
                        : "";
                    return `${i + 1}. [select] "${desc}"${opts}`;
                })
                .join("\n");
            parts.push(`**Selects (${hoverInfo.selects.length}):**\n${selectsText}`);
        }

        if (hoverInfo.buttons.length > 0) {
            const buttonsText = hoverInfo.buttons
                .map((button, i) => `${i + 1}. "${button.text}"${button.type ? ` [${button.type}]` : ""}`)
                .join("\n");
            parts.push(`**Buttons (${hoverInfo.buttons.length}):**\n${buttonsText}`);
        }

        // Create a hash of the result for repetition tracking
        const hasElements = parts.length > 0;
        const hash = this.createHoverHash(hoverInfo);

        // Record result and check for repetition
        const { count } = this.ctx.cursorExtension.recordCursorResult(hash);
        const warning = this.getRepetitionWarning(count, hasElements);

        // Build final message
        let message: string;
        if (parts.length === 0) {
            message = `Cursor at ${coordStr}${description ? ` (${description})` : ""} - no interactive elements found`;
        } else {
            message = `Cursor at ${coordStr}${description ? ` (${description})` : ""}\n\n${parts.join("\n\n")}`;
        }

        // Append warning if present
        if (warning) {
            message += `\n\n${warning}`;
        }

        return this.simpleTextSuccessMessage(context, message);
    }

    /** Number of repeated results before warning is shown */
    private static readonly REPETITION_WARNING_THRESHOLD = 3;

    /**
     * Get a warning message if repetition threshold is exceeded.
     */
    private getRepetitionWarning(count: number, hasElements: boolean): string | undefined {
        if (count < CursorTool.REPETITION_WARNING_THRESHOLD) {
            return undefined;
        }

        if (!hasElements) {
            return `Warning: No interactive elements found at this position for ${count} consecutive cursor moves. Consider exploring a different area or report back for feedback.`;
        } else {
            return `Warning: The same elements have been found ${count} times in a row. Consider exploring a different area or report back for feedback.`;
        }
    }

    /**
     * Create a hash of the hover info to detect repeated results.
     */
    private createHoverHash(hoverInfo: {
        links: Array<{ text: string; href: string }>;
        inputs: Array<{
            type: string;
            placeholder?: string;
            name?: string;
            ariaLabel?: string;
            label?: string;
        }>;
        buttons: Array<{ text: string; type?: string; ariaLabel?: string }>;
        selects: Array<{
            placeholder?: string;
            ariaLabel?: string;
            label?: string;
            options?: string[];
        }>;
    }): string {
        // Create a string representation of the hover info
        const parts: string[] = [];

        // Links: count + first href
        parts.push(`links:${hoverInfo.links.length}`);
        if (hoverInfo.links.length > 0) {
            parts.push(hoverInfo.links[0].href);
        }

        // Inputs: count + first input signature
        parts.push(`inputs:${hoverInfo.inputs.length}`);
        if (hoverInfo.inputs.length > 0) {
            const inp = hoverInfo.inputs[0];
            parts.push(`${inp.type}:${inp.label || inp.placeholder || inp.name || "none"}`);
        }

        // Buttons: count + first button text
        parts.push(`buttons:${hoverInfo.buttons.length}`);
        if (hoverInfo.buttons.length > 0) {
            parts.push(hoverInfo.buttons[0].text);
        }

        // Selects: count + first select label
        parts.push(`selects:${hoverInfo.selects.length}`);
        if (hoverInfo.selects.length > 0) {
            const sel = hoverInfo.selects[0];
            parts.push(sel.label || sel.ariaLabel || sel.placeholder || "none");
        }

        return hashString(parts.join("|"));
    }
}
