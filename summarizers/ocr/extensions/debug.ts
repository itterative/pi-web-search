import type { Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Page } from "puppeteer";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import { OcrExtension, type OcrExtensionExecutionContext, type MessageChange } from "./base";
import type { CursorExtension } from "./cursor";
import type { InteractionPositioning } from "../state";
import { addCoordinateGrid } from "../screenshot";

/**
 * Context needed for the debug extension.
 */
export interface DebugExtensionInit {
    page: Page;
    /** Optional reference to cursor extension for accessing cursor history in screenshots */
    cursorExtension?: CursorExtension;
    /** Positioning mode for coordinate normalization */
    positioning: InteractionPositioning;
    /** Number of recent cursor positions to show in debug screenshots (default: 5) */
    maxHistoryEntries?: number;
}

/**
 * Extension for debug logging and screenshot saving.
 *
 * Handles:
 * - Saving debug screenshots with coordinate grids
 * - Saving screenshots from tool results (zoom tool, etc.)
 * - Tracking tool names for debug naming
 * - Logging extension lifecycle events
 *
 * Debug directory is controlled by PI_WEBSEARCH_DEBUG_DIR env var,
 * defaults to "debug/" if not set.
 */
export class DebugExtension extends OcrExtension {
    readonly name = "debug";

    private page: Page;
    private enabled: boolean;
    private screenshotsEnabled: boolean;
    private debugDir: string;
    private cursorExtension: CursorExtension | undefined;
    private positioning: InteractionPositioning;
    private maxHistoryEntries: number;
    private currentToolName: string = "";
    private sessionDate: string;

    /** Round tracking for determining when to take round-end screenshots */
    private trackedRound: number = -1;
    /** Whether the current tracked round had a screenshot in tool results */
    private roundHadScreenshot: boolean = false;

    /** Fingerprint of the last message we wrote to the conversation file */
    private lastWrittenFingerprint: string | null = null;
    /** Index of the last message we wrote (for quick lookup) */
    private lastWrittenIndex: number = -1;

    constructor(init: DebugExtensionInit) {
        super();

        this.enabled = process.env.PI_WEB_SEARCH_DEBUG === "1" || process.env.PI_WEB_SEARCH_DEBUG === "true";
        this.screenshotsEnabled =
            process.env.PI_WEB_SEARCH_DEBUG_SCREENSHOTS === "1" ||
            process.env.PI_WEB_SEARCH_DEBUG_SCREENSHOTS === "true";
        this.debugDir = process.env.PI_WEB_SEARCH_DEBUG_DIR ?? "debug";

        this.page = init.page;
        this.cursorExtension = init.cursorExtension;
        this.positioning = init.positioning;
        this.maxHistoryEntries = init.maxHistoryEntries ?? 5;

        this.sessionDate = new Date().toISOString().replace(/[:.]/g, "-");
    }

    onInit(ctx: OcrExtensionExecutionContext): Promise<void> {
        if (!this.enabled) {
            return Promise.resolve();
        }

        ctx.log?.(`[debug] Debug extension initialized (dir: ${this.debugDir})`);
        return Promise.resolve();
    }

    onToolCall(_ctx: OcrExtensionExecutionContext, toolCall: ToolCall): Promise<void> {
        this.currentToolName = toolCall.name;
        return Promise.resolve();
    }

    async onToolResult(
        ctx: OcrExtensionExecutionContext,
        _toolCall: ToolCall,
        result: ToolResultMessage,
    ): Promise<void> {
        if (!this.enabled || !this.screenshotsEnabled) {
            return;
        }

        // Update round tracking
        if (this.trackedRound !== ctx.currentRound) {
            this.trackedRound = ctx.currentRound;
            this.roundHadScreenshot = false;
        }

        // Look for the latest image in tool result content
        let latestImage: { data: string; mimeType: string } | undefined;

        if (Array.isArray(result.content)) {
            // Iterate in reverse to find the last image
            for (let i = result.content.length - 1; i >= 0; i--) {
                const item = result.content[i];
                if (item.type === "image") {
                    latestImage = { data: item.data, mimeType: item.mimeType };
                    break;
                }
            }
        }

        if (latestImage && latestImage.data) {
            this.roundHadScreenshot = true;

            // Save the screenshot from tool result
            await this.saveToolResultScreenshot(ctx, result.toolName, latestImage.data, result.isError);
        }
    }

    async onRoundEnd(ctx: OcrExtensionExecutionContext): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // Save conversation at end of each round
        await this.saveConversation(ctx);

        if (!this.screenshotsEnabled) {
            return;
        }

        // Only save debug screenshot at round end if:
        // 1. No tool results were processed this round (trackedRound != currentRound), OR
        // 2. Tool results were processed but none had screenshots
        const hadToolResults = this.trackedRound === ctx.currentRound;
        const needsRoundEndScreenshot = !hadToolResults || !this.roundHadScreenshot;

        if (needsRoundEndScreenshot) {
            await this.saveDebugScreenshot(
                ctx,
                `${this.sessionDate}__round${String(ctx.currentRound).padStart(2, "0")}_${this.currentToolName || "end"}`,
            );
        }
    }

    async onError(ctx: OcrExtensionExecutionContext, error: Error): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // Save conversation on error for debugging
        await this.saveConversation(ctx, error);
    }

    async onComplete(ctx: OcrExtensionExecutionContext): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // Save final conversation state with completion marker
        await this.saveConversation(ctx, undefined, true);
    }

    async onMessagesChanged(ctx: OcrExtensionExecutionContext, change: MessageChange): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // Reset tracking when messages are replaced or truncated (compression)
        if (change.type === "replace" || change.type === "truncate") {
            ctx.log?.(
                `[debug] Messages ${change.type}: ${change.previousCount} -> ${change.type === "replace" ? change.messages.length : change.count} (source: ${change.source})`,
            );
            this.lastWrittenFingerprint = null;
            this.lastWrittenIndex = -1;
        } else if (change.type === "append") {
            ctx.log?.(`[debug] Messages appended: +${change.messages.length} (source: ${change.source})`);
        }

        // Save conversation at end of each round
        await this.saveConversation(ctx);
    }

    /**
     * Format a message for debug output, filtering out image data.
     */
    private formatMessage(message: Message): string {
        const timestamp = new Date(message.timestamp).toISOString();

        switch (message.role) {
            case "user": {
                let content: string;
                if (typeof message.content === "string") {
                    content = message.content;
                } else {
                    // Filter out image data from content array
                    content = message.content
                        .map((c) => {
                            if (c.type === "text") {
                                return c.text;
                            } else if (c.type === "image") {
                                return `[IMAGE: ${c.mimeType}, ${c.data.length} bytes]`;
                            }
                            return "";
                        })
                        .join("\n");
                }
                return `[USER] ${timestamp}\n${content}`;
            }

            case "assistant": {
                const content = message.content
                    .map((c) => {
                        if (c.type === "text") {
                            return c.text;
                        } else if (c.type === "thinking") {
                            const prefix = c.redacted ? "[REDACTED THINKING]" : "[THINKING]";
                            return `${prefix}\n${c.thinking}`;
                        } else if (c.type === "toolCall") {
                            return `[TOOL CALL] ${c.name}(${JSON.stringify(c.arguments, null, 2)})`;
                        }
                        return "";
                    })
                    .join("\n");
                return `[ASSISTANT] ${timestamp} (${message.provider}/${message.model})\n${content}`;
            }

            case "toolResult": {
                const content = message.content
                    .map((c) => {
                        if (c.type === "text") {
                            return c.text;
                        } else if (c.type === "image") {
                            return `[IMAGE: ${c.mimeType}, ${c.data.length} bytes]`;
                        }
                        return "";
                    })
                    .join("\n");
                const status = message.isError ? "ERROR" : "OK";
                return `[TOOL RESULT] ${timestamp} (${message.toolName}, ${status})\n${content}`;
            }

            default: {
                // Fallback for unknown message types
                const role = (message as { role?: string }).role ?? "unknown";
                return `[${role.toUpperCase()}] ${timestamp}`;
            }
        }
    }

    /**
     * Create a fingerprint for a message to track what we've already written.
     * Uses role + timestamp for uniqueness.
     */
    private getMessageFingerprint(message: Message): string {
        return `${message.role}:${message.timestamp}`;
    }

    /**
     * Find the index of the last written message in the current messages array.
     * Uses the tracked index for quick lookup, verifies with fingerprint.
     * Returns -1 if not found (e.g., compression happened).
     */
    private findLastWrittenIndex(messages: Message[]): number {
        if (!this.lastWrittenFingerprint || this.lastWrittenIndex < 0) {
            return -1;
        }

        // Check if the tracked index is still valid and matches fingerprint
        if (
            this.lastWrittenIndex < messages.length &&
            this.getMessageFingerprint(messages[this.lastWrittenIndex]) === this.lastWrittenFingerprint
        ) {
            return this.lastWrittenIndex;
        }

        // Fingerprint mismatch - compression happened
        return -1;
    }

    private async saveConversation(
        ctx: OcrExtensionExecutionContext,
        error?: Error,
        isComplete = false,
    ): Promise<void> {
        try {
            // Ensure directory exists
            await mkdir(this.debugDir, { recursive: true, mode: 0o640 });

            const filePath = path.join(this.debugDir, `${this.sessionDate}_conversation.txt`);
            const messages = ctx.state.base.messages;

            // Find where we left off
            const lastIndex = this.findLastWrittenIndex(messages);
            const startIndex = lastIndex + 1;

            // Build round header
            const lines: string[] = [];
            lines.push("");
            lines.push("");
            lines.push("=".repeat(80));

            if (error) {
                lines.push(`ERROR - ${new Date().toISOString()}`);
                lines.push(error.message);
            } else if (isComplete) {
                lines.push(`COMPLETE - ${new Date().toISOString()}`);
            } else {
                lines.push(`ROUND ${ctx.currentRound} - ${new Date().toISOString()}`);
            }

            // Indicate if this is a continuation or full output (compression happened)
            if (lastIndex >= 0) {
                lines.push(`(continuing from message ${lastIndex + 1})`);
            } else if (this.lastWrittenFingerprint !== null) {
                lines.push("(CONTEXT WAS COMPRESSED - showing full conversation)");
            }

            lines.push("=".repeat(80));
            lines.push("");
            lines.push("");

            // Include system prompt for round 0
            if (ctx.currentRound === 0) {
                lines.push("[SYSTEM PROMPT]");
                lines.push(ctx.systemPrompt);
                lines.push("-".repeat(40));
            }

            // Only write new messages
            const newMessages = messages.slice(startIndex);
            ctx.log?.(`[debug] Writing ${newMessages.length} new messages (from index ${startIndex})`);

            for (const message of newMessages) {
                const formatted = this.formatMessage(message);
                lines.push(formatted);
                lines.push("-".repeat(40));
            }

            // Update fingerprint and index to last message written (if any)
            if (messages.length > 0) {
                this.lastWrittenIndex = messages.length - 1;
                this.lastWrittenFingerprint = this.getMessageFingerprint(messages[this.lastWrittenIndex]);
            }

            // Append to file
            await appendFile(filePath, lines.join("\n"));

            // ctx.log?.(`[debug] Saved conversation: ${filePath}`);
        } catch (e) {
            ctx.log?.(`[debug] Failed to save conversation: ${e}`);
        }
    }

    /**
     * Save a screenshot from a tool result (e.g., zoom tool).
     */
    private async saveToolResultScreenshot(
        ctx: OcrExtensionExecutionContext,
        toolName: string,
        imageData: string,
        isError: boolean,
    ): Promise<void> {
        try {
            // Ensure directory exists
            await mkdir(this.debugDir, { recursive: true, mode: 0o640 });

            const status = isError ? "error" : "ok";
            const fileName = `${this.sessionDate}__round${String(ctx.currentRound).padStart(2, "0")}_${toolName}_${status}`;
            const filePath = path.join(this.debugDir, `${fileName}.png`);

            await writeFile(filePath, Buffer.from(imageData, "base64"));

            ctx.log?.(`[debug] Saved tool result screenshot: ${filePath}`);
        } catch (e) {
            ctx.log?.(`[debug] Failed to save tool result screenshot: ${e}`);
        }
    }

    /**
     * Save a debug screenshot with coordinate grid overlay.
     */
    private async saveDebugScreenshot(ctx: OcrExtensionExecutionContext, name: string): Promise<void> {
        if (!this.enabled) {
            return;
        }

        try {
            const screenshot = await this.page.screenshot({
                encoding: "base64",
            });

            const { width, height } = await this.page.evaluate(() => ({
                width: window.innerWidth * window.devicePixelRatio,
                height: window.innerHeight * window.devicePixelRatio,
            }));

            const clickHistory = (await this.cursorExtension?.getRecentHistory(this.maxHistoryEntries)) ?? [];

            const gridScreenshot = await addCoordinateGrid(screenshot as string, width, height, {
                positioning: this.positioning,
                clickHistory,
            });

            // Ensure directory exists
            await mkdir(this.debugDir, { recursive: true, mode: 0o640 });

            // Save screenshot to file
            const filePath = path.join(this.debugDir, `${name}.png`);
            await writeFile(filePath, Buffer.from(gridScreenshot, "base64"));

            ctx.log?.(`[debug] Saved debug screenshot: ${filePath}`);
        } catch (e) {
            ctx.log?.(`[debug] Failed to save debug screenshot: ${e}`);
        }
    }
}
