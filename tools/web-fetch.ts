import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import type { ContentType, SummarizerMode } from "../summarizers";
import { summarize } from "../summarizers";

/** Tool parameter schema */
const WEB_FETCH_PARAMS = Type.Object({
    url: Type.String({
        description: "The URL to fetch",
    }),
    mode: Type.Optional(
        Type.Union(
            [
                Type.Literal("summarize", {
                    description:
                        "Summarize the page content, following instructions to extract specific information like images, media, or other elements (default)",
                }),
                Type.Literal("full", {
                    description: "Extract all visible text content only, without images or media",
                }),
            ],
            {
                description: "Fetch mode: 'summarize' (default) or 'full' for text-only content",
                default: "summarize",
            },
        ),
    ),
    instruction: Type.Optional(
        Type.String({
            description:
                "Instruction to guide summarization. Use to request specific content like images, videos, links, or focused information. Examples: 'extract all images and their descriptions', 'list all download links', 'focus on pricing information'.",
        }),
    ),
    expectedContentType: Type.Optional(
        Type.Array(
            Type.Union([
                Type.Literal("text", {
                    description: "Text content (articles, posts, documentation)",
                }),
                Type.Literal("image", {
                    description: "Images (photos, graphics, diagrams)",
                }),
                Type.Literal("video", {
                    description: "Videos (embedded players, video links)",
                }),
            ]),
            {
                description:
                    "Expected content types. Use to optimize summarizer selection: ['text'] for text-only (faster), ['image'] or ['video'] for visual content (uses OCR/screenshots), or combinations like ['text', 'image'].",
            },
        ),
    ),
});

/**
 * Details tracked during web fetch execution.
 */
export interface WebFetchDetails {
    /** Current status message */
    message: string;
    /** The fetched URL */
    url?: string;
    /** Summary or content of the page */
    summary?: string;
    /** Fetch mode used */
    mode?: "summarize" | "full";
    /** ID of the summarizer used */
    summarizerId?: string;
    /** Whether an LLM was used */
    usedLlm?: boolean;
    /** Error message if fetch failed */
    error?: string;
    /** Whether the fetch was cancelled */
    cancelled?: boolean;
    /** The model's thinking/message from the current round */
    thinking?: string;
}

export default function webFetchTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "web-fetch",
        label: "Web Fetch",
        description:
            "Fetch content from a web page. " +
            "Use mode='summarize' (default) to follow instructions and extract specific content like images or media. " +
            "Use mode='full' to extract text-only content. " +
            "Use expectedContentType to optimize: ['text'] for text-only (faster), ['image'] or ['video'] for visual content.",
        promptSnippet: "Fetch content from a URL",
        promptGuidelines: [
            "mode='summarize' (default): Follows instructions to extract specific content (images, media, links, etc.)",
            "mode='full': Extracts text-only content, no images or media",
            "Use the 'instruction' parameter with summarize mode to request specific elements like 'extract all images'",
            "expectedContentType=['text']: Optimizes for text extraction (faster, no screenshots)",
            "expectedContentType=['image'] or ['video']: Optimizes for visual content (uses OCR/screenshots)",
            "Use web-explore for interactive tasks (hovering, clicking, scrolling)",
        ],
        parameters: WEB_FETCH_PARAMS,
        async execute(
            _toolCallId: string,
            params: {
                url: string;
                mode?: "summarize" | "full";
                instruction?: string;
                expectedContentType?: ContentType[];
            },
            signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<WebFetchDetails> | undefined,
            ctx: ExtensionContext,
        ): Promise<AgentToolResult<WebFetchDetails>> {
            const update = (details: WebFetchDetails) => {
                onUpdate?.({
                    content: [{ type: "text", text: details.message }],
                    details,
                });
            };

            const mode = params.mode ?? "summarize";
            const contentTypes = params.expectedContentType;

            const url = params.url.trim();

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
                    content: [{ type: "text", text: "Fetch cancelled." }],
                    details: { message: "Cancelled", cancelled: true },
                };
            }

            update({
                message: `Fetching ${parsedUrl.href}...`,
                url: parsedUrl.href,
                mode,
            });

            try {
                let currentThinking: string | undefined;

                const result = await summarize(
                    parsedUrl.href,
                    params.instruction,
                    ctx,
                    (progress) => {
                        // Only update thinking if a new one is provided
                        if (progress.thinking !== undefined) {
                            currentThinking = progress.thinking;
                        }

                        update({
                            message: progress.message,
                            thinking: currentThinking,
                        });
                    },
                    signal,
                    mode as SummarizerMode,
                    contentTypes,
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

                const successMessage = mode === "full" ? "Fetched full content" : "Summarized successfully";
                update({
                    message: successMessage,
                    summary: result.summary,
                    summarizerId: result.summarizerId,
                    usedLlm: result.usedLlm,
                    mode,
                });

                return {
                    content: [{ type: "text", text: content }],
                    details: {
                        message: successMessage,
                        url: parsedUrl.href,
                        summary: result.summary,
                        summarizerId: result.summarizerId,
                        usedLlm: result.usedLlm,
                        mode,
                    },
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);

                // Check if it was cancelled
                if (signal?.aborted || errorMessage.includes("cancelled")) {
                    return {
                        content: [{ type: "text", text: "Fetch cancelled." }],
                        details: { message: "Cancelled", cancelled: true },
                    };
                }

                update({ message: `Error: ${errorMessage}`, error: errorMessage });

                return {
                    content: [{ type: "text", text: `Error fetching URL: ${errorMessage}` }],
                    details: { message: errorMessage, error: errorMessage },
                };
            }
        },

        renderCall(args, theme) {
            let text = theme.fg("toolTitle", theme.bold("web-fetch "));
            const mode = args.mode ?? "summarize";
            const modeColor = mode === "full" ? "warning" : "accent";
            text += theme.fg(modeColor, `[${mode}] `);
            text += theme.fg("muted", args.url);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded, isPartial }, theme) {
            if (isPartial) {
                const parts: string[] = [theme.fg("accent", result.details.message)];

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
                const mode = result.details.mode ?? "summarize";
                if (mode === "full") {
                    return new Text(
                        theme.fg("muted", `Fetched full content via ${result.details.summarizerId ?? "ocr"}`),
                        0,
                        0,
                    );
                } else {
                    const summarizer = result.details.summarizerId ?? "unknown";
                    const llmTag = result.details.usedLlm ? " (LLM)" : "";
                    return new Text(theme.fg("muted", `Summarized via ${summarizer}${llmTag}`), 0, 0);
                }
            }

            // Show full summary with markdown rendering when expanded
            const content = result.content[0];
            if (!content || content.type !== "text") {
                return new Text(theme.fg("muted", "No content."), 0, 0);
            }
            return new Markdown(content.text, 0, 0, getMarkdownTheme());
        },
    });
}
