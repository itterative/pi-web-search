# Refactor Overlay Extension to Use Extension Hooks

## Overview

Currently, `OverlayExtension` implements its own internal interaction loop with `runHandlingIteration()`, `handleClick()`, `handleWait()`, and `handleFinish()`. This violates the principle of using the framework's extension hooks.

The goal is to refactor the overlay handling to use the standard extension hooks (`onRoundStart`, `onToolCall`, `onToolResult`, etc.) instead of maintaining an internal loop.

## Current Architecture Problems

1. **Internal Loop**: The extension has its own `for` loop with `maxIterations` instead of using the summarizer's round loop
2. **Direct `complete()` Calls**: Bypasses the summarizer's message building and tool execution flow
3. **State Management**: Internal state (`actionHistory`, `clickHistory`, etc.) is not properly integrated with the extension lifecycle
4. **Screenshot Handling**: Custom screenshot capturing bypasses the standard tool result flow

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OcrBase (Summarizer)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Round 1      │  │ Round 2      │  │ Round N          │  │
│  │              │  │              │  │                  │  │
│  │ onRoundStart │──│ onRoundStart │──│ onRoundStart     │  │
│  │ overlay.onToolCall │ overlay.onToolCall │ overlay.onToolCall│  │
│  │ overlay.onToolResult│ overlay.onToolResult│ overlay.onToolResult│  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  OverlayExtension                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ onInit() - Detect overlay once at start             │    │
│  │ onRoundStart() - Check if handled, skip if done     │    │
│  │ onToolCall() - Intercept overlay tools (click,wait,finish) │    │
│  │ onToolResult() - Execute browser actions            │    │
│  │ onRoundEnd() - Track state across rounds            │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Refactoring Plan

### Phase 1: Prepare Infrastructure

- [ ] **Remove internal loop**: Delete `handleOverlay()`, `handle()`, `runHandlingIteration()` methods
- [ ] **Add state management**: Create proper state interface for per-round state
- [ ] **Create overlay tools**: Move tool definitions to a proper tools/ overlay folder
- [ ] **Update eta templates**: Ensure templates work with new state structure

### Phase 2: Implement Extension Hooks

- [ ] **onInit()**: Run initial overlay detection
- [ ] **onBeforeRun()**: Set up viewport, prepare for handling
- [ ] **onRoundStart()**: Check if overlay is handled, skip if done
- [ ] **onToolCall()**: Intercept `click`, `wait`, `finish` tool calls
- [ ] **onToolResult()**: Execute browser actions, update state
- [ ] **onRoundEnd()**: Persist state, check for convergence

### Phase 3: Browser Integration

- [ ] **createClickTool()**: Create a tool that calls `safeCursorClick()`
- [ ] **createWaitTool()**: Create a tool that waits for specified duration
- [ ] **createFinishTool()**: Create a tool that signals completion
- [ ] **executeBrowserAction()**: Unified method for browser interactions
- [ ] **updateStateFromTool()**: Update overlay state from tool results

### Phase 4: State Management

- [ ] **OverlayState interface**: Add fields for:
  - `currentRound` (number)
  - `totalRounds` (number)
  - `maxRounds` (number)
  - `actionHistory` (string[])
  - `clickHistory` (Array<{x, y}>)
  - `previousScreenshot` (string)
  - `hadClickLastRound` (boolean)
  - `screenshotChanged` (boolean)
- [ ] **State persistence**: Ensure state persists across rounds
- [ ] **State reset**: Properly reset state when needed

### Phase 5: Integration

- [ ] **Register tools**: Register overlay tools with the summarizer
- [ ] **Tool registration**: Use `navigationExtension.registerNavigationTool()` if needed
- [ ] **Viewport management**: Handle viewport changes via hooks
- [ ] **Screenshot placeholders**: Use standard placeholder system

### Phase 6: Testing & Validation

- [ ] **Unit tests**: Test each hook individually
- [ ] **Integration tests**: Test full overlay handling flow
- [ ] **Edge cases**: Test cancellation, max rounds, errors
- [ ] **Backward compatibility**: Ensure public API still works

## Implementation Details

### Hook Implementation Strategy

#### onInit()
```typescript
async onInit(ctx: OcrExtensionExecutionContext): Promise<void> {
    ctx.log?.("Checking for overlays...");
    
    await this.page.setViewport({
        width: OVERLAY_VIEWPORT_HEIGHT,
        height: OVERLAY_VIEWPORT_HEIGHT,
    });
    
    this.state.detected = await this.detectOverlay(ctx);
    
    if (!this.state.detected) {
        ctx.log?.("No overlay detected");
        // Restore viewport
        await this.page.setViewport({
            width: this.width,
            height: this.maxHeight,
        });
        return;
    }
    
    ctx.log?.("Overlay detected, will handle during interaction");
}
```

#### onRoundStart()
```typescript
async onRoundStart(ctx: OcrExtensionExecutionContext): Promise<boolean | void> {
    // If overlay is already handled, skip this round
    if (this.state.handled) {
        ctx.log?.("Overlay already handled, skipping round");
        return false; // Skip this round
    }
    
    // If not detected yet, we're not handling overlays
    if (!this.state.detected) {
        return true; // Continue with normal processing
    }
    
    ctx.updateUI?.({
        message: `Handling overlay (attempt ${ctx.currentRound}/${this.maxRounds})...`,
        round: ctx.currentRound,
        maxRounds: this.maxRounds,
    });
    
    return true; // Continue with tool execution
}
```

#### onToolCall()
```typescript
async onToolCall(
    ctx: OcrExtensionExecutionContext,
    toolCall: ToolCall,
): Promise<ToolResultMessage | undefined | void> {
    // Only intercept overlay tools
    if (!toolCall.name.startsWith("overlay")) {
        return undefined; // Allow other tools to execute normally
    }
    
    switch (toolCall.name) {
        case "overlay/click":
            return this.interceptClick(ctx, toolCall);
        case "overlay/wait":
            return this.interceptWait(ctx, toolCall);
        case "overlay/finish":
            return this.interceptFinish(ctx, toolCall);
        default:
            return undefined;
    }
}
```

#### onToolResult()
```typescript
async onToolResult(
    ctx: OcrExtensionExecutionContext,
    toolCall: ToolCall,
    result: ToolResultMessage,
): Promise<void> {
    switch (toolCall.name) {
        case "overlay/click":
            await this.executeClick(ctx, result);
            break;
        case "overlay/wait":
            await this.executeWait(ctx, result);
            break;
        case "overlay/finish":
            this.handleFinish(ctx, result);
            break;
    }
}
```

### Tool Definition Strategy

Instead of defining tools inline in the extension, create them in a separate file:

```typescript
// summarizers/ocr/tools/overlay/click.ts
export const OverlayClickTool: Tool = {
    name: "overlay/click",
    description: "Click/tap at specific coordinates on the overlay screenshot.",
    parameters: Type.Object({
        x: Type.Number({ description: "X coordinate (0.0 = left, 1.0 = right)" }),
        y: Type.Number({ description: "Y coordinate (0.0 = top, 1.0 = bottom)" }),
    }),
};
```

## Migration Checklist

- [ ] Create `summarizers/ocr/tools/overlay/` directory
- [ ] Create `click.ts`, `wait.ts`, `finish.ts` tool files
- [ ] Update `OverlayExtension` to use new tools
- [ ] Remove internal loop methods
- [ ] Update eta templates to use new state structure
- [ ] Update documentation/comments
- [ ] Run tests
- [ ] Update README/docs

## Benefits of Refactoring

1. **Framework Consistency**: Uses standard extension hooks instead of custom loop
2. **Better State Management**: State naturally persists across rounds
3. **Easier Debugging**: Each hook is isolated and testable
4. **Framework Features**: Can leverage summarizer features (checkpoints, context compression)
5. **Maintainability**: Clearer separation of concerns
6. **Extensibility**: Easier to add more hooks or modify behavior

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing API | Keep public methods (`getResult()`, `isOverlayDetected()`, etc.) |
| State sync issues | Use proper state interface with `OcrState` type |
| Performance impact | Minimal - same operations, just different flow |
| Testing complexity | Add comprehensive tests for each hook |

## Timeline Estimate

- Phase 1: 2-3 hours
- Phase 2: 3-4 hours
- Phase 3: 2-3 hours
- Phase 4: 1-2 hours
- Phase 5: 1-2 hours
- Phase 6: 2-3 hours

**Total: 11-17 hours**
