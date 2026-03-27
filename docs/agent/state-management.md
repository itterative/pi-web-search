# State Management

## Interaction State

### Positioning Systems

Two coordinate systems are supported:

**Absolute** (pixels):

```typescript
{
    type: "absolute";
}
```

- Coordinates: `0` to `viewport.width/height`
- Example: `click(x=150, y=300)`

**Relative** (configurable range):

```typescript
{ type: "relative", x: 1000, y: 1000 }
```

- Coordinates: `0.0` to `x/y`
- Example: `click(x=500, y=500)` for center of 1000x1000 system
- Scales to viewport: `x * viewport.width / positioning.x`

The default used by `ocr-v2.ts` is `{ type: "relative", x: 1000, y: 1000 }`.

### InteractionConfig

```typescript
{
    defaultSleepMillis: number;      // Default delay after actions (default: 2)
    minSleepMillis: number;          // Minimum delay (default: 0.5)
    maxSleepMillis: number;          // Maximum delay (default: 10)
    delayMillis: number;             // Network idle timeout (default: 500)
    scrollRelativeMultiplier: number; // Scroll amount multiplier (default: 0.75)
    maxTextMatchResults: number;     // Max results for text search (default: 15)
    minZoomDimension?: number;       // Minimum zoom output dimension in pixels
    minZoomRounding?: number;        // Rounding increment for min size suggestions
    coordinatePrecision?: number;    // Decimal places (0=absolute, 2=relative)
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

### OverlayState

```typescript
{
    mode: "idle" | "handling" | "done"; // Current overlay handling state
    handlingStartRound: number;        // Round when handling started
    result: OverlayResult | null;      // Result of overlay handling
    savedDismissCall: SavedDismissCall | null; // Original dismiss-overlay call info
    savedViewport: { width: number; height: number } | null; // Viewport saved on enter
}
```

### CompressionState (nested in CheckpointState)

```typescript
{
    messageCountBefore: number; // Message count before compression (for rollback)
    inCompressionMode: boolean; // Blocking non-checkpoint tools
    inRecoveryMode: boolean; // Just finished compression, in recovery
    checkpointsAtLastCompression: number; // Checkpoint count at last compression
    compressionsWithoutProgress: number; // Consecutive compressions without new checkpoints
    compressionAttempts: number; // Attempts in current compression cycle
    compressionRequestRound: number; // Round when compression started (-1 if not)
}
```

### CheckpointState

```typescript
{
    compression: CompressionState; // Compression sub-state
    lastCheckpointRound: number; // Round of last checkpoint save
    lastCompressionAttemptRound: number; // Round of last compression attempt
    consecutiveCompressionFailures: number; // Consecutive compression failures
    checkpointRequestedRound: number; // Round when checkpoint was requested (-1 if not)
}
```

### Checkpoint

```typescript
{
    title: string; // e.g., "Found 5 products"
    content: string; // Detailed progress summary
}
```

### Full State (OcrBaseState<TCustom>)

```typescript
type OcrBaseState<TCustom = object> = {
    base: OcrSharedState;
    checkpoint: CheckpointState;
    overlay: OverlayState;
} & TCustom;
```

## State Flow

```
[INIT]
  ├─ collectInitialState() → Merge extension states (checkpoint, overlay)
  └─ Build OcrBaseState<TCustom>

[ROUND LOOP]
  ├─ onRoundStart() → Check token usage, request checkpoint
  ├─ complete() → API call, update lastInputTokens
  ├─ onResponse() → Handle compression response
  ├─ onToolCall/Result → Update extension state
  └─ onRoundEnd() → Trigger compression if threshold reached

[COMPRESSION]
  ├─ shouldRequestCheckpoint: tokens / contextWindow >= (threshold - 0.1)
  ├─ shouldForceCompression: waited too long OR usage >= 90%
  ├─ Request checkpoint from model
  ├─ Replace messages with checkpoint text + screenshot
  └─ Set inRecoveryMode = true
```

## Extension State

Each extension can store per-run state in two ways:

### 1. Context State (via getInitialState)

Extensions contribute state to the shared context via `getInitialState()`. This state is accessible via `ctx.state.checkpoint`, `ctx.state.overlay`, etc.

```typescript
class MyExtension extends OcrExtension {
    override getInitialState(): Partial<OcrBaseStateInterface> {
        return { myState: createMyState() };
    }

    async onToolResult(ctx, toolCall, result) {
        ctx.state.myState.count++;
    }
}
```

### 2. Extension State Map (per-extension, per-run)

For simpler per-extension state, use the `ctx.extensionState` Map:

```typescript
class MyExtension extends OcrExtension {
    async onToolResult(ctx, toolCall, result) {
        const state = ctx.extensionState.get(this.name) as { count: number } | undefined;
        ctx.extensionState.set(this.name, { count: (state?.count ?? 0) + 1 });
    }
}
```

## Message Management

The execution context provides typed message operations:

| Method                            | Description          | Triggers                                  |
| --------------------------------- | -------------------- | ----------------------------------------- |
| `appendMessages(msgs, source)`    | Append messages      | `onMessagesChanged({ type: "append" })`   |
| `replaceMessages(msgs, source)`   | Replace all messages | `onMessagesChanged({ type: "replace" })`  |
| `truncateMessages(count, source)` | Truncate to count    | `onMessagesChanged({ type: "truncate" })` |
| `pushMessages(source)`            | Push to stack, clear | `onMessagesChanged({ type: "push" })`     |
| `popMessages(source)`             | Restore from stack   | `onMessagesChanged({ type: "pop" })`      |

Message change events include source tracking for debugging:

```typescript
type MessageChange =
    | { type: "append"; messages: Message[]; source: string }
    | { type: "replace"; messages: Message[]; previousCount: number; source: string }
    | { type: "truncate"; count: number; previousCount: number; source: string }
    | { type: "push"; previousCount: number; stackDepth: number; source: string }
    | { type: "pop"; restoredCount: number; stackDepth: number; source: string };
```

## Key Files

| File                       | Purpose                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `state.ts`                 | InteractionConfig, InteractionPositioning, Checkpoint                              |
| `extensions/base.ts`       | OcrSharedState, OcrBaseStateInterface, OcrExtensionExecutionContext, MessageChange |
| `extensions/checkpoint.ts` | CheckpointState, CompressionState, CheckpointExtension                             |
| `extensions/overlay.ts`    | OverlayState, OverlayExtension                                                     |
| `ocr.ts`                   | OcrBaseState<TCustom> type                                                         |
