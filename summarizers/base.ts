import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Page } from "puppeteer";

/**
 * Result from summarization including metadata about how it was processed.
 */
export interface SummarizerResult {
    /** The summarized content */
    summary: string;
    /** ID of the summarizer that produced this result */
    summarizerId: string;
    /** Whether an LLM was used for summarization */
    usedLlm: boolean;
}

/**
 * Mode for content extraction.
 */
export type SummarizerMode = "summarize" | "full" | "instruct";

/**
 * Content type hints for summarizer selection.
 */
export type ContentType = "text" | "image" | "video";

/**
 * Progress update from a summarizer.
 */
export interface SummarizerProgress {
    /** Human-readable status message */
    message: string;
    /** Current interaction round (if applicable) */
    round?: number;
    /** Maximum interaction rounds (if applicable) */
    maxRounds?: number;
    /** Action being performed (e.g., "click", "scroll") */
    action?: string;
    /** The model's thinking/message from the current round */
    thinking?: string;
    /** List of checkpoint titles collected so far */
    checkpoints?: string[];
    /** Content of the most recent checkpoint */
    lastCheckpointContent?: string;
}

/**
 * Update type for UI callbacks.
 * - `undefined` field → keep current value
 * - `null` field → clear/delete the field
 * - value → update the field
 */
export type SummarizerProgressUpdate = {
    [K in keyof SummarizerProgress]?: SummarizerProgress[K] | null;
};

/**
 * Callback for summarizer progress updates.
 */
export type SummarizerUpdateCallback = (progress: SummarizerProgress) => void;

/**
 * Interface for content summarizers.
 *
 * Summarizers can use different strategies:
 * - LLM-based summarization (generic, blog posts, etc.)
 * - Structured extraction (GitHub repos, package registries)
 * - Content-specific parsing (Hacker News comments, Reddit threads)
 * - OCR-based summarization (screenshots sent to vision models)
 *
 * Multiple summarizers can handle the same URL. The one with the highest
 * confidence score will be selected.
 *
 * Summarizers receive a pre-navigated page from the registry, allowing
 * efficient content inspection without duplicate network requests.
 */
export interface Summarizer {
    /** Unique identifier for this summarizer */
    readonly id: string;

    /**
     * Priority for ordering when confidence scores are equal.
     * Higher priority summarizers are checked first.
     */
    readonly priority: number;

    /**
     * Determine if this summarizer can handle the given URL, mode, and page.
     *
     * The page is already navigated to the URL, so summarizers can inspect
     * the content type, DOM structure, etc. without additional network requests.
     *
     * IMPORTANT: This method should be read-only. Any changes to the page state
     * (scroll, navigation, clicks, etc.) will be automatically restored before
     * checking the next summarizer or calling summarize().
     *
     * @param url - The URL to summarize
     * @param mode - The requested mode ("summarize" or "full")
     * @param page - Puppeteer page already navigated to the URL
     * @param ctx - Extension context for accessing model registry
     * @param contentTypes - Expected content types (text, image, video) for summarizer selection
     * @returns Confidence score from 0 to 1. 0 means cannot handle.
     */
    canHandle(
        url: string,
        mode: SummarizerMode,
        page: Page,
        ctx: ExtensionContext,
        contentTypes?: ContentType[],
    ): number | Promise<number>;

    /**
     * Summarize the content at the given URL using the provided page.
     *
     * The page is already navigated and shared between summarizer selection
     * and summarization. The summarizer should NOT close the page - the
     * registry handles cleanup.
     *
     * This method is free to modify the page state (scroll, click, navigate)
     * as needed for summarization, since the page will be closed afterward.
     *
     * @param url - The URL to summarize
     * @param instruction - Optional instruction to guide behavior (e.g., "list all navigation links", "find pricing info")
     * @param ctx - Extension context for accessing model registry, browser, etc.
     * @param page - Puppeteer page already navigated to the URL
     * @param onUpdate - Optional callback for progress updates
     * @param signal - Optional abort signal for cancellation
     * @param mode - Optional mode: "summarize" (default) or "full" for complete content
     * @param contentTypes - Expected content types (text, image, video) for summarizer selection
     * @returns The summarized content with metadata
     */
    summarize(
        url: string,
        instruction: string | undefined,
        ctx: ExtensionContext,
        page: Page,
        onUpdate?: SummarizerUpdateCallback,
        signal?: AbortSignal,
        mode?: SummarizerMode,
        contentTypes?: ContentType[],
    ): Promise<SummarizerResult>;
}
