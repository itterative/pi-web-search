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

/** A DOM node's metadata returned from page.evaluate */
interface NodeInfo {
    /** Index in the flat child list */
    idx: number;
    /** Node text content */
    text: string;
    /** Tag name (uppercase) */
    tag: string;
    /** Whether this node or its direct child is a heading */
    isHeading: boolean;
}

/**
 * Extract a structural outline from the page by finding the deepest meaningful
 * content container, then splitting its children into sections at heading
 * boundaries. Merges small adjacent sections to keep entries in the 5k–20k
 * character range.
 *
 * All DOM reads happen in page.evaluate; splitting/merging runs in Node.
 */
export async function extractOutline(page: Page): Promise<OutlineEntry[]> {
    // ── Step 1: Read DOM structure ───────────────────────────────────────
    const domData = await page.evaluate(() => {
        const contentSelectors = [
            "article",
            "[role='main']",
            "main",
            ".post-content",
            ".article-content",
            ".entry-content",
            ".s-prose",
            ".mw-parser-output",
            ".content",
            "#content",
            "#main",
            "#bodyContent",
            "#mw-content-text",
        ];

        const blockTags = new Set([
            "DIV",
            "SECTION",
            "ARTICLE",
            "P",
            "H1",
            "H2",
            "H3",
            "H4",
            "H5",
            "H6",
            "UL",
            "OL",
            "TABLE",
            "PRE",
            "BLOCKQUOTE",
            "DETAILS",
            "DL",
            "FIGURE",
            "FORM",
            "FIELDSET",
        ]);

        const headingSelector = "h1, h2, h3, h4, h5, h6";

        // Find best content container
        let contentEl: Element = document.body;
        let bestScore = 0;
        for (const selector of contentSelectors) {
            const matches = document.querySelectorAll(selector);
            matches.forEach(function (el) {
                let bc = 0;
                for (const child of Array.from(el.children)) {
                    if (!blockTags.has(child.tagName.toUpperCase())) continue;
                    const text = child.textContent?.trim() ?? "";
                    if (text.length > 0) bc++;
                }
                const textLen = el.textContent?.trim().length ?? 0;
                if (bc >= 3 && textLen > 1000 && bc > bestScore) {
                    bestScore = bc;
                    contentEl = el;
                }
            });
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
            contentEl.querySelectorAll(selector).forEach(function (el) {
                el.remove();
            });
        }

        // Collect direct block children info
        const nodes: NodeInfo[] = [];
        let idx = 0;
        for (const child of Array.from(contentEl.children)) {
            if (!blockTags.has(child.tagName.toUpperCase())) continue;

            const style = window.getComputedStyle(child);
            if (style.display === "none" || style.visibility === "hidden") continue;

            const text = child.textContent?.trim() ?? "";
            if (text.length === 0) continue;

            const isHeading =
                child.matches(headingSelector) || child.querySelector(":scope > " + headingSelector) !== null;

            nodes.push({ idx, text, tag: child.tagName, isHeading });
            idx++;
        }

        return { nodes, totalTextLen: contentEl.textContent?.trim().length ?? 0 };
    });

    if (domData.nodes.length === 0) return [];

    // ── Step 2: Split into sections at heading boundaries ────────────────
    interface Section {
        nodeIndices: number[];
        text: string;
    }

    const sections: Section[] = [];
    let currentIndices: number[] = [];
    let currentText = "";

    function flushSection() {
        const trimmed = currentText.trim();
        if (trimmed.length === 0) return;
        sections.push({ nodeIndices: [...currentIndices], text: trimmed });
        currentIndices = [];
        currentText = "";
    }

    for (const node of domData.nodes) {
        if (node.isHeading && currentText.trim().length > 0) {
            flushSection();
        }

        currentIndices.push(node.idx);
        currentText += "\n" + node.text;

        if (node.text.length > MAX_ENTRY_CHARS) {
            flushSection();
        }
    }
    flushSection();

    // ── Step 3: Merge small adjacent sections ────────────────────────────
    interface MergedSection {
        nodeIndices: number[];
        text: string;
    }

    const merged: MergedSection[] = [];
    let mergeIndices: number[] = [];
    let mergeText = "";

    function flushMerged() {
        const trimmed = mergeText.trim();
        if (trimmed.length === 0) return;
        merged.push({ nodeIndices: [...mergeIndices], text: trimmed });
        mergeIndices = [];
        mergeText = "";
    }

    for (const section of sections) {
        mergeIndices.push(...section.nodeIndices);
        mergeText += "\n" + section.text;

        if (mergeText.trim().length >= MIN_ENTRY_CHARS) {
            flushMerged();
        }
    }

    // Flush remaining
    if (mergeText.trim().length > 0) {
        if (merged.length > 0) {
            const last = merged[merged.length - 1];
            last.nodeIndices.push(...mergeIndices);
            last.text += "\n" + mergeText.trim();
        } else {
            flushMerged();
        }
    }

    if (merged.length === 0) return [];

    // ── Step 4: Tag DOM nodes and build result ───────────────────────────
    // Build a mapping: nodeIdx -> outlineId
    const nodeToOutline: Map<number, string> = new Map();
    const entries: OutlineEntry[] = merged.map(function (section, i) {
        const outlineId = `outline-${i}`;
        for (const idx of section.nodeIndices) {
            nodeToOutline.set(idx, outlineId);
        }
        return {
            index: i + 1,
            preview: section.text.slice(0, PREVIEW_LENGTH).replace(/\n/g, " "),
            charCount: section.text.length,
            outlineId,
        };
    });

    // Write data-outline-id attributes back to the DOM
    await page.evaluate(function (mapping: Array<[number, string]>) {
        // Re-find the content container
        const contentSelectors = [
            "article",
            "[role='main']",
            "main",
            ".post-content",
            ".article-content",
            ".entry-content",
            ".s-prose",
            ".mw-parser-output",
            ".content",
            "#content",
            "#main",
            "#bodyContent",
            "#mw-content-text",
        ];

        const blockTags = new Set([
            "DIV",
            "SECTION",
            "ARTICLE",
            "P",
            "H1",
            "H2",
            "H3",
            "H4",
            "H5",
            "H6",
            "UL",
            "OL",
            "TABLE",
            "PRE",
            "BLOCKQUOTE",
            "DETAILS",
            "DL",
            "FIGURE",
            "FORM",
            "FIELDSET",
        ]);

        let contentEl: Element = document.body;
        let bestScore = 0;
        for (const selector of contentSelectors) {
            const matches = document.querySelectorAll(selector);
            matches.forEach(function (el) {
                let bc = 0;
                for (const child of Array.from(el.children)) {
                    if (!blockTags.has(child.tagName.toUpperCase())) continue;
                    const text = child.textContent?.trim() ?? "";
                    if (text.length > 0) bc++;
                }
                const textLen = el.textContent?.trim().length ?? 0;
                if (bc >= 3 && textLen > 1000 && bc > bestScore) {
                    bestScore = bc;
                    contentEl = el;
                }
            });
        }

        // Collect the same block children in the same order
        let idx = 0;
        for (const child of Array.from(contentEl.children)) {
            if (!blockTags.has(child.tagName.toUpperCase())) continue;
            const style = window.getComputedStyle(child);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const text = child.textContent?.trim() ?? "";
            if (text.length === 0) continue;

            for (const [nodeIdx, outlineId] of mapping) {
                if (nodeIdx === idx) {
                    child.setAttribute("data-outline-id", outlineId);
                }
            }
            idx++;
        }
    }, Array.from(nodeToOutline.entries()));

    return entries;
}

/**
 * Extract text content from only the selected DOM nodes identified by their
 * outline IDs. Produces structured markdown similar to extractRawContent().
 */
export async function extractSelectedContent(page: Page, entries: OutlineEntry[]): Promise<string> {
    const outlineIds = entries.map((e) => e.outlineId);

    const texts = await page.evaluate(function (ids: string[]) {
        const results: string[] = [];

        for (const id of ids) {
            const nodes = document.querySelectorAll('[data-outline-id="' + id + '"]');
            if (nodes.length === 0) continue;

            const sectionTexts: string[] = [];

            for (let ni = 0; ni < nodes.length; ni++) {
                const el = nodes[ni];

                // Recursive text extraction with markdown formatting
                function formatText(node: Element, outlineId: string): string {
                    const pieces: string[] = [];

                    for (const child of Array.from(node.childNodes)) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            const t = child.textContent?.trim();
                            if (t) pieces.push(t);
                        } else if (child.nodeType === Node.ELEMENT_NODE) {
                            const elem = child as Element;
                            const tag = elem.tagName.toLowerCase();

                            const attr = elem.getAttribute("data-outline-id");
                            if (attr && attr !== outlineId) continue;

                            const style = window.getComputedStyle(elem);
                            if (style.display === "none" || style.visibility === "hidden") continue;

                            const inner = formatText(elem, outlineId);
                            if (!inner) continue;

                            if (["h1", "h2", "h3", "h4", "h5", "h6"].indexOf(tag) !== -1) {
                                const prefix = "#".repeat(parseInt(tag[1]));
                                pieces.push("\n\n" + prefix + " " + inner + "\n");
                            } else if (tag === "p") {
                                pieces.push("\n\n" + inner);
                            } else if (tag === "br") {
                                pieces.push("\n");
                            } else if (tag === "li") {
                                pieces.push("\n- " + inner);
                            } else if (tag === "a") {
                                const href = elem.getAttribute("href");
                                if (href && inner) {
                                    pieces.push("[" + inner + "](" + href + ")");
                                } else {
                                    pieces.push(inner);
                                }
                            } else if (tag === "code") {
                                pieces.push("`" + inner + "`");
                            } else if (tag === "pre") {
                                pieces.push("\n```\n" + inner + "\n```\n");
                            } else if (tag === "blockquote") {
                                const lines = inner
                                    .split("\n")
                                    .map(function (l) {
                                        return "> " + l;
                                    })
                                    .join("\n");
                                pieces.push("\n\n" + lines + "\n");
                            } else {
                                pieces.push(inner);
                            }
                        }
                    }

                    return pieces.join(" ");
                }

                const text = formatText(el, id)
                    .replace(/\n{3,}/g, "\n\n")
                    .replace(/^\s+|\s+$/g, "");

                if (text) sectionTexts.push(text);
            }

            results.push(sectionTexts.join("\n\n"));
        }

        return results;
    }, outlineIds);

    return texts.join("\n\n");
}
