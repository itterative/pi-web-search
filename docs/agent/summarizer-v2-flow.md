# V2 Summarizer Flow

## Main Loop

```
OcrBase.run()
  ├─ 1. Set viewport (720x3000)
  ├─ 2. Build extension context
  ├─ 3. dispatchOnBeforeRun()
  ├─ 4. Build initial message with screenshot
  │
  └─ FOR EACH ROUND (0 to maxRounds-1):
      ├─ 5. dispatchOnRoundStart() → Can skip round
      ├─ 6. complete() → API call to LLM
      │   └─ dispatchOnBeforeCompletion()
      │
      ├─ 7. Process response:
      │   ├─ Check empty response (llamacpp bug)
      │   ├─ Push to messages
      │   └─ dispatchOnResponse()
      │
      ├─ 8. No tool calls? → Model done (break)
      │
      └─ 9. Tool calls exist:
          └─ FOR EACH toolCall:
              ├─ dispatchOnToolCall() → Extensions can intercept
              ├─ executeOcrToolCall() → Puppeteer action
              └─ dispatchOnToolResult() → Extensions modify result
          └─ dispatchOnToolResultsComplete()
      │
      └─ dispatchOnRoundEnd()
  │
  └─ 10. Force final summary
      ├─ Push force summary prompt
      ├─ complete() → Get final response
      └─ dispatchOnComplete()
```

## Extension Hooks (in order)

| Hook | When | Purpose |
|------|------|---------|
| `getInitialState()` | Before run | Contribute initial state |
| `onBeforeRun()` | Before initial message | Modify options |
| `onInit()` | After context built | One-time init |
| `onRoundStart()` | Each round start | Skip round or request checkpoint |
| `onBeforeCompletion()` | Before API call | Modify messages |
| `onResponse()` | After API response | Handle checkpoints |
| `onToolCall()` | Before tool exec | **Intercept** tool execution |
| `onToolResult()` | After tool result | **Modify result in place** |
| `onToolResultsComplete()` | After all tools | Batch operations |
| `onRoundEnd()` | End of round | Cleanup |
| `onFinalSummary()` | Before final summary | Final prep |
| `onComplete()` | After completion | Final cleanup |
| `onError()` | On error | Debug/cleanup |
| `onMessagesChanged()` | On message changes | Debug/tracking |

## Tool Interception Flow

```
Model → click(x, y)
  │
  ▼
dispatchOnToolCall()
  ├─ OverlayExtension: captcha detected?
  │   └─ Return { shouldExecute: false, interceptedResult }
  │
  ▼ (if shouldExecute)
executeOcrToolCall()
  ├─ Validate params
  ├─ Find tool
  └─ tool.execute()
  │
  ▼
dispatchOnToolResult()
  └─ ScreenshotExtension: fill placeholder images
```

## Checkpoint Compression

```
Round starts
  │
  ▼
onRoundStart()
  ├─ Check: tokens / contextWindow >= threshold (0.8)
  │
  ├─ If exceeded:
  │   ├─ Return false (skip round)
  │   ├─ Request checkpoint from model
  │   ├─ Replace old messages with checkpoint text
  │   └─ Set inCompressionMode = true
  │
  └─ Block non-checkpoint tools during compression
```

## Key Files

| File | Purpose |
|------|---------|
| `ocr.ts` | OcrBase class - main orchestrator |
| `extensions/base.ts` | OcrExtension base class + hooks |
| `extensions/registry.ts` | Extension registry + dispatch |
| `tools/base.ts` | OcrTool base class |
| `tools/*.ts` | Concrete tools (click, scroll, etc.) |
| `index.ts` | Factory functions (create*V2) |

## Factory Pattern

```typescript
// Create summarizer
const summarizer = createExploreOcrSummarizerV2(config);

// Run it
const result = await summarizer.run({
    page,
    instruction: "Extract all product prices",
    screenshot: base64Image,
    linksContext: "",
});
```

Three modes:
- **Full**: Scroll only, extract all content
- **Summarize**: Click/scroll/screenshot, concise summary
- **Explore**: All 11 tools, complex tasks
