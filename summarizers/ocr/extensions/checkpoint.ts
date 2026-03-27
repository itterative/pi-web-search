import type { AssistantMessage, Context, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import { OcrExtension, type OcrExtensionExecutionContext, type OcrBaseStateInterface } from "./base";
import type { Checkpoint } from "../state";
import { renderWithFallback } from "../instructions";

/**
 * Arguments passed to checkpoint recovery prompt.
 */
export interface CheckpointRecoveryArgs {
    checkpointResponse: string;
    checkpoints?: Checkpoint[];
    instruction?: string;
    navContext?: string;
    linksContext?: string;
}

/**
 * Host interface for checkpoint compression.
 * The OCR summarizer must implement this to provide mode-specific functionality.
 */
export interface CheckpointCompressionHost {
    /**
     * Optional: Get the prompt to request a checkpoint from the model.
     * If not provided, uses template from templatePath/checkpoint-compression-request.eta
     */
    getCheckpointRequestPrompt?(ctx: OcrExtensionExecutionContext): string;

    /**
     * Optional: Get the prompt for recovering from a checkpoint.
     * If not provided, uses template from templatePath/checkpoint-compression-recovery.eta
     */
    getCheckpointRecoveryPrompt?(ctx: OcrExtensionExecutionContext, args: CheckpointRecoveryArgs): string;

    /**
     * Optional: Get the current instruction for template rendering.
     */
    getInstruction?(ctx: OcrExtensionExecutionContext): string | undefined;

    /**
     * Optional: Get navigation context for template rendering.
     */
    getNavigationContext?(ctx: OcrExtensionExecutionContext): string;

    /**
     * Perform a completion (API call to the model).
     */
    complete(
        ctx: OcrExtensionExecutionContext,
        context: Context,
        options?: { signal?: AbortSignal },
    ): Promise<AssistantMessage>;

    /**
     * Capture a screenshot of the current page.
     */
    captureScreenshot(ctx: OcrExtensionExecutionContext): Promise<string>;

    /**
     * Get the tool definitions for building contexts.
     */
    getToolDefinitions(): Context["tools"];

    /**
     * Optional: Get links context for recovery prompts.
     */
    getLinksContext?(ctx: OcrExtensionExecutionContext): Promise<string>;

    /**
     * Optional: Consolidate checkpoints when progress is stalled.
     * Returns consolidated text, or undefined if consolidation not possible/needed.
     */
    consolidateCheckpoints?(ctx: OcrExtensionExecutionContext, checkpoints: Checkpoint[]): Promise<string | undefined>;

    /**
     * Optional: Called when compression fails due to stalled progress.
     * Can throw an error or return a fallback message.
     */
    onCompressionStalled?(ctx: OcrExtensionExecutionContext): Promise<void>;
}

/**
 * Per-run state for compression logic.
 */
export interface CompressionState {
    /** Message count before compression attempt, for rollback */
    messageCountBefore: number;
    /** Whether we're currently in compression mode */
    inCompressionMode: boolean;
    inRecoveryMode: boolean;
    /** Checkpoint count at last compression */
    checkpointsAtLastCompression: number;
    /** Consecutive compressions without new checkpoints */
    compressionsWithoutProgress: number;
    /** Attempts in current compression cycle */
    compressionAttempts: number;
    /** Round when current compression started (-1 if not compressing) */
    compressionRequestRound: number;
}

/**
 * Full checkpoint state stored in context.
 * Includes both compression state and tracking state.
 */
export interface CheckpointState {
    /** Compression-related state */
    compression: CompressionState;
    /** Round of last checkpoint save */
    lastCheckpointRound: number;
    /** Round of last compression attempt */
    lastCompressionAttemptRound: number;
    /** Consecutive compression failures */
    consecutiveCompressionFailures: number;
    /** Round when checkpoint was requested (-1 if not requested) */
    checkpointRequestedRound: number;
}

/**
 * Create default checkpoint state.
 */
export function createCheckpointState(): CheckpointState {
    return {
        compression: {
            messageCountBefore: 0,
            inCompressionMode: false,
            inRecoveryMode: false,
            checkpointsAtLastCompression: 0,
            compressionsWithoutProgress: 0,
            compressionAttempts: 0,
            compressionRequestRound: -1,
        },
        lastCheckpointRound: -100,
        lastCompressionAttemptRound: -100,
        consecutiveCompressionFailures: 0,
        checkpointRequestedRound: -1,
    };
}

export interface CheckpointExtensionInit {
    /** The host summarizer that provides compression functionality */
    host: CheckpointCompressionHost;
    /**
     * Context usage threshold for checkpointing (0.0-1.0, default 0.8).
     *
     * When usage exceeds (checkpointThreshold - 0.1), the extension requests
     * the model to use the checkpoint tool. At checkpointThreshold, compression
     * is triggered after a checkpoint is saved.
     */
    checkpointThreshold?: number;
    /** How many rounds to wait for checkpoint tool call before forcing compression (default 5) */
    maxRoundsBeforeForceCompression?: number;
    /** Minimum rounds between compression events (default 3) */
    minRoundsBetweenCompression?: number;
    /** Maximum compressions without progress before stalling (default 2) */
    maxCompressionsWithoutProgress?: number;
    /** Maximum attempts per compression cycle (default 10) */
    maxCompressionAttempts?: number;
    /**
     * Path to template folder for checkpoint messages (default "base").
     * Looks for templates in instructions/{templatePath}/:
     * - checkpoint-request.eta
     * - tool-blocked-compression.eta
     * - tool-blocked-checkpoint.eta
     * - checkpoints.eta
     * - checkpoint-compression-request.eta
     * - checkpoint-compression-recovery.eta
     */
    templatePath?: string;
    /**
     * Fallback path if templatePath templates are not found (default "base").
     */
    fallbackPath?: string;
}

/**
 * Extension that manages checkpoint compression and context limits.
 *
 * This extension is fully self-contained and manages all checkpoint state internally.
 * It performs compression using the host interface for mode-specific functionality.
 *
 * @example
 * ```ts
 * const checkpointExt = new CheckpointExtension({
 *   host: this, // the OCR summarizer
 *   checkpointThreshold: 0.8,
 * });
 *
 * registry.register(checkpointExt);
 * ```
 */
export class CheckpointExtension extends OcrExtension {
    readonly name = "checkpoint";

    private host: CheckpointCompressionHost;
    private templatePath: string;
    private fallbackPath: string;
    private checkpointThreshold: number;
    private maxRoundsBeforeForceCompression: number;
    private minRoundsBetweenCompression: number;
    private maxCompressionsWithoutProgress: number;
    private maxCompressionAttempts: number;

    // Checkpoint state (persisted across runs)
    private checkpoints: Checkpoint[] = [];

    constructor(init: CheckpointExtensionInit) {
        super();

        this.host = init.host;
        this.templatePath = init.templatePath ?? "base";
        this.fallbackPath = init.fallbackPath ?? "base";

        this.checkpointThreshold = init.checkpointThreshold ?? 0.8;
        this.maxRoundsBeforeForceCompression = init.maxRoundsBeforeForceCompression ?? 5;
        this.minRoundsBetweenCompression = init.minRoundsBetweenCompression ?? 3;
        this.maxCompressionsWithoutProgress = init.maxCompressionsWithoutProgress ?? 2;
        this.maxCompressionAttempts = init.maxCompressionAttempts ?? 10;
    }

    override getInitialState(): Partial<OcrBaseStateInterface> {
        return { checkpoint: createCheckpointState() };
    }

    async onRoundStart(ctx: OcrExtensionExecutionContext): Promise<boolean> {
        // Check if we should request the model to checkpoint
        if (!this.shouldRequestCheckpoint(ctx)) {
            return true;
        }

        ctx.updateUI?.({
            message: "Context limit approaching, requesting checkpoint...",
        });
        ctx.log?.(`Requesting checkpoint at round ${ctx.currentRound}`);

        // Inject a user message asking the model to use the checkpoint tool
        ctx.appendMessages(
            [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: renderWithFallback(
                                `${this.templatePath}/checkpoint-request`,
                                `${this.fallbackPath}/checkpoint-request`,
                            ),
                        },
                    ],
                    timestamp: Date.now(),
                },
            ],
            "CheckpointExtension:request",
        );

        ctx.state.checkpoint.checkpointRequestedRound = ctx.currentRound;

        return true;
    }

    async onToolCall(ctx: OcrExtensionExecutionContext, toolCall: ToolCall): Promise<ToolResultMessage | undefined> {
        // Block non-checkpoint tools during compression mode - we need a text response
        if (ctx.state.checkpoint.compression.inCompressionMode && toolCall.name !== "checkpoint") {
            ctx.log?.(`Blocking tool ${toolCall.name}: compression mode requires text response`);
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                isError: true,
                content: [
                    {
                        type: "text",
                        text: renderWithFallback(
                            `${this.templatePath}/tool-blocked-compression`,
                            `${this.fallbackPath}/tool-blocked-compression`,
                        ),
                    },
                ],
                timestamp: Date.now(),
            };
        }

        // Only block tools when we've requested a checkpoint
        if (ctx.state.checkpoint.checkpointRequestedRound < 0) {
            return undefined;
        }

        // Checkpoint tool is always allowed
        if (toolCall.name === "checkpoint") {
            return undefined;
        }

        // Block all other tools when checkpoint is requested
        ctx.log?.(`Blocking tool ${toolCall.name}: checkpoint requested, waiting for model to finish`);
        return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            isError: true,
            content: [
                {
                    type: "text",
                    text: renderWithFallback(
                        `${this.templatePath}/tool-blocked-checkpoint`,
                        `${this.fallbackPath}/tool-blocked-checkpoint`,
                    ),
                },
            ],
            timestamp: Date.now(),
        };
    }

    async onToolResultsComplete(
        ctx: OcrExtensionExecutionContext,
        toolCalls: ToolCall[],
        _results: ToolResultMessage[],
    ): Promise<void> {
        // Just log when checkpoint tool is used - don't trigger compression yet
        // Model can use checkpoint tool multiple times before signaling "done" with text
        const checkpointWasCalled = toolCalls.some((tc) => tc.name === "checkpoint");
        if (checkpointWasCalled) {
            ctx.log?.(`Checkpoint tool called, waiting for model to signal completion`);
        }
    }

    async onRoundEnd(ctx: OcrExtensionExecutionContext): Promise<void> {
        // Exit recovery mode after the round completes
        ctx.state.checkpoint.compression.inRecoveryMode = false;

        if (!this.shouldForceCompression(ctx)) {
            return;
        }

        ctx.updateUI?.({
            message: "Context limit reached, compressing context...",
        });
        ctx.log?.(`Force compression triggered at round ${ctx.currentRound}`);

        // Clear checkpoint request state
        ctx.state.checkpoint.checkpointRequestedRound = -1;

        await this.startCompression(ctx);
    }

    async onResponse(ctx: OcrExtensionExecutionContext, response: AssistantMessage): Promise<void> {
        const state = ctx.state.checkpoint.compression;

        // Handle compression mode
        if (state.inCompressionMode) {
            await this.handleCompressionResponse(ctx, response);
            return;
        }

        const hasToolCalls = response.content.some((c) => c.type === "toolCall");

        // If model responded without tool calls after checkpoint request,
        // it's providing the checkpoint summary as text (following instructions).
        if (ctx.state.checkpoint.checkpointRequestedRound >= 0 && !hasToolCalls) {
            ctx.log?.(`Model responded with checkpoint summary as text, starting compression`);

            // Clear checkpoint request state
            ctx.state.checkpoint.checkpointRequestedRound = -1;

            await this.startCompression(ctx);
        }
    }

    // Compression logic
    private async startCompression(ctx: OcrExtensionExecutionContext): Promise<void> {
        const state = ctx.state.checkpoint.compression;

        // Check for stalled progress first
        if (this.host.consolidateCheckpoints && this.host.onCompressionStalled) {
            const currentCheckpointCount = this.checkpoints.length;
            const hasNewCheckpoints = currentCheckpointCount > state.checkpointsAtLastCompression;

            if (!hasNewCheckpoints) {
                state.compressionsWithoutProgress++;
            } else {
                state.compressionsWithoutProgress = 0;
            }

            if (state.compressionsWithoutProgress >= this.maxCompressionsWithoutProgress) {
                ctx.updateUI?.({
                    message: "Progress stalled - consolidating checkpoints...",
                });
                const consolidated = await this.host.consolidateCheckpoints(ctx, this.checkpoints);

                if (!consolidated) {
                    await this.host.onCompressionStalled(ctx);
                    ctx.state.checkpoint.consecutiveCompressionFailures++;
                    return;
                }

                await this.applyCheckpointMessage(ctx, consolidated);
                ctx.state.checkpoint.lastCheckpointRound = ctx.currentRound;
                ctx.state.checkpoint.consecutiveCompressionFailures = 0;
                return;
            }
        }

        ctx.log?.("Starting compression...", "info");

        // Track message count for rollback
        state.messageCountBefore = ctx.state.base.messages.length;
        state.compressionAttempts = 0;
        state.compressionRequestRound = ctx.currentRound;
        ctx.state.checkpoint.lastCompressionAttemptRound = ctx.currentRound;

        // Always enter compression mode and request a fresh summary from the model
        // This ensures we get the model's current progress and findings
        state.inCompressionMode = true;

        // Build the request prompt, including saved checkpoints as context if available
        let requestText = this.getCheckpointRequestPrompt(ctx);
        if (this.checkpoints.length > 0) {
            const checkpointContext = this.formatCheckpoints();
            requestText = `${requestText}\n\nHere are the checkpoints you saved:\n\n${checkpointContext}`;
        }

        const checkpointRequest: Message = {
            role: "user",
            content: [
                {
                    type: "text",
                    text: requestText,
                },
            ],
            timestamp: Date.now(),
        };

        ctx.appendMessages([checkpointRequest], "CheckpointExtension:compressionRequest");
        ctx.log?.(
            `Compression mode started, request message appended${this.checkpoints.length > 0 ? ` with ${this.checkpoints.length} saved checkpoints` : ""}`,
        );
    }

    /**
     * Handle a response during compression mode.
     * Either applies the checkpoint or retries.
     */
    private async handleCompressionResponse(
        ctx: OcrExtensionExecutionContext,
        response: AssistantMessage,
    ): Promise<void> {
        const state = ctx.state.checkpoint.compression;
        state.compressionAttempts++;

        const checkpointText = this.extractTextContent(response.content);

        if (checkpointText) {
            ctx.log?.(`Got checkpoint text on attempt ${state.compressionAttempts}`);
            await this.applyCheckpointMessage(ctx, checkpointText);
            state.inCompressionMode = false;
            state.inRecoveryMode = true;
            ctx.state.checkpoint.lastCheckpointRound = ctx.currentRound;
            ctx.state.checkpoint.consecutiveCompressionFailures = 0;
            // Clear checkpoint request state
            ctx.state.checkpoint.checkpointRequestedRound = -1;
            return;
        }

        // No text - check if we should retry
        if (state.compressionAttempts >= this.maxCompressionAttempts) {
            ctx.log?.("Failed to get checkpoint summary from model", "warning");
            ctx.truncateMessages(state.messageCountBefore, "CheckpointExtension:compressionFailure");
            state.inCompressionMode = false;
            ctx.state.checkpoint.consecutiveCompressionFailures++;
            ctx.updateUI?.({ message: "Compression failed, continuing..." });
            // Clear checkpoint request state
            ctx.state.checkpoint.checkpointRequestedRound = -1;
            return;
        }

        // Retry - the next round will call complete again
        ctx.log?.(
            `Compression attempt ${state.compressionAttempts}/${this.maxCompressionAttempts} produced no text, retrying...`,
        );
        ctx.updateUI?.({
            message: `Compressing context (attempt ${state.compressionAttempts + 1}/${this.maxCompressionAttempts})...`,
        });
    }

    /**
     * Apply the checkpoint message, replacing the conversation.
     */
    private async applyCheckpointMessage(ctx: OcrExtensionExecutionContext, checkpointText: string): Promise<void> {
        const screenshot = await this.host.captureScreenshot(ctx);
        const linksContext = this.host.getLinksContext ? await this.host.getLinksContext(ctx) : undefined;

        const text = await this.getCheckpointRecoveryPrompt(ctx, {
            checkpointResponse: checkpointText,
            linksContext,
        });

        const checkpointMessage: Message = {
            role: "user",
            content: [
                { type: "image", data: screenshot, mimeType: "image/png" },
                { type: "text", text },
            ],
            timestamp: Date.now(),
        };

        ctx.replaceMessages([checkpointMessage], "CheckpointExtension:applyCheckpoint");
        ctx.state.base.lastInputTokens = 0;

        // Update compression state
        ctx.state.checkpoint.compression.checkpointsAtLastCompression = this.checkpoints.length;
        ctx.state.checkpoint.compression.inCompressionMode = false;

        ctx.log?.("Context compressed, continuing from checkpoint", "info");
        ctx.updateUI?.({ message: "Checkpoints compressed, continuing..." });
    }

    /**
     * Extract text content from a message content array.
     */
    private extractTextContent(content: Message["content"]): string | undefined {
        if (typeof content === "string") {
            return content;
        }

        const textParts = content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);

        return textParts.length > 0 ? textParts.join("\n") : undefined;
    }

    // Checkpoint management
    getCheckpoints(): Checkpoint[] {
        return this.checkpoints;
    }

    /**
     * Clear all checkpoints.
     */
    clearCheckpoints(): void {
        this.checkpoints = [];
    }

    /**
     * Replace all checkpoints with new ones.
     */
    setCheckpoints(checkpoints: Checkpoint[]): void {
        this.checkpoints = checkpoints;
    }

    /**
     * Add a checkpoint.
     * Tools can use this to add checkpoints (e.g., checkpoint tool).
     */
    addCheckpoint(checkpoint: Checkpoint): void {
        this.checkpoints.push(checkpoint);
    }

    /**
     * Format all checkpoints for inclusion in prompts.
     */
    formatCheckpoints(): string {
        if (this.checkpoints.length === 0) {
            return "";
        }
        return renderWithFallback(`${this.templatePath}/checkpoints`, `${this.fallbackPath}/checkpoints`, {
            checkpoints: this.checkpoints,
        });
    }

    // Template helpers
    private getCheckpointRequestPrompt(ctx: OcrExtensionExecutionContext): string {
        if (this.host.getCheckpointRequestPrompt) {
            return this.host.getCheckpointRequestPrompt(ctx);
        }
        return renderWithFallback(
            `${this.templatePath}/checkpoint-compression-request`,
            `${this.fallbackPath}/checkpoint-compression-request`,
        );
    }

    /**
     * Get the checkpoint recovery prompt, using host method or template.
     */
    private async getCheckpointRecoveryPrompt(
        ctx: OcrExtensionExecutionContext,
        args: CheckpointRecoveryArgs,
    ): Promise<string> {
        if (this.host.getCheckpointRecoveryPrompt) {
            return this.host.getCheckpointRecoveryPrompt(ctx, args);
        }

        // Gather template data from host helpers
        const instruction = this.host.getInstruction?.(ctx);
        const navContext = this.host.getNavigationContext?.(ctx);
        const linksContext = args.linksContext ?? (await this.host.getLinksContext?.(ctx));

        return renderWithFallback(
            `${this.templatePath}/checkpoint-compression-recovery`,
            `${this.fallbackPath}/checkpoint-compression-recovery`,
            {
                checkpointResponse: args.checkpointResponse,
                checkpoints: this.checkpoints.length > 0 ? this.checkpoints : undefined,
                instruction,
                navContext,
                linksContext,
            },
        );
    }

    // Helper methods
    private shouldRequestCheckpoint(ctx: OcrExtensionExecutionContext): boolean {
        // Don't request again if already requested
        if (ctx.state.checkpoint.checkpointRequestedRound >= 0) {
            return false;
        }

        if (ctx.state.checkpoint.compression.inRecoveryMode) {
            return false;
        }

        // Require at least minRoundsBetweenCompression rounds since last checkpoint
        const minRoundsBetweenCheckpoints = this.minRoundsBetweenCompression;
        if (ctx.currentRound - ctx.state.checkpoint.lastCheckpointRound < minRoundsBetweenCheckpoints) {
            return false;
        }

        // Apply backoff based on consecutive compression failures
        // This prevents infinite retry loops when compression keeps failing
        if (ctx.state.checkpoint.consecutiveCompressionFailures > 0) {
            const backoffRounds =
                ctx.state.checkpoint.consecutiveCompressionFailures * this.minRoundsBetweenCompression;
            const roundsSinceAttempt = ctx.currentRound - ctx.state.checkpoint.lastCompressionAttemptRound;

            if (roundsSinceAttempt < backoffRounds) {
                ctx.log?.(
                    `shouldRequestCheckpoint: backing off (${roundsSinceAttempt}/${backoffRounds} rounds, ${ctx.state.checkpoint.consecutiveCompressionFailures} failures)`,
                );
                return false;
            }
        }

        if (ctx.state.base.lastInputTokens === 0) {
            return false;
        }

        // Use a lower threshold for requesting (70%)
        const requestThreshold = this.checkpointThreshold - 0.1;
        const usage = ctx.state.base.lastInputTokens / ctx.contextWindow;

        const shouldRequest = usage >= requestThreshold;
        if (shouldRequest) {
            ctx.log?.(
                `shouldRequestCheckpoint: usage=${Math.round(usage * 100)}%, threshold=${Math.round(requestThreshold * 100)}%`,
            );
        }

        return shouldRequest;
    }

    /**
     * Check if we must force compression now.
     * True if we've requested a checkpoint and waited maxRoundsBeforeForceCompression rounds,
     * or if we're at critical usage (90%).
     *
     * Critical threshold is fixed at 90% to prevent context overflow.
     */
    private shouldForceCompression(ctx: OcrExtensionExecutionContext): boolean {
        // If we requested a checkpoint, give the model some time to use it
        if (ctx.state.checkpoint.checkpointRequestedRound >= 0) {
            const roundsSinceRequest = ctx.currentRound - ctx.state.checkpoint.checkpointRequestedRound;

            if (roundsSinceRequest >= this.maxRoundsBeforeForceCompression) {
                ctx.log?.(`Force compression: ${this.maxRoundsBeforeForceCompression} rounds since checkpoint request`);
                return true;
            }
        }

        // Also force if we're at critical usage (90% - fixed threshold to prevent context overflow)
        if (ctx.state.base.lastInputTokens === 0) {
            return false;
        }

        const criticalThreshold = 0.9;
        const usage = ctx.state.base.lastInputTokens / ctx.contextWindow;

        if (usage >= criticalThreshold) {
            ctx.log?.(`Force compression: critical usage ${Math.round(usage * 100)}%`);
            return true;
        }

        return false;
    }
}
