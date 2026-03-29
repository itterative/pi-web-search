import type { Message, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Page } from "puppeteer";

import { OcrExtension, type OcrExtensionExecutionContext } from "./base";
import { OVERLAY_VIEWPORT_WIDTH, OVERLAY_VIEWPORT_HEIGHT, captureScreenshot } from "../screenshot";
import type { InteractionPositioning } from "../state";
import type { OcrTool } from "../tools/base";
import { ClickTool, CursorTool, FindTool, ScreenshotTool, WaitTool, ReportOverlayResultTool } from "../tools";
import { render } from "../instructions";

/** Result of overlay handling */
export interface OverlayResult {
    success: boolean;
    message: string;
}

/**
 * Context needed for the overlay extension.
 */
export interface OverlayExtensionInit {
    page: Page;
    positioning: InteractionPositioning;
    /** Maximum rounds for overlay handling (default: 20) */
    maxIterations?: number;
    /** Viewport width for overlay handling (default: 1280) */
    width?: number;
    /** Max viewport height for overlay handling (default: 800). Handling viewport height = min(maxHeight, width). */
    maxHeight?: number;
    /** Interaction config for tool creation */
    interaction: import("../state").InteractionConfig;
    /** Cursor extension for tools that need it */
    cursorExtension: import("./cursor").CursorExtension;
    /** Navigation extension for tools that need it */
    navigationExtension: import("./navigation").NavigationExtension;
}

/**
 * Saved info about the original dismiss-overlay tool call that entered handling mode.
 * Used to reconstruct a clean tool call → result pair in the main conversation on exit.
 */
export interface SavedDismissCall {
    /** Tool call ID from the original dismiss-overlay call */
    toolCallId: string;
    /** Description argument from the original dismiss-overlay call */
    description: string;
}

/**
 * State for overlay handling, stored on ctx.state.overlay.
 */
export interface OverlayState {
    /** Current handling mode */
    mode: "idle" | "handling" | "done";
    /** Round when handling started */
    handlingStartRound: number;
    /** Result of overlay handling */
    result: OverlayResult | null;
    /** Saved info about the dismiss-overlay call that started handling mode */
    savedDismissCall: SavedDismissCall | null;
    /** Viewport dimensions saved on entry, restored on exit */
    savedViewport: { width: number; height: number } | null;
}

/**
 * Create default overlay state.
 */
export function createOverlayState(): OverlayState {
    return {
        mode: "idle",
        handlingStartRound: 0,
        result: null,
        savedDismissCall: null,
        savedViewport: null,
    };
}

/**
 * Extension that handles page overlays (captchas, cookie consent, verification pages).
 *
 * When the model calls `dismiss-overlay`, the extension enters "handling mode":
 * - Saves current messages and starts a fresh overlay-focused conversation
 * - Registers overlay handling tools (click, cursor, screenshot, wait) via getTools()
 * - Injects overlay-specific guidance via `onBeforeCompletion`
 * - The model uses the overlay tools to dismiss the overlay
 * - When the model calls `dismiss-overlay` again with a status, the extension:
 *   - Exits handling mode
 *   - Restores the original messages
 *   - Returns the result
 *
 * State is stored on `ctx.state.overlay` following the established pattern.
 *
 * @example
 * ```ts
 * const overlayExt = new OverlayExtension({
 *   page,
 *   positioning: { type: "relative", x: 1, y: 1 },
 *   interaction: config.interaction,
 *   cursorExtension,
 *   navigationExtension,
 * });
 * registry.register(overlayExt);
 * ```
 */
export class OverlayExtension extends OcrExtension {
    readonly name = "overlay";

    private page: Page;
    private positioning: InteractionPositioning;
    private maxIterations: number;
    private width: number;
    private maxHeight: number;

    /** Overlay handling tools (click, cursor, screenshot, wait) */
    private readonly handlingTools: OcrTool<any>[];

    constructor(init: OverlayExtensionInit) {
        super();

        this.page = init.page;
        this.positioning = init.positioning;
        this.maxIterations = init.maxIterations ?? 20;
        this.width = init.width ?? OVERLAY_VIEWPORT_WIDTH;
        this.maxHeight = init.maxHeight ?? OVERLAY_VIEWPORT_HEIGHT;

        // Create overlay handling tools
        this.handlingTools = [
            new CursorTool({
                page: this.page,
                config: init.interaction,
                cursorExtension: init.cursorExtension,
                positioning: this.positioning,
            }),
            new ClickTool({
                page: this.page,
                config: init.interaction,
                cursorExtension: init.cursorExtension,
                positioning: this.positioning,
                navigationExtension: init.navigationExtension,
            }),
            new FindTool({
                page: this.page,
                config: init.interaction,
                positioning: this.positioning,
            }),
            new ScreenshotTool({
                page: this.page,
                config: init.interaction,
                cursorExtension: init.cursorExtension,
            }),
            new WaitTool({ config: init.interaction }),
            new ReportOverlayResultTool(),
        ];
    }

    // --- Public API ---

    /**
     * Whether the extension is currently in overlay handling mode.
     */
    isInHandlingMode(ctx: OcrExtensionExecutionContext): boolean {
        return ctx.state.overlay.mode === "handling";
    }

    /**
     * Get the result of overlay handling.
     */
    getResult(ctx: OcrExtensionExecutionContext): OverlayResult | null {
        return ctx.state.overlay.result;
    }

    // --- State ---

    override getInitialState(): Partial<import("./base").OcrBaseStateInterface> {
        return { overlay: createOverlayState() };
    }

    // --- Tools ---

    /**
     * Filter tool definitions sent to the model during handling mode.
     * Removes the idle-mode dismiss-overlay tool and adds handling-mode tools
     * (including ReportOverlayResultTool).
     */
    async onFilterTools(ctx: OcrExtensionExecutionContext, tools: Tool[]): Promise<Tool[]> {
        if (ctx.state.overlay.mode !== "handling") return tools;
        return [...tools.filter((t) => t.name !== "dismiss-overlay"), ...this.handlingTools.map((t) => t.tool)];
    }

    /**
     * Filter executable tools during handling mode.
     * Removes the idle-mode dismiss-overlay tool and adds handling-mode tools
     * (including ReportOverlayResultTool).
     */
    async onFilterExecutionTools(ctx: OcrExtensionExecutionContext, tools: OcrTool<any>[]): Promise<OcrTool<any>[]> {
        if (ctx.state.overlay.mode !== "handling") return tools;
        return [...tools.filter((t) => t.tool.name !== "dismiss-overlay"), ...this.handlingTools];
    }

    // --- Lifecycle hooks ---

    /**
     * Dispatch dismiss-overlay calls based on current mode.
     * In handling mode, the call must be the report variant (status is required by schema).
     * Outside handling mode, the call must be the idle variant (description only).
     */
    async onToolCall(ctx: OcrExtensionExecutionContext, toolCall: ToolCall): Promise<ToolResultMessage | undefined> {
        if (toolCall.name !== "dismiss-overlay") {
            return undefined;
        }

        if (ctx.state.overlay.mode === "handling") {
            // Must be the report variant — status is required by schema
            const args = toolCall.arguments as { status: "success" | "failure"; message?: string };
            return this.handleStatusReport(ctx, args);
        }

        // Must be the idle variant — description only
        const args = toolCall.arguments as { description?: string };
        return this.enterHandlingMode(ctx, toolCall, args);
    }

    /**
     * Hard-enforce the overlay round budget (issue 6).
     * Detect stale handling mode when rounds are exhausted and force-exit.
     */
    async onRoundStart(ctx: OcrExtensionExecutionContext): Promise<boolean | void> {
        if (ctx.state.overlay.mode !== "handling") return;

        const roundsSpent = ctx.currentRound - ctx.state.overlay.handlingStartRound;
        if (roundsSpent >= this.maxIterations) {
            ctx.log?.(`[overlay] Hard-enforcing round budget: ${roundsSpent} >= ${this.maxIterations}`);

            const result: OverlayResult = {
                success: false,
                message: `Overlay not dismissed after ${this.maxIterations} rounds (budget exhausted)`,
            };

            // Build tool result BEFORE exitHandlingMode clears savedDismissCall
            const toolResult = this.buildToolResult(ctx, result);

            await this.exitHandlingMode(ctx, result);

            // Append tool result to complete the dismiss-overlay call in the restored main conversation
            ctx.appendMessages([toolResult], "OverlayExtension:budgetExhausted");

            // Skip this round — the main loop continues normally on the next round
            // with the restored conversation
            return false;
        }
    }

    /**
     * Pop messages and restore viewport on error (issue 2).
     */
    async onError(ctx: OcrExtensionExecutionContext, _error: Error): Promise<void> {
        if (ctx.state.overlay.mode === "handling") {
            ctx.log?.(`[overlay] Error during handling mode, cleaning up`);

            const result: OverlayResult = {
                success: false,
                message: `Overlay handling interrupted by error: ${_error.message}`,
            };

            // Build tool result BEFORE exitHandlingMode clears savedDismissCall
            const toolResult = this.buildToolResult(ctx, result);

            await this.exitHandlingMode(ctx, result);

            // Append tool result to complete the dismiss-overlay call in the restored main conversation
            ctx.appendMessages([toolResult], "OverlayExtension:error");
        }
    }

    /**
     * When in handling mode, inject overlay-specific guidance before each completion.
     * Also enforces the max iterations limit with a soft prompt.
     */
    async onBeforeCompletion(ctx: OcrExtensionExecutionContext, messages: Message[]): Promise<void> {
        if (ctx.state.overlay.mode !== "handling") return;

        const roundsSpent = ctx.currentRound - ctx.state.overlay.handlingStartRound;

        // Soft enforcement: tell the model to report failure when nearing the limit.
        // Hard enforcement happens in onRoundStart.
        if (roundsSpent >= this.maxIterations - 1) {
            messages.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Maximum overlay handling rounds reached. Call dismiss-overlay with status='failure' and describe what happened.",
                    },
                ],
                timestamp: Date.now(),
            });
            return;
        }

        // Inject overlay handling system instructions as the first message
        const overlayInstructions = render("overlay/handling-guide", {
            toolSnippets: this.handlingTools.map((t) => t.tool.promptSnippet).filter((s): s is string => s != null),
            toolGuidelines: this.handlingTools
                .map((t) => t.tool.promptGuidelines)
                .filter((g): g is string => g != null),
        });
        messages.unshift({
            role: "user",
            content: [{ type: "text", text: overlayInstructions }],
            timestamp: Date.now(),
        });

        // Inject reminder if the model has been trying for a while
        if (roundsSpent >= 5 && roundsSpent % 3 === 0) {
            messages.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `Reminder: you are still handling an overlay (round ${roundsSpent}/${this.maxIterations}). If the overlay cannot be dismissed, call dismiss-overlay with status='failure'.`,
                    },
                ],
                timestamp: Date.now(),
            });
        }
    }

    // --- Private methods ---

    private async enterHandlingMode(
        ctx: OcrExtensionExecutionContext,
        toolCall: ToolCall,
        args: { description?: string },
    ): Promise<ToolResultMessage> {
        // Guard against re-entering handling mode (issue 3)
        if (ctx.state.overlay.mode === "handling") {
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [
                    {
                        type: "text",
                        text: "Already in overlay handling mode. Call dismiss-overlay with status='success' or status='failure' to report the result first.",
                    },
                ],
                isError: true,
                timestamp: Date.now(),
            };
        }

        ctx.log?.(`[overlay] Entering handling mode${args.description ? `: ${args.description}` : ""}`);
        ctx.updateUI?.({ message: "Handling overlay..." });

        ctx.state.overlay.mode = "handling";
        ctx.state.overlay.handlingStartRound = ctx.currentRound;
        ctx.state.overlay.savedDismissCall = {
            toolCallId: toolCall.id,
            description: args.description ?? "",
        };

        // Push current messages onto the stack and start fresh
        ctx.pushMessages("OverlayExtension:enterHandling");

        // Save actual viewport and set fixed dimensions for handling
        const viewport = this.page.viewport();
        if (viewport) {
            ctx.state.overlay.savedViewport = { width: viewport.width, height: viewport.height };
        }
        await this.page.setViewport({
            width: this.width,
            height: Math.min(this.maxHeight, this.width),
        });

        // Take a screenshot for context
        const screenshot = await captureScreenshot(this.page, {
            debug: true,
            positioning: this.positioning,
        });

        return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [
                { type: "image", data: screenshot, mimeType: "image/png" },
                {
                    type: "text",
                    text:
                        "Overlay detected. Use your normal tools (click, cursor, find, screenshot, wait, etc.) to dismiss it. " +
                        "When the overlay is gone, call dismiss-overlay with status='success'. " +
                        "If it cannot be dismissed, call dismiss-overlay with status='failure'.",
                },
            ],
            isError: false,
            timestamp: Date.now(),
        };
    }

    private async handleStatusReport(
        ctx: OcrExtensionExecutionContext,
        args: { status?: "success" | "failure"; message?: string },
    ): Promise<ToolResultMessage> {
        const success = args.status === "success";
        const message = args.message ?? (success ? "Overlay dismissed" : "Could not dismiss overlay");

        ctx.log?.(`[overlay] Status report: ${args.status}${args.message ? ` - ${args.message}` : ""}`);

        const result: OverlayResult = { success, message };

        // Build tool result BEFORE exitHandlingMode, which may invalidate savedDismissCall
        const toolResult = this.buildToolResult(ctx, result);

        // Exit handling mode: pop messages, restore viewport
        await this.exitHandlingMode(ctx, result);

        if (success) {
            ctx.updateUI?.({ message: "Overlay dismissed!" });
        } else {
            ctx.updateUI?.({ message: `Overlay handling failed: ${message}` });
        }

        // Return a tool result using the ORIGINAL dismiss-overlay call ID.
        // processToolCalls pushes this to the restored main conversation,
        // completing the tool call -> result pair without synthetic messages.
        return toolResult;
    }

    /**
     * Centralized cleanup for exiting handling mode (issues 1, 2, 6).
     *
     * 1. Pops the saved messages from the stack
     * 2. Restores the viewport
     * 3. Transitions mode to "done"
     *
     * Does NOT inject messages. The caller is responsible for ensuring the
     * main conversation has a coherent tool call -> result pair:
     * - handleStatusReport: returns a ToolResultMessage (pushed by processToolCalls)
     * - onRoundStart/onError: appends via ctx.appendMessages
     */
    private async exitHandlingMode(ctx: OcrExtensionExecutionContext, result: OverlayResult): Promise<void> {
        ctx.state.overlay.mode = "done";
        ctx.state.overlay.result = result;

        // Restore original messages from the stack
        ctx.popMessages("OverlayExtension:exitHandling");

        // Restore viewport to pre-handling dimensions
        const savedViewport = ctx.state.overlay.savedViewport;
        if (savedViewport) {
            await this.page.setViewport(savedViewport);
            ctx.state.overlay.savedViewport = null;
        }
    }

    /**
     * Build a tool result using the saved original dismiss-overlay call ID.
     */
    private buildToolResult(ctx: OcrExtensionExecutionContext, result: OverlayResult): ToolResultMessage {
        const toolCallId = ctx.state.overlay.savedDismissCall?.toolCallId ?? "unknown";

        if (result.success) {
            return {
                role: "toolResult",
                toolCallId,
                toolName: "dismiss-overlay",
                content: [{ type: "text", text: `Overlay dismissed: ${result.message}` }],
                isError: false,
                timestamp: Date.now(),
            };
        }

        return {
            role: "toolResult",
            toolCallId,
            toolName: "dismiss-overlay",
            content: [{ type: "text", text: `Could not dismiss overlay: ${result.message}` }],
            isError: true,
            timestamp: Date.now(),
        };
    }

    private async waitForPageSettle(): Promise<void> {
        try {
            await this.page.waitForNetworkIdle({ timeout: 5000 });
        } catch {
            // Ignore timeout
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}
