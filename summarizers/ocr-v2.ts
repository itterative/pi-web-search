import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Page } from "puppeteer";

import websearchConfig from "../common/config";

import type { ContentType, Summarizer, SummarizerMode, SummarizerResult, SummarizerUpdateCallback } from "./base";
import {
    createFullOcrSummarizerV2,
    createSummarizeOcrSummarizerV2,
    createExploreOcrSummarizerV2,
    type OcrSummarizerConfig,
    InteractionPositioning,
} from "./ocr/index";
import { takeScreenshot } from "./ocr/screenshot";

/**
 * Extract meaningful links from a page.
 * Filters out navigation, ads, and other non-content links.
 */
async function extractLinks(page: Page, baseUrl: string): Promise<Array<{ href: string; text: string }>> {
    return page.evaluate((base) => {
        const baseUri = new URL(base);
        const links: Array<{ href: string; text: string }> = [];

        // Selectors to exclude (navigation, ads, footers, etc.)
        const excludeSelectors = [
            "nav",
            "header",
            "footer",
            ".nav",
            ".navigation",
            ".menu",
            ".sidebar",
            ".ad",
            ".ads",
            ".advertisement",
            ".social",
            ".share",
            ".footer",
            ".header",
            "[role=navigation]",
            "[role=banner]",
            "[role=contentinfo]",
        ];

        const excludeElements = excludeSelectors
            .flatMap((s) => Array.from(document.querySelectorAll(s)))
            .filter(Boolean);

        const isExcluded = (el: Element): boolean => {
            let current: Element | null = el;
            while (current) {
                if (excludeElements.includes(current)) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        };

        document.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href");
            if (!href) return;

            // Skip excluded sections
            if (isExcluded(a)) return;

            // Skip anchor links, javascript, mailto
            if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
                return;
            }

            // Get visible text
            const text = a.textContent?.trim().slice(0, 100) ?? "";
            if (!text || text.length < 2) return;

            // Resolve relative URLs
            let resolvedUrl: URL;
            try {
                resolvedUrl = new URL(href, base);
            } catch {
                return;
            }

            // Skip if same as base URL
            if (resolvedUrl.href === baseUri.href) return;

            // Keep links from same domain or subdomain
            const isSameDomain =
                resolvedUrl.hostname === baseUri.hostname ||
                resolvedUrl.hostname.endsWith("." + baseUri.hostname) ||
                baseUri.hostname.endsWith("." + resolvedUrl.hostname);

            // For external links, only keep if they look like content references
            if (!isSameDomain) {
                // Skip common non-content patterns
                const skipPatterns = [
                    /facebook\.com/i,
                    /twitter\.com/i,
                    /x\.com/i,
                    /linkedin\.com/i,
                    /instagram\.com/i,
                    /youtube\.com/i,
                    /github\.com\/(login|signup)/i,
                    /accounts?\.google/i,
                    /appleid\.apple\.com/i,
                ];
                if (skipPatterns.some((p) => p.test(resolvedUrl.href))) return;
            }

            links.push({
                href: resolvedUrl.href,
                text,
            });
        });

        // Dedupe by href, keep first occurrence
        const seen = new Set<string>();
        return links.filter((link) => {
            if (seen.has(link.href)) return false;
            seen.add(link.href);
            return true;
        });
    }, baseUrl);
}

/**
 * Format links for inclusion in the prompt.
 */
function formatLinks(links: Array<{ href: string; text: string }>, maxLinks: number = 30): string {
    if (links.length === 0) {
        return "";
    }

    const limited = links.slice(0, maxLinks);
    const formatted = limited.map((l) => `- [${l.text}](${l.href})`).join("\n");

    if (links.length > maxLinks) {
        return `${formatted}\n\n(${links.length - maxLinks} more links not shown)`;
    }

    return formatted;
}

/**
 * OCR-based summarizer using the V2 architecture with tools and extensions.
 *
 * This summarizer uses the refactored V2 implementation which provides:
 * - Modular tool system (click, scroll, type, etc.)
 * - Extension architecture (screenshots, checkpoints, navigation)
 * - Better testability and configurability
 *
 * Mode mapping:
 * - "summarize" → SummarizeOcrSummarizerV2 (cursor, click, scroll, screenshot tools)
 * - "full" → FullOcrSummarizerV2 (scroll tool only)
 * - "instruct" → ExploreOcrSummarizerV2 (all tools)
 *
 * Requires:
 * - `fetch.useOcrV2` to be enabled in config (or falls back to V1 behavior)
 * - A configured model with image input support
 */
export const ocrV2Summarizer: Summarizer = {
    id: "ocr-v2",
    priority: 50, // Same as V1

    canHandle(
        _url: string,
        _mode: SummarizerMode,
        _page: Page,
        ctx: ExtensionContext,
        contentTypes?: ContentType[],
    ): number {
        const config = websearchConfig.current;

        if (!config.fetch.useOcr) {
            return 0;
        }

        const { provider, modelId } = config.fetch.model;
        if (!provider || !modelId) {
            return 0;
        }

        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
            return 0;
        }

        if (!model.input.includes("image")) {
            return 0;
        }

        // Boost score if visual content is expected
        if (contentTypes) {
            const hasVisual = contentTypes.includes("image") || contentTypes.includes("video");
            const hasOnlyText = contentTypes.length === 1 && contentTypes[0] === "text";

            if (hasVisual) {
                // OCR is ideal for visual content
                return 1.0;
            } else if (hasOnlyText) {
                // If only text expected, prefer markdown-html (lower score)
                return 0.4;
            }
        }

        return 0.9;
    },

    async summarize(
        url: string,
        instruction: string | undefined,
        ctx: ExtensionContext,
        page: Page,
        onUpdate?: SummarizerUpdateCallback,
        signal?: AbortSignal,
        mode: SummarizerMode = "summarize",
        _contentTypes?: ContentType[],
    ): Promise<SummarizerResult> {
        // const positioning: InteractionPositioning = { type: "absolute" };
        const positioning: InteractionPositioning = {
            type: "relative",
            x: 1000,
            y: 1000,
        };

        const config = websearchConfig.current;
        const { provider, modelId } = config.fetch.model;

        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
            throw new Error(`Configured model not found: ${provider}/${modelId}`);
        }

        const apiKey = await ctx.modelRegistry.getApiKey(model);

        const width = config.fetch.screenshotWidth ?? 1280;
        const maxHeight = config.fetch.screenshotMaxHeight ?? 3000;
        const maxRounds = config.fetch.interactionRounds ?? 10;
        const delay = config.fetch.interactionDelay ?? 500;

        // Instruct mode always uses interactive mode and requires an instruction
        const interactive = mode === "instruct" || maxRounds > 0;

        // Validate instruct mode has an instruction
        if (mode === "instruct" && !instruction) {
            throw new Error("mode='instruct' requires an instruction parameter");
        }

        // Set viewport to desired width
        await page.setViewport({ width, height: 800 });

        // Check for cancellation
        if (signal?.aborted) {
            throw new Error("Summarization cancelled");
        }

        // Extract links
        onUpdate?.({ message: "Extracting page links..." });
        const links = await extractLinks(page, url);
        const linksContext = formatLinks(links);

        // Take initial screenshot
        onUpdate?.({ message: "Capturing screenshot..." });
        const screenshotResult = await takeScreenshot(page, { width, maxHeight });

        // Build config for V2 summarizers
        // Overlay handling is done by OverlayExtension registered in OcrBase
        const summarizerConfig: OcrSummarizerConfig = {
            page,
            model,
            apiKey,
            width,
            maxHeight,
            maxRounds: mode === "instruct" ? Math.max(maxRounds, 10) : maxRounds,
            delay,
            checkpointThreshold: config.fetch.checkpointThreshold,
            positioning,
            interaction: {
                minZoomDimension: 300,
            },
            overlay: {
                maxIterations: config.fetch.captchaMaxIterations ?? 20,
            },
        };

        // Select the appropriate V2 summarizer based on mode
        const summarizer =
            mode === "full"
                ? createFullOcrSummarizerV2(summarizerConfig)
                : mode === "instruct"
                  ? createExploreOcrSummarizerV2(summarizerConfig)
                  : createSummarizeOcrSummarizerV2(summarizerConfig);

        // Notification helper
        const notify = (message: string, type?: "info" | "warning" | "error") => {
            ctx.ui.notify(message, type);
        };

        // Run the summarizer
        return await summarizer.run({
            instruction,
            linksContext,
            screenshot: screenshotResult.data,
            onUpdate,
            notify,
            signal,
        });
    },
};
