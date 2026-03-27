import { Static, Tool, ToolResultMessage, TSchema } from "@mariozechner/pi-ai";
import { TimeoutError } from "puppeteer";
import { ScreenshotMimeAddition } from "../screenshot";
import { SummarizerProgressUpdate } from "../../base";
import { sleep } from "../../../common/utils";

export class OcrToolValidationError extends Error {}

export type OcrToolDefinition<TParameters extends TSchema = TSchema> = Tool<TParameters> & {
    promptSnippet?: string;
    promptGuidelines?: string;
};

/**
 * Static options for tool construction (config that doesn't change per-run).
 */
export interface OcrToolOptions {
    logDebug?: (message: string) => void;
}

/**
 * Runtime context passed to tool execute() (callbacks and signal available at run-time).
 */
export interface OcrToolExecutionContext {
    /** The tool name for this execution (same as the one in the tool itself) */
    toolName: string;
    /** The tool call ID for this execution */
    toolCallId: string;
    /** UI update callback - just pass a message string */
    updateUI?: (update: SummarizerProgressUpdate) => void;
    /** Logging callback with optional severity */
    log?: (message: string, type?: "info" | "warning" | "error") => void;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}

function simpleTextMessage(
    toolName: string,
    toolCallId: string,
    message: string,
    success: boolean = true,
): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: toolCallId,
        toolName: toolName,
        content: [
            {
                type: "text",
                text: message,
            },
        ],
        isError: !success,
        timestamp: Date.now(),
    };
}

export abstract class OcrTool<TContext, TParameters extends TSchema = TSchema> {
    constructor(
        public readonly tool: OcrToolDefinition<TParameters>,
        protected readonly ctx: TContext,
        protected readonly options: OcrToolOptions = {},
    ) {}

    abstract execute(context: OcrToolExecutionContext, args: Static<TParameters>): Promise<ToolResultMessage>;

    protected simpleTextSuccessMessage(context: OcrToolExecutionContext, message: string): ToolResultMessage {
        return simpleTextMessage(context.toolName, context.toolCallId, message, true);
    }

    /**
     * Creates a success message with a screenshot placeholder.
     *
     * The placeholder has an empty `data` field and a mime type like "image/png+raw"
     * or "image/png+debug". The ScreenshotExtension will fill in the actual screenshot
     * data when it processes the tool result via its onToolResult hook.
     *
     * @param context - The tool execution context
     * @param message - The text message to include
     * @param addition - The screenshot type: "raw" for plain, "debug" for coordinate grid overlay
     */
    protected screenshotPlaceholderSuccessMessage(
        context: OcrToolExecutionContext,
        message: string,
        addition: ScreenshotMimeAddition = "raw",
    ): ToolResultMessage {
        const result = simpleTextMessage(context.toolName, context.toolCallId, message, true);

        // Placeholder will be filled by ScreenshotExtension.onToolResult
        result.content.unshift({
            type: "image",
            data: "",
            mimeType: `image/png+${addition}`,
        });

        return result;
    }

    protected simpleTextFailureMessage(context: OcrToolExecutionContext, message: string): ToolResultMessage {
        return simpleTextMessage(context.toolName, context.toolCallId, message, false);
    }

    /**
     * Wait for network idle after an interaction (click, navigation, etc.).
     * Sleeps for the specified delay, then waits for network to be idle.
     * Timeouts are ignored - the method returns normally even if network doesn't become idle.
     *
     * @param context - The tool execution context (for the abort signal)
     * @param delay - Delay in milliseconds before waiting for network idle (default: 100ms)
     */
    protected async waitForNetworkIdleAfterInteraction(
        context: OcrToolExecutionContext,
        delay: number = 100,
    ): Promise<void> {
        await sleep(delay, context.signal);
        try {
            await (this.ctx as any).page.waitForNetworkIdle({
                idleTime: (this.ctx as any).config.delayMillis,
                timeout: 10_000,
                signal: context.signal,
            });
        } catch (e) {
            if (e instanceof TimeoutError) {
                // Ignore timeout - continue regardless
            } else {
                throw e;
            }
        }
    }
}
