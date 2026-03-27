import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

import type { SummarizerResult } from "../base";

/**
 * Check if response is empty (thinking only, no text or tool calls).
 * This handles a bug in llamacpp where tool calling models with thinking
 * may return responses with only thinking content.
 */
export function isEmptyResponse(response: AssistantMessage): boolean {
    const hasThinking = response.content.some((c) => c.type === "thinking");
    const hasText = response.content.some((c) => c.type === "text");
    const hasToolCalls = response.content.some((c) => c.type === "toolCall");

    return hasThinking && !hasText && !hasToolCalls;
}

/**
 * Extract thinking/message text from model response content.
 * Returns thinking content (reasoning) if present, otherwise text content.
 */
export function extractThinkingFromContent(content: AssistantMessage["content"]): string | undefined {
    const thinkingParts: string[] = [];
    const textParts: string[] = [];

    for (const part of content) {
        if (part.type === "thinking") {
            thinkingParts.push((part as any).thinking);
        } else if (part.type === "text") {
            textParts.push((part as any).text);
        }
    }

    const thinking = thinkingParts.join("\n").trim();
    const text = textParts.join("\n").trim();

    return thinking || text || undefined;
}

/**
 * Extract text summary from message content.
 * Returns undefined if no text content is found.
 */
export function extractTextSummary(content: Message["content"]): SummarizerResult | undefined {
    if (typeof content === "string") {
        return content ? { summary: content, summarizerId: "ocr", usedLlm: true } : undefined;
    }

    const textParts = content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text);

    const textContent = textParts.length > 0 ? textParts.join("\n") : undefined;

    if (textContent) {
        return { summary: textContent, summarizerId: "ocr", usedLlm: true };
    }
    return undefined;
}
