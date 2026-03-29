# Extension Lifecycle

## Quick Overview

Extensions hook into the interaction loop at 15 specific points. Implement only what you need.

## Hook Timeline

```
[INIT]
  1. getInitialState() → Contribute state (merged into ctx.state)
  2. onBeforeRun() → Modify options

[ROUND LOOP] (repeated maxRounds times)
  3. onRoundStart() → Skip round? request checkpoint?
  4. onFilterTools() → Filter/replace/add tool definitions before API call
  5. onBeforeCompletion() → Modify messages before API
  6. onResponse() → Handle response (compression, checkpoints)
  7. onFilterExecutionTools() → Filter/replace/add executable tools before execution
  8. onToolCall() → Intercept tool?
  9. onToolResult() → Modify result in place
  10. onToolResultsComplete() → Batch ops
  11. onRoundEnd() → Trigger compression, save debug data

[END]
  12. onFinalSummary() → Before final summary
  13. onComplete() → After completion
  14. onError() → On error (cleanup)
  15. onMessagesChanged() → On message changes (debug/tracking)
```

**Note**: `onInit` exists on the `OcrExtension` base class but is **not dispatched** by `OcrBase.run()`. Use `onBeforeRun` or `getInitialState` for initialization.

## Key Hooks

### getInitialState - Contribute State

```typescript
override getInitialState(): Partial<OcrBaseStateInterface> {
    return {
        checkpoint: createCheckpointState(),
    };
}
```

### onBeforeRun - Modify Options

```typescript
async onBeforeRun(ctx, options) {
    // Modify options before the initial message is built
    // e.g., overlay handling may update the screenshot
    if (this.overlayDetected) {
        options.screenshot = await this.captureFreshScreenshot();
    }
}
```

### onToolCall - Intercept Tools

```typescript
async onToolCall(ctx, toolCall) {
    // OverlayExtension: intercept dismiss-overlay tool
    if (toolCall.name === "dismiss-overlay") {
        const args = toolCall.arguments;
        if (args.status === "success") {
            // Model reports overlay dismissed
            await this.exitHandlingMode(ctx, { success: true, message: "Dismissed" });
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "Overlay dismissed" }],
                isError: false,
                timestamp: Date.now(),
            };
        }
        // Enter handling mode...
    }

    // CheckpointExtension: block non-checkpoint tools during compression
    if (ctx.state.checkpoint.compression.inCompressionMode && toolCall.name !== "checkpoint") {
        return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "Tools blocked during compression" }],
            isError: true,
            timestamp: Date.now(),
        };
    }

    // Return undefined to allow normal execution
}
```

### onToolResult - Modify Results

```typescript
// ScreenshotExtension: fill placeholder images
async onToolResult(ctx, toolCall, result) {
    for (const part of result.content) {
        if (part.type !== "image" || part.data !== "") continue;

        const match = part.mimeType?.match(/^image\/(png)\+(raw|debug)$/);
        if (!match) continue;

        // Capture actual screenshot and fill placeholder
        const screenshot = await captureScreenshot(this.page, {
            debug: match[2] === "debug",
            positioning: this.positioning,
        });
        part.data = screenshot;
        part.mimeType = match[1];
    }
}
```

````

### onRoundStart - Control Rounds

```typescript
// CheckpointExtension: request checkpoint when approaching threshold
async onRoundStart(ctx) {
    if (!this.shouldRequestCheckpoint(ctx)) return true;

    // Inject checkpoint request message
    ctx.appendMessages([{
        role: "user",
        content: [{ type: "text", text: "Please save your progress using the checkpoint tool." }],
        timestamp: Date.now(),
    }], "CheckpointExtension");

    ctx.state.checkpoint.checkpointRequestedRound = ctx.currentRound;
    return true; // Continue (don't skip)
}
````

### onBeforeCompletion - Modify Messages

```typescript
// OverlayExtension: inject overlay handling instructions
async onBeforeCompletion(ctx, messages) {
    if (ctx.state.overlay.mode !== "handling") return;

    // Inject overlay-specific system instructions
    const overlayGuide = render("overlay/handling-guide", { ... });
    messages.unshift({
        role: "user",
        content: [{ type: "text", text: overlayGuide }],
        timestamp: Date.now(),
    });
}
```

## Extension Example

```typescript
class MyExtension extends OcrExtension {
    readonly name = "my-extension";

    override getInitialState(): Partial<OcrBaseStateInterface> {
        return { myState: { count: 0 } };
    }

    async onToolCall(ctx, toolCall) {
        if (toolCall.name === "sensitive") {
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "Intercepted!" }],
                isError: false,
                timestamp: Date.now(),
            };
        }
    }

    async onToolResult(ctx, toolCall, result) {
        const state = ctx.extensionState.get(this.name) as { count: number } | undefined;
        ctx.extensionState.set(this.name, { count: (state?.count ?? 0) + 1 });
    }

    async onComplete(ctx) {
        const state = ctx.extensionState.get(this.name) as { count: number } | undefined;
        ctx.log?.(`Total tool calls: ${state?.count ?? 0}`);
    }
}
```

## Important Rules

1. **All extensions receive all events** - Even if one intercepts a tool call, all still get `onToolResult`
2. **In-place modification** - Modify `ctx.state`, `messages`, `result` directly
3. **Optional hooks** - Implement only what you need (all hooks have default no-op implementations)
4. **Registration order matters** - Extensions registered first receive events first
5. **State isolation** - Each run has isolated state (extensions are reused across runs, so reset in `getInitialState`)
6. **Message stack** - Use `ctx.pushMessages`/`ctx.popMessages` for nested conversations (e.g., overlay handling)

## Common Patterns

| Pattern                  | Hook                                       | Use Case                                             |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| Captcha/overlay handling | `onToolCall`                               | Intercept dismiss-overlay, manage sub-conversation   |
| Tool schema swapping     | `onFilterTools`, `onFilterExecutionTools`  | Replace tools based on mode (e.g., overlay handling) |
| Screenshot filling       | `onToolResult`                             | Replace placeholder images with real screenshots     |
| Cursor tracking          | `onToolResult`                             | Update cursor position after click                   |
| Context compression      | `onRoundStart`, `onResponse`, `onRoundEnd` | Multi-phase checkpoint/compression cycle             |
| Navigation tracking      | `onToolCall`, `onToolResult`               | Record page changes, detect URL changes              |
| Debug logging            | `onMessagesChanged`, `onRoundEnd`          | Track message flow, save debug screenshots           |
| Tool blocking            | `onToolCall`                               | Block tools during compression or checkpoint request |

## Registered Extensions (in order)

`OcrBase` registers these extensions in the constructor:

1. **CursorExtension** - Cursor state tracking
2. **NavigationExtension** - Page history and navigation context
3. **OverlayExtension** (if enabled) - Captcha/overlay handling + `dismiss-overlay` tool
4. **DebugExtension** - Debug screenshots and conversation logging
5. **ScreenshotExtension** - Fills screenshot placeholders in tool results
6. **CheckpointExtension** - Context compression via checkpoints
