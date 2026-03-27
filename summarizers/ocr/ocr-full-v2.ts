import type { Message } from "@mariozechner/pi-ai";

import type { SummarizerResult } from "../base";
import { OcrBase } from "./ocr";
import { type OcrExtensionExecutionContext } from "./extensions";
import { ScrollTool } from "./tools";
import { buildOcrConfig, type OcrSummarizerConfig } from "./ocr-summarizer-base";
import { render } from "./instructions";
import { OcrRunOptions } from "./config";

/**
 * OCR summarizer for "full" mode.
 * Extracts all content from web pages without summarizing.
 *
 * Tools: scroll only
 * Extensions: screenshot, cursor, navigation, checkpoint, debug (registered by base class)
 */
export class FullOcrSummarizerV2 extends OcrBase {
    protected readonly initialProgressMessage = "Extracting page content...";

    constructor(config: OcrSummarizerConfig) {
        super(buildOcrConfig({ ...config, templatePath: "full" }));

        // Register tools
        this.registerTool(
            new ScrollTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
            }),
        );
    }

    async run(options: OcrRunOptions): Promise<SummarizerResult> {
        this.instruction = options.instruction;
        return super.run(options);
    }

    getSystemPrompt(): string {
        return render("full/system", {
            toolSnippets: this.getToolSnippets(),
            toolGuidelines: this.getToolGuidelines(),
        });
    }

    getForceSummaryPrompt(): string {
        return render("full/force");
    }

    getInstruction(_ctx: OcrExtensionExecutionContext): string | undefined {
        return this.instruction;
    }

    buildInitialMessage(screenshot: string, instruction: string | undefined, linksContext: string): Message {
        const text = render("full/initial-message", { instruction, linksContext });

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
 * Create a FullOcrSummarizerV2 instance.
 */
export function createFullOcrSummarizerV2(config: OcrSummarizerConfig): FullOcrSummarizerV2 {
    return new FullOcrSummarizerV2(config);
}
