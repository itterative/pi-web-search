import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "puppeteer";

import { ExploreOcrSummarizerV2, type OcrExtensionExecutionContext } from "../../../../summarizers/ocr/index.js";
import type { Checkpoint } from "../../../../summarizers/ocr/state.js";

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
const sampleCheckpoints: Checkpoint[] = [
    { title: "Pricing found", content: "Basic: $10/mo, Pro: $25/mo" },
    { title: "Features", content: "Unlimited API calls, Priority support" },
];

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

describe("ExploreOcrSummarizerV2", () => {
    let summarizer: ExploreOcrSummarizerV2;
    let mockCtx: OcrExtensionExecutionContext;

    beforeEach(() => {
        summarizer = new ExploreOcrSummarizerV2({
            page: createMockPage(),
            model: mockModel as any,
            apiKey: "test-key",
        });
        mockCtx = createMockContext();
    });

    describe("getSystemPrompt", () => {
        it("should render system prompt with all tool guidelines", () => {
            const prompt = summarizer.getSystemPrompt();
            expect(prompt).toMatchSnapshot();
        });
    });

    describe("getForceSummaryPrompt", () => {
        it("should render force summary prompt without checkpoints", () => {
            const prompt = summarizer.getForceSummaryPrompt();
            expect(prompt).toMatchSnapshot();
        });

        it("should render force summary prompt with checkpoints", () => {
            // Add checkpoints via the checkpoint extension
            for (const cp of sampleCheckpoints) {
                summarizer["checkpointExtension"].addCheckpoint(cp);
            }
            const prompt = summarizer.getForceSummaryPrompt();
            expect(prompt).toMatchSnapshot();
        });
    });

    describe("formatCheckpoints", () => {
        it("should format checkpoints for display", () => {
            // Add checkpoints via the checkpoint extension
            for (const cp of sampleCheckpoints) {
                summarizer["checkpointExtension"].addCheckpoint(cp);
            }
            const formatted = summarizer["checkpointExtension"].formatCheckpoints();
            expect(formatted).toMatchSnapshot();
        });

        it("should format empty checkpoints array", () => {
            const formatted = summarizer["checkpointExtension"].formatCheckpoints();
            expect(formatted).toMatchSnapshot();
        });
    });

    describe("getConsolidatePrompt", () => {
        it("should render consolidate prompt for stalled progress", () => {
            const prompt = summarizer.getConsolidatePrompt(sampleCheckpoints);
            expect(prompt).toMatchSnapshot();
        });
    });

    describe("buildInitialMessage", () => {
        it("should render initial message with instruction", () => {
            const message = summarizer.buildInitialMessage(sampleScreenshot, sampleInstruction, sampleLinksContext);
            expect(message.role).toBe("user");
            expect((message.content[1] as any).text).toMatchSnapshot();
        });

        it("should render initial message without instruction", () => {
            const message = summarizer.buildInitialMessage(sampleScreenshot, undefined, sampleLinksContext);
            expect(message.role).toBe("user");
            expect((message.content[1] as any).text).toMatchSnapshot();
        });
    });
});
