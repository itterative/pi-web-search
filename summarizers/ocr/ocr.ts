import {
    completeSimple,
    type AssistantMessage,
    type Context,
    type Message,
    type Model,
    type ToolCall,
    type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Page } from "puppeteer";

import type { SummarizerProgress, SummarizerResult } from "../base";
import type { InteractionConfig, InteractionPositioning } from "./state";
import { captureScreenshot } from "./screenshot";
import { OcrTool, executeOcrToolCall, type OcrToolExecutionContext } from "./tools";
import { isEmptyResponse, extractThinkingFromContent, extractTextSummary } from "./response-utils";
import {
    OcrExtension,
    OcrExtensionRegistry,
    type OcrExtensionExecutionContext,
    type OcrExtensionConstructor,
    type OcrSharedState,
    type OcrBaseStateInterface,
    type SummarizerProgressUpdate,
    type CheckpointCompressionHost,
    type CheckpointRecoveryArgs,
} from "./extensions";
import {
    CheckpointExtension,
    CursorExtension,
    DebugExtension,
    NavigationExtension,
    OverlayExtension,
    ScreenshotExtension,
    type CheckpointState,
} from "./extensions";
import type { OcrRunOptions } from "./config";

/**
 * Configuration for overlay handling.
 */
export interface OverlayConfig {
    /** Enable overlay detection and handling (default: true) */
    enabled: boolean;
    /** Maximum iterations for overlay handling (default: 20) */
    maxIterations: number;
}

/**
 * Configuration for the OCR interaction runner.
 */
export interface OcrConfig {
    /** The page to interact with */
    page: Page;

    /** The vision model to use */
    model: Model<any>;

    /** API key for the model */
    apiKey: string | undefined;

    /** Screenshot width */
    width: number;

    /** Maximum screenshot height */
    maxHeight: number;

    /** Maximum interaction rounds */
    maxRounds: number;

    /** Delay after interactions in ms */
    delay: number;

    /** Context usage threshold for checkpointing (0.0-1.0, default 0.8) */
    checkpointThreshold?: number;

    /** Template path for checkpoint extension (e.g., "explore", "full", "summarize") */
    templatePath: string;

    /** Positioning mode for coordinates */
    positioning: InteractionPositioning;

    /** Interaction config (delays, scroll, etc.) */
    interaction: InteractionConfig;

    /** Overlay handling config (default: { enabled: true, maxIterations: 20 }) */
    overlay?: Partial<OverlayConfig>;

    /** Maximum consecutive empty responses before giving up (default: 3) */
    maxEmptyResponseRetries?: number;
}

/**
 * Full state type: base field with shared state merged with custom fields.
 * Subclasses define only their custom fields, and this combines them.
 */
export type OcrBaseState<TCustom = object> = {
    base: OcrSharedState;
    checkpoint: CheckpointState;
} & TCustom;

/**
 * Base class for OCR-based interactive summarizers.
 *
 * This class orchestrates the interaction loop between the model and the page,
 * using tools for page manipulation and extensions for cross-cutting concerns.
 */
export abstract class OcrBase<TCustom = object> implements CheckpointCompressionHost {
    protected readonly config: OcrConfig;
    private readonly registry: OcrExtensionRegistry<OcrBaseState<TCustom>>;
    private readonly tools: OcrTool<any>[];

    /** Extension references (for subclass access) */
    protected readonly overlayExtension: OverlayExtension | undefined;
    protected readonly cursorExtension: CursorExtension;
    protected readonly navigationExtension: NavigationExtension;
    protected readonly checkpointExtension: CheckpointExtension;

    /** Current instruction being executed */
    protected instruction?: string;

    /** Current UI progress state, used for merging partial updates */
    private currentProgress: SummarizerProgress = { message: "Initializing..." };

    constructor(config: OcrConfig) {
        this.config = config;
        this.registry = new OcrExtensionRegistry<OcrBaseState<TCustom>>();
        this.tools = [];

        // Register overlay extension first (if enabled)
        const overlayConfig = {
            enabled: true,
            maxIterations: 20,
            ...config.overlay,
        };
        if (overlayConfig.enabled) {
            this.overlayExtension = this.registerExtension(
                new OverlayExtension({
                    page: this.config.page,
                    model: this.config.model,
                    apiKey: this.config.apiKey,
                    positioning: this.config.positioning,
                    maxIterations: overlayConfig.maxIterations,
                    width: this.config.width,
                    maxHeight: this.config.maxHeight,
                }),
            );
        }

        // Register other extensions
        this.cursorExtension = this.registerExtension(
            new CursorExtension({
                page: this.config.page,
                positioning: this.config.positioning,
            }),
        );

        this.registerExtension(
            new DebugExtension({
                page: this.config.page,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
            }),
        );

        this.navigationExtension = this.registerExtension(new NavigationExtension({ page: this.config.page }));

        this.registerExtension(
            new ScreenshotExtension({
                page: this.config.page,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
            }),
        );

        this.checkpointExtension = this.registerExtension(
            new CheckpointExtension({
                host: this,
                checkpointThreshold: this.config.checkpointThreshold,
                templatePath: this.config.templatePath,
                fallbackPath: "base",
            }),
        );
    }

    /**
     * Register a tool. Call this in the subclass constructor.
     */
    protected registerTool<T extends OcrTool<any>>(tool: T): T {
        this.tools.push(tool);
        return tool;
    }

    /**
     * Register an extension. Call this in the subclass constructor.
     */
    protected registerExtension<T extends OcrExtension<OcrBaseStateInterface>>(extension: T): T {
        return this.registry.register(extension);
    }

    /**
     * Get an extension by its class. Useful for accessing extension state.
     */
    protected getExtension<T extends OcrExtension<OcrBaseStateInterface>>(
        constructor: OcrExtensionConstructor<OcrBaseStateInterface, T>,
    ): T | undefined {
        return this.registry.get(constructor);
    }

    /**
     * Get tool snippets (short descriptions) for the system prompt.
     * Returns an array of promptSnippet strings from all registered tools that have them.
     */
    protected getToolSnippets(): string[] {
        return this.tools.map((t) => t.tool.promptSnippet).filter((s): s is string => s !== undefined);
    }

    /**
     * Get tool guidelines (detailed usage instructions) for the system prompt.
     * Returns an array of promptGuidelines from all registered tools that have them.
     */
    protected getToolGuidelines(): string[] {
        return this.tools.map((t) => t.tool.promptGuidelines).filter((g): g is string => g !== undefined);
    }

    /**
     * Get the system prompt for this mode.
     * Public for testing purposes.
     */
    abstract getSystemPrompt(): string;

    /**
     * Build the initial user message with screenshot.
     * Public for testing purposes.
     */
    abstract buildInitialMessage(screenshot: string, instruction: string | undefined, linksContext: string): Message;

    /**
     * Get the prompt to use when forcing a summary.
     * Public for testing purposes.
     */
    abstract getForceSummaryPrompt(): string;

    /**
     * Initial progress message for UI updates.
     * Subclasses must provide a message for the initial UI state.
     */
    protected abstract readonly initialProgressMessage: string;

    /**
     * Perform a completion (API call to the model).
     */
    async complete(
        extCtx: OcrExtensionExecutionContext,
        context: Context,
        options?: { signal?: AbortSignal },
    ): Promise<AssistantMessage> {
        // Notify extensions before completion (e.g., to modify screenshots)
        await this.registry.dispatchOnBeforeCompletion(
            extCtx as OcrExtensionExecutionContext<OcrBaseState<TCustom>>,
            context.messages,
        );

        return await completeSimple(this.config.model, context, {
            apiKey: this.config.apiKey,
            signal: options?.signal,
        });
    }

    /**
     * Capture a screenshot of the current page.
     */
    async captureScreenshot(_ctx: OcrExtensionExecutionContext): Promise<string> {
        return await captureScreenshot(this.config.page);
    }

    /**
     * Get the tool definitions for building contexts.
     */
    getToolDefinitions(): Context["tools"] {
        return this.tools.map((t) => t.tool);
    }

    /**
     * Get links context for recovery prompts.
     * Subclasses can override to provide custom links context.
     */
    async getLinksContext(_ctx: OcrExtensionExecutionContext): Promise<string> {
        return "";
    }

    /**
     * Run the OCR interaction loop.
     */
    async run(options: OcrRunOptions): Promise<SummarizerResult> {
        this.currentProgress = { message: this.initialProgressMessage };

        await this.config.page.setViewport({
            width: this.config.width,
            height: this.config.maxHeight,
        });

        // Build extension context
        const extCtx = this.buildExtensionContext(options);

        try {
            // Let extensions modify options before run starts (e.g., overlay handling)
            await this.registry.dispatchOnBeforeRun(extCtx, options);

            // Build initial message (after extensions may have modified options)
            extCtx.state.base.messages = [
                this.buildInitialMessage(options.screenshot, options.instruction, options.linksContext),
            ];

            // Run interaction loop
            for (let round = 0; round < this.config.maxRounds; round++) {
                if (options.signal?.aborted) {
                    throw new Error("Summarization cancelled");
                }

                extCtx.currentRound = round;

                const shouldContinue = await this.registry.dispatchOnRoundStart(extCtx);
                if (!shouldContinue) {
                    continue;
                }

                const result = await this.runRound(extCtx, round, options);
                if (result) {
                    // Model is done - check if we already have a summary
                    const lastMessage = extCtx.state.base.messages[extCtx.state.base.messages.length - 1];
                    if (lastMessage?.role === "assistant") {
                        const existingSummary = extractTextSummary(lastMessage.content);
                        if (existingSummary) {
                            await this.registry.dispatchOnComplete(extCtx);
                            return existingSummary;
                        }
                    }
                    break;
                }

                await this.registry.dispatchOnRoundEnd(extCtx);
            }

            // Force final summary
            const result = await this.forceSummary(extCtx, options);
            await this.registry.dispatchOnComplete(extCtx);
            return result;
        } catch (error) {
            await this.registry.dispatchOnError(extCtx, error as Error);
            throw error;
        }
    }

    private async runRound(
        extCtx: OcrExtensionExecutionContext<OcrBaseState<TCustom>>,
        round: number,
        options: OcrRunOptions,
    ): Promise<boolean> {
        const { signal, onUpdate } = options;

        onUpdate?.({
            message: `Analyzing page (round ${round + 1}/${this.config.maxRounds})...`,
            round: round + 1,
            maxRounds: this.config.maxRounds + 1,
        });

        const response = await this.complete(extCtx, this.buildContext(extCtx), {
            signal,
        });

        if (response.stopReason === "aborted") {
            throw new Error("Summarization cancelled");
        }

        // Track token usage
        extCtx.state.base.lastInputTokens = response.usage.input;

        // Check for empty response (thinking only, no content) - llamacpp bug workaround
        const maxEmptyRetries = this.config.maxEmptyResponseRetries ?? 3;
        if (isEmptyResponse(response)) {
            extCtx.state.base.consecutiveEmptyResponses++;
            extCtx.log?.(
                `Empty response (thinking only) ${extCtx.state.base.consecutiveEmptyResponses}/${maxEmptyRetries}`,
            );

            if (extCtx.state.base.consecutiveEmptyResponses >= maxEmptyRetries) {
                throw new Error(`Model returned ${maxEmptyRetries} consecutive empty responses`);
            }

            // Don't add the empty message - just retry
            return false;
        }

        // Reset counter on non-empty response
        extCtx.state.base.consecutiveEmptyResponses = 0;

        extCtx.state.base.messages.push(response);

        // Notify extensions of response
        await this.registry.dispatchOnResponse(extCtx, response);

        // Extract thinking for UI update
        const thinking = extractThinkingFromContent(response.content);
        if (thinking) {
            onUpdate?.({
                message: "Model is interacting with the page...",
                round: round + 1,
                maxRounds: this.config.maxRounds + 1,
                thinking,
            });
        }

        // Check for tool calls
        const toolCalls = response.content.filter((c) => c.type === "toolCall") as ToolCall[];

        if (toolCalls.length === 0) {
            // No tool calls - but check if compression just happened
            // If messages were reset (few messages, last is user), continue
            if (
                extCtx.state.base.messages.length <= 2 &&
                extCtx.state.base.messages[extCtx.state.base.messages.length - 1]?.role === "user"
            ) {
                // Compression reset messages - continue to next round
                return false;
            }
            // Check if we're in compression mode - need to continue for retry
            if (extCtx.state.checkpoint.compression.inCompressionMode) {
                return false;
            }
            // No tool calls - model is done
            return true; // Break out of loop
        }

        // Check if we're in compression mode - only allow checkpoint tool
        if (extCtx.state.checkpoint.compression.inCompressionMode) {
            const nonCheckpointTools = toolCalls.filter((tc) => tc.name !== "checkpoint");
            if (nonCheckpointTools.length > 0) {
                // Model tried to use non-checkpoint tools during compression - add a message and continue
                extCtx.state.base.messages.push({
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Tools are not available right now. Please provide a text summary of your progress.",
                        },
                    ],
                    timestamp: Date.now(),
                });
                return false; // Continue to next round
            }
            // Only checkpoint tool(s) - let them process normally
        }

        // Process tool calls
        const results = await this.processToolCalls(extCtx, toolCalls, options);
        extCtx.state.base.messages.push(...results);

        // Notify extensions after all tool results
        await this.registry.dispatchOnToolResultsComplete(extCtx, toolCalls, results);

        return false; // Continue to next round
    }

    private async processToolCalls(
        extCtx: OcrExtensionExecutionContext<OcrBaseState<TCustom>>,
        toolCalls: ToolCall[],
        options: OcrRunOptions,
    ): Promise<ToolResultMessage[]> {
        const results: ToolResultMessage[] = [];

        for (const tc of toolCalls) {
            const toolContext: OcrToolExecutionContext = {
                toolName: tc.name,
                toolCallId: tc.id,
                updateUI: extCtx.updateUI,
                log: extCtx.log,
                signal: options.signal,
            };

            // Ask extensions if they want to intercept this tool call
            const { shouldExecute, interceptedResult } = await this.registry.dispatchOnToolCall(extCtx, tc);

            const result = interceptedResult ?? (await executeOcrToolCall(toolContext, this.tools, tc));

            // Notify ALL extensions of tool result (they can modify in place)
            await this.registry.dispatchOnToolResult(extCtx, tc, result);
            results.push(result);
        }

        return results;
    }

    private async forceSummary(
        extCtx: OcrExtensionExecutionContext<OcrBaseState<TCustom>>,
        options: OcrRunOptions,
    ): Promise<SummarizerResult> {
        const { signal, onUpdate } = options;

        onUpdate?.({ message: "Forcing final summary..." });

        // Notify extensions before final summary
        await this.registry.dispatchOnFinalSummary(extCtx);

        extCtx.state.base.messages.push({
            role: "user",
            content: [{ type: "text", text: this.getForceSummaryPrompt() }],
            timestamp: Date.now(),
        });

        const response = await this.complete(extCtx, this.buildContext(extCtx), {
            signal,
        });

        // Extract text content as summary
        const textResult = extractTextSummary(response.content);
        if (textResult) {
            return textResult;
        }

        throw new Error("Model failed to provide summary after forced summary request");
    }

    private buildExtensionContext(options: OcrRunOptions): OcrExtensionExecutionContext<OcrBaseState<TCustom>> {
        // Collect initial state from extensions (checkpoint, etc.)
        const extensionState = this.registry.collectInitialState();

        const state: OcrBaseState<TCustom> = {
            base: {
                messages: [],
                lastInputTokens: 0,
                consecutiveEmptyResponses: 0,
            },
            ...extensionState,
        } as OcrBaseState<TCustom>;

        const ctx: OcrExtensionExecutionContext<OcrBaseState<TCustom>> = {
            state,
            currentRound: 0,
            maxRounds: this.config.maxRounds,
            contextWindow: this.config.model.contextWindow,
            systemPrompt: this.getSystemPrompt(),
            updateUI: this.buildUpdateUIHandler(options),
            signal: options.signal,
            extensionState: new Map(),
            log: this.createLogger(state, options),
            appendMessages: (messages: Message[], source: string) => {
                const previousCount = state.base.messages.length;
                state.base.messages.push(...messages);
                this.registry.dispatchOnMessagesChanged(ctx, {
                    type: "append",
                    messages,
                    source,
                });
            },
            replaceMessages: (messages: Message[], source: string) => {
                const previousCount = state.base.messages.length;
                state.base.messages = messages;
                this.registry.dispatchOnMessagesChanged(ctx, {
                    type: "replace",
                    messages,
                    previousCount,
                    source,
                });
            },
            truncateMessages: (count: number, source: string) => {
                const previousCount = state.base.messages.length;
                state.base.messages.length = count;
                this.registry.dispatchOnMessagesChanged(ctx, {
                    type: "truncate",
                    count,
                    previousCount,
                    source,
                });
            },
        };

        return ctx;
    }

    private createLogger(state: OcrBaseState<TCustom>, options: OcrRunOptions) {
        let currentMessages = -1;
        let currentLog: string = "";

        return (msg: string) => {
            if (state.base.messages.length > 0 && currentMessages === state.base.messages.length) {
                currentLog = `${currentLog}\n${msg}`;
            } else {
                currentLog = msg;
                currentMessages = state.base.messages.length;
            }

            options.notify?.(`[ocr] messages ${currentMessages}\n${currentLog}`);
        };
    }

    /**
     * Handle a partial progress update, merging with current state.
     * - `undefined` field → keep current value
     * - `null` field → delete/clear the field
     * - value → update the field
     */
    private buildUpdateUIHandler(options: OcrRunOptions) {
        return (update: SummarizerProgressUpdate) => {
            for (const key of Object.keys(update) as (keyof SummarizerProgress)[]) {
                const value = update[key];
                if (value === null) {
                    // Clear the field
                    delete this.currentProgress[key];
                } else if (value !== undefined) {
                    // Update the field
                    (this.currentProgress as any)[key] = value;
                }
                // If undefined, keep current value (do nothing)
            }

            options?.onUpdate?.(this.currentProgress);
        };
    }

    private buildContext(extCtx: OcrExtensionExecutionContext<OcrBaseState<TCustom>>): Context {
        return {
            systemPrompt: this.getSystemPrompt(),
            messages: extCtx.state.base.messages,
            tools: this.tools.map((t) => t.tool),
        };
    }
}
