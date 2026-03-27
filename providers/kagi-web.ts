import { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Browser, Page } from "puppeteer";

import { Provider, ProviderSearchResult } from "./base";
import websearchConfig, { KagiWebProviderConfig } from "../common/config";

/**
 * Kagi web search provider using Puppeteer to scrape the HTML search page.
 * Requires a session token to be set via /kagi-login.
 */
export class KagiWebProvider implements Provider<KagiWebProviderConfig> {
    readonly #type = "kagi-web";

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

            // Set the session token cookie for authentication
            await browser.setCookie({
                name: "kagi_session",
                value: config.sessionToken,
                domain: ".kagi.com",
                path: "/",
                httpOnly: true,
                secure: true,
            });

            const searchUrl = `https://kagi.com/html/search?q=${encodeURIComponent(query)}`;

            // Navigate to the search page and wait for it to load
            await page.goto(searchUrl, {
                waitUntil: "networkidle2",
                signal: signal,
            });

            // Check if aborted after navigation
            if (signal?.aborted) {
                return undefined;
            }

            // Get the main element and snapshot only its accessibility tree
            const mainElement = await page.$("main");
            const accessibilityTree = mainElement
                ? await page.accessibility.snapshot({
                      interestingOnly: false,
                      root: mainElement,
                  })
                : await page.accessibility.snapshot({
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

    #getConfig(ctx: ExtensionContext): KagiWebProviderConfig {
        const config = websearchConfig.current;

        if (!config?.providers["kagi-web"]?.sessionToken) {
            throw new Error(
                "Could not search the web using Kagi due to missing session token. Has you set up your config?",
            );
        }

        return config.providers["kagi-web"];
    }

    /**
     * Extract search results from the accessibility tree
     */
    #extractSearchResults(tree: unknown, maxResults?: number): ProviderSearchResult[] {
        if (!tree) return [];

        maxResults = maxResults ?? 20;

        const mainNode = (tree as any).role === "main" ? tree : this.#findNodeByRole(tree, "main");
        if (!mainNode) return [];

        const containers = this.#extractResultContainersFromMain(mainNode);
        const results: ProviderSearchResult[] = [];

        for (const container of containers) {
            if (results.length >= maxResults) break;
            if (!this.#hasFavicon(container)) continue;

            const result = this.#extractSingleResult(container);
            if (result) results.push(result);
        }

        return results;
    }

    /**
     * Find a node with a specific role in the tree
     */
    #findNodeByRole(node: unknown, role: string): unknown | null {
        if (!node) return null;
        if ((node as any).role === role) return node;

        if (!(node as any).children) return null;

        for (const child of (node as any).children) {
            const found = this.#findNodeByRole(child, role);
            if (found) return found;
        }

        return null;
    }

    /**
     * Check if a node matches the result container pattern:
     *   role="none" > first child role="generic" > first child role="heading"
     */
    #isResultContainer(node: unknown): boolean {
        if ((node as any).role !== "none" || !(node as any).children?.length) return false;

        const genericNode = (node as any).children[0];
        if (genericNode.role !== "generic" || !genericNode.children?.length) return false;

        return genericNode.children[0].role === "heading";
    }

    /**
     * Recursively find all result containers in the tree
     */
    #extractResultContainersFromMain(node: unknown): unknown[] {
        if (!(node as any)?.children) return [];

        // If this node is a result container, return it (don't recurse into it)
        if (this.#isResultContainer(node)) return [node];

        // Otherwise, recursively search children
        const containers: unknown[] = [];
        for (const child of (node as any).children) {
            containers.push(...this.#extractResultContainersFromMain(child));
        }
        return containers;
    }

    /**
     * Extract a single search result from a container node
     */
    #extractSingleResult(container: unknown): ProviderSearchResult | null {
        if (!(container as any).children?.length) return null;

        const genericNode = (container as any).children[0];
        if (genericNode.role !== "generic" || !genericNode.children?.length) return null;

        const headingNode = genericNode.children[0];
        if (headingNode.role !== "heading") return null;

        const link = this.#findNodeByRole(headingNode, "link") as any;
        if (!link?.url || !headingNode.name) return null;
        if (this.#isKagiInternalLink(link.url)) return null;

        return {
            title: headingNode.name.trim(),
            url: link.url.trim(),
            snippet: this.#extractSnippet(container),
        };
    }

    /**
     * Extract snippet text from a container's children
     */
    #extractSnippet(container: unknown): string {
        if (!(container as any).children) return "";

        for (let i = 1; i < (container as any).children.length; i++) {
            const child = (container as any).children[i];
            if (child.role === "generic") {
                const text = this.#extractStaticText(child);
                if (text) return text;
            }
        }

        return "";
    }

    /**
     * Check if a container has a favicon link (indicating it's a main result, not a subsection)
     */
    #hasFavicon(node: unknown): boolean {
        if (!node) return false;

        // Check if this is a link with a favicon image
        if ((node as any).role === "link" && (node as any).children) {
            for (const child of (node as any).children) {
                if (this.#isFaviconImage(child)) return true;
            }
        }

        // Recursively search children
        if (!(node as any).children) return false;

        for (const child of (node as any).children) {
            if (this.#hasFavicon(child)) return true;
        }

        return false;
    }

    /**
     * Check if an image node is a favicon
     */
    #isFaviconImage(node: unknown): boolean {
        if ((node as any).role !== "image") return false;

        const nameMatch = (node as any).name?.toLowerCase().includes("favicon");
        const urlMatch = (node as any).url?.includes("kagi.com") && (node as any).url.includes("/proxy/favicons");

        return nameMatch && urlMatch;
    }

    /**
     * Extract all StaticText content from a node and its children
     */
    #extractStaticText(node: unknown): string {
        if (!node) return "";
        if ((node as any).role === "StaticText" && (node as any).name) return (node as any).name;
        if (!(node as any).children) return "";

        const texts: string[] = [];
        for (const child of (node as any).children) {
            const text = this.#extractStaticText(child);
            if (text) texts.push(text);
        }

        return texts.join(" ");
    }

    /**
     * Check if a URL is a Kagi internal link
     */
    #isKagiInternalLink(url: string): boolean {
        if (!url) return false;
        if (url.startsWith("#") || url.startsWith("javascript:")) return true;
        if (url.includes("kagi.com/search")) return true;
        if (url.includes("kagi.com/html/search")) return true;
        return false;
    }
}
