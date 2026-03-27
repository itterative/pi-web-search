import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import type {
    MessageChange,
    OcrExtension,
    OcrExtensionConstructor,
    OcrExtensionExecutionContext,
    OcrBaseStateInterface,
} from "./base";
import type { OcrRunOptions } from "../config";

/**
 * Options for registering an extension.
 */
export interface RegisterOptions {
    /** If true, replace any existing extension of the same class */
    overwrite?: boolean;
}

/**
 * Registry for managing extensions with type-safe access.
 *
 * The registry is generic over the full state type TState. Extensions that only
 * need access to the base state (most extensions) can extend OcrExtension without
 * a type parameter and will work with any registry.
 *
 * Extensions are retrieved using instanceof for polymorphic matching:
 * - `get(DerivedExtension)` returns `DerivedExtension` instance
 * - `get(BaseExtension)` also returns `DerivedExtension` instance (polymorphic)
 * - Returns first match if multiple extensions match the type
 *
 * ```typescript
 * const navExt = registry.get(NavigationExtension);
 * // navExt is NavigationExtension | undefined
 *
 * const checkpoints = registry.get(CheckpointExtension)?.getCheckpoints(ctx);
 * ```
 */
export class OcrExtensionRegistry<TState extends OcrBaseStateInterface = OcrBaseStateInterface> {
    private readonly extensions: OcrExtension<OcrBaseStateInterface>[] = [];

    /**
     * Register an extension.
     *
     * @param extension - The extension instance to register
     * @param options - Registration options
     * @throws If extension of this exact class is already registered and overwrite is false
     */
    register<T extends OcrExtension<OcrBaseStateInterface>>(extension: T, options?: RegisterOptions): T {
        const constructor = extension.constructor as OcrExtensionConstructor<OcrBaseStateInterface, T>;
        const existingIndex = this.findIndexByConstructor(constructor);

        if (existingIndex !== -1) {
            if (!options?.overwrite) {
                throw new Error(
                    `Extension "${extension.name}" (${constructor.name}) is already registered. Use { overwrite: true } to replace.`,
                );
            }
            this.extensions[existingIndex] = extension;
        } else {
            this.extensions.push(extension);
        }

        return extension;
    }

    /**
     * Get an extension by its class using instanceof (polymorphic).
     *
     * @param constructor - The extension class
     * @returns The first matching extension instance, or undefined if not found
     */
    get<T extends OcrExtension<OcrBaseStateInterface>>(
        constructor: OcrExtensionConstructor<OcrBaseStateInterface, T>,
    ): T | undefined {
        for (const ext of this.extensions) {
            if (ext instanceof constructor) {
                return ext as T;
            }
        }
        return undefined;
    }

    /**
     * Get all registered extensions.
     */
    getAll(): OcrExtension<OcrBaseStateInterface>[] {
        return [...this.extensions];
    }

    /**
     * Collect initial state from all extensions.
     * Each extension can contribute a partial state object via getInitialState().
     * Returns the merged state object.
     */
    collectInitialState(): Partial<TState> {
        const state: Partial<TState> = {};
        for (const ext of this.extensions) {
            const partial = ext.getInitialState?.();
            if (partial) {
                Object.assign(state, partial);
            }
        }
        return state;
    }

    // --- Private helpers ---

    /**
     * Find extension index by exact constructor match.
     */
    private findIndexByConstructor<T extends OcrExtension<OcrBaseStateInterface>>(
        constructor: OcrExtensionConstructor<OcrBaseStateInterface, T>,
    ): number {
        return this.extensions.findIndex((ext) => ext.constructor === constructor);
    }

    // --- Lifecycle dispatch methods ---

    async dispatchOnBeforeRun(ctx: OcrExtensionExecutionContext<TState>, options: OcrRunOptions): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onBeforeRun?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, options);
        }
    }

    async dispatchOnInit(ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onInit?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>);
        }
    }

    async dispatchOnRoundStart(ctx: OcrExtensionExecutionContext<TState>): Promise<boolean> {
        for (const ext of this.extensions) {
            const result = await ext.onRoundStart?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>);
            if (result === false) return false;
        }
        return true;
    }

    async dispatchOnResponse(ctx: OcrExtensionExecutionContext<TState>, response: AssistantMessage): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onResponse?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, response);
        }
    }

    /**
     * Result of dispatching onToolCall to extensions.
     * - shouldExecute: true if the tool should be executed normally
     * - interceptedResult: the result to use if an extension intercepted the call
     */
    async dispatchOnToolCall(
        ctx: OcrExtensionExecutionContext<TState>,
        toolCall: ToolCall,
    ): Promise<{
        shouldExecute: boolean;
        interceptedResult?: ToolResultMessage;
    }> {
        let interceptedResult: ToolResultMessage | undefined;

        for (const ext of this.extensions) {
            const result = await ext.onToolCall?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, toolCall);
            // First extension to return a ToolResultMessage wins
            if (result && typeof result === "object" && "role" in result && result.role === "toolResult") {
                interceptedResult = result;
            }
        }

        // If an extension intercepted, we don't execute the tool
        return {
            shouldExecute: !interceptedResult,
            interceptedResult,
        };
    }

    async dispatchOnToolResult(
        ctx: OcrExtensionExecutionContext<TState>,
        toolCall: ToolCall,
        result: ToolResultMessage,
    ): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onToolResult?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, toolCall, result);
        }
    }

    async dispatchOnToolResultsComplete(
        ctx: OcrExtensionExecutionContext<TState>,
        toolCalls: ToolCall[],
        results: ToolResultMessage[],
    ): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onToolResultsComplete?.(
                ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>,
                toolCalls,
                results,
            );
        }
    }

    async dispatchOnRoundEnd(ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onRoundEnd?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>);
        }
    }

    async dispatchOnBeforeCompletion(ctx: OcrExtensionExecutionContext<TState>, messages: Message[]): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onBeforeCompletion?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, messages);
        }
    }

    async dispatchOnFinalSummary(ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onFinalSummary?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>);
        }
    }

    async dispatchOnComplete(ctx: OcrExtensionExecutionContext<TState>): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onComplete?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>);
        }
    }

    async dispatchOnError(ctx: OcrExtensionExecutionContext<TState>, error: Error): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onError?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, error);
        }
    }

    async dispatchOnMessagesChanged(ctx: OcrExtensionExecutionContext<TState>, change: MessageChange): Promise<void> {
        for (const ext of this.extensions) {
            await ext.onMessagesChanged?.(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, change);
        }
    }
}
