import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { AutocompleteItem, Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, globSync } from "fs";
import { readFile } from "fs/promises";
import path, { join } from "path";

import { summarize } from "../summarizers";

/** Tool parameter schema */
const WEB_EXPLORE_PARAMS = Type.Object({
    url: Type.String({
        description: "The URL to explore",
    }),
    instruction: Type.String({
        description:
            "Task for the model to perform on the page. The model can hover to discover URLs, click to reveal content, and scroll to see more. Be as explicit as possible with your instructions, as this guides the entire exploration process. Examples: 'hover over gallery items and list all image URLs', 'click each FAQ and extract answers', 'find and click the download button'.",
    }),
});

/**
 * Details tracked during web explore execution.
 */
export interface WebExploreDetails {
    /** Current status message */
    message: string;
    /** The explored URL */
    url?: string;
    /** Result of the exploration */
    result?: string;
    /** ID of the summarizer used */
    summarizerId?: string;
    /** Error message if explore failed */
    error?: string;
    /** Whether the explore was cancelled */
    cancelled?: boolean;
    /** The model's thinking/message from the current round */
    thinking?: string;
    /** List of checkpoint titles collected so far */
    checkpoints?: string[];
    /** Content of the most recent checkpoint */
    lastCheckpointContent?: string;
}

export default function webExploreTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "web-explore",
        label: "Web Explore",
        description:
            "Interactively explore a web page by hovering, clicking, and scrolling. " +
            "Use this when you need to discover content that requires interaction, " +
            "like hovering over elements to see URLs, clicking to reveal hidden content, " +
            "or navigating through multi-page content.",
        promptSnippet: "Explore a web page interactively",
        promptGuidelines: [
            "Use this tool when you need to interact with a page to discover content that requires active user engagement",
            "The model can hover over clickable elements to discover their URLs and labels",
            "The model can click elements to reveal hidden content, expand accordions, or navigate to new sections",
            "The model can scroll down to view more content that is initially out of view",
            "Provide a very explicit, step-by-step instruction for what you want to discover or accomplish on the page",
            "Your instruction should specify: which elements to interact with, what actions to perform, and the exact output format",
            "These are example of short instructions, however you should be as explicit as you can while still following the user intention:",
            "  - 'Hover over each product card in the hero section and extract the product name and price, then list them'",
            "  - 'Click each accordion header in the FAQ section and read the answer, then summarize all answers in order'",
            "  - 'Find the download button in the bottom right corner of the page, click it, and confirm the download starts'",
            "  - 'Navigate through all pagination pages (1, 2, 3...) and collect every article title, then list them in order'",
            "  - 'Hover over each navigation menu item and list all the destination URLs'",
            "  - 'Click each testimonial card and extract the customer name, rating, and quote text'",
        ],
        parameters: WEB_EXPLORE_PARAMS,
        async execute(
            _toolCallId: string,
            params: { url: string; instruction: string },
            signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<WebExploreDetails> | undefined,
            ctx: ExtensionContext,
        ): Promise<AgentToolResult<WebExploreDetails>> {
            const update = (details: WebExploreDetails) => {
                onUpdate?.({
                    content: [{ type: "text", text: details.message }],
                    details,
                });
            };

            const url = params.url.trim();
            const instruction = params.instruction.trim();

            // Validate URL
            let parsedUrl: URL;

            try {
                parsedUrl = new URL(url);
            } catch {
                const error = `Invalid URL: ${url}`;
                update({ message: error, error });

                return {
                    content: [{ type: "text", text: `Error: ${error}` }],
                    details: { message: error, error },
                };
            }

            // Check for cancellation
            if (signal?.aborted) {
                return {
                    content: [{ type: "text", text: "Explore cancelled." }],
                    details: { message: "Cancelled", cancelled: true },
                };
            }

            update({
                message: `Exploring ${parsedUrl.href}...`,
                url: parsedUrl.href,
            });

            try {
                // Track current thinking and checkpoints to preserve them across updates
                let currentThinking: string | undefined;
                let currentCheckpoints: string[] | undefined;
                let currentLastCheckpointContent: string | undefined;

                const result = await summarize(
                    parsedUrl.href,
                    instruction,
                    ctx,
                    (progress) => {
                        // Only update thinking if a new one is provided
                        if (progress.thinking !== undefined) {
                            currentThinking = progress.thinking;
                        }
                        // Only update checkpoints if new ones are provided
                        if (progress.checkpoints !== undefined) {
                            currentCheckpoints = progress.checkpoints;
                        }
                        // Only update last checkpoint content if provided
                        if (progress.lastCheckpointContent !== undefined) {
                            currentLastCheckpointContent = progress.lastCheckpointContent;
                        }
                        update({
                            message: progress.message,
                            thinking: currentThinking,
                            checkpoints: currentCheckpoints,
                            lastCheckpointContent: currentLastCheckpointContent,
                        });
                    },
                    signal,
                    "instruct",
                );

                if (!result) {
                    const error = "No summarizer available for this URL";
                    update({ message: error, error });

                    return {
                        content: [{ type: "text", text: `Error: ${error}` }],
                        details: { message: error, error },
                    };
                }

                // Build response with source attribution
                const sourceInfo = `\n\n---\n*Source: [${parsedUrl.href}](${parsedUrl.href})*`;
                const content = result.summary + sourceInfo;

                update({
                    message: "Exploration complete",
                    result: result.summary,
                    summarizerId: result.summarizerId,
                    thinking: undefined, // Clear thinking on completion
                });

                return {
                    content: [{ type: "text", text: content }],
                    details: {
                        message: "Exploration complete",
                        url: parsedUrl.href,
                        result: result.summary,
                        summarizerId: result.summarizerId,
                    },
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);

                // Check if it was cancelled
                if (signal?.aborted || errorMessage.includes("cancelled")) {
                    return {
                        content: [{ type: "text", text: "Explore cancelled." }],
                        details: { message: "Cancelled", cancelled: true },
                    };
                }

                update({ message: `Error: ${errorMessage}`, error: errorMessage });

                return {
                    content: [{ type: "text", text: `Error exploring URL: ${errorMessage}` }],
                    details: { message: errorMessage, error: errorMessage },
                };
            }
        },

        renderCall(args, theme) {
            let text = theme.fg("toolTitle", theme.bold("web-explore "));
            text += theme.fg("muted", args.url);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded, isPartial }, theme) {
            if (isPartial) {
                const parts: string[] = [theme.fg("accent", result.details.message)];
                // Show checkpoints if available during partial updates
                if (result.details.checkpoints && result.details.checkpoints.length > 0) {
                    const allCheckpoints = result.details.checkpoints;
                    const showCount = Math.min(3, allCheckpoints.length);
                    const remaining = allCheckpoints.length - showCount;
                    const recentCheckpoints = allCheckpoints.slice(-showCount).reverse();

                    parts.push("");
                    parts.push(theme.fg("muted", `Checkpoints (${allCheckpoints.length}):`));
                    for (const title of recentCheckpoints) {
                        parts.push(theme.fg("muted", `  • ${title}`));
                    }
                    if (remaining > 0) {
                        parts.push(theme.fg("muted", `  ... and ${remaining} more`));
                    }

                    // Show last checkpoint content (truncated)
                    if (result.details.lastCheckpointContent) {
                        const content = result.details.lastCheckpointContent;
                        const truncated = content.length > 300 ? content.slice(0, 300) + "..." : content;
                        parts.push("");
                        parts.push(theme.fg("muted", "Latest checkpoint:"));
                        parts.push(
                            theme.fg(
                                "muted",
                                truncated
                                    .split("\n")
                                    .map((l) => `  ${l}`)
                                    .join("\n"),
                            ),
                        );
                    }
                }
                // Show thinking if available during partial updates
                if (result.details.thinking) {
                    const thinking = result.details.thinking;
                    // const truncated = thinking.length > 200 ? thinking.slice(0, 200) + "..." : thinking;
                    parts.push("");
                    parts.push(theme.fg("muted", thinking));
                }
                return new Text(parts.join("\n"), 0, 0);
            }

            if (result.details.cancelled) {
                return new Text(theme.fg("muted", "Cancelled"), 0, 0);
            }

            if (result.details.error) {
                return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
            }

            // Show brief info when not expanded
            if (!expanded) {
                const summarizer = result.details.summarizerId ?? "unknown";
                return new Text(theme.fg("muted", `Explored via ${summarizer}`), 0, 0);
            }

            // Show full result with markdown rendering when expanded
            const content = result.content[0];
            if (!content || content.type !== "text") {
                return new Text(theme.fg("muted", "No content."), 0, 0);
            }
            return new Markdown(content.text, 0, 0, getMarkdownTheme());
        },
    });
}
