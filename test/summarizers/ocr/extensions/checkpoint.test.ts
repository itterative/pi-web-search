import { describe, it, expect, vi, beforeEach } from "vitest";

import {
    CheckpointExtension,
    type CheckpointExtensionInit,
    type CheckpointCompressionHost,
    type CheckpointRecoveryArgs,
    type OcrExtensionExecutionContext,
} from "../../../../summarizers/ocr/extensions/index.js";
import type { Checkpoint } from "../../../../summarizers/ocr/state.js";
import type { AssistantMessage, Context, ToolCall } from "@mariozechner/pi-ai";

function createMockAssistantMessage(
    content: AssistantMessage["content"],
    stopReason: "stop" | "toolUse" = "stop",
): AssistantMessage {
    return {
        role: "assistant",
        content,
        stopReason,
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

function createMockHost(overrides: Partial<CheckpointCompressionHost> = {}): CheckpointCompressionHost {
    return {
        getCheckpointRequestPrompt: vi.fn(() => "Please provide a checkpoint."),
        getCheckpointRecoveryPrompt: vi.fn(
            (_ctx, args: CheckpointRecoveryArgs) => `Recovery: ${args.checkpointResponse}`,
        ),
        complete: vi.fn(async () => createMockAssistantMessage([{ type: "text", text: "Checkpoint summary" }])),
        captureScreenshot: vi.fn(async () => "base64-screenshot"),
        getToolDefinitions: vi.fn(() => []),
        ...overrides,
    };
}

function createMockContext(overrides: Partial<OcrExtensionExecutionContext> = {}): OcrExtensionExecutionContext {
    return {
        state: {
            base: {
                messages: [],
                lastInputTokens: 0,
                consecutiveEmptyResponses: 0,
            },
            checkpoint: {
                compression: {
                    messageCountBefore: 0,
                    inCompressionMode: false,
                    inRecoveryMode: false,
                    checkpointsAtLastCompression: 0,
                    compressionsWithoutProgress: 0,
                    compressionAttempts: 0,
                    compressionRequestRound: -1,
                },
                lastCheckpointRound: -100,
                lastCompressionAttemptRound: -100,
                consecutiveCompressionFailures: 0,
                checkpointRequestedRound: -1,
            },
        },
        currentRound: 0,
        maxRounds: 10,
        contextWindow: 100000,
        systemPrompt: "Test system prompt",
        extensionState: new Map(),
        appendMessages: vi.fn(),
        replaceMessages: vi.fn(),
        truncateMessages: vi.fn(),
        updateUI: vi.fn(),
        log: vi.fn(),
        signal: undefined,
        ...overrides,
    };
}

function createMockToolCall(name: string, id = "call_123"): ToolCall {
    return {
        type: "toolCall",
        id,
        name,
        arguments: {},
    } as ToolCall;
}

describe("CheckpointExtension", () => {
    let host: CheckpointCompressionHost;
    let extension: CheckpointExtension;
    let ctx: OcrExtensionExecutionContext;

    beforeEach(() => {
        host = createMockHost();
        extension = new CheckpointExtension({ host });
        ctx = createMockContext();
    });

    describe("checkpoint management", () => {
        it("should start with no checkpoints", () => {
            expect(extension.getCheckpoints()).toEqual([]);
        });

        it("should add checkpoints", () => {
            const checkpoint: Checkpoint = { title: "Test", content: "Content" };
            extension.addCheckpoint(checkpoint);
            expect(extension.getCheckpoints()).toHaveLength(1);
            expect(extension.getCheckpoints()[0]).toEqual(checkpoint);
        });

        it("should clear checkpoints", () => {
            extension.addCheckpoint({ title: "Test 1", content: "Content 1" });
            extension.addCheckpoint({ title: "Test 2", content: "Content 2" });
            expect(extension.getCheckpoints()).toHaveLength(2);

            extension.clearCheckpoints();
            expect(extension.getCheckpoints()).toHaveLength(0);
        });

        it("should set checkpoints", () => {
            const checkpoints: Checkpoint[] = [
                { title: "Test 1", content: "Content 1" },
                { title: "Test 2", content: "Content 2" },
            ];
            extension.setCheckpoints(checkpoints);
            expect(extension.getCheckpoints()).toEqual(checkpoints);
        });

        it("should format checkpoints", () => {
            extension.addCheckpoint({
                title: "Found pricing",
                content: "Basic: $10",
            });
            const formatted = extension.formatCheckpoints();
            expect(formatted).toContain("## Checkpoints");
            expect(formatted).toContain("Found pricing");
            expect(formatted).toContain("Basic: $10");
        });

        it("should format empty checkpoints", () => {
            const formatted = extension.formatCheckpoints();
            expect(formatted).toBe("");
        });
    });

    describe("shouldRequestCheckpoint", () => {
        it("should not request checkpoint when usage is low", async () => {
            ctx.state.base.lastInputTokens = 10000; // 10% of 100k
            const result = await extension.onRoundStart(ctx);
            expect(result).toBe(true);
            expect(ctx.appendMessages).not.toHaveBeenCalled();
        });

        it("should request checkpoint when usage reaches threshold", async () => {
            ctx.state.base.lastInputTokens = 75000; // 75% of 100k (above 70% request threshold)
            const result = await extension.onRoundStart(ctx);
            expect(result).toBe(true);
            expect(ctx.appendMessages).toHaveBeenCalled();
        });

        it("should not request checkpoint twice in same run", async () => {
            ctx.state.base.lastInputTokens = 75000;

            await extension.onRoundStart(ctx);
            expect(ctx.appendMessages).toHaveBeenCalledTimes(1);

            ctx.currentRound = 1;
            await extension.onRoundStart(ctx);
            expect(ctx.appendMessages).toHaveBeenCalledTimes(1); // Still 1, not called again
        });

        it("should not request checkpoint if lastInputTokens is 0", async () => {
            ctx.state.base.lastInputTokens = 0;
            const result = await extension.onRoundStart(ctx);
            expect(result).toBe(true);
            expect(ctx.appendMessages).not.toHaveBeenCalled();
        });
    });

    describe("tool blocking", () => {
        it("should not block tools when checkpoint not requested", async () => {
            const toolCall = createMockToolCall("click");
            const result = await extension.onToolCall(ctx, toolCall);
            expect(result).toBeUndefined();
        });

        it("should allow checkpoint tool when requested", async () => {
            // Request a checkpoint first
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            const toolCall = createMockToolCall("checkpoint");
            const result = await extension.onToolCall(ctx, toolCall);
            expect(result).toBeUndefined();
        });

        it("should block non-checkpoint tools immediately after request", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // First non-checkpoint tool should be blocked immediately
            const click = createMockToolCall("click");
            const result = await extension.onToolCall(ctx, click);
            expect(result).toBeDefined();
            expect(result?.isError).toBe(true);
            expect(result?.content[0]).toHaveProperty("type", "text");
        });
    });

    describe("compression on checkpoint tool call", () => {
        it("should NOT trigger compression immediately on checkpoint tool call", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // Simulate checkpoint tool call
            const checkpointCall = createMockToolCall("checkpoint");
            await extension.onToolResultsComplete(ctx, [checkpointCall], []);

            // Compression should NOT have been triggered yet - waiting for text response
            expect(host.captureScreenshot).not.toHaveBeenCalled();
            expect(ctx.replaceMessages).not.toHaveBeenCalled();
        });

        it("should trigger compression when model responds with text after checkpoint tool", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // Simulate checkpoint tool call (adds checkpoint)
            const checkpointCall = createMockToolCall("checkpoint");
            extension.addCheckpoint({ title: "Test", content: "Checkpoint content" });
            await extension.onToolResultsComplete(ctx, [checkpointCall], []);

            // Model responds with text (no tool calls) - this triggers compression
            ctx.state.base.messages.push(
                createMockAssistantMessage([{ type: "text", text: "I'm done with checkpoints" }]),
            );
            const response = createMockAssistantMessage([{ type: "text", text: "I'm done with checkpoints" }]);
            await extension.onResponse(ctx, response);

            // Compression mode should be entered (request appended)
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);
            expect(ctx.appendMessages).toHaveBeenCalled();

            // Model responds to the compression request
            const compressionResponse = createMockAssistantMessage([
                { type: "text", text: "Here's my summary with checkpoint data" },
            ]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            // Now checkpoint should be applied
            expect(host.captureScreenshot).toHaveBeenCalled();
            expect(ctx.replaceMessages).toHaveBeenCalled();
        });

        it("should not trigger compression when usage is low", async () => {
            ctx.state.base.lastInputTokens = 10000;

            const checkpointCall = createMockToolCall("checkpoint");
            await extension.onToolResultsComplete(ctx, [checkpointCall], []);

            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(false);
        });
    });

    describe("compression on text response", () => {
        it("should trigger compression when model responds with text after request", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // Simulate assistant message with text
            ctx.state.base.messages.push(
                createMockAssistantMessage([{ type: "text", text: "Here's my checkpoint summary" }]),
            );

            const response = createMockAssistantMessage([{ type: "text", text: "Here's my checkpoint summary" }]);

            await extension.onResponse(ctx, response);

            // Compression mode should be entered (request appended)
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);
            expect(ctx.appendMessages).toHaveBeenCalled();

            // Model responds to the compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            expect(host.captureScreenshot).toHaveBeenCalled();
            expect(ctx.replaceMessages).toHaveBeenCalled();
        });

        it("should not trigger compression when model responds with tools", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            const response = createMockAssistantMessage(
                [
                    {
                        type: "toolCall",
                        id: "1",
                        name: "click",
                        arguments: {},
                    } as ToolCall,
                ],
                "toolUse",
            );

            await extension.onResponse(ctx, response);

            expect(host.captureScreenshot).not.toHaveBeenCalled();
        });

        it("should enter compression mode after text response", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            const response = createMockAssistantMessage([{ type: "text", text: "Checkpoint" }]);

            await extension.onResponse(ctx, response);

            // Should have entered compression mode
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);
            // Should have appended compression request message
            expect(ctx.appendMessages).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ role: "user" })]),
                expect.any(String),
            );
        });
    });

    describe("force compression", () => {
        it("should force compression at critical usage (90%)", async () => {
            ctx.state.base.lastInputTokens = 91000; // 91% of 100k
            ctx.currentRound = 5;

            // Simulate an assistant message already present (from the round)
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Summary text" }]));

            await extension.onRoundEnd(ctx);

            // Compression mode should be entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            expect(ctx.replaceMessages).toHaveBeenCalled();
        });

        it("should force compression after max rounds waiting for checkpoint", async () => {
            // Request checkpoint
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // Simulate waiting for many rounds
            ctx.currentRound = 6; // Default maxRoundsBeforeForceCompression is 5

            // Simulate an assistant message already present
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Summary text" }]));

            await extension.onRoundEnd(ctx);

            // Compression mode should be entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            expect(ctx.replaceMessages).toHaveBeenCalled();
        });
    });

    describe("compression flow", () => {
        it("should call host methods in correct order", async () => {
            ctx.state.base.lastInputTokens = 80000;
            await extension.onRoundStart(ctx);

            // Add a checkpoint (simulating checkpoint tool usage)
            extension.addCheckpoint({ title: "Test", content: "Checkpoint content" });

            // Model responds with text (no tool calls) - triggers compression
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "I'm done" }]));
            const response = createMockAssistantMessage([{ type: "text", text: "I'm done" }]);
            await extension.onResponse(ctx, response);

            // Compression mode should be entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            // Should capture screenshot
            expect(host.captureScreenshot).toHaveBeenCalled();

            // Should build recovery prompt
            expect(host.getCheckpointRecoveryPrompt).toHaveBeenCalledWith(
                ctx,
                expect.objectContaining({
                    checkpointResponse: expect.any(String),
                }),
            );

            // Should replace messages
            expect(ctx.replaceMessages).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ role: "user" })]),
                expect.any(String),
            );
        });

        it("should reset lastInputTokens after compression", async () => {
            ctx.state.base.lastInputTokens = 80000;
            await extension.onRoundStart(ctx);

            // Add a checkpoint
            extension.addCheckpoint({ title: "Test", content: "Checkpoint content" });

            // Trigger compression via text response
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Done" }]));
            const response = createMockAssistantMessage([{ type: "text", text: "Done" }]);
            await extension.onResponse(ctx, response);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            expect(ctx.state.base.lastInputTokens).toBe(0);
        });

        it("should handle compression failure gracefully", async () => {
            ctx.state.base.lastInputTokens = 80000;
            await extension.onRoundStart(ctx);

            // Don't add any checkpoints - model will use text response instead

            // Model responds with text (no tool calls) - triggers compression
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Summary" }]));
            const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
            await extension.onResponse(ctx, response);

            // Compression mode should be entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            // Compression should have applied
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(false);
        });

        it("should enter compression mode when no checkpoints and no text in history", async () => {
            ctx.state.base.lastInputTokens = 80000;
            await extension.onRoundStart(ctx);

            // Model responds with text (no tool calls) but we don't add to history
            // and no checkpoints saved - this should enter compression mode
            const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
            await extension.onResponse(ctx, response);

            // No checkpoints, no assistant message in history → compression mode entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);
        });
    });

    describe("multiple checkpoint tool calls", () => {
        it("should allow multiple checkpoint tool calls before text response", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // First checkpoint tool call
            const checkpointCall1 = createMockToolCall("checkpoint", "call_1");
            extension.addCheckpoint({ title: "First", content: "First checkpoint" });
            await extension.onToolResultsComplete(ctx, [checkpointCall1], []);

            // Compression should NOT have triggered yet
            expect(host.captureScreenshot).not.toHaveBeenCalled();

            // Second checkpoint tool call
            const checkpointCall2 = createMockToolCall("checkpoint", "call_2");
            extension.addCheckpoint({ title: "Second", content: "Second checkpoint" });
            await extension.onToolResultsComplete(ctx, [checkpointCall2], []);

            // Still should NOT have triggered
            expect(host.captureScreenshot).not.toHaveBeenCalled();

            // Model responds with text (signals done)
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Done" }]));
            const response = createMockAssistantMessage([{ type: "text", text: "Done" }]);
            await extension.onResponse(ctx, response);

            // Compression mode should be entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final summary" }]);
            ctx.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx, compressionResponse);

            // NOW checkpoint should be applied
            expect(host.captureScreenshot).toHaveBeenCalled();
            expect(ctx.replaceMessages).toHaveBeenCalled();
        });

        it("should include formatted checkpoints in compression request", async () => {
            ctx.state.base.lastInputTokens = 75000;
            await extension.onRoundStart(ctx);

            // Add multiple checkpoints
            extension.addCheckpoint({ title: "Step 1", content: "Clicked button" });
            extension.addCheckpoint({ title: "Step 2", content: "Scrolled down" });
            extension.addCheckpoint({ title: "Step 3", content: "Found data" });

            // Trigger compression via text response
            ctx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Done" }]));
            const response = createMockAssistantMessage([{ type: "text", text: "Done" }]);
            await extension.onResponse(ctx, response);

            // Compression mode should be entered
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Check that the compression request includes the formatted checkpoints
            const appendCalls = (ctx.appendMessages as any).mock.calls;
            const compressionRequestCall = appendCalls.find(
                (call: any[]) => call[1] === "CheckpointExtension:compressionRequest",
            );
            expect(compressionRequestCall).toBeDefined();
            const requestMessage = compressionRequestCall[0][0];
            expect(requestMessage.content[0].text).toContain("Step 1");
            expect(requestMessage.content[0].text).toContain("Step 2");
            expect(requestMessage.content[0].text).toContain("Step 3");
        });
    });

    describe("checkpoint tool during compression mode", () => {
        it("should allow checkpoint tool when in compression mode", async () => {
            ctx.state.base.lastInputTokens = 80000;
            await extension.onRoundStart(ctx);

            // Trigger compression without checkpoints or assistant message
            const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
            await extension.onResponse(ctx, response);

            // Should be in compression mode now
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Checkpoint tool should be allowed
            const checkpointCall = createMockToolCall("checkpoint");
            const result = await extension.onToolCall(ctx, checkpointCall);
            expect(result).toBeUndefined();
        });

        it("should block non-checkpoint tools when in compression mode", async () => {
            ctx.state.base.lastInputTokens = 80000;
            await extension.onRoundStart(ctx);

            // Trigger compression without checkpoints or assistant message
            const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
            await extension.onResponse(ctx, response);

            // Should be in compression mode now
            expect(ctx.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Non-checkpoint tool should be blocked
            const clickCall = createMockToolCall("click");
            const result = await extension.onToolCall(ctx, clickCall);
            expect(result).toBeDefined();
            expect(result?.isError).toBe(true);
        });
    });

    describe("stalled progress handling", () => {
        it("should call consolidateCheckpoints when progress stalls", async () => {
            const consolidateHost = createMockHost({
                consolidateCheckpoints: vi.fn(async () => "Consolidated summary"),
                onCompressionStalled: vi.fn(),
            });

            const consolidateExtension = new CheckpointExtension({
                host: consolidateHost,
                maxCompressionsWithoutProgress: 2,
                minRoundsBetweenCompression: 1, // Allow frequent compressions
            });

            const consolidateCtx = createMockContext();
            consolidateCtx.state.base.lastInputTokens = 80000;

            // Add initial checkpoint
            consolidateExtension.addCheckpoint({ title: "Test", content: "Content" });

            // Helper to trigger full compression cycle
            const triggerCompression = async () => {
                await consolidateExtension.onRoundStart(consolidateCtx);
                // First response triggers compression mode
                consolidateCtx.state.base.messages.push(
                    createMockAssistantMessage([{ type: "text", text: "Summary" }]),
                );
                const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
                await consolidateExtension.onResponse(consolidateCtx, response);
                // Second response (to compression request) completes compression
                if (consolidateCtx.state.checkpoint.compression.inCompressionMode) {
                    const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final" }]);
                    consolidateCtx.state.base.messages.push(compressionResponse);
                    await consolidateExtension.onResponse(consolidateCtx, compressionResponse);
                }
                // Call onRoundEnd to reset inRecoveryMode for next round
                await consolidateExtension.onRoundEnd(consolidateCtx);
            };

            // First compression - sets baseline with 1 checkpoint
            await triggerCompression();
            expect(consolidateHost.consolidateCheckpoints).not.toHaveBeenCalled();

            // Second compression - no new checkpoints, compressionsWithoutProgress = 1
            consolidateCtx.currentRound = 2;
            consolidateCtx.state.base.lastInputTokens = 80000;
            await triggerCompression();
            expect(consolidateHost.consolidateCheckpoints).not.toHaveBeenCalled();

            // Third compression - no new checkpoints, compressionsWithoutProgress = 2, triggers stalled
            consolidateCtx.currentRound = 4;
            consolidateCtx.state.base.lastInputTokens = 80000;
            await triggerCompression();

            // Should have called consolidate
            expect(consolidateHost.consolidateCheckpoints).toHaveBeenCalled();
        });

        it("should call onCompressionStalled when consolidation fails", async () => {
            const stalledHost = createMockHost({
                consolidateCheckpoints: vi.fn(async () => undefined), // Returns undefined = failed
                onCompressionStalled: vi.fn(),
            });

            const stalledExtension = new CheckpointExtension({
                host: stalledHost,
                maxCompressionsWithoutProgress: 2,
                minRoundsBetweenCompression: 1,
            });

            const stalledCtx = createMockContext();
            stalledCtx.state.base.lastInputTokens = 80000;

            // Add initial checkpoint
            stalledExtension.addCheckpoint({ title: "Test", content: "Content" });

            // Helper to trigger full compression cycle
            const triggerCompression = async () => {
                await stalledExtension.onRoundStart(stalledCtx);
                // First response triggers compression mode
                stalledCtx.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Summary" }]));
                const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
                await stalledExtension.onResponse(stalledCtx, response);
                // Second response (to compression request) completes compression
                if (stalledCtx.state.checkpoint.compression.inCompressionMode) {
                    const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final" }]);
                    stalledCtx.state.base.messages.push(compressionResponse);
                    await stalledExtension.onResponse(stalledCtx, compressionResponse);
                }
                // Call onRoundEnd to reset inRecoveryMode for next round
                await stalledExtension.onRoundEnd(stalledCtx);
            };

            // First compression - sets baseline
            await triggerCompression();

            // Second compression - compressionsWithoutProgress = 1
            stalledCtx.currentRound = 2;
            stalledCtx.state.base.lastInputTokens = 80000;
            await triggerCompression();

            // Third compression - will trigger stalled handling
            stalledCtx.currentRound = 4;
            stalledCtx.state.base.lastInputTokens = 80000;
            await triggerCompression();

            expect(stalledHost.onCompressionStalled).toHaveBeenCalled();
        });
    });

    describe("extension state isolation", () => {
        it("should use separate state for each context", async () => {
            const ctx1 = createMockContext();
            const ctx2 = createMockContext();

            ctx1.state.base.lastInputTokens = 80000;
            ctx2.state.base.lastInputTokens = 80000;

            // Add checkpoint and trigger compression in ctx1
            extension.addCheckpoint({ title: "Test", content: "Content" });
            await extension.onRoundStart(ctx1);
            ctx1.state.base.messages.push(createMockAssistantMessage([{ type: "text", text: "Summary" }]));
            const response = createMockAssistantMessage([{ type: "text", text: "Summary" }]);
            await extension.onResponse(ctx1, response);

            // ctx1 should be in compression mode
            expect(ctx1.state.checkpoint.compression.inCompressionMode).toBe(true);

            // Model responds to compression request
            const compressionResponse = createMockAssistantMessage([{ type: "text", text: "Final" }]);
            ctx1.state.base.messages.push(compressionResponse);
            await extension.onResponse(ctx1, compressionResponse);

            // ctx1 should have completed compression (no longer in compression mode)
            expect(ctx1.state.checkpoint.compression.inCompressionMode).toBe(false);

            // ctx2 should still have its original state (not affected by ctx1)
            expect(ctx2.state.checkpoint.compression.inCompressionMode).toBe(false);
            expect(ctx2.state.checkpoint.checkpointRequestedRound).toBe(-1);
        });
    });

    describe("custom configuration", () => {
        it("should use custom checkpoint threshold", async () => {
            const customExtension = new CheckpointExtension({
                host,
                checkpointThreshold: 0.5, // 50% - request threshold will be 40%
            });

            const customCtx = createMockContext();
            customCtx.state.base.lastInputTokens = 35000; // 35% - below 40% request threshold

            await customExtension.onRoundStart(customCtx);
            expect(customCtx.appendMessages).not.toHaveBeenCalled();

            customCtx.state.base.lastInputTokens = 42000; // 42% - above 40% request threshold
            await customExtension.onRoundStart(customCtx);
            expect(customCtx.appendMessages).toHaveBeenCalled();
        });
    });
});
