import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Page } from "puppeteer";

import websearchConfig from "../common/config";

import type { ContentType, Summarizer, SummarizerMode, SummarizerResult, SummarizerUpdateCallback } from "./base";

/**
 * Result of fetching raw content from a page.
 */
export interface RawContentResult {
    /** Page title */
    title: string;
    /** Raw text content */
    content: string;
    /** Final URL after redirects */
    url: string;
}

/**
 * Extract raw text content from a page using readability-like logic.
 *
 * @param page - Puppeteer page already navigated to the URL
 * @returns Extracted content with title, text, and final URL
 */
export async function extractRawContent(page: Page): Promise<RawContentResult> {
    // Wait a bit for any JS to execute
    await new Promise((r) => setTimeout(r, 500));

    // Extract content using readability-like logic
    const result = await page.evaluate(() => {
        // Get title
        const title = document.title || "";

        // Try to find main content area
        const mainSelectors = [
            "article",
            "[role='main']",
            "main",
            ".post-content",
            ".article-content",
            ".entry-content",
            ".content",
            "#content",
            "#main",
        ];

        let contentEl: Element | null = null;
        for (const selector of mainSelectors) {
            contentEl = document.querySelector(selector);
            if (contentEl) break;
        }

        // Fall back to body if no main content found
        if (!contentEl) {
            contentEl = document.body;
        }

        // Remove unwanted elements
        const removeSelectors = [
            "nav",
            "header",
            "footer",
            "aside",
            ".sidebar",
            ".navigation",
            ".menu",
            ".ads",
            ".advertisement",
            ".social",
            ".share",
            ".comments",
            "script",
            "style",
            "noscript",
            "iframe",
        ];

        for (const selector of removeSelectors) {
            contentEl?.querySelectorAll(selector).forEach((el) => el.remove());
        }

        // Extract text content with some structure preservation
        const extractText = (el: Element, depth: number = 0): string => {
            const parts: string[] = [];

            for (const child of Array.from(el.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE) {
                    const text = child.textContent?.trim();
                    if (text) parts.push(text);
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    const elem = child as Element;
                    const tag = elem.tagName.toLowerCase();

                    // Skip hidden elements
                    const style = window.getComputedStyle(elem);
                    if (style.display === "none" || style.visibility === "hidden") {
                        continue;
                    }

                    const childText = extractText(elem, depth + 1);

                    // Add structure based on tag
                    if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
                        const prefix = "#".repeat(parseInt(tag[1]));
                        parts.push(`\n\n${prefix} ${childText}\n`);
                    } else if (tag === "p") {
                        parts.push(`\n\n${childText}`);
                    } else if (tag === "br") {
                        parts.push("\n");
                    } else if (tag === "li") {
                        parts.push(`\n- ${childText}`);
                    } else if (tag === "a") {
                        const href = elem.getAttribute("href");
                        if (href && childText) {
                            parts.push(`[${childText}](${href})`);
                        } else {
                            parts.push(childText);
                        }
                    } else if (tag === "code") {
                        parts.push(`\`${childText}\``);
                    } else if (tag === "pre") {
                        parts.push(`\n\`\`\`\n${childText}\n\`\`\`\n`);
                    } else if (tag === "blockquote") {
                        const lines = childText
                            .split("\n")
                            .map((l) => `> ${l}`)
                            .join("\n");
                        parts.push(`\n\n${lines}\n`);
                    } else {
                        parts.push(childText);
                    }
                }
            }

            return parts.join(" ");
        };

        const content = extractText(contentEl)
            .replace(/\n{3,}/g, "\n\n") // Max 2 newlines
            .replace(/^\s+|\s+$/g, ""); // Trim

        return {
            title,
            content,
            url: window.location.href,
        };
    });

    return result;
}

/** System prompts for different modes */
const MARKDOWN_FULL_PROMPT = `You are a helpful assistant that extracts and cleans web page content.

Your task is to preserve ALL meaningful content from the page while removing noise:
- Keep all main content: articles, posts, documentation, tutorials, guides
- Remove navigation, ads, sidebars, footers, cookie banners, social share buttons
- Preserve the structure and formatting using markdown
- Keep all links as markdown links
- Include all headings, paragraphs, lists, code blocks, and images
- Do NOT summarize - preserve the full content
- Output clean, well-formatted markdown`;

const MARKDOWN_SUMMARIZE_PROMPT = `You are a helpful assistant that summarizes web page content.

When summarizing:
- Focus on the main content, not navigation, ads, or sidebars
- Preserve important links as markdown links
- Be concise but comprehensive
- Include key facts, numbers, and specific details
- Use markdown formatting for structure`;

const MARKDOWN_INSTRUCT_PROMPT = `You are a helpful assistant that follows instructions regarding web page content.

Follow the given instruction exactly and report your findings clearly.`;

/**
 * Check if a page is HTML content by examining the content-type.
 */
async function isHtmlContent(page: Page): Promise<boolean> {
    try {
        const docType = await page.evaluate(() => {
            return document.contentType || "";
        });
        return docType.includes("text/html") || docType === "";
    } catch {
        return true;
    }
}

/**
 * HTML-to-markdown summarizer.
 * - "full" mode: Uses LLM to extract and clean all main content (no summarization)
 * - "summarize" mode: Uses LLM to summarize extracted content
 * - "instruct" mode: Uses LLM to follow instructions on extracted content
 */
export const markdownHtmlSummarizer: Summarizer = {
    id: "markdown-html",
    priority: 10, // Low priority - fallback option

    async canHandle(
        _url: string,
        mode: SummarizerMode,
        page: Page,
        ctx: ExtensionContext,
        contentTypes?: ContentType[],
    ): Promise<number> {
        // Check if the page is HTML content
        if (!(await isHtmlContent(page))) {
            return 0;
        }

        // All modes need a configured model
        const config = websearchConfig.current;
        const { provider, modelId } = config.fetch.model;

        if (!provider || !modelId) {
            return 0;
        }

        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
            return 0;
        }

        // Boost score if only text is expected (markdown-html is ideal for text)
        if (contentTypes) {
            const hasOnlyText = contentTypes.length === 1 && contentTypes[0] === "text";
            const hasVisual = contentTypes.includes("image") || contentTypes.includes("video");

            if (hasOnlyText) {
                // Text-only is ideal for markdown-html
                return 0.9;
            } else if (hasVisual) {
                // If visual content expected, prefer OCR (lower score)
                return 0.3;
            }
        }

        // Return confidence based on mode
        return mode === "full" ? 0.3 : 0.5;
    },

    async summarize(
        _url: string,
        instruction: string | undefined,
        ctx: ExtensionContext,
        page: Page,
        onUpdate?: SummarizerUpdateCallback,
        signal?: AbortSignal,
        mode: SummarizerMode = "summarize",
        _contentTypes?: ContentType[],
    ): Promise<SummarizerResult> {
        onUpdate?.({ message: "Extracting page content..." });

        const rawContent = await extractRawContent(page);

        // All modes use LLM
        const config = websearchConfig.current;
        const { provider, modelId } = config.fetch.model;

        if (!provider || !modelId) {
            throw new Error("Model not configured for markdown summarization");
        }

        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
            throw new Error(`Configured model not found: ${provider}/${modelId}`);
        }

        const apiKey = await ctx.modelRegistry.getApiKey(model);

        const message = mode === "full" ? "Extracting full content..." : "Summarizing content...";
        onUpdate?.({ message });

        const systemPrompt =
            mode === "full"
                ? MARKDOWN_FULL_PROMPT
                : mode === "instruct"
                  ? MARKDOWN_INSTRUCT_PROMPT
                  : MARKDOWN_SUMMARIZE_PROMPT;

        const userContent = instruction
            ? `Instruction: "${instruction}"\n\nPage content:\n\n# ${rawContent.title}\n\nURL: ${rawContent.url}\n\n${rawContent.content}`
            : `# ${rawContent.title}\n\nURL: ${rawContent.url}\n\n${rawContent.content}`;

        const response = await complete(
            model,
            {
                systemPrompt,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: userContent }],
                        timestamp: Date.now(),
                    },
                ],
            },
            { apiKey, signal },
        );

        // Extract text from response
        const summary =
            typeof response.content === "string"
                ? response.content
                : response.content
                      .filter((c): c is { type: "text"; text: string } => c.type === "text")
                      .map((c) => c.text)
                      .join("\n");

        return {
            summary,
            summarizerId: this.id,
            usedLlm: true,
        };
    },
};
