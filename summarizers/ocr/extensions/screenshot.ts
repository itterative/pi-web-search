import type { Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Page } from "puppeteer";

import { OcrExtension, type OcrExtensionExecutionContext } from "./base";
import type { CursorExtension } from "./cursor";
import type { InteractionPositioning } from "../state";
import { captureScreenshot, ScreenshotMimeAddition } from "../screenshot";

/**
 * Context needed for the screenshot extension.
 */
export interface ScreenshotExtensionInit {
    page: Page;
    /** Optional reference to cursor extension for debug screenshots */
    cursorExtension?: CursorExtension;
    /** Positioning mode for coordinate normalization */
    positioning: InteractionPositioning;
    /** Number of recent cursor positions to show in debug screenshots (default: 5) */
    maxHistoryEntries?: number;
}

/**
 * Extension that processes screenshot placeholders in tool results and user messages.
 *
 * Looks for image content with mime types like "image/png+raw" or "image/png+debug"
 * that have empty data, captures the actual screenshot, and fills it in.
 *
 * - Tool results: processed via onToolResult
 * - User messages: processed via onBeforeCompletion
 */
export class ScreenshotExtension extends OcrExtension {
    readonly name = "screenshot";

    private page: Page;
    private cursorExtension: CursorExtension | undefined;
    private positioning: InteractionPositioning;
    private maxHistoryEntries: number;

    constructor(init: ScreenshotExtensionInit) {
        super();
        this.page = init.page;
        this.cursorExtension = init.cursorExtension;
        this.positioning = init.positioning;
        this.maxHistoryEntries = init.maxHistoryEntries ?? 5;
    }

    async onToolResult(
        _ctx: OcrExtensionExecutionContext,
        _toolCall: ToolCall,
        result: ToolResultMessage,
    ): Promise<void> {
        await this.processScreenshotPlaceholders(result.content);
    }

    async onBeforeCompletion(_ctx: OcrExtensionExecutionContext, messages: Message[]): Promise<void> {
        // Process user message images
        for (const msg of messages) {
            if (msg.role !== "user" || typeof msg.content === "string") {
                continue;
            }

            await this.processScreenshotPlaceholders(msg.content);
        }
    }

    // --- Public API for tools ---

    /**
     * Get the page instance.
     */
    getPage(): Page {
        return this.page;
    }

    // --- Helper methods ---

    /**
     * Processes image content and populates any empty screenshot placeholders.
     */
    private async processScreenshotPlaceholders(content: Message["content"]): Promise<void> {
        if (typeof content === "string") return;

        for (const part of content) {
            if (part.type !== "image" || part.data !== "") {
                continue;
            }

            const parsed = this.parseMimeWithAddition(part.mimeType);
            if (!parsed || (parsed.addition !== "raw" && parsed.addition !== "debug")) {
                continue;
            }

            const addition = parsed.addition as ScreenshotMimeAddition;

            // Get cursor history with positioning-aware coordinates
            const cursorHistory = this.cursorExtension
                ? await this.cursorExtension.getRecentHistory(this.maxHistoryEntries)
                : [];

            // Capture screenshot with or without debug overlay
            const screenshotData = await captureScreenshot(this.page, {
                debug: addition === "debug",
                positioning: this.positioning,
                cursorHistory,
            });

            // Update the content in place
            part.data = screenshotData;
            part.mimeType = parsed.base;
        }
    }

    /**
     * Parses a mime type with addition (e.g., "image/png+debug" -> { base: "image/png", addition: "debug" }).
     */
    private parseMimeWithAddition(mimeType: string): { base: string; addition: string } | null {
        const match = mimeType.match(/^(image\/[^+]+)\+(.+)$/);
        if (!match) {
            return null;
        }

        return {
            base: match[1],
            addition: match[2],
        };
    }
}
