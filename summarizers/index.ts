import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Page } from "puppeteer";

import { getBrowser } from "../common/browser";
import type { ContentType, Summarizer, SummarizerMode, SummarizerResult, SummarizerUpdateCallback } from "./base";

// Re-export types
export {
    type Summarizer,
    type SummarizerMode,
    type SummarizerResult,
    type SummarizerProgress,
    type SummarizerUpdateCallback,
    type ContentType,
} from "./base";

/** Summarizer registry and lookup functions */
const summarizers: Summarizer[] = [];

/**
 * Register a summarizer.
 * Summarizers are sorted by priority after registration.
 */
export function registerSummarizer(summarizer: Summarizer): void {
    summarizers.push(summarizer);
    summarizers.sort((a, b) => b.priority - a.priority);
}

/**
 * Get all registered summarizers, sorted by priority.
 */
export function getSummarizers(): Summarizer[] {
    return [...summarizers];
}

/**
 * Get a specific summarizer by ID.
 */
export function getSummarizer(id: string): Summarizer | undefined {
    return summarizers.find((s) => s.id === id);
}

/**
 * Find the best summarizer for the given URL, mode, and page.
 *
 * Iterates through summarizers in priority order and returns the one
 * with the highest confidence score. If no summarizer returns a score > 0,
 * returns undefined.
 *
 * Restores page state (scroll position, URL) after each summarizer check
 * to ensure each summarizer sees a clean page.
 *
 * @param url - The URL to summarize
 * @param mode - The requested mode ("summarize" or "full")
 * @param page - Puppeteer page already navigated to the URL
 * @param ctx - Extension context for accessing model registry
 * @param contentTypes - Expected content types (text, image, video) for summarizer selection
 * @returns The best matching summarizer, or undefined if none can handle it
 */
export async function findSummarizer(
    url: string,
    mode: SummarizerMode,
    page: Page,
    ctx: ExtensionContext,
    contentTypes?: ContentType[],
): Promise<Summarizer | undefined> {
    let bestSummarizer: Summarizer | undefined;
    let bestScore = 0;

    for (const summarizer of summarizers) {
        // Capture current state before calling canHandle
        const stateBefore = await capturePageState(page);

        const score = await summarizer.canHandle(url, mode, page, ctx, contentTypes);

        // Restore state if it was changed
        await restorePageState(page, stateBefore);

        if (score > bestScore) {
            bestScore = score;
            bestSummarizer = summarizer;

            // Early exit if we find a perfect match
            if (score >= 1) {
                break;
            }
        }
    }

    return bestSummarizer;
}

/**
 * Captures the current page state for later restoration.
 */
interface PageState {
    url: string;
    scrollX: number;
    scrollY: number;
    historyLength: number;
}

async function capturePageState(page: Page): Promise<PageState> {
    const [scroll, currentUrl, historyLength] = await Promise.all([
        page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })),
        page.url(),
        page.evaluate(() => window.history.length),
    ]);

    return {
        url: currentUrl,
        scrollX: scroll.x,
        scrollY: scroll.y,
        historyLength,
    };
}

/**
 * Restores page state if it was changed.
 */
async function restorePageState(page: Page, state: PageState): Promise<void> {
    const currentUrl = page.url();
    const currentHistoryLength = await page.evaluate(() => window.history.length);

    // Calculate how many navigations happened (history entries added)
    const navigationCount = currentHistoryLength - state.historyLength;

    // Go back through all navigations
    for (let i = 0; i < navigationCount; i++) {
        await page.goBack({ waitUntil: "networkidle2", timeout: 30000 });
    }

    // Reset scroll position
    await page.evaluate((x, y) => window.scrollTo(x, y), state.scrollX, state.scrollY);
}

/**
 * Summarize content at the given URL using the best matching summarizer.
 *
 * This function handles page lifecycle:
 * 1. Creates a browser page and navigates to the URL
 * 2. Finds the best summarizer based on the page content
 * 3. Runs the summarizer
 * 4. Closes the page
 *
 * @param url - The URL to summarize
 * @param instruction - Optional instruction to guide behavior (e.g., "list all links", "find pricing info")
 * @param ctx - Extension context
 * @param onUpdate - Optional callback for progress updates
 * @param signal - Optional abort signal for cancellation
 * @param mode - Optional mode: "summarize" (default) or "full" for complete content
 * @param contentTypes - Expected content types (text, image, video) for summarizer selection
 * @returns The summarization result, or undefined if no summarizer can handle it
 */
export async function summarize(
    url: string,
    instruction: string | undefined,
    ctx: ExtensionContext,
    onUpdate?: SummarizerUpdateCallback,
    signal?: AbortSignal,
    mode?: SummarizerMode,
    contentTypes?: ContentType[],
): Promise<SummarizerResult | undefined> {
    const effectiveMode = mode ?? "summarize";

    // Create page and navigate to URL
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 30000,
        });

        // Check for cancellation
        if (signal?.aborted) {
            throw new Error("Cancelled");
        }

        // Find best summarizer with the navigated page
        const summarizer = await findSummarizer(url, effectiveMode, page, ctx, contentTypes);

        if (!summarizer) {
            return undefined;
        }

        // Run summarizer with the same page
        return await summarizer.summarize(url, instruction, ctx, page, onUpdate, signal, mode, contentTypes);
    } finally {
        await page.close().catch(() => {});
    }
}

// Built-in summarizers
import { markdownHtmlSummarizer } from "./markdown-html";
import { ocrV2Summarizer } from "./ocr-v2";

registerSummarizer(ocrV2Summarizer); // V2
registerSummarizer(markdownHtmlSummarizer);
