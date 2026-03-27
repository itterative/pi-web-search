# Summarizer Flow

## Main Loop

```
OcrBase.run()
  ├─ 1. Set viewport (config.width x config.maxHeight, default 1280x800)
  ├─ 2. Build extension context
  │     ├─ collectInitialState() → Merge extension states
  │     ├─ Build message management (append, replace, truncate, push, pop)
  │     └─ Build logger and UI update handler
  ├─ 3. dispatchOnBeforeRun()
  ├─ 4. Build initial message with screenshot
  │
  └─ FOR EACH ROUND (0 to maxRounds-1):
      ├─ 5. Check abort signal
      ├─ 6. dispatchOnRoundStart() → Can skip round
      ├─ 7. runRound():
      │   ├─ Update UI (round progress)
      │   ├─ complete() → API call to LLM
      │   │   └─ dispatchOnBeforeCompletion()
      │   ├─ Track token usage (response.usage.input)
      │   ├─ Check empty response (llamacpp bug) → retry if < maxEmptyResponseRetries
      │   ├─ Push response to messages
      │   ├─ dispatchOnResponse() → Handle checkpoints/compression
      │   │
      │   ├─ No tool calls?
      │   │   ├─ After compression reset? → Continue
      │   │   ├─ In compression mode? → Continue
      │   │   └─ Model is done → Extract text summary or break
      │   │
      │   └─ Tool calls exist:
      │       ├─ In compression mode? → Block non-checkpoint tools
      │       └─ FOR EACH toolCall:
      │           ├─ dispatchOnToolCall() → Extensions can intercept
      │           ├─ executeOcrToolCall() → Puppeteer action
      │           └─ dispatchOnToolResult() → Extensions modify result
      │       └─ dispatchOnToolResultsComplete()
      │
      └─ 8. dispatchOnRoundEnd() → Trigger compression if needed
  │
  └─ 9. Force final summary
      ├─ dispatchOnFinalSummary()
      ├─ Push force summary prompt
      ├─ complete() → Get final response
      └─ dispatchOnComplete()
```

## Extension Hooks (in order)

| Hook                      | When                   | Purpose                                           |
| ------------------------- | ---------------------- | ------------------------------------------------- |
| `getInitialState()`       | Before run             | Contribute initial state (merged into ctx.state)  |
| `onBeforeRun()`           | Before initial message | Modify options (e.g., overlay changes screenshot) |
| `onRoundStart()`          | Each round start       | Skip round or request checkpoint                  |
| `onBeforeCompletion()`    | Before API call        | Modify messages (inject guidance)                 |
| `onResponse()`            | After API response     | Handle compression, checkpoint text               |
| `onToolCall()`            | Before tool exec       | **Intercept** tool execution                      |
| `onToolResult()`          | After tool result      | **Modify result in place**                        |
| `onToolResultsComplete()` | After all tools        | Batch operations                                  |
| `onRoundEnd()`            | End of round           | Trigger compression, save debug data              |
| `onFinalSummary()`        | Before final summary   | Final prep                                        |
| `onComplete()`            | After completion       | Final cleanup                                     |
| `onError()`               | On error               | Cleanup (e.g., pop overlay messages)              |
| `onMessagesChanged()`     | On message changes     | Debug/tracking                                    |

**Note**: `onInit` exists on `OcrExtension` but is **not dispatched** by `OcrBase.run()`. Use `onBeforeRun` or `getInitialState` for initialization.

## Tool Interception Flow

```
Model → click(x, y)
  │
  ▼
dispatchOnToolCall()
  ├─ OverlayExtension: dismiss-overlay tool?
  │   ├─ No status → enter handling mode (push messages, return screenshot)
  │   ├─ status="success" → exit handling mode (pop messages, return result)
  │   └─ status="failure" → exit handling mode (pop messages, return error)
  ├─ CheckpointExtension: non-checkpoint tool during compression?
  │   └─ Return blocked message
  ├─ NavigationExtension: store URL before execution
  │   └─ Return undefined (allow)
  ├─ DebugExtension: store tool name for debug naming
  │   └─ Return undefined (allow)
  │
  ▼ (if shouldExecute)
executeOcrToolCall()
  ├─ validateToolCall()
  ├─ Find tool by name
  ├─ tool.execute()
  └─ Handle errors (validation, protocol, timeout)
  │
  ▼
dispatchOnToolResult()
  ├─ ScreenshotExtension: fill placeholder images
  ├─ NavigationExtension: detect URL change, append nav info
  └─ DebugExtension: save debug screenshots
```

## Checkpoint Compression

Compression is managed by `CheckpointExtension` with a two-phase approach:

### Phase 1: Request Checkpoint (soft, ~70% usage)

```
onRoundStart()
  ├─ Check: tokens / contextWindow >= (checkpointThreshold - 0.1)
  ├─ Not already requested? Not in recovery? Backoff satisfied?
  └─ If yes:
      ├─ Append checkpoint-request message
      └─ Set checkpointRequestedRound
```

### Phase 2: Block Tools (after request)

```
onToolCall()
  ├─ Checkpoint tool? → Allow
  ├─ Non-checkpoint tool while checkpoint requested?
  │   └─ Return blocked message (tool-blocked-checkpoint template)
  └─ Non-checkpoint tool during compression?
      └─ Return blocked message (tool-blocked-compression template)
```

### Phase 3: Force Compression (at threshold or 90%)

```
onRoundEnd()
  └─ shouldForceCompression():
      ├─ Waited maxRoundsBeforeForceCompression since request?
      ├─ Or: usage >= 90% (critical threshold)?
      └─ If yes → startCompression()

onResponse()
  ├─ Model responded with text (no tool calls) after checkpoint request?
  │   └─ startCompression()
  └─ In compression mode?
      └─ handleCompressionResponse()
```

### Compression Cycle

```
startCompression()
  ├─ Check for stalled progress (compressionsWithoutProgress)
  │   ├─ consolidateCheckpoints() via host (explore mode only)
  │   └─ If consolidation fails → onCompressionStalled()
  ├─ Set inCompressionMode = true
  ├─ Build request prompt (include saved checkpoints)
  └─ Append compression request message

handleCompressionResponse()
  ├─ Got text content?
  │   ├─ applyCheckpointMessage():
  │   │   ├─ Capture screenshot
  │   │   ├─ Build recovery prompt (with checkpoint text, instruction, nav context, links)
  │   │   ├─ replaceMessages() with [screenshot + recovery text]
  │   │   └─ Reset token count
  │   ├─ Set inRecoveryMode = true
  │   └─ Exit compression mode
  └─ No text? Retry up to maxCompressionAttempts
      └─ If exhausted → truncate to pre-compression state, increment failures
```

## Key Files

| File                       | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `ocr.ts`                   | OcrBase class - main orchestrator                               |
| `ocr-summarizer-base.ts`   | OcrSummarizerConfig, buildOcrConfig factory                     |
| `config.ts`                | OcrRunOptions type                                              |
| `response-utils.ts`        | isEmptyResponse, extractThinkingFromContent, extractTextSummary |
| `extensions/base.ts`       | OcrExtension base class + hooks + execution context types       |
| `extensions/registry.ts`   | Extension registry + dispatch                                   |
| `extensions/checkpoint.ts` | CheckpointExtension, CheckpointState, CompressionState          |
| `tools/base.ts`            | OcrTool base class                                              |
| `tools/index.ts`           | Tool exports + executeOcrToolCall()                             |
| `instructions/index.ts`    | Template rendering (Eta)                                        |
| `index.ts`                 | Factory functions (create\*V2) + re-exports                     |

## Factory Pattern

```typescript
// Create summarizer
const summarizer = createExploreOcrSummarizerV2(config);

// Run it
const result = await summarizer.run({
    page, // set by OcrBase from config
    instruction: "Extract all product prices",
    screenshot: base64Image,
    linksContext: "",
});
```

Three modes:

- **Full**: Scroll only, extract all content (templatePath: "full")
- **Summarize**: Cursor, click, scroll, screenshot (templatePath: "summarize")
- **Explore**: All 12 tools, complex tasks (templatePath: "explore")
