import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { getBrowser } from "../common/browser";
import websearchConfig from "../common/config";
import { getProviders, ProviderSearchResult } from "../providers";
import { summarize } from "../summarizers";

/** Tool parameter schema */
const WEB_SEARCH_PARAMS = Type.Object({
    query: Type.String({
        description: "The search query to execute",
    }),
});

/**
 * Details tracked during web search execution.
 * Used for progress updates and final result.
 */
export interface WebSearchDetails {
    /** Current status message */
    message: string;
    /** Search results (populated once complete) */
    results?: ProviderSearchResult[];
    /** Summary of the top result (if summarization enabled) */
    topSummary?: string;
    /** Error message if search failed */
    error?: string;
    /** Whether the search was cancelled */
    cancelled?: boolean;
}

/**
 * Render search results as markdown with optional summary section.
 */
function renderResults(results: ProviderSearchResult[], maxResults: number, topSummary?: string): string {
    const lines: string[] = [];

    // Summary section (if available)
    if (topSummary) {
        lines.push("# Summary");
        lines.push("");
        lines.push(topSummary);
        lines.push("");
        lines.push("---");
        lines.push("");
    }

    // Results section
    lines.push("# Search Results");
    lines.push("");

    const limitedResults = results.slice(0, maxResults);

    for (let i = 0; i < limitedResults.length; i++) {
        const result = limitedResults[i];
        const num = i + 1;

        // Title and URL
        lines.push(`## ${num}. [${result.title}](${result.url})`);

        // Snippet if available
        if (result.snippet) {
            lines.push("");
            lines.push(result.snippet);
        }

        lines.push("");

        // Nested results (e.g., from a news or video section)
        if (result.children && result.children.length > 0) {
            for (const child of result.children) {
                lines.push(`- [${child.title}](${child.url})`);
                if (child.snippet) {
                    lines.push(`  ${child.snippet}`);
                }
            }
            lines.push("");
        }
    }

    return lines.join("\n").trim();
}

export default function webSearchTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "web-search",
        label: "Web Search",
        description:
            "Search the web using configured search providers (e.g., Kagi, DuckDuckGo). Can optionally summarize the top result if configured.",
        promptSnippet: "Search the web for information",
        promptGuidelines: [
            "Use this tool to find current information on the web",
            "Results include titles, URLs, and snippets",
            "If summarizeTopResult is enabled, the top result will be summarized",
            "Use web-fetch to get full content from specific URLs",
        ],
        parameters: WEB_SEARCH_PARAMS,
        async execute(
            _toolCallId: string,
            params: { query: string },
            signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
            ctx: ExtensionContext,
        ): Promise<AgentToolResult<WebSearchDetails>> {
            const update = (details: WebSearchDetails) => {
                onUpdate?.({
                    content: [{ type: "text", text: details.message }],
                    details,
                });
            };

            // Load config for current working directory
            const config = websearchConfig.load(ctx.cwd);

            // Get the configured provider type
            const providerType = config.search.provider;
            const maxResults = config.search.maxResults;

            update({ message: `Loading search provider: ${providerType}` });

            // Get all implementations for this provider type
            const providers = getProviders(providerType);

            if (providers.length === 0) {
                const error = `No providers registered for type "${providerType}"`;
                update({ message: error, error });

                return {
                    content: [{ type: "text", text: `Error: ${error}` }],
                    details: { message: error, error },
                };
            }

            // Check for cancellation before starting browser
            if (signal?.aborted) {
                return {
                    content: [{ type: "text", text: "Search cancelled." }],
                    details: { message: "Cancelled", cancelled: true },
                };
            }

            // Get shared browser instance
            update({ message: "Starting browser..." });
            const browser = await getBrowser();

            // Check for cancellation after browser startup
            if (signal?.aborted) {
                return {
                    content: [{ type: "text", text: "Search cancelled." }],
                    details: { message: "Cancelled", cancelled: true },
                };
            }

            // Try each provider implementation until we get results
            let results: ProviderSearchResult[] | undefined;
            let lastError: Error | null = null;

            for (let i = 0; i < providers.length; i++) {
                // Check for cancellation before each provider attempt
                if (signal?.aborted) {
                    return {
                        content: [{ type: "text", text: "Search cancelled." }],
                        details: { message: "Cancelled", cancelled: true },
                    };
                }

                const provider = providers[i];
                update({
                    message: `Searching via ${providerType} (implementation ${i + 1}/${providers.length})...`,
                });

                try {
                    results = await provider.process(browser, params.query, ctx, signal);
                    if (results && results.length > 0) {
                        break; // Got results, stop trying
                    }
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    update({
                        message: `Implementation ${i + 1} failed: ${lastError.message}`,
                        error: lastError.message,
                    });
                    // Continue to next provider implementation
                }
            }

            // Check if cancelled after all providers
            if (signal?.aborted) {
                return {
                    content: [{ type: "text", text: "Search cancelled." }],
                    details: { message: "Cancelled", cancelled: true },
                };
            }

            // Check if we got any results
            if (!results || results.length === 0) {
                const error = lastError?.message ?? "No search results found";
                const message = `Search failed: ${error}`;
                update({ message, error });

                return {
                    content: [{ type: "text", text: message }],
                    details: { message, error },
                };
            }

            // Optionally summarize the top result
            let topSummary: string | undefined;

            if (config.search.summarizeTopResult && results[0]) {
                const topResult = results[0];

                // Check for cancellation before summarizing
                if (signal?.aborted) {
                    return {
                        content: [{ type: "text", text: "Search cancelled." }],
                        details: { message: "Cancelled", cancelled: true },
                    };
                }

                update({
                    message: `Summarizing top result: ${topResult.title}`,
                });

                try {
                    const result = await summarize(
                        topResult.url,
                        params.query,
                        ctx,
                        (progress) => update({ message: progress.message }),
                        signal,
                        "summarize",
                        ["text"],
                    );

                    if (result) {
                        topSummary = result.summary;
                    }
                } catch (error) {
                    // Summarization failed, but we still have search results
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    update({
                        message: `Summarization failed: ${errorMessage}`,
                    });
                    // Continue without summary
                }
            }

            // Render results as markdown
            update({
                message: `Found ${results.length} results${topSummary ? " (with summary)" : ""}`,
            });
            const markdown = renderResults(results, maxResults, topSummary);

            const details: WebSearchDetails = {
                message: `Found ${results.length} results`,
                results,
                topSummary,
            };

            return {
                content: [{ type: "text", text: markdown }],
                details,
            };
        },

        renderCall(args, theme) {
            let text = theme.fg("toolTitle", theme.bold("web-search "));
            text += theme.fg("muted", args.query);
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme) {
            if (isPartial) {
                return new Text(theme.fg("accent", result.details.message), 0, 0);
            }

            if (result.details.cancelled) {
                return new Text(theme.fg("muted", "Cancelled"), 0, 0);
            }

            const results = result.details.results ?? [];

            if (results.length === 0) {
                return new Text(theme.fg("muted", "No results found."), 0, 0);
            }

            // Show result count and first result title when not expanded
            if (!expanded) {
                const firstTitle = results[0]?.title ?? "Unknown";
                const truncated = firstTitle.length > 50 ? firstTitle.substring(0, 50) + "..." : firstTitle;
                const summaryTag = result.details.topSummary ? " (with summary)" : "";
                return new Text(
                    theme.fg("muted", `${results.length} result(s)${summaryTag}. First: `) + truncated,
                    0,
                    0,
                );
            }

            // Show full results with markdown rendering when expanded
            const content = result.content[0];
            if (!content || content.type !== "text") {
                return new Text(theme.fg("muted", "No results."), 0, 0);
            }
            return new Markdown(content.text, 0, 0, getMarkdownTheme());
        },
    });
}
