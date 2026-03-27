import { describe, it, expect } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { isEmptyResponse } from "../../../summarizers/ocr/response-utils.js";

function createMockResponse(content: AssistantMessage["content"]): AssistantMessage {
    return {
        role: "assistant",
        content,
        stopReason: "stop",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
    };
}

describe("isEmptyResponse", () => {
    describe("empty response detection", () => {
        it("should return true for thinking-only response", () => {
            const response = createMockResponse([{ type: "thinking", thinking: "Let me think..." }]);
            expect(isEmptyResponse(response)).toBe(true);
        });

        it("should return true for multiple thinking blocks", () => {
            const response = createMockResponse([
                { type: "thinking", thinking: "First thought" },
                { type: "thinking", thinking: "Second thought" },
            ]);
            expect(isEmptyResponse(response)).toBe(true);
        });

        it("should return false for thinking + text", () => {
            const response = createMockResponse([
                { type: "thinking", thinking: "Let me think..." },
                { type: "text", text: "Here's my answer" },
            ]);
            expect(isEmptyResponse(response)).toBe(false);
        });

        it("should return false for thinking + tool calls", () => {
            const response = createMockResponse([
                { type: "thinking", thinking: "I'll click that" },
                { type: "toolCall", id: "1", name: "click", arguments: {} },
            ]);
            expect(isEmptyResponse(response)).toBe(false);
        });

        it("should return false for text-only response", () => {
            const response = createMockResponse([{ type: "text", text: "Here's my answer" }]);
            expect(isEmptyResponse(response)).toBe(false);
        });

        it("should return false for tool-call-only response", () => {
            const response = createMockResponse([{ type: "toolCall", id: "1", name: "click", arguments: {} }]);
            expect(isEmptyResponse(response)).toBe(false);
        });

        it("should return false for empty content array", () => {
            const response = createMockResponse([]);
            expect(isEmptyResponse(response)).toBe(false);
        });

        it("should return false for thinking + text + tool calls", () => {
            const response = createMockResponse([
                { type: "thinking", thinking: "Thinking..." },
                { type: "text", text: "Some text" },
                { type: "toolCall", id: "1", name: "click", arguments: {} },
            ]);
            expect(isEmptyResponse(response)).toBe(false);
        });
    });

    describe("edge cases", () => {
        it("should return true for empty thinking content", () => {
            const response = createMockResponse([{ type: "thinking", thinking: "" }]);
            expect(isEmptyResponse(response)).toBe(true);
        });

        it("should return true for whitespace-only thinking", () => {
            const response = createMockResponse([{ type: "thinking", thinking: "   " }]);
            expect(isEmptyResponse(response)).toBe(true);
        });

        it("should return false for text with empty thinking", () => {
            const response = createMockResponse([
                { type: "thinking", thinking: "" },
                { type: "text", text: "Actual content" },
            ]);
            expect(isEmptyResponse(response)).toBe(false);
        });
    });
});
