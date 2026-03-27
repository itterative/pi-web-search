import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "puppeteer";

import { FullOcrSummarizerV2, type OcrExtensionExecutionContext } from "../../../../summarizers/ocr/index.js";

// Mock page with minimal implementation
function createMockPage(): Page {
    return {
        viewport: () => ({ width: 1280, height: 800 }),
        screenshot: () => Promise.resolve(Buffer.from("")),
        evaluate: () => Promise.resolve(undefined),
        $: () => Promise.resolve(null),
        $$: () => Promise.resolve([]),
        goto: () => Promise.resolve(null),
        url: () => "https://example.com",
        mouse: { click: vi.fn(), move: vi.fn() },
        keyboard: { press: vi.fn(), type: vi.fn() },
    } as unknown as Page;
}

// Mock model
const mockModel = {
    id: "test-model",
    contextWindow: 128000,
};

// Sample data for tests
const sampleScreenshot = "base64 screenshot data";
const sampleInstruction = "Find the pricing information";
const sampleLinksContext = "1. [Home](/) - Navigate to homepage\n2. [About](/about) - Learn more about us";

// Create a minimal mock context for prompt methods
function createMockContext(): OcrExtensionExecutionContext {
    return {
        state: { base: { messages: [], lastInputTokens: 0 } },
        currentRound: 0,
        maxRounds: 10,
        contextWindow: 128000,
        systemPrompt: "",
        extensionState: new Map(),
        appendMessages: vi.fn(),
        replaceMessages: vi.fn(),
        truncateMessages: vi.fn(),
    } as unknown as OcrExtensionExecutionContext;
}

describe("FullOcrSummarizerV2", () => {
    let summarizer: FullOcrSummarizerV2;
    let mockCtx: OcrExtensionExecutionContext;

    beforeEach(() => {
        summarizer = new FullOcrSummarizerV2({
            page: createMockPage(),
            model: mockModel as any,
            apiKey: "test-key",
        });
        mockCtx = createMockContext();
    });

    describe("getSystemPrompt", () => {
        it("should render system prompt with scroll tool guidelines", () => {
            const prompt = summarizer.getSystemPrompt();
            expect(prompt).toMatchSnapshot();
        });
    });

    describe("getForceSummaryPrompt", () => {
        it("should render force summary prompt", () => {
            const prompt = summarizer.getForceSummaryPrompt();
            expect(prompt).toMatchSnapshot();
        });
    });

    describe("buildInitialMessage", () => {
        it("should render initial message without instruction", () => {
            const message = summarizer.buildInitialMessage(sampleScreenshot, undefined, sampleLinksContext);
            expect(message.role).toBe("user");
            expect(message.content).toHaveLength(2);
            expect(message.content[0]).toEqual({
                type: "image",
                data: sampleScreenshot,
                mimeType: "image/png",
            });
            expect((message.content[1] as any).text).toMatchSnapshot();
        });

        it("should render initial message with instruction", () => {
            const message = summarizer.buildInitialMessage(sampleScreenshot, sampleInstruction, sampleLinksContext);
            expect(message.role).toBe("user");
            expect((message.content[1] as any).text).toMatchSnapshot();
        });

        it("should render initial message without links context", () => {
            const message = summarizer.buildInitialMessage(sampleScreenshot, sampleInstruction, "");
            expect((message.content[1] as any).text).toMatchSnapshot();
        });
    });
});
