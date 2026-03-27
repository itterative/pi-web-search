import type { Message, ToolCall, ToolResultMessage, AssistantMessage } from "@mariozechner/pi-ai";
import type { SummarizerProgressUpdate } from "../../base";
import type { OcrRunOptions } from "../config";
import type { CheckpointState } from "./checkpoint";

/**
 * Shared state fields managed by the OCR base class.
 */
export interface OcrSharedState {
    messages: Message[];
    lastInputTokens: number;
    /** Consecutive empty responses (thinking only, no content) */
    consecutiveEmptyResponses: number;
}

/**
 * Base state interface that all OCR states must satisfy.
 * Extensions depend on this base interface, not the full custom state.
 */
export interface OcrBaseStateInterface {
    base: OcrSharedState;
    checkpoint: CheckpointState;
}

/**
 * Full state type: base field with shared state merged with custom fields.
 */
export type OcrState<TCustom = object> = { base: OcrSharedState } & TCustom;

/**
 * Describes a change to the message list.
 */
export type MessageChange =
    | { type: "append"; messages: Message[]; source: string }
    | {
          type: "replace";
          messages: Message[];
          previousCount: number;
          source: string;
      }
    | { type: "truncate"; count: number; previousCount: number; source: string };

/**
 * Context passed to extensions during the interaction loop.
 * The state type must at least have a 'base' field with shared state.
 */
export interface OcrExtensionExecutionContext<TState extends OcrBaseStateInterface = OcrBaseStateInterface> {
    // --- Mutable state ---
    state: TState;

    // --- Round info ---
    currentRound: number;
    maxRounds: number;

    // --- Token tracking ---
    contextWindow: number;

    // --- System prompt ---
    systemPrompt: string;

    // --- Message management ---
    /**
     * Append messages to the conversation. Triggers onMessagesChanged hook.
     */
    appendMessages(messages: Message[], source: string): void;

    /**
     * Replace all messages. Triggers onMessagesChanged hook.
     */
    replaceMessages(messages: Message[], source: string): void;

    /**
     * Truncate messages to a specific count. Triggers onMessagesChanged hook.
     */
    truncateMessages(count: number, source: string): void;

    // --- Callbacks ---
    updateUI?: (update: SummarizerProgressUpdate) => void;
    log?: (message: string, type?: "info" | "warning" | "error") => void;

    signal?: AbortSignal;

    // --- Extension state ---
    /**
     * Per-extension per-run state. Keyed by extension name.
     * Allows extensions to store transient state that persists across hooks
     * within a single run, isolated from concurrent runs.
     */
    extensionState: Map<string, unknown>;
}

/**
 * Lifecycle hooks for OCR extensions.
 *
 * Extensions can hook into various points in the interaction loop
 * to modify behavior, add functionality, or track state.
 *
 * All hooks are optional - implement only what you need.
 * All hooks return Promises for consistency.
 */
export interface OcrExtensionHooks<TState extends OcrBaseStateInterface> {
    /**
     * Called to get the extension's initial state contribution.
     * Return a partial state object that will be merged into the context state.
     * Called before onBeforeRun.
     */
    getInitialState?(): Partial<TState> | undefined;

    /**
     * Called once before the run starts, before the initial message is built.
     * Extensions can modify options in place (e.g., update screenshot after overlay handling).
     */
    onBeforeRun?(ctx: OcrExtensionExecutionContext<TState>, options: OcrRunOptions): Promise<void>;

    /**
     * Called once before the interaction loop starts.
     * Use for initialization.
     */
    onInit?(ctx: OcrExtensionExecutionContext<TState>): Promise<void>;

    /**
     * Called at the start of each round, before the API call.
     * Return false to skip this round's normal processing.
     */
    onRoundStart?(ctx: OcrExtensionExecutionContext<TState>): Promise<boolean | void>;

    /**
     * Called after receiving the model's response.
     * The response has already been added to messages.
     */
    onResponse?(ctx: OcrExtensionExecutionContext<TState>, response: AssistantMessage): Promise<void>;

    /**
     * Called for each tool call before execution.
     * Return a ToolResultMessage to intercept and replace the tool's execution.
     * Return undefined to allow normal tool execution.
     *
     * Note: If any extension returns a result, that result is used instead of
     * executing the tool, but ALL extensions still receive onToolResult.
     */
    onToolCall?(
        ctx: OcrExtensionExecutionContext<TState>,
        toolCall: ToolCall,
    ): Promise<ToolResultMessage | undefined | void>;

    /**
     * Called after each tool result is built, before adding to messages.
     * Can modify the result in place.
     */
    onToolResult?(
        ctx: OcrExtensionExecutionContext<TState>,
        toolCall: ToolCall,
        result: ToolResultMessage,
    ): Promise<void>;

    /**
     * Called after all tool results for a round are processed.
     */
    onToolResultsComplete?(
        ctx: OcrExtensionExecutionContext<TState>,
        toolCalls: ToolCall[],
        results: ToolResultMessage[],
    ): Promise<void>;

    /**
     * Called at the end of each round.
     */
    onRoundEnd?(ctx: OcrExtensionExecutionContext<TState>): Promise<void>;

    /**
     * Called when an error occurs during the interaction loop.
     * Use for cleanup or debugging (e.g., saving state before error is thrown).
     */
    onError?(ctx: OcrExtensionExecutionContext<TState>, error: Error): Promise<void>;

    /**
     * Called before each completion (API call to the model).
     * Extensions can modify messages in place (e.g., add screenshot overlays).
     */
    onBeforeCompletion?(ctx: OcrExtensionExecutionContext<TState>, messages: Message[]): Promise<void>;

    /**
     * Called before the final summary is requested.
     */
    onFinalSummary?(ctx: OcrExtensionExecutionContext<TState>): Promise<void>;

    /**
     * Called once after the interaction loop completes.
     */
    onComplete?(ctx: OcrExtensionExecutionContext<TState>): Promise<void>;

    /**
     * Called whenever messages are appended, replaced, or truncated.
     * Useful for debugging and tracking message flow.
     */
    onMessagesChanged?(ctx: OcrExtensionExecutionContext<TState>, change: MessageChange): Promise<void>;
}

/**
 * Constructor type for extensions (supports abstract classes).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OcrExtensionConstructor<
    TState extends OcrBaseStateInterface = OcrBaseStateInterface,
    T extends OcrExtension<TState> = OcrExtension<TState>,
> = abstract new (...args: any[]) => T;

/**
 * Base class for OCR extensions.
 *
 * Extensions hook into the interaction loop lifecycle to provide
 * additional functionality like screenshot handling, checkpoint management, etc.
 *
 * Example:
 * ```typescript
 * class ScreenshotExtension extends OcrExtension {
 *   readonly name = "screenshot";
 *
 *   async onToolResult(ctx, toolCall, result) {
 *     // Fill in screenshot placeholders
 *   }
 * }
 * ```
 */
export abstract class OcrExtension<TState extends OcrBaseStateInterface = OcrBaseStateInterface> implements Partial<
    OcrExtensionHooks<TState>
> {
    /**
     * Unique name for this extension (for debugging/logging).
     */
    abstract readonly name: string;

    // All hooks are optional - subclasses implement what they need
    getInitialState?(): Partial<TState> | undefined {
        return undefined;
    }
    onBeforeRun?(_ctx: OcrExtensionExecutionContext<TState>, _options: OcrRunOptions): Promise<void> {
        return Promise.resolve();
    }
    onInit?(_ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        return Promise.resolve();
    }
    onRoundStart?(_ctx: OcrExtensionExecutionContext<TState>): Promise<boolean | void> {
        return Promise.resolve();
    }
    onResponse?(_ctx: OcrExtensionExecutionContext<TState>, _response: AssistantMessage): Promise<void> {
        return Promise.resolve();
    }
    onToolCall?(
        _ctx: OcrExtensionExecutionContext<TState>,
        _toolCall: ToolCall,
    ): Promise<ToolResultMessage | undefined | void> {
        return Promise.resolve();
    }
    onToolResult?(
        _ctx: OcrExtensionExecutionContext<TState>,
        _toolCall: ToolCall,
        _result: ToolResultMessage,
    ): Promise<void> {
        return Promise.resolve();
    }
    onToolResultsComplete?(
        _ctx: OcrExtensionExecutionContext<TState>,
        _toolCalls: ToolCall[],
        _results: ToolResultMessage[],
    ): Promise<void> {
        return Promise.resolve();
    }
    onRoundEnd?(_ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        return Promise.resolve();
    }
    onError?(_ctx: OcrExtensionExecutionContext<TState>, _error: Error): Promise<void> {
        return Promise.resolve();
    }
    onBeforeCompletion?(_ctx: OcrExtensionExecutionContext<TState>, _messages: Message[]): Promise<void> {
        return Promise.resolve();
    }
    onFinalSummary?(_ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        return Promise.resolve();
    }
    onComplete?(_ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        return Promise.resolve();
    }
    onMessagesChanged?(_ctx: OcrExtensionExecutionContext<TState>, _change: MessageChange): Promise<void> {
        return Promise.resolve();
    }
}
