import { ToolResultMessage, Type } from "@mariozechner/pi-ai";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions } from "./base";
import type { CheckpointExtension } from "../extensions";

interface CheckpointToolParameters {
    title: string;
    content: string;
}

export const CHECKPOINT_TOOL = {
    name: "checkpoint",
    description:
        "Log useful information to remember for later. Use this to save findings, captions, summaries, or any important data discovered during exploration.",
    promptSnippet: "checkpoint - Log useful information for long term tracking",
    promptGuidelines:
        "## checkpoint tool\n" +
        "- Save important findings for later use\n" +
        "- `title`: short label\n" +
        "- `content`: the information to remember\n" +
        "- Checkpoints survive context compression, so you are encourages to use these\n" +
        "- Use frequently to log each and every progress step in your exploation process\n" +
        "- All checkpoints are included in final summary",
    parameters: Type.Object({
        title: Type.String({
            description: "A short title for this checkpoint (e.g., 'Image 1 caption', 'Page 2 summary', 'Key finding')",
        }),
        content: Type.String({
            description: "The information to store. Be concise but complete.",
        }),
    }),
};

export class CheckpointTool extends OcrTool<CheckpointExtension> {
    constructor(ctx: CheckpointExtension, options?: OcrToolOptions) {
        super(CHECKPOINT_TOOL, ctx, options);
    }

    async execute(context: OcrToolExecutionContext, args: CheckpointToolParameters): Promise<ToolResultMessage> {
        const { title, content } = args;

        // Add checkpoint via extension
        this.ctx.addCheckpoint({ title, content });

        const checkpoints = this.ctx.getCheckpoints();
        context.updateUI?.({ message: `Checkpoint saved: "${title}"` });

        return this.simpleTextSuccessMessage(
            context,
            `Checkpoint "${title}" saved. Total checkpoints: ${checkpoints.length}`,
        );
    }
}
