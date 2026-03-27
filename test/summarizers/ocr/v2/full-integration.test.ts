import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { Page, Browser } from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

import {
    FullOcrSummarizerV2,
    type OcrSummarizerConfig,
    type CheckpointRecoveryArgs,
    OcrExtensionExecutionContext,
} from "../../../../summarizers/ocr/index.js";
import type { Context, AssistantMessage, ToolCall, Usage, StopReason } from "@mariozechner/pi-ai";
import { getBrowser, closeBrowser } from "../../../../common/browser.js";

interface MockResponse {
    /** Text content to include */
    text?: string;
    /** Tool calls to make */
    toolCalls?: Array<{ name: string; args: Record<string, any> }>;
    /** Stop reason (default: "stop" for text, "toolUse" for tool calls) */
    stopReason?: StopReason;
}

/**
 * Creates a minimal valid Usage object.
 */
function createMockUsage(): Usage {
    return {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
}

/**
 * Creates a mock assistant message from a response specification.
 */
function createMockResponse(response: MockResponse): AssistantMessage {
    const content: AssistantMessage["content"] = [];

    if (response.text) {
        content.push({ type: "text", text: response.text });
    }

    if (response.toolCalls) {
        for (const tc of response.toolCalls) {
            content.push({
                type: "toolCall",
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                name: tc.name,
                arguments: tc.args,
            } as ToolCall);
        }
    }

    const stopReason: StopReason = response.stopReason ?? (response.toolCalls ? "toolUse" : "stop");

    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        timestamp: Date.now(),
        stopReason,
        usage: createMockUsage(),
    };
}

/**
 * Creates a sequence of mock responses.
 */
function createMockResponses(responses: MockResponse[]): AssistantMessage[] {
    return responses.map(createMockResponse);
}

/**
 * A testable version of FullOcrSummarizerV2 that uses mock responses.
 */
class TestableFullOcrSummarizerV2 extends FullOcrSummarizerV2 {
    private responseQueue: AssistantMessage[] = [];
    private callLog: { context: Context; round: number }[] = [];

    constructor(config: OcrSummarizerConfig) {
        super(config);
    }

    /**
     * Set the sequence of responses to return.
     */
    setResponses(responses: MockResponse[]): void {
        this.responseQueue = createMockResponses(responses);
    }

    /**
     * Get the log of complete() calls for assertions.
     */
    getCallLog(): { context: Context; round: number }[] {
        return this.callLog;
    }

    /**
     * Override complete to return mock responses.
     */
    override async complete(
        ctx: OcrExtensionExecutionContext,
        context: Context,
        options?: { signal?: AbortSignal },
    ): Promise<AssistantMessage> {
        this.callLog.push({ context, round: ctx.state.base.messages.length });

        if (this.responseQueue.length === 0) {
            throw new Error("No more mock responses available");
        }

        return this.responseQueue.shift()!;
    }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../../fixtures/pages");

/**
 * Check if a browser is available.
 * Returns true if browser can be launched, false otherwise.
 */
let _browserAvailable: boolean | undefined;

async function isBrowserAvailable(): Promise<boolean> {
    if (process.env.PI_WEB_SEARCH_INTEGRATION_TEST !== "1") {
        return false;
    }

    if (_browserAvailable !== undefined) {
        return _browserAvailable;
    }

    try {
        const browser = await getBrowser();
        const page = await browser.newPage();
        await page.close();
        _browserAvailable = true;
        return true;
    } catch (error) {
        _browserAvailable = false;
        return false;
    }
}

async function createTestPage(): Promise<{ browser: Browser; page: Page }> {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    return { browser, page };
}

// Mock model
const mockModel = {
    id: "test-model",
    contextWindow: 128000,
};

// Skip reason when browser is not available
const SKIP_REASON = "Browser not available (sandbox may be enabled - Chrome/Chromium required)";

describe("FullOcrSummarizerV2 Integration", () => {
    let browser: Browser;
    let page: Page;
    let summarizer: TestableFullOcrSummarizerV2;

    beforeEach(async () => {
        const available = await isBrowserAvailable();
        if (!available) return;

        const result = await createTestPage();
        browser = result.browser;
        page = result.page;

        summarizer = new TestableFullOcrSummarizerV2({
            page,
            model: mockModel as any,
            apiKey: "test-key",
        });
    });

    afterEach(async () => {
        await page?.close().catch(() => {});
    });

    afterAll(async () => {
        await closeBrowser();
    });

    describe("with scrollable page", () => {
        it("should scroll down twice then provide summary", async () => {
            const available = await isBrowserAvailable();
            if (!available) {
                return;
            }

            await page.goto(`file://${fixturesDir}/scrollable.html`, {
                waitUntil: "networkidle0",
            });

            // Take initial screenshot
            const screenshot = await page.screenshot({ encoding: "base64" });
            const linksContext = "";

            // Configure mock responses: scroll, scroll, done signal, forced summary
            summarizer.setResponses([
                { toolCalls: [{ name: "scroll", args: { direction: "down" } }] },
                { toolCalls: [{ name: "scroll", args: { direction: "down" } }] },
                { text: "I have extracted all the content." }, // Model signals done (no tool calls)
                {
                    text: "## Extracted Content\n\n- Section 1: Introduction\n- Section 2: Features\n- Section 3: Pricing\n- Section 4: Contact",
                }, // Forced summary
            ]);

            const result = await summarizer.run({
                screenshot: screenshot as string,
                instruction: undefined,
                linksContext,
            });

            expect(result).toBeDefined();
            expect(result?.summary).toContain("Extracted Content");

            const callLog = summarizer.getCallLog();
            expect(callLog.length).toBe(4); // 2 scroll + 1 done signal + 1 forced summary
        });

        it("should extract content without scrolling", async () => {
            const available = await isBrowserAvailable();
            if (!available) {
                return;
            }

            await page.goto(`file://${fixturesDir}/scrollable.html`, {
                waitUntil: "networkidle0",
            });

            const screenshot = await page.screenshot({ encoding: "base64" });
            const linksContext = "";

            // Model immediately signals done, then provides summary
            summarizer.setResponses([
                { text: "I see the page content." }, // Model signals done (no tool calls)
                {
                    text: "## Page Content\n\nThis is a test page with multiple sections.",
                }, // Forced summary
            ]);

            const result = await summarizer.run({
                screenshot: screenshot as string,
                instruction: undefined,
                linksContext,
            });

            expect(result).toBeDefined();
            expect(result?.summary).toContain("Page Content");

            const callLog = summarizer.getCallLog();
            expect(callLog.length).toBe(2); // 1 done signal + 1 forced summary
        });

        it("should follow instruction to find specific content", async () => {
            const available = await isBrowserAvailable();
            if (!available) {
                return;
            }

            await page.goto(`file://${fixturesDir}/scrollable.html`, {
                waitUntil: "networkidle0",
            });

            const screenshot = await page.screenshot({ encoding: "base64" });
            const linksContext = "";

            // Model scrolls to find pricing, signals done, then provides summary
            summarizer.setResponses([
                { toolCalls: [{ name: "scroll", args: { direction: "down" } }] },
                { toolCalls: [{ name: "scroll", args: { direction: "down" } }] },
                { text: "Found the pricing section." }, // Model signals done
                {
                    text: "## Pricing Information\n\n- Basic: $10/month\n- Pro: $25/month\n- Enterprise: Contact us",
                }, // Forced summary
            ]);

            const result = await summarizer.run({
                screenshot: screenshot as string,
                instruction: "Find the pricing information",
                linksContext,
            });

            expect(result).toBeDefined();
            expect(result?.summary).toContain("Pricing");
            expect(result?.summary).toContain("$10");
        });
    });
});
