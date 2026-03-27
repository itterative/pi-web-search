import { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Browser, Page } from "puppeteer";

import { Provider, ProviderSearchResult } from "./base";
import websearchConfig, { DuckDuckGoWebProviderConfig } from "../common/config";

/**
 * Represents a node in the accessibility tree
 */
interface AccessibilityNode {
    role: string;
    name?: string;
    url?: string;
    children?: AccessibilityNode[];
}

/**
 * DuckDuckGo web search provider using Puppeteer to scrape the HTML search page.
 * No authentication required.
 */
export class DuckDuckGoWebProvider implements Provider<DuckDuckGoWebProviderConfig> {
    readonly #type = "duckduckgo-web";

    get type(): string {
        return this.#type;
    }

    async process(
        browser: Browser,
        query: string,
        ctx: ExtensionContext,
        signal?: AbortSignal,
    ): Promise<ProviderSearchResult[] | undefined> {
        const config = this.#getConfig(ctx);

        const page = await browser.newPage();
        page.setDefaultTimeout(30000);

        // Set up abort handler to close page on cancellation
        const abortHandler = () => {
            page.close().catch(() => {});
        };
        signal?.addEventListener("abort", abortHandler);

        try {
            // Check if already aborted
            if (signal?.aborted) {
                return undefined;
            }

            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

            // Navigate to the search page and wait for it to load
            await page.goto(searchUrl, {
                waitUntil: "networkidle2",
                signal: signal,
            });

            // Check if aborted after navigation
            if (signal?.aborted) {
                return undefined;
            }

            // Get the accessibility tree
            const accessibilityTree = await page.accessibility.snapshot({
                interestingOnly: false,
            });

            // Check if aborted after snapshot
            if (signal?.aborted) {
                return undefined;
            }

            const maxResults = config.maxResults ?? websearchConfig.current.search.maxResults;

            // Extract search results from the accessibility tree
            const results = this.#extractSearchResults(accessibilityTree, maxResults);

            return results;
        } finally {
            signal?.removeEventListener("abort", abortHandler);
            await page.close().catch(() => {});
        }
    }

    #getConfig(ctx: ExtensionContext): DuckDuckGoWebProviderConfig {
        const config = websearchConfig.current;
        return config.providers["duckduckgo-web"];
    }

    /**
     * Extract search results from the accessibility tree
     */
    #extractSearchResults(tree: unknown, maxResults: number): ProviderSearchResult[] {
        if (!tree) return [];

        // Find the results container
        const container = this.#findResultsContainer(tree);
        if (!container || !container.children) return [];

        // Group children into result blocks
        const resultBlocks = this.#groupResultBlocks(container.children);
        const results: ProviderSearchResult[] = [];

        for (const block of resultBlocks) {
            if (results.length >= maxResults) break;

            const result = this.#extractFromResultBlock(block);
            if (result) results.push(result);
        }

        return results;
    }

    /**
     * Find the results container: look for a generic node that has at least 2
     * heading descendants (direct or nested one level deep in "none" nodes)
     */
    #findResultsContainer(node: unknown): AccessibilityNode | null {
        if (!node) return null;

        const n = node as AccessibilityNode;

        // Check if this is a generic node with heading descendants
        if (n.role === "generic" && n.children?.length) {
            const headingCount = this.#countHeadingDescendants(n, 3);

            if (headingCount >= 2) {
                return n;
            }
        }

        // Recursively search children
        if (!n.children) return null;

        for (const child of n.children) {
            const found = this.#findResultsContainer(child);
            if (found) return found;
        }

        return null;
    }

    /**
     * Count heading descendants up to a max depth
     */
    #countHeadingDescendants(node: AccessibilityNode, maxDepth: number): number {
        if (maxDepth <= 0 || !node.children) return 0;

        let count = 0;
        for (const child of node.children) {
            if (child.role === "heading") {
                count++;
            } else {
                count += this.#countHeadingDescendants(child, maxDepth - 1);
            }
        }
        return count;
    }

    /**
     * Check if a node has a heading descendant
     */
    #hasHeading(node: AccessibilityNode): boolean {
        if (node.role === "heading") return true;
        if (!node.children) return false;
        return node.children.some((child) => this.#hasHeading(child));
    }

    /**
     * Group children into result blocks.
     * Each result is either a "none" node or a "generic" wrapping a "none" node
     */
    #groupResultBlocks(children: AccessibilityNode[]): AccessibilityNode[][] {
        const blocks: AccessibilityNode[][] = [];

        for (const child of children) {
            // Direct "none" node with heading
            if (child.role === "none" && child.children?.length && this.#hasHeading(child)) {
                blocks.push(child.children);
            }
            // Generic node wrapping a "none" with heading
            else if (child.role === "generic" && child.children?.length) {
                for (const grandchild of child.children) {
                    if (grandchild.role === "none" && grandchild.children?.length && this.#hasHeading(grandchild)) {
                        blocks.push(grandchild.children);
                    }
                }
            }
        }

        return blocks;
    }

    /**
     * Extract a result from a block of nodes.
     * Expected pattern: [heading, generic, link, ...]
     */
    #extractFromResultBlock(block: AccessibilityNode[]): ProviderSearchResult | null {
        if (block.length < 2) return null;

        const heading = block[0];

        // Extract URL and title from heading's link
        const headingLink = this.#findNodeByRole(heading, "link");
        if (!headingLink?.url || !heading.name) return null;

        const resultUrl = this.#decodeDuckDuckGoUrl(headingLink.url);

        // Find the snippet from the link node
        let snippet = "";

        for (let i = 1; i < block.length; i++) {
            const node = block[i];

            if (node.role === "link" && node.url && node.name) {
                // The snippet is the link with matching URL that has actual text
                const nodeUrl = this.#decodeDuckDuckGoUrl(node.url);
                if (this.#urlsMatch(resultUrl, nodeUrl) && node.name.length > 50) {
                    snippet = node.name;
                    break;
                }
            }
        }

        return {
            title: heading.name.trim(),
            url: resultUrl.trim(),
            snippet: snippet.trim(),
        };
    }

    /**
     * Find a node with a specific role in the tree
     */
    #findNodeByRole(node: unknown, role: string): AccessibilityNode | null {
        if (!node) return null;
        const n = node as AccessibilityNode;
        if (n.role === role) return n;

        if (!n.children) return null;

        for (const child of n.children) {
            const found = this.#findNodeByRole(child, role);
            if (found) return found;
        }

        return null;
    }

    /**
     * Check if two URLs refer to the same resource (normalize and compare)
     */
    #urlsMatch(url1: string, url2: string): boolean {
        if (!url1 || !url2) return false;

        // Normalize URLs for comparison
        const normalize = (url: string): string => {
            try {
                const parsed = new URL(url);
                // Remove trailing slashes and common tracking params
                return parsed.origin + parsed.pathname.replace(/\/$/, "");
            } catch {
                return url.toLowerCase().replace(/\/$/, "");
            }
        };

        return normalize(url1) === normalize(url2);
    }

    /**
     * Decode a DuckDuckGo redirect URL to get the actual target URL.
     * DDG URLs look like: https://duckduckgo.com/l/?uddg=ENCODED_URL&rut=...
     */
    #decodeDuckDuckGoUrl(url: string): string {
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== "duckduckgo.com" || parsed.pathname !== "/l/") {
                return url; // Not a DDG redirect URL
            }

            const uddg = parsed.searchParams.get("uddg");
            if (uddg) {
                return decodeURIComponent(uddg);
            }

            return url;
        } catch {
            return url;
        }
    }
}
