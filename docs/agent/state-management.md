# State Management

## Interaction State

### Positioning Systems

Two coordinate systems are supported:

**Absolute** (pixels):
```typescript
{ type: "absolute" }
```
- Coordinates: `0` to `viewport.width/height`
- Example: `click(x=150, y=300)`

**Relative** (0.0-1.0 scaled):
```typescript
{ type: "relative", x: 1280, y: 800 }
```
- Coordinates: `0.0` to `x/y`
- Example: `click(x=0.5, y=0.5)` for center
- Scales to viewport: `x * viewport.width / positioning.x`

### InteractionConfig

```typescript
{
    defaultSleepMillis: number;      // Default delay after actions
    minSleepMillis: number;          // Minimum delay
    maxSleepMillis: number;          // Maximum delay
    delayMillis: number;             // Network idle timeout
    scrollRelativeMultiplier: number; // Scroll amount multiplier
    maxTextMatchResults: number;     // Max results for text search (default: 5)
    coordinatePrecision: number;     // Decimal places (0=absolute, 2=relative)
}
```

## State Types

### OcrSharedState (base)

```typescript
{
    messages: Message[];              // Conversation history
    lastInputTokens: number;          // Token usage for checkpointing
    consecutiveEmptyResponses: number; // llamacpp bug workaround
}
```

### CheckpointState

```typescript
{
    compression: {
        inCompressionMode: boolean;   // Blocking non-checkpoint tools
    };
    checkpoints: Checkpoint[];        // Saved progress
}
```

### Checkpoint

```typescript
{
    title: string;    // e.g., "Found 5 products"
    content: string;  // Detailed progress summary
}
```

## State Flow

```
[INIT]
  ├─ collectInitialState() → Merge extension states
  └─ Build OcrBaseState<TCustom>

[ROUND LOOP]
  ├─ onRoundStart() → Check token usage
  ├─ complete() → API call
  ├─ onResponse() → Handle checkpoints
  ├─ onToolCall/Result → Update state
  └─ onMessagesChanged → Track changes

[COMPRESSION]
  ├─ tokens / contextWindow >= 0.8
  ├─ Request checkpoint from model
  ├─ Replace messages with checkpoint text
  └─ Set inCompressionMode = true
```

## Extension State

Each extension can store per-run state:

```typescript
class MyExtension extends OcrExtension {
    async onToolResult(ctx, toolCall, result) {
        // Store in extension-specific map
        const state = ctx.extensionState.get(this.name) || {};
        state.callCount = (state.callCount || 0) + 1;
        ctx.extensionState.set(this.name, state);
    }
}
```

## Key Files

| File | Purpose |
|------|---------|
| `state.ts` | InteractionConfig, InteractionPositioning |
| `extensions/base.ts` | OcrSharedState, OcrBaseStateInterface |
| `extensions/checkpoint.ts` | CheckpointState, compression logic |
| `ocr.ts` | OcrBaseState<TCustom> type |
