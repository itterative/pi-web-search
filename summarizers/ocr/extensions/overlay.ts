import { complete, type Model, type Message, type Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Page } from "puppeteer";

import { OcrExtension, type OcrExtensionExecutionContext } from "./base";
import { render } from "../instructions";
import type { OcrRunOptions } from "../config";
import type { CursorExtension } from "./cursor";
import { OVERLAY_VIEWPORT_WIDTH, OVERLAY_VIEWPORT_HEIGHT, captureScreenshot } from "../screenshot";
import type { InteractionPositioning } from "../state";
import { safeCursorClick } from "../common/interact";

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
    model: Model<any>;
    apiKey: string | undefined;
    positioning: InteractionPositioning;
    /** Maximum iterations for overlay handling (default: 20) */
    maxIterations?: number;
    /** Optional reference to cursor extension for click history in debug screenshots */
    cursorExtension?: CursorExtension;
    /** Viewport width to restore after overlay handling */
    width?: number;
    /** Viewport height to restore after overlay handling */
    maxHeight?: number;
}

/**
 * State for overlay handling.
 */
export interface OverlayState {
    /** Whether an overlay was detected */
    detected: boolean;
    /** Whether the overlay has been handled (successfully or not) */
    handled: boolean;
    /** Result of overlay handling (set after handling completes) */
    result: OverlayResult | null;
}

/** Tool definitions for overlay handling */
const OVERLAY_CLICK_TOOL: Tool = {
    name: "click",
    description: "Click/tap at specific coordinates on the screenshot.",
    parameters: Type.Object({
        x: Type.Number({
            description: "X coordinate (0.0 = left, 1.0 = right)",
        }),
        y: Type.Number({
            description: "Y coordinate (0.0 = top, 1.0 = bottom)",
        }),
    }),
};

const OVERLAY_WAIT_TOOL: Tool = {
    name: "wait",
    description: "Wait for the page to change or load.",
    parameters: Type.Object({
        duration: Type.Optional(
            Type.Number({
                description: "Duration in ms (default: 1000, max: 5000)",
            }),
        ),
    }),
};

const OVERLAY_FINISH_TOOL: Tool = {
    name: "finish",
    description: "Signal that handling is complete.",
    parameters: Type.Object({
        status: Type.Union([Type.Literal("success"), Type.Literal("failure")], {
            description: "'success' if overlay dismissed, 'failure' if cannot dismiss",
        }),
        message: Type.Optional(Type.String({ description: "Optional explanation" })),
    }),
};

const OVERLAY_TOOLS = [OVERLAY_CLICK_TOOL, OVERLAY_WAIT_TOOL, OVERLAY_FINISH_TOOL];

/**
 * Extension that detects and handles page overlays (captchas, cookie consent, verification pages).
 *
 * This extension:
 * 1. Detects overlays at initialization (`onInit`)
 * 2. If detected, handles them before the main summarizer starts (`onRoundStart`)
 *
 * The handling process runs its own internal interaction loop with click, wait, and finish tools.
 *
 * @example
 * ```ts
 * const overlayExt = new OverlayExtension({
 *   page,
 *   model,
 *   apiKey,
 *   positioning: { type: "relative", x: 1000, y: 1000 },
 * });
 * registry.register(overlayExt);
 *
 * // After running the summarizer:
 * if (overlayExt.getResult()?.success === false) {
 *   throw new Error("Overlay not dismissed");
 * }
 * ```
 */
export class OverlayExtension extends OcrExtension {
    readonly name = "overlay";

    private page: Page;
    private model: Model<any>;
    private apiKey: string | undefined;
    private positioning: InteractionPositioning;
    private maxIterations: number;
    private cursorExtension: CursorExtension | undefined;
    private width: number;
    private maxHeight: number;

    private state: OverlayState = {
        detected: false,
        handled: false,
        result: null,
    };

    // Internal tracking during handling
    private actionHistory: string[] = [];
    private clickHistory: Array<{ x: number; y: number }> = [];
    private previousScreenshot = "";
    private hadClickLastRound = false;

    constructor(init: OverlayExtensionInit) {
        super();

        this.page = init.page;
        this.model = init.model;
        this.apiKey = init.apiKey;
        this.positioning = init.positioning;
        this.maxIterations = init.maxIterations ?? 20;
        this.cursorExtension = init.cursorExtension;
        this.width = init.width ?? OVERLAY_VIEWPORT_WIDTH;
        this.maxHeight = init.maxHeight ?? OVERLAY_VIEWPORT_HEIGHT;
    }

    private wrapContext(ctx: OcrExtensionExecutionContext): OcrExtensionExecutionContext {
        return {
            ...ctx,
            log: (msg, type) => ctx.log?.(`[overlay] ${msg}`, type),
        };
    }

    // Lifecycle hooks
    async onBeforeRun(ctx: OcrExtensionExecutionContext, options: OcrRunOptions): Promise<void> {
        ctx = this.wrapContext(ctx);

        ctx.log?.("Checking for overlays...");

        // Set fixed viewport for overlay handling
        await this.page.setViewport({
            width: OVERLAY_VIEWPORT_WIDTH,
            height: OVERLAY_VIEWPORT_HEIGHT,
        });

        this.state.detected = await this.detectOverlay(ctx);

        if (!this.state.detected) {
            ctx.log?.("No overlay detected");
            // Restore viewport before proceeding
            await this.page.setViewport({
                width: this.width,
                height: this.maxHeight,
            });
            return;
        }

        // Overlay detected - handle it
        ctx.log?.("Overlay detected, attempting to dismiss...");
        ctx.updateUI?.({
            message: "Overlay detected, attempting to dismiss...",
        });

        const result = await this.handleOverlay(ctx);
        this.state.result = result;
        this.state.handled = true;

        if (result.success) {
            ctx.log?.(`Overlay dismissed: ${result.message}`);
            ctx.updateUI?.({ message: "Overlay dismissed!" });
            await this.waitForPageSettle();
        } else {
            ctx.log?.(`Overlay handling failed: ${result.message}`, "error");
        }

        // Restore viewport
        await this.page.setViewport({
            width: this.width,
            height: this.maxHeight,
        });

        // Update screenshot in options so buildInitialMessage uses the new one
        options.screenshot = await captureScreenshot(this.page, {
            debug: false,
            positioning: this.positioning,
        });

        ctx.log?.("Updated screenshot after overlay handling");
    }

    // Public API
    isOverlayDetected(): boolean {
        return this.state.detected;
    }

    isOverlayHandled(): boolean {
        return this.state.handled;
    }

    getResult(): OverlayResult | null {
        return this.state.result;
    }

    getState(): OverlayState {
        return { ...this.state };
    }

    // Helper methods for eta templates
    private getToolSnippets(): string[] {
        return [
            `Click/tap at specific coordinates on the screenshot.
- X coordinate (0.0 = left, 1.0 = right)
- Y coordinate (0.0 = top, 1.0 = bottom)`,
            `Wait for the page to change or load.
- Duration in ms (default: 1000, max: 5000)`,
            `Signal that handling is complete.
- 'success' if overlay dismissed
- 'failure' if cannot dismiss
- Optional message explaining the result`,
        ];
    }

    private getToolGuidelines(): string[] {
        return [
            "Use click with relative coordinates (0.0-1.0). The grid overlay helps estimate positions.",
            "Use wait after clicking or when content appears to be loading (blurred, spinner).",
            "Call finish with 'success' when the main page content is visible (no more overlay).",
            "Call finish with 'failure' if the overlay cannot be dismissed or the page is broken.",
            "If clicks are correct but nothing changes after 2-3 attempts, the page may be broken - give up.",
            "Don't waste attempts on broken or malicious overlays.",
        ];
    }

    /**
     * Run detection and return whether an overlay was found.
     * Useful for standalone use without the extension lifecycle.
     */
    async detect(ctx: OcrExtensionExecutionContext): Promise<boolean> {
        await this.page.setViewport({
            width: OVERLAY_VIEWPORT_WIDTH,
            height: OVERLAY_VIEWPORT_HEIGHT,
        });
        const screenshot = await captureScreenshot(this.page, {
            debug: true,
            positioning: this.positioning,
        });
        const systemPrompt = render("overlay/detection");
        const message: Message = {
            role: "user",
            content: [
                { type: "image", data: screenshot, mimeType: "image/png" },
                {
                    type: "text",
                    text: "Does this screenshot show an overlay that blocks the main content? Answer only 'yes' or 'no'.",
                },
            ],
            timestamp: Date.now(),
        };
        const response = await complete(
            this.model,
            { systemPrompt, messages: [message] },
            { apiKey: this.apiKey, maxTokens: 1500 },
        );
        const allContent = this.extractTextContent(response.content);
        ctx.log?.(`Detection result: "${allContent.slice(0, 50)}..."`);
        this.state.detected = allContent.includes("yes");
        return this.state.detected;
    }
    /**
     * Run overlay handling. Returns the result.
     * Useful for standalone use without the extension lifecycle.
     */
    async handle(ctx: OcrExtensionExecutionContext): Promise<OverlayResult> {
        // Reset internal state
        this.actionHistory = [];
        this.clickHistory = [];
        this.previousScreenshot = "";
        this.hadClickLastRound = false;
        await this.page.setViewport({
            width: OVERLAY_VIEWPORT_WIDTH,
            height: OVERLAY_VIEWPORT_HEIGHT,
        });
        for (let iteration = 0; iteration < this.maxIterations; iteration++) {
            if (ctx.signal?.aborted) {
                return { success: false, message: "Cancelled" };
            }

            const result = await this.runHandlingIteration(ctx, iteration);
            if (result) {
                this.state.result = result;
                this.state.handled = true;
                return result;
            }
        }
        const result = {
            success: false,
            message: `Overlay not dismissed after ${this.maxIterations} attempts`,
        };
        this.state.result = result;
        this.state.handled = true;
        return result;
    }
    /**
     * Detect and handle overlay in one call.
     * Useful for standalone use without the extension lifecycle.
     */
    async detectAndHandle(ctx: OcrExtensionExecutionContext): Promise<OverlayResult> {
        const detected = await this.detect(ctx);
        if (!detected) {
            return { success: true, message: "No overlay detected" };
        }
        ctx.log?.("Overlay detected, attempting to dismiss...", "info");
        return this.handle(ctx);
    }

    async redetect(ctx: OcrExtensionExecutionContext): Promise<boolean> {
        ctx.log?.("Re-detecting overlays...");

        await this.page.setViewport({
            width: OVERLAY_VIEWPORT_WIDTH,
            height: OVERLAY_VIEWPORT_HEIGHT,
        });

        this.state.detected = await this.detectOverlay(ctx);

        if (this.state.detected) {
            this.state.handled = false;
            this.state.result = null;
        }

        return this.state.detected;
    }

    // Detection
    private async detectOverlay(ctx: OcrExtensionExecutionContext): Promise<boolean> {
        const screenshot = await captureScreenshot(this.page, {
            debug: true,
            positioning: this.positioning,
        });

        const systemPrompt = render("overlay/detection");
        const message: Message = {
            role: "user",
            content: [
                { type: "image", data: screenshot, mimeType: "image/png" },
                {
                    type: "text",
                    text: "Does this screenshot show an overlay that blocks the main content? Answer only 'yes' or 'no'.",
                },
            ],
            timestamp: Date.now(),
        };

        const response = await complete(
            this.model,
            { systemPrompt, messages: [message] },
            { apiKey: this.apiKey, signal: ctx.signal, maxTokens: 1500 },
        );

        const allContent = this.extractTextContent(response.content);
        ctx.log?.(`Detection result: "${allContent.slice(0, 50)}..."`);

        return allContent.includes("yes");
    }

    // Handling
    private async handleOverlay(ctx: OcrExtensionExecutionContext): Promise<OverlayResult> {
        // Reset internal state
        this.actionHistory = [];
        this.clickHistory = [];
        this.previousScreenshot = "";
        this.hadClickLastRound = false;

        for (let iteration = 0; iteration < this.maxIterations; iteration++) {
            if (ctx.signal?.aborted) {
                return { success: false, message: "Cancelled" };
            }

            const result = await this.runHandlingIteration(ctx, iteration);
            if (result) {
                return result;
            }
        }

        return {
            success: false,
            message: `Overlay not dismissed after ${this.maxIterations} attempts`,
        };
    }

    private async runHandlingIteration(
        ctx: OcrExtensionExecutionContext,
        iteration: number,
    ): Promise<OverlayResult | undefined> {
        ctx.updateUI?.({
            message: `Handling overlay (attempt ${iteration + 1}/${this.maxIterations})...`,
            round: iteration + 1,
            maxRounds: this.maxIterations,
        });

        // Take screenshot with grid overlay
        const { rawScreenshot, griddedScreenshot } = await this.takeGriddedScreenshot();

        // Check if screenshot changed
        const screenshotChanged = rawScreenshot !== this.previousScreenshot;
        this.previousScreenshot = rawScreenshot;

        // Build user message
        const userMessage = this.buildUserMessage(griddedScreenshot, screenshotChanged);

        // Get model response
        const response = await complete(
            this.model,
            {
                systemPrompt: render("overlay/system", {
                    toolSnippets: this.getToolSnippets(),
                    toolGuidelines: this.getToolGuidelines(),
                }),
                messages: [userMessage],
                tools: OVERLAY_TOOLS,
            },
            { apiKey: this.apiKey, signal: ctx.signal },
        );

        if (response.stopReason === "aborted") {
            return { success: false, message: "Cancelled" };
        }

        // Process tool calls
        const toolCalls = response.content.filter((c) => c.type === "toolCall");

        if (toolCalls.length === 0) {
            return this.handleNoToolCalls(ctx, response.content);
        }

        // Reset counters
        this.hadClickLastRound = false;

        // Process each tool call
        for (const tc of toolCalls) {
            if (tc.type !== "toolCall") continue;

            if (tc.name === "finish") {
                return this.handleFinish(ctx, tc.arguments);
            }

            if (tc.name === "click") {
                this.hadClickLastRound = true;
                await this.handleClick(ctx, tc.arguments, iteration);
            } else if (tc.name === "wait") {
                await this.handleWait(ctx, tc.arguments, iteration);
            }
        }

        // Brief settle delay after actions
        await new Promise((r) => setTimeout(r, 300));

        return undefined;
    }

    private async handleClick(
        ctx: OcrExtensionExecutionContext,
        args: Record<string, unknown>,
        iteration: number,
    ): Promise<void> {
        const relX = Number(args.x);
        const relY = Number(args.y);

        if (isNaN(relX) || isNaN(relY)) {
            this.actionHistory.push(`Click failed: invalid coordinates (${args.x}, ${args.y})`);
            return;
        }

        const clampedRelX = Math.max(0, Math.min(1, relX));
        const clampedRelY = Math.max(0, Math.min(1, relY));

        const pageX = Math.round(clampedRelX * OVERLAY_VIEWPORT_WIDTH);
        const pageY = Math.round(clampedRelY * OVERLAY_VIEWPORT_HEIGHT);

        ctx.log?.(`Click at (${clampedRelX.toFixed(2)}, ${clampedRelY.toFixed(2)}) -> page (${pageX}, ${pageY})`);

        try {
            const result = await safeCursorClick(this.page, pageX, pageY);

            if (!result.success) {
                this.actionHistory.push(`Click failed: ${result.error}`);
                return;
            }

            await new Promise((r) => setTimeout(r, 500));

            this.clickHistory.push({ x: clampedRelX, y: clampedRelY });
            this.actionHistory.push(`Clicked at (${clampedRelX.toFixed(2)}, ${clampedRelY.toFixed(2)})`);

            ctx.updateUI?.({
                message: `Clicked at (${clampedRelX.toFixed(2)}, ${clampedRelY.toFixed(2)})`,
                action: "click",
            });
        } catch (error) {
            this.actionHistory.push(`Click failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        await this.executeClick(ctx, clampedRelX, clampedRelY, pageX, pageY);
    }

    private async executeClick(
        ctx: OcrExtensionExecutionContext,
        clampedRelX: number,
        clampedRelY: number,
        pageX: number,
        pageY: number,
    ): Promise<void> {
        try {
            const result = await safeCursorClick(this.page, pageX, pageY);

            if (!result.success) {
                this.actionHistory.push(`Click failed: ${result.error}`);
                return;
            }

            await new Promise((r) => setTimeout(r, 500));

            this.clickHistory.push({ x: clampedRelX, y: clampedRelY });
            this.actionHistory.push(`Clicked at (${clampedRelX.toFixed(2)}, ${clampedRelY.toFixed(2)})`);

            ctx.updateUI?.({
                message: `Clicked at (${clampedRelX.toFixed(2)}, ${clampedRelY.toFixed(2)})`,
            });
        } catch (error) {
            this.actionHistory.push(`Click failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleWait(
        ctx: OcrExtensionExecutionContext,
        args: Record<string, unknown>,
        _iteration: number,
    ): Promise<void> {
        const duration = Math.min(Math.max(Number(args.duration) || 1000, 100), 5000);
        await new Promise((r) => setTimeout(r, duration));

        this.actionHistory.push(`Waited ${duration}ms`);
        ctx.updateUI?.({ message: `Waiting ${duration}ms...`, action: "wait" });
    }

    private handleFinish(ctx: OcrExtensionExecutionContext, args: Record<string, unknown>): OverlayResult {
        const status = args.status as "success" | "failure";
        const message =
            typeof args.message === "string"
                ? args.message
                : status === "success"
                  ? "Overlay dismissed"
                  : "Could not dismiss overlay";

        const result = { success: status === "success", message };

        if (result.success) {
            ctx.log?.(`Finished successfully: ${message}`);
        } else {
            ctx.log?.(`Finished with failure: ${message}`, "warning");
        }

        return result;
    }

    private handleNoToolCalls(
        ctx: OcrExtensionExecutionContext,
        content: Message["content"],
    ): OverlayResult | undefined {
        const allContent = this.extractTextContent(content);

        // Check for implicit success/failure
        if (allContent.includes("solved") || allContent.includes("success") || allContent.includes("completed")) {
            ctx.log?.("Model indicates overlay dismissed");
            return {
                success: true,
                message: "Model indicated overlay was dismissed",
            };
        }

        if (allContent.includes("failed") || allContent.includes("cannot solve") || allContent.includes("unable")) {
            ctx.log?.("Model indicates overlay cannot be dismissed", "warning");
            return {
                success: false,
                message: "Model indicated overlay cannot be dismissed",
            };
        }

        // Track consecutive no-action rounds
        this.hadClickLastRound = false;
        this.actionHistory.push("System: You must use tools to dismiss the overlay. Call 'finish' when done.");

        return undefined;
    }

    // Helpers
    private async takeGriddedScreenshot(): Promise<{
        rawScreenshot: string;
        griddedScreenshot: string;
    }> {
        const rawScreenshot = await captureScreenshot(this.page, {
            debug: false,
            positioning: this.positioning,
        });

        const griddedScreenshot = await captureScreenshot(this.page, {
            debug: true,
            positioning: this.positioning,
            cursorHistory: await this.cursorExtension?.getRecentHistory(5),
        });

        return { rawScreenshot, griddedScreenshot };
    }

    private buildUserMessage(screenshot: string, screenshotChanged: boolean): Message {
        const data = {
            positioning: this.positioning,
            clickHistory: this.clickHistory,
            actionHistory: this.actionHistory,
            warning:
                !screenshotChanged && this.hadClickLastRound
                    ? "The screenshot has NOT changed since the last action. Your previous click may have missed."
                    : undefined,
        };

        const text = render("overlay/initial-message", data);

        return {
            role: "user",
            content: [
                { type: "image", data: screenshot, mimeType: "image/png" },
                { type: "text", text },
            ],
            timestamp: Date.now(),
        };
    }

    private extractTextContent(content: Message["content"]): string {
        if (typeof content === "string") {
            return content.toLowerCase();
        }

        const textContent = content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text.toLowerCase().trim())
            .join("");

        const thinkingContent = content
            .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
            .map((c) => c.thinking.toLowerCase().trim())
            .join(" ");

        return textContent || thinkingContent;
    }

    private async waitForPageSettle(): Promise<void> {
        try {
            await this.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        } catch {
            // Ignore timeout
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}
