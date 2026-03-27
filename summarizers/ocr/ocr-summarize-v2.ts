import type { Message } from "@mariozechner/pi-ai";

import type { SummarizerResult } from "../base";
import { OcrBase } from "./ocr";
import { type OcrExtensionExecutionContext } from "./extensions";
import { ClickTool, CursorTool, ScrollTool, ScreenshotTool } from "./tools";
import { buildOcrConfig, type OcrSummarizerConfig } from "./ocr-summarizer-base";
import { render } from "./instructions";
import { OcrRunOptions } from "./config";

/**
 * OCR summarizer for "summarize" mode.
 * Creates concise summaries of web page content.
 *
 * Tools: cursor, click, scroll, screenshot
 * Extensions: screenshot, cursor, navigation, checkpoint, debug (registered by base class)
 */
export class SummarizeOcrSummarizerV2 extends OcrBase {
    protected readonly initialProgressMessage = "Summarizing page...";

    constructor(config: OcrSummarizerConfig) {
        super(buildOcrConfig({ ...config, templatePath: "summarize" }));

        // Register tools
        this.registerTool(
            new CursorTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
            }),
        );
        this.registerTool(
            new ClickTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
                navigationExtension: this.navigationExtension,
            }),
        );
        this.registerTool(
            new ScrollTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
            }),
        );
        this.registerTool(
            new ScreenshotTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
            }),
        );
    }

    async run(options: OcrRunOptions): Promise<SummarizerResult> {
        this.instruction = options.instruction;
        return super.run(options);
    }

    getSystemPrompt(): string {
        return render("summarize/system", {
            toolSnippets: this.getToolSnippets(),
            toolGuidelines: this.getToolGuidelines(),
        });
    }

    getForceSummaryPrompt(): string {
        return render("summarize/force");
    }

    getInstruction(_ctx: OcrExtensionExecutionContext): string | undefined {
        return this.instruction;
    }

    buildInitialMessage(screenshot: string, instruction: string | undefined, linksContext: string): Message {
        const text = render("summarize/initial-message", {
            instruction,
            linksContext,
        });

        return {
            role: "user",
            content: [
                { type: "image", data: screenshot, mimeType: "image/png" },
                { type: "text", text },
            ],
            timestamp: Date.now(),
        };
    }
}

/**
 * Create a SummarizeOcrSummarizerV2 instance.
 */
export function createSummarizeOcrSummarizerV2(config: OcrSummarizerConfig): SummarizeOcrSummarizerV2 {
    return new SummarizeOcrSummarizerV2(config);
}
