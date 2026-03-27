import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { OcrTool, OcrToolExecutionContext, OcrToolOptions } from "./base";
import { Page } from "puppeteer";

import { InteractionConfig, InteractionPositioning } from "../state";
import type { CursorExtension } from "../extensions/cursor";
import { NavigationExtension } from "../extensions/navigation";
import { sleep } from "../../../common/utils";

type InsertMode = "overwrite" | "append" | "prefix";

interface TypeToolParameters {
    description?: string;
    text: string;
    submit?: boolean;
    insert?: InsertMode;
}

interface TypeToolContext {
    page: Page;
    config: InteractionConfig;
    cursorExtension: CursorExtension;
    positioning: InteractionPositioning;
    navigationExtension: NavigationExtension;
}

export class TypeTool extends OcrTool<TypeToolContext> {
    constructor(ctx: TypeToolContext, options?: OcrToolOptions) {
        // Register this tool as capable of causing navigation
        ctx.navigationExtension.registerNavigationTool("type");

        super(
            {
                name: "type",
                description:
                    "Type text into an input field. If an input is already focused, types directly into it. Otherwise, uses the cursor position (set via cursor tool) to click and type into the field.",
                promptSnippet: "type - Type text into an input field at cursor position",
                promptGuidelines:
                    "## type tool\n" +
                    "- Type text into input fields (text, search, email, password, etc.)\n" +
                    "- Two ways to use:\n" +
                    "  1. If an input is already focused, types directly into it\n" +
                    "  2. Otherwise, requires cursor position (use cursor tool first)\n" +
                    "- `text`: the text to type into the field\n" +
                    "- `insert`: how to insert text (default: overwrite)\n" +
                    "  - `overwrite`: replace existing content (select all, then type)\n" +
                    "  - `append`: add text to the end of existing content\n" +
                    "  - `prefix`: add text to the beginning of existing content\n" +
                    "- `submit=true`: press Enter after typing (for search forms, login)\n" +
                    "- `description`: optional label for the input being typed into",
                parameters: Type.Object({
                    description: Type.Optional(
                        Type.String({
                            description: "Optional human readable concise description of the element being typed into",
                        }),
                    ),
                    text: Type.String({
                        description: "The text to type into the field",
                    }),
                    insert: Type.Optional(
                        Type.Union(
                            [
                                Type.Literal("overwrite", { description: "Replace existing content (default)" }),
                                Type.Literal("append", { description: "Add text to the end" }),
                                Type.Literal("prefix", { description: "Add text to the beginning" }),
                            ],
                            {
                                description: "How to insert text relative to existing content (default: overwrite)",
                            },
                        ),
                    ),
                    submit: Type.Optional(
                        Type.Boolean({
                            description: "Whether to press Enter after typing (default: false)",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: TypeToolParameters): Promise<ToolResultMessage> {
        context.updateUI?.({ message: this.getUserMessage(args.description) });

        const insertMode = args.insert ?? "overwrite";

        // Check if there's already a focused input element
        const focusedElement = await this.getFocusedInputElement();

        if (focusedElement) {
            // Element is already focused, apply insert mode and type
            await this.applyInsertMode(insertMode);
            await this.ctx.page.keyboard.type(args.text);

            if (args.submit) {
                await this.ctx.page.keyboard.press("Enter");
                await sleep(this.ctx.config.delayMillis, context.signal);
                return this.screenshotPlaceholderSuccessMessage(
                    context,
                    "Successfully typed into focused input element and submitted.",
                );
            }

            return this.simpleTextSuccessMessage(context, "Successfully typed into focused input element.");
        }

        // No focused input - check cursor position
        if (!this.ctx.cursorExtension.isCursorSet()) {
            return this.simpleTextFailureMessage(
                context,
                "No input element is focused. Use the cursor tool to position the cursor on an input field first.",
            );
        }

        const cursor = this.ctx.cursorExtension.getCursorPosition()!;
        const viewport = this.ctx.page.viewport();

        if (!viewport) {
            return this.simpleTextFailureMessage(
                context,
                "Error: Page viewport cannot be retrieved. Is the browser still running?",
            );
        }

        let pageX =
            this.ctx.positioning.type === "absolute"
                ? Math.max(0, Math.min(cursor.x, viewport.width))
                : (Math.max(0, Math.min(cursor.x, this.ctx.positioning.x)) * viewport.width) / this.ctx.positioning.x;

        let pageY =
            this.ctx.positioning.type === "absolute"
                ? Math.max(0, Math.min(cursor.y, viewport.height))
                : (Math.max(0, Math.min(cursor.y, this.ctx.positioning.y)) * viewport.height) / this.ctx.positioning.y;

        const found = await this.ctx.page.evaluate(
            (x, y) => {
                let elements = document.elementsFromPoint(x, y);

                for (const element of elements) {
                    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
                        return true;
                    }

                    if (element.hasAttribute("contenteditable") && element.getAttribute("contenteditable") !== "true") {
                        return true;
                    }

                    if (element.tagName === "LABEL") {
                        const id = element.getAttribute("id");
                        if (!id) {
                            continue;
                        }

                        const forElement = document.getElementById(id);
                        if (!forElement) {
                            continue;
                        }

                        if (forElement.tagName === "INPUT" || forElement.tagName === "TEXTAREA") {
                            return true;
                        }
                    }
                }

                return false;
            },
            pageX,
            pageY,
        );

        if (!found) {
            return this.simpleTextFailureMessage(
                context,
                "Error: No input element found at cursor position. Try moving the cursor to an input element.",
            );
        }

        await this.ctx.page.mouse.click(pageX, pageY);
        await this.applyInsertMode(insertMode);
        await this.ctx.page.keyboard.type(args.text);

        if (args.submit) {
            await this.ctx.page.keyboard.press("Enter");
            await sleep(this.ctx.config.delayMillis, context.signal);
            // Return screenshot placeholder - form submission may navigate to new page
            return this.screenshotPlaceholderSuccessMessage(
                context,
                "Successfully typed into input element and submitted.",
            );
        }

        return this.simpleTextSuccessMessage(context, "Successfully typed into input element.");
    }

    /**
     * Apply the insert mode by positioning cursor appropriately.
     * - overwrite: Select all content (Ctrl+A)
     * - append: Move to end (End key)
     * - prefix: Move to beginning (Home key)
     */
    private async applyInsertMode(mode: InsertMode): Promise<void> {
        switch (mode) {
            case "overwrite":
                // Select all - use Meta for Mac, Control for others
                await this.ctx.page.keyboard.down("Control");
                await this.ctx.page.keyboard.press("a");
                await this.ctx.page.keyboard.up("Control");
                break;
            case "append":
                await this.ctx.page.keyboard.press("End");
                break;
            case "prefix":
                await this.ctx.page.keyboard.press("Home");
                break;
        }
    }

    /**
     * Check if there's a focused input element on the page.
     * Returns true if an input, textarea, or contenteditable element is focused.
     */
    private async getFocusedInputElement(): Promise<boolean> {
        return await this.ctx.page.evaluate(() => {
            const active = document.activeElement;
            if (!active) return false;

            if (active.tagName === "INPUT" || active.tagName === "TEXTAREA") {
                return true;
            }

            if (active.hasAttribute("contenteditable") && active.getAttribute("contenteditable") === "true") {
                return true;
            }

            return false;
        });
    }

    private getUserMessage(description?: string) {
        if (description) {
            return `Typing into ${description}...`;
        }

        return "Typing...";
    }
}
