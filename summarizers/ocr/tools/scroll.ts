import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions, OcrToolValidationError } from "./base";
import { InteractionConfig, InteractionPositioning } from "../state";
import { sleep } from "../../../common/utils";
import type { CursorExtension } from "../extensions/cursor";

interface ScrollToolParameter {
    direction?: "up" | "down";
    to?: "top" | "bottom";
    mode?: "page" | "wheel";
}

interface ScrollToolContext {
    page: Page;
    config: InteractionConfig;
    cursorExtension: CursorExtension;
    positioning: InteractionPositioning;
}

type ScrollAction = (ScrollDownAction | ScrollUpAction) & {
    full: boolean;
};

interface ScrollDownAction {
    direction: "down";
}

interface ScrollUpAction {
    direction: "up";
}

export class ScrollTool extends OcrTool<ScrollToolContext> {
    constructor(ctx: ScrollToolContext, options?: OcrToolOptions) {
        super(
            {
                name: "scroll",
                description:
                    "Scroll the page in a direction or jump to top/bottom. Use 'down' (default) to reveal more content below, 'up' to go back to content above. Use 'top' to jump to the very top, 'bottom' to jump to the very bottom.",
                promptSnippet: "scroll - Scroll up/down or jump to top/bottom",
                promptGuidelines:
                    "## scroll tool\n" +
                    "- Scroll to reveal more content on long pages\n" +
                    "- **Recommended**: Use `mode=\"wheel\"` for natural scrolling at cursor position\n" +
                    '- `direction="down"` (default): scroll down to see content below\n' +
                    '- `direction="up"`: scroll up to see content above\n' +
                    '- `to="top"`: jump to the very top of the page\n' +
                    '- `to="bottom"`: jump to the very bottom of the page\n' +
                    '- `mode="wheel"`: scroll using mouse wheel at cursor position (cursor centered by default if not set)\n' +
                    '- `mode="page"`: use page-based scrolling (legacy mode)\n' +
                    "- After scrolling, a new screenshot is provided automatically\n" +
                    "- Use scroll when you've explored visible content and need to see more",
                parameters: Type.Object({
                    direction: Type.Optional(
                        Type.Union(
                            [
                                Type.Literal("up", {
                                    description: "Scroll up to reveal content above",
                                }),
                                Type.Literal("down", {
                                    description: "Scroll down to reveal content below (default)",
                                }),
                            ],
                            {
                                description: "Scroll direction: 'up' or 'down' (default: down)",
                            },
                        ),
                    ),
                    to: Type.Optional(
                        Type.Union(
                            [
                                Type.Literal("top", {
                                    description: "Jump to the very top of the page",
                                }),
                                Type.Literal("bottom", {
                                    description: "Jump to the very bottom of the page",
                                }),
                            ],
                            {
                                description: "Jump to 'top' or 'bottom' of the page (overrides direction)",
                            },
                        ),
                    ),
                    mode: Type.Optional(
                        Type.Union(
                            [
                                Type.Literal("page", {
                                    description: "Use page-based scrolling (default)",
                                }),
                                Type.Literal("wheel", {
                                    description:
                                        "Use mouse wheel scrolling at cursor position (cursor centered by default)",
                                }),
                            ],
                            {
                                description:
                                    "Scrolling mode: 'page' for page-based scrolling, 'wheel' for mouse wheel scrolling at cursor position",
                            },
                        ),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: ScrollToolParameter): Promise<ToolResultMessage> {
        const action = this.parseAction(args);
        const mode = args.mode ?? "page";

        context.updateUI?.({ message: this.getActionUserMessage(action) });

        if (mode === "wheel") {
            const hasScrolled = await this.executeWheelScroll(action, context);
            if (!hasScrolled) {
                return this.simpleTextSuccessMessage(context, "Warning: scroll position has not changed");
            }
            await this.waitForNetworkIdleAfterInteraction(context);
            return this.screenshotPlaceholderSuccessMessage(context, this.getActionMessage(action));
        }

        const hasScrolled = await this.pageScroll(action);

        if (!hasScrolled) {
            return this.simpleTextSuccessMessage(context, "Warning: scroll position has not changed");
        }

        await this.waitForNetworkIdleAfterInteraction(context);

        return this.screenshotPlaceholderSuccessMessage(context, this.getActionMessage(action));
    }

    private async pageScroll(action: ScrollAction): Promise<boolean> {
        return await this.ctx.page.evaluate(
            (scrollDirection, scrollFully, scrollRelativeMultiplier) => {
                const beforeScroll = window.scrollY;

                if (scrollFully && scrollDirection === "down") {
                    window.scrollTo(0, document.body.scrollHeight);
                } else if (scrollFully && scrollDirection === "up") {
                    window.scrollTo(0, 0);
                } else if (!scrollFully && scrollDirection === "down") {
                    window.scrollBy(0, window.innerHeight * scrollRelativeMultiplier);
                } else if (!scrollFully && scrollDirection === "up") {
                    window.scrollBy(0, -window.innerHeight * scrollRelativeMultiplier);
                }

                const afterScroll = window.scrollY;
                return beforeScroll !== afterScroll;
            },
            action.direction,
            action.full,
            this.ctx.config.scrollRelativeMultiplier,
        );
    }

    private async executeWheelScroll(action: ScrollAction, context: OcrToolExecutionContext): Promise<boolean> {
        const viewport = this.ctx.page.viewport();
        if (!viewport) {
            return false;
        }

        let pageX: number;
        let pageY: number;

        // Use cursor position if set, otherwise default to middle of viewport
        if (this.ctx.cursorExtension.isCursorSet()) {
            const cursorPos = this.ctx.cursorExtension.getCursorPosition()!;
            if (this.ctx.positioning.type === "relative") {
                pageX = (cursorPos.x / this.ctx.positioning.x) * viewport.width;
                pageY = (cursorPos.y / this.ctx.positioning.y) * viewport.height;
            } else {
                pageX = cursorPos.x;
                pageY = cursorPos.y;
            }
        } else {
            pageX = viewport.width / 2;
            pageY = viewport.height / 2;
        }

        await this.ctx.page.mouse.move(pageX, pageY);
        await sleep(100, context.signal);

        // Calculate scroll delta based on direction
        const scrollDelta = this.ctx.config.scrollRelativeMultiplier * viewport.height;
        const deltaY = action.direction === "down" ? scrollDelta : -scrollDelta;

        // Simulate mouse wheel event
        await this.ctx.page.mouse.wheel({ deltaX: 0, deltaY });

        return true;
    }

    private parseAction(args: ScrollToolParameter): ScrollAction {
        if (args.direction === "down") {
            if (args.to !== undefined) {
                throw new OcrToolValidationError(`invalid scroll usage, use either only direction or to parameters`);
            }

            return {
                direction: "down",
                full: false,
            };
        }

        if (args.direction === "up") {
            if (args.to !== undefined) {
                throw new OcrToolValidationError(`invalid scroll usage, use either only direction or to parameters`);
            }

            return {
                direction: "up",
                full: false,
            };
        }

        if (args.to === "bottom") {
            if (args.direction !== undefined) {
                throw new OcrToolValidationError(`invalid scroll usage, use either only direction or to parameters`);
            }

            return {
                direction: "down",
                full: true,
            };
        }

        if (args.to === "top") {
            if (args.direction !== undefined) {
                throw new OcrToolValidationError(`invalid scroll usage, use either only direction or to parameters`);
            }

            return {
                direction: "up",
                full: true,
            };
        }

        return {
            direction: "down",
            full: false,
        };
    }

    private getActionMessage(action: ScrollAction): string {
        if (action.full && action.direction === "down") {
            return "Jumped to the bottom of the page";
        } else if (action.full && action.direction === "up") {
            return "Jumped to the top of the page";
        } else if (!action.full && action.direction === "down") {
            return "Scrolled down the page";
        } else if (!action.full && action.direction === "up") {
            return "Scrolled up the page";
        }

        return "Warning: Scroll position has changed, but position might be unexpected. Use screenshot tool if no screenshot was provided";
    }

    private getActionUserMessage(action: ScrollAction): string {
        if (action.full && action.direction === "down") {
            return "Scrolling down...";
        } else if (action.full && action.direction === "up") {
            return "Scrolling up...";
        } else if (!action.full && action.direction === "down") {
            return "Scrolling to the bottom...";
        } else if (!action.full && action.direction === "up") {
            return "Scrolling to the top...";
        }

        return "Scrolling...";
    }
}
