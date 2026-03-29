import type { Page } from "puppeteer";

/**
 * An outline entry representing a section of the page.
 * Used internally and for model selection.
 */
export interface OutlineEntry {
    /** Sequential index (1-based) presented to the model */
    index: number;
    /** First ~100 characters of the entry's content */
    preview: string;
    /** Character count of the entry's content */
    charCount: number;
    /** Internal reference: the data-outline-id attribute value */
    outlineId: string;
}

/** Minimum characters for a standalone entry */
const MIN_ENTRY_CHARS = 5000;
/** Maximum characters per entry before splitting */
const MAX_ENTRY_CHARS = 20000;
/** Preview text length */
const PREVIEW_LENGTH = 100;

/**
 * Extract a structural outline from the page by finding block-level containers
 * with significant text content, splitting/merging to keep entries in the
 * 5k-20k character range.
 *
 * Injects `data-outline-id` attributes into the DOM for later extraction.
 */
export async function extractOutline(page: Page): Promise<OutlineEntry[]> {
    const rawEntries = await page.evaluate(
        (minChars: number, maxChars: number, previewLen: number) => {
            // Find main content area
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
                contentEl.querySelectorAll(selector).forEach((el) => el.remove());
            }

            // Collect block-level children that have text content
            const blockTags = new Set([
                "DIV",
                "SECTION",
                "ARTICLE",
                "MAIN",
                "P",
                "H1",
                "H2",
                "H3",
                "H4",
                "H5",
                "H6",
                "UL",
                "OL",
                "LI",
                "TABLE",
                "PRE",
                "BLOCKQUOTE",
                "DETAILS",
                "DL",
                "FIGURE",
                "FIGCAPTION",
                "FORM",
                "FIELDSET",
            ]);

            // Get direct block children with their text
            const candidates: { node: Element; text: string }[] = [];
            for (const child of Array.from(contentEl.children)) {
                if (!blockTags.has(child.tagName.toUpperCase())) continue;

                const style = window.getComputedStyle(child);
                if (style.display === "none" || style.visibility === "hidden") continue;

                const text = child.textContent?.trim() ?? "";
                if (text.length === 0) continue;

                candidates.push({ node: child, text });
            }

            // If no block children found, use the content element itself
            if (candidates.length === 0) {
                const text = contentEl.textContent?.trim() ?? "";
                if (text.length === 0) return [];

                const id = "outline-0";
                contentEl.setAttribute("data-outline-id", id);
                return [
                    {
                        outlineId: id,
                        text,
                        preview: text.slice(0, previewLen).replace(/\n/g, " "),
                        charCount: text.length,
                    },
                ];
            }

            // Phase 1: Split large nodes at heading boundaries
            const headingSelectors = "h1, h2, h3, h4, h5, h6";
            const splitNodes: { node: Element; text: string }[] = [];

            for (const candidate of candidates) {
                if (candidate.text.length <= maxChars) {
                    splitNodes.push(candidate);
                } else {
                    // Try to split at heading boundaries
                    const headings = Array.from(candidate.node.querySelectorAll(headingSelectors));

                    if (headings.length > 1) {
                        // Split into sections between headings
                        let sectionNodes: Element[] = [];
                        let sectionText = "";

                        const flushSection = () => {
                            if (sectionText.trim().length > 0) {
                                const wrapper = document.createElement("div");
                                sectionNodes.forEach((n) => wrapper.appendChild(n.cloneNode(true)));
                                candidate.node.parentElement!.insertBefore(wrapper, candidate.node);
                                splitNodes.push({ node: wrapper, text: sectionText.trim() });
                                sectionNodes = [];
                                sectionText = "";
                            }
                        };

                        for (const child of Array.from(candidate.node.children)) {
                            if (child.matches(headingSelectors)) {
                                flushSection();
                            }
                            const childText = child.textContent?.trim() ?? "";
                            if (childText.length > 0) {
                                sectionNodes.push(child);
                                sectionText += "\n" + childText;
                            }
                        }
                        flushSection();

                        // Remove original node
                        candidate.node.remove();
                    } else {
                        // Can't split at headings, split at paragraph boundaries
                        const paragraphs = Array.from(candidate.node.querySelectorAll("p"));
                        if (paragraphs.length > 1) {
                            let chunkNodes: Element[] = [];
                            let chunkText = "";

                            const flushChunk = () => {
                                if (chunkText.trim().length > 0) {
                                    const wrapper = document.createElement("div");
                                    chunkNodes.forEach((n) => wrapper.appendChild(n.cloneNode(true)));
                                    candidate.node.parentElement!.insertBefore(wrapper, candidate.node);
                                    splitNodes.push({ node: wrapper, text: chunkText.trim() });
                                    chunkNodes = [];
                                    chunkText = "";
                                }
                            };

                            for (const p of paragraphs) {
                                const pText = p.textContent?.trim() ?? "";
                                if (chunkText.length + pText.length > maxChars && chunkText.length > 0) {
                                    flushChunk();
                                }
                                chunkNodes.push(p);
                                chunkText += "\n" + pText;
                            }
                            flushChunk();

                            candidate.node.remove();
                        } else {
                            // No good split points, keep as-is
                            splitNodes.push(candidate);
                        }
                    }
                }
            }

            // Phase 2: Merge small adjacent nodes
            // Result entries: { outlineId, text, preview, charCount }
            const result: { outlineId: string; text: string; preview: string; charCount: number }[] = [];
            let mergeBuffer: { node: Element; text: string }[] = [];
            let mergeText = "";

            const flushMerged = () => {
                if (mergeText.trim().length === 0) return;

                const id = `outline-${result.length}`;
                if (mergeBuffer.length === 1) {
                    // Single node
                    mergeBuffer[0].node.setAttribute("data-outline-id", id);
                } else {
                    // Multiple nodes merged - wrap in container
                    const wrapper = document.createElement("div");
                    const parent = mergeBuffer[0].node.parentElement;
                    mergeBuffer.forEach((b) => {
                        wrapper.appendChild(b.node.cloneNode(true));
                        b.node.remove();
                    });
                    if (parent) {
                        parent.insertBefore(wrapper, mergeBuffer[0].node);
                    } else {
                        document.body.appendChild(wrapper);
                    }
                    wrapper.setAttribute("data-outline-id", id);
                }

                const text = mergeText.trim();
                result.push({
                    outlineId: id,
                    text,
                    preview: text.slice(0, previewLen).replace(/\n/g, " "),
                    charCount: text.length,
                });
                mergeBuffer = [];
                mergeText = "";
            };

            for (const node of splitNodes) {
                mergeBuffer.push(node);
                mergeText += "\n" + node.text;

                if (mergeText.trim().length >= minChars) {
                    flushMerged();
                }
            }

            // Flush remaining small nodes
            if (mergeText.trim().length > 0) {
                if (result.length > 0) {
                    // Append to last entry
                    const lastEntry = result[result.length - 1];
                    lastEntry.text += "\n" + mergeText.trim();
                    lastEntry.charCount = lastEntry.text.length;
                    lastEntry.preview = lastEntry.text.slice(0, previewLen).replace(/\n/g, " ");

                    // Move remaining nodes under last entry's element
                    const lastEl = document.querySelector(`[data-outline-id="${lastEntry.outlineId}"]`);
                    if (lastEl) {
                        mergeBuffer.forEach((b) => {
                            lastEl.appendChild(b.node.cloneNode(true));
                            b.node.remove();
                        });
                    }
                } else {
                    // Only entry, keep it even if small
                    flushMerged();
                }
            }

            return result;
        },
        MIN_ENTRY_CHARS,
        MAX_ENTRY_CHARS,
        PREVIEW_LENGTH,
    );

    if (!rawEntries || rawEntries.length === 0) return [];

    // Build OutlineEntry list with sequential indices
    const entries: OutlineEntry[] = rawEntries.map((e, i) => ({
        index: i + 1,
        preview: e.preview,
        charCount: e.charCount,
        outlineId: e.outlineId,
    }));

    return entries;
}

/**
 * Extract text content from only the selected DOM nodes identified by their
 * outline IDs. Produces structured markdown similar to extractRawContent().
 */
export async function extractSelectedContent(page: Page, entries: OutlineEntry[]): Promise<string> {
    const outlineIds = entries.map((e) => e.outlineId);

    const texts = await page.evaluate((ids: string[]) => {
        const results: string[] = [];

        for (const id of ids) {
            const el = document.querySelector(`[data-outline-id="${id}"]`);
            if (!el) continue;

            // Reuse the same text extraction logic as extractRawContent
            const extractText = (node: Element): string => {
                const parts: string[] = [];

                for (const child of Array.from(node.childNodes)) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const text = child.textContent?.trim();
                        if (text) parts.push(text);
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        const elem = child as Element;
                        const tag = elem.tagName.toLowerCase();

                        const style = window.getComputedStyle(elem);
                        if (style.display === "none" || style.visibility === "hidden") continue;

                        const childText = extractText(elem);

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
                                .map((l: string) => `> ${l}`)
                                .join("\n");
                            parts.push(`\n\n${lines}\n`);
                        } else {
                            parts.push(childText);
                        }
                    }
                }

                return parts.join(" ");
            };

            const text = extractText(el)
                .replace(/\n{3,}/g, "\n\n")
                .replace(/^\s+|\s+$/g, "");

            results.push(text);
        }

        return results;
    }, outlineIds);

    return texts.join("\n\n");
}
