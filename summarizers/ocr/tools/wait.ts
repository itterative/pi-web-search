import { ToolResultMessage, Type } from "@mariozechner/pi-ai";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions } from "./base";
import { sleep } from "../../../common/utils";
import { InteractionConfig } from "../state";

interface WaitToolParameter {
    seconds?: number;
}

interface WaitToolContext {
    config: InteractionConfig;
}

export class WaitTool extends OcrTool<WaitToolContext> {
    constructor(ctx: WaitToolContext, options?: OcrToolOptions) {
        super(
            {
                name: "wait",
                description: "Wait for a specified duration. Use this when content needs time to load after an action.",
                promptSnippet: "wait - Pause for content to load",
                promptGuidelines:
                    "## wait tool\n" +
                    "- Wait for content to load after actions\n" +
                    "- `seconds`: duration to wait (default: 2s, max: 10s)\n" +
                    "- Use when page appears blank or content appears not loaded" +
                    "- Use after clicking elements that trigger async content\n" +
                    "- Use after navigation if page loads slowly\n" +
                    "- Don't overuse - most actions include automatic delays",
                parameters: Type.Object({
                    seconds: Type.Optional(
                        Type.Number({
                            description: `Seconds to wait (default: ${ctx.config.defaultSleepMillis.toPrecision(1)}, max: ${ctx.config.maxSleepMillis.toPrecision(1)})`,
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: WaitToolParameter): Promise<ToolResultMessage> {
        const { seconds = this.ctx.config.defaultSleepMillis } = args;
        const clampedSeconds = Math.min(
            Math.max(this.ctx.config.minSleepMillis, seconds),
            this.ctx.config.maxSleepMillis,
        );

        context.updateUI?.({ message: this.getUserMessage(seconds) });
        await sleep(clampedSeconds * 1000, context.signal);

        return this.simpleTextSuccessMessage(context, `Waited ${seconds.toPrecision(1)} second(s)`);
    }

    private getUserMessage(seconds: number): string {
        return `Waiting for ${seconds.toPrecision(1)} seconds...`;
    }
}
