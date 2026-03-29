import { complete } from "@mariozechner/pi-ai";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

import type { SummarizerMode, SummarizerUpdateCallback } from "../base";

import type { OutlineEntry } from "./extract";

/** Default max retries for section selection JSON parsing */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Render the outline as a text block for the model.
 */
function formatOutline(entries: OutlineEntry[]): string {
    return entries
        .map((e) => `[${e.index}] ${e.charCount} chars — "${e.preview}${e.charCount > e.preview.length ? "..." : ""}"`)
        .join("\n");
}

/**
 * Send the outline to the model and get back selected entry indices.
 * Includes retry logic for malformed JSON responses.
 */
export async function selectSections(
    entries: OutlineEntry[],
    mode: SummarizerMode,
    instruction: string | undefined,
    model: Model<Api>,
    apiKey: string,
    headers: Record<string, string> | undefined,
    maxRetries: number = DEFAULT_MAX_RETRIES,
    onUpdate?: SummarizerUpdateCallback,
    signal?: AbortSignal,
): Promise<OutlineEntry[]> {
    const { render } = await import("./instructions/index.js");

    const systemPrompt = render("select");
    const outlineText = formatOutline(entries);

    let modeContext: string;
    if (instruction) {
        modeContext = `Instruction: "${instruction}"`;
    } else if (mode === "full") {
        modeContext =
            "Goal: Select ALL entries that contain meaningful page content (not navigation, ads, or boilerplate). Be inclusive.";
    } else {
        modeContext = "Goal: Select entries that contain the most important and relevant content of the page.";
    }

    const userMessage = `${modeContext}\n\nPage outline:\n\n${outlineText}`;

    const lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw new Error("Cancelled");

        onUpdate?.({ message: `Selecting relevant sections (attempt ${attempt + 1})...` });

        const response: AssistantMessage = await complete(
            model,
            {
                systemPrompt,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: userMessage }],
                        timestamp: Date.now(),
                    },
                ],
            },
            { apiKey, headers, signal },
        );

        // Extract text from response
        const text =
            typeof response.content === "string"
                ? response.content
                : response.content
                      .filter((c): c is { type: "text"; text: string } => c.type === "text")
                      .map((c) => c.text)
                      .join("\n");

        // Try to parse JSON from response
        const selected = parseSelectionResponse(text);
        if (selected !== null) {
            // Map indices back to entries
            const indexSet = new Set(selected);
            const selectedEntries = entries.filter((e) => indexSet.has(e.index));

            if (selectedEntries.length > 0) {
                return selectedEntries;
            }
            // Model selected zero entries - retry
        }

        // On retry, append correction instruction
        if (attempt < maxRetries) {
            // Will loop with same message
        }
    }

    // All retries failed, return all entries as fallback
    return entries;
}

/**
 * Parse the model's JSON response to extract selected entry indices.
 * Handles markdown code blocks and extra text around the JSON.
 */
function parseSelectionResponse(text: string): number[] | null {
    // Try to find a JSON object with "selected" key
    const match = text.match(/\{[\s\S]*?"selected"[\s\S]*?\}/);
    if (!match) return null;

    try {
        const parsed = JSON.parse(match[0]) as { selected: unknown };
        if (Array.isArray(parsed.selected)) {
            const numbers = parsed.selected
                .filter((v): v is number => typeof v === "number" && Number.isInteger(v))
                .map((n) => n);
            if (numbers.length > 0) return numbers;
        }
    } catch {
        // JSON parse failed
    }

    return null;
}
