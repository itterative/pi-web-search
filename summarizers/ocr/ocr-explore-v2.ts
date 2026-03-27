import type { Context, Message } from "@mariozechner/pi-ai";

import type { SummarizerResult } from "../base";
import { OcrBase } from "./ocr";
import {
    ClickTool,
    CursorTool,
    ScrollTool,
    ScreenshotTool,
    NavigateTool,
    TypeTool,
    KeyboardTool,
    WaitTool,
    CheckpointTool,
    FindTool,
    ZoomTool,
} from "./tools";
import { buildOcrConfig, type OcrSummarizerConfig } from "./ocr-summarizer-base";
import type { Checkpoint } from "./state";
import { render } from "./instructions";
import { type OcrExtensionExecutionContext } from "./extensions";
import type { OcrRunOptions } from "./config";

/**
 * OCR summarizer for "explore" mode.
 * Explores pages to follow specific instructions with full tool access.
 *
 * Tools: cursor, click, scroll, find, navigate, type, keyboard, wait, checkpoint, screenshot, zoom
 * Extensions: screenshot, cursor, navigation, checkpoint, debug (registered by base class)
 */
export class ExploreOcrSummarizerV2 extends OcrBase {
    protected readonly initialProgressMessage = "Exploring page...";

    constructor(config: OcrSummarizerConfig) {
        super(buildOcrConfig({ ...config, templatePath: "explore" }));

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
            new FindTool({
                page: this.config.page,
                config: this.config.interaction,
                positioning: this.config.positioning,
            }),
        );
        this.registerTool(
            new NavigateTool({
                page: this.config.page,
                config: this.config.interaction,
                onPageChange: async () => {
                    // Navigation tracking is handled by NavigationExtension
                },
            }),
        );
        this.registerTool(
            new TypeTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
                positioning: this.config.positioning,
                navigationExtension: this.navigationExtension,
            }),
        );
        this.registerTool(
            new KeyboardTool({
                page: this.config.page,
                config: this.config.interaction,
                navigationExtension: this.navigationExtension,
            }),
        );
        this.registerTool(new WaitTool({ config: this.config.interaction }));
        this.registerTool(new CheckpointTool(this.checkpointExtension));
        this.registerTool(
            new ScreenshotTool({
                page: this.config.page,
                config: this.config.interaction,
                cursorExtension: this.cursorExtension,
            }),
        );
        this.registerTool(
            new ZoomTool({
                page: this.config.page,
                config: this.config.interaction,
                positioning: this.config.positioning,
            }),
        );
    }

    async run(options: OcrRunOptions): Promise<SummarizerResult> {
        this.instruction = options.instruction;
        this.checkpointExtension.clearCheckpoints();

        return super.run(options);
    }

    getSystemPrompt(): string {
        return render("explore/system", {
            toolSnippets: this.getToolSnippets(),
            toolGuidelines: this.getToolGuidelines(),
        });
    }

    getForceSummaryPrompt(): string {
        const checkpoints = this.checkpointExtension.getCheckpoints();
        return render("explore/force", {
            instruction: this.instruction,
            checkpoints: checkpoints.length > 0 ? checkpoints : undefined,
        });
    }

    getInstruction(_ctx: OcrExtensionExecutionContext): string | undefined {
        return this.instruction;
    }

    getNavigationContext(_ctx: OcrExtensionExecutionContext): string {
        return this.navigationExtension.getNavigationContextSync?.() ?? "";
    }

    async consolidateCheckpoints(
        ctx: OcrExtensionExecutionContext,
        checkpoints: Checkpoint[],
    ): Promise<string | undefined> {
        if (checkpoints.length === 0) {
            return "(No previous checkpoints)";
        }

        const consolidatePrompt = this.getConsolidatePrompt(checkpoints);

        const context: Context = {
            systemPrompt: this.getSystemPrompt(),
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: consolidatePrompt }],
                    timestamp: Date.now(),
                },
            ],
            tools: [],
        };

        const response = await this.complete(ctx, context, {
            signal: ctx.signal,
        });

        // Extract text from response
        const content = response.content;
        if (typeof content === "string") {
            return content;
        }

        const textParts = content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);

        return textParts.length > 0 ? textParts.join("\n") : undefined;
    }

    async onCompressionStalled(_ctx: OcrExtensionExecutionContext): Promise<void> {
        throw new Error("Exploration was unsuccessful: too much context, try reducing the scope of the exploration.");
    }

    /**
     * Get the consolidation prompt for stalled progress.
     * Public for testing purposes.
     */
    getConsolidatePrompt(checkpoints: Checkpoint[]): string {
        return render("explore/consolidate", {
            checkpointCount: checkpoints.length,
            checkpoints,
        });
    }

    buildInitialMessage(screenshot: string, instruction: string | undefined, linksContext: string): Message {
        const text = render("explore/initial-message", {
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
 * Create an ExploreOcrSummarizerV2 instance.
 */
export function createExploreOcrSummarizerV2(config: OcrSummarizerConfig): ExploreOcrSummarizerV2 {
    return new ExploreOcrSummarizerV2(config);
}
