import { Static, TSchema, ToolCall, ToolResultMessage, validateToolCall } from "@mariozechner/pi-ai";
import { ProtocolError, TimeoutError } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolValidationError } from "./base";

// Re-export base types and class
export {
    OcrTool,
    OcrToolValidationError,
    type OcrToolDefinition,
    type OcrToolOptions,
    type OcrToolExecutionContext,
} from "./base";

// Re-export concrete tool implementations
export { CheckpointTool } from "./checkpoint";
export { ClickTool } from "./click";
export { CursorTool } from "./cursor";
export { DismissOverlayTool } from "./dismiss-overlay";
export { ReportOverlayResultTool } from "./report-overlay-result";
export { FindTool } from "./find";
export { KeyboardTool } from "./keyboard";
export { NavigateTool } from "./navigate";
export { ScreenshotTool } from "./screenshot";
export { ScrollTool } from "./scroll";
export { TypeTool } from "./type";
export { WaitTool } from "./wait";
export { ZoomTool } from "./zoom";

/**
 * Executes an OCR tool call with the given context and tools.
 *
 * Error handling:
 * - Validation errors (OcrToolValidationError) → returned as tool result with error message
 * - Puppeteer ProtocolError → returned as tool result with browser error message
 * - Puppeteer TimeoutError → returned as tool result with timeout message
 * - Unknown errors → re-thrown (crashes the run)
 *
 * This design allows extension-specific errors to bubble up for debugging
 * while handling expected failure modes gracefully.
 */
export async function executeOcrToolCall(
    context: OcrToolExecutionContext,
    tools: OcrTool<any, TSchema>[],
    toolCall: ToolCall,
): Promise<ToolResultMessage> {
    const piTools = tools.map((t) => t.tool);

    let args: any;
    try {
        args = validateToolCall(piTools, toolCall);
    } catch (e) {
        return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [
                {
                    type: "text",
                    text: String(e),
                },
            ],
            isError: true,
            timestamp: Date.now(),
        };
    }

    const tool = tools.find((t) => t.tool.name === toolCall.name);

    if (!tool) {
        return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [
                {
                    type: "text",
                    text: `Error: tool ${toolCall.name} not found`,
                },
            ],
            isError: true,
            timestamp: Date.now(),
        };
    }

    try {
        return await tool.execute(context, args);
    } catch (e) {
        if (e instanceof OcrToolValidationError) {
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [
                    {
                        type: "text",
                        text: `Validation error: ${e.message}`,
                    },
                ],
                isError: true,
                timestamp: Date.now(),
            };
        }

        if (e instanceof ProtocolError) {
            let error = e.originalMessage;

            if (e.code !== undefined) {
                error += ` [puppeteer error code ${e.code}]`;
            }

            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [
                    {
                        type: "text",
                        text: `Browser error: ${error}`,
                    },
                ],
                isError: true,
                timestamp: Date.now(),
            };
        }

        if (e instanceof TimeoutError) {
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [
                    {
                        type: "text",
                        text: `Browser timeout: ${e.message}`,
                    },
                ],
                isError: true,
                timestamp: Date.now(),
            };
        }

        throw e;
    }
}
