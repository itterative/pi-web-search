# Extension Lifecycle

## Quick Overview

Extensions hook into the interaction loop at 14 specific points. Implement only what you need.

## Hook Timeline

```
[INIT]
  1. getInitialState() → Contribute state
  2. onBeforeRun() → Modify options
  3. onInit() → One-time init

[ROUND LOOP] (repeated maxRounds times)
  4. onRoundStart() → Skip round? request checkpoint?
  5. onBeforeCompletion() → Modify messages before API
  6. onResponse() → Handle response
  7. onToolCall() → Intercept tool?
  8. onToolResult() → Modify result
  9. onToolResultsComplete() → Batch ops
  10. onRoundEnd() → Cleanup

[END]
  11. onFinalSummary() → Before final summary
  12. onComplete() → After completion
  13. onError() → On error
  14. onMessagesChanged() → On message changes
```

## Key Hooks

### onToolCall - Intercept Tools

```typescript
async onToolCall(ctx, toolCall) {
    // Intercept captcha solving
    if (this.overlayExists && toolCall.name === "click") {
        const result = await this.solveCaptcha();
        return {
            role: "toolResult",
            toolCallId: toolCall.id,
            content: [{ type: "text", text: "Captcha solved" }],
        };
    }
    // Return undefined to allow normal execution
}
```

### onToolResult - Modify Results

```typescript
async onToolResult(ctx, toolCall, result) {
    // Fill screenshot placeholders
    if (toolCall.name === "screenshot") {
        // result already has image data
        return;
    }
    
    // Replace placeholder with actual screenshot
    if (result.content.some(c => c.isPlaceholder)) {
        const screenshot = await this.page.screenshot();
        result.content = result.content.map(c =>
            c.isPlaceholder ? { type: "image", data: screenshot } : c
        );
    }
}
```

### onRoundStart - Control Rounds

```typescript
async onRoundStart(ctx) {
    // Checkpoint compression
    const usage = ctx.state.base.lastInputTokens / ctx.contextWindow;
    if (usage >= 0.8) {
        return false; // Skip round, request checkpoint
    }
    return true;
}
```

### onBeforeCompletion - Modify Messages

```typescript
async onBeforeCompletion(ctx, messages) {
    // Fill placeholders before API call
    for (const msg of messages) {
        if (msg.role === "user") {
            fillScreenshotPlaceholders(msg.content);
        }
    }
}
```

## Extension Example

```typescript
class MyExtension extends OcrExtension {
    readonly name = "my-extension";

    // Contribute state
    getInitialState() {
        return { myState: { count: 0 } };
    }

    // Intercept tool calls
    async onToolCall(ctx, toolCall) {
        if (toolCall.name === "sensitive") {
            return {
                role: "toolResult",
                toolCallId: toolCall.id,
                content: [{ type: "text", text: "Intercepted!" }],
            };
        }
    }

    // Modify results
    async onToolResult(ctx, toolCall, result) {
        ctx.state.myState.count++;
    }

    // Cleanup
    async onComplete(ctx) {
        console.log("Total tool calls:", ctx.state.myState.count);
    }
}
```

## Important Rules

1. **All extensions receive all events** - Even if one intercepts, all get onToolResult
2. **In-place modification** - Modify `ctx.state`, `messages`, `result` directly
3. **Optional hooks** - Implement only what you need
4. **Registration order matters** - Dependencies first
5. **State isolation** - Each run has isolated state

## Common Patterns

| Pattern | Hook | Use Case |
|---------|------|----------|
| Captcha solving | onToolCall | Intercept clicks when overlay exists |
| Screenshot filling | onToolResult | Replace placeholders with images |
| Cursor tracking | onToolResult | Update cursor position after click |
| Context compression | onRoundStart | Request checkpoint at 80% usage |
| Navigation tracking | onToolResult | Record page changes |
| Debug logging | onMessagesChanged | Track message flow |
