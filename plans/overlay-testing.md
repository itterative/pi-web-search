# Overlay Extension Integration Tests

## Goal

Test the Phase 2 overlay handling flow end-to-end: the model sees an overlay, calls `dismiss-overlay`, uses normal tools to dismiss it, then reports status. Tests run without a real browser or model by injecting mock dependencies.

## Current State

The existing integration test (`full-integration.test.ts`) shows the pattern:
- Subclass the summarizer
- Override `complete()` to return a queue of mock `AssistantMessage`s
- Skip tests when no browser is available

Two problems prevent reusing this pattern directly:
1. **Browser dependency** — tools like `click` call `page.mouse.click()`, and `captureScreenshot` calls `page.screenshot()`. Even with a mock model, the tools still need a page that responds to these calls.
2. **Screenshot capture in OverlayExtension** — `captureScreenshot` is a module-level function imported directly, so it can't be mocked without vi.mock or restructuring.

## Architecture Changes

### 1. Make screenshot capture injectable into OverlayExtension

`OverlayExtension` currently calls the top-level `captureScreenshot()` function. Instead, accept a `screenshotCapture` function in the init:

```typescript
export interface OverlayExtensionInit {
    page: Page;
    positioning: InteractionPositioning;
    maxIterations?: number;
    width?: number;
    maxHeight?: number;
    /** Custom screenshot capture function (defaults to captureScreenshot from ../screenshot) */
    captureScreenshot?: ScreenshotCaptureFn;
}

export type ScreenshotCaptureFn = (
    page: Page,
    options?: {
        debug?: boolean;
        positioning: InteractionPositioning;
        cursorHistory?: NormalizedCursorActionHistoryEntry[];
        maxHistoryEntries?: number;
    },
) => Promise<string>;
```

In the extension, use `this.captureScreenshot ?? importedCaptureScreenshot`. This way production code passes nothing (uses the real function), and tests inject a stub that returns a fixed base64 string.

### 2. Provide a FakePage utility for tests

Create a reusable `FakePage` that satisfies the `Page` interface enough for the overlay and tool tests. It tracks:

- Viewport changes (`setViewport` calls)
- Click positions
- Whether `waitForNetworkIdle` was called

```typescript
// test/helpers/fake-page.ts
export function createFakePage(overrides?: Partial<FakePageOptions>): Page {
    // Returns a Page mock that:
    // - viewport() returns the last setViewport() call's values
    // - screenshot() returns a fixed 1x1 PNG base64
    // - waitForNetworkIdle() resolves immediately
    // - mouse.click() records coordinates
    // - evaluate() returns reasonable defaults (scroll position, body dimensions)
}
```

This is a simple mock object, not a full browser. Tools like `ClickTool` call `page.mouse.click()` and `page.screenshot()` — the fake page records these without error.

### 3. Testable summarizer pattern (already exists)

The existing `TestableFullOcrSummarizerV2` pattern works well. Generalize it:

```typescript
// test/helpers/testable-summarizer.ts

export interface MockResponse {
    text?: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    stopReason?: StopReason;
}

export function createMockResponse(response: MockResponse): AssistantMessage;
export function createMockUsage(): Usage;
```

Create a `TestableSummarizeOcrSummarizerV2` (or whichever mode you want to test) that:
- Accepts a `MockResponse[]` queue
- Overrides `complete()` to dequeue and return responses
- Exposes `getCallLog()` for assertions on what contexts were sent to the model

### 4. Wire it together in OcrBase

`OcrBase.complete()` is already a method, so subclassing works. The only change needed is in `OcrBase` (or `OcrSummarizerBase`) to make the overlay extension's screenshot capture injectable. Since the overlay extension is created in `OcrBase`'s constructor, we can pass through a config option:

```typescript
interface OcrConfig {
    // ... existing fields ...
    overlay?: Partial<OverlayConfig> & {
        /** Custom screenshot capture for overlay handling (testing only) */
        captureScreenshot?: ScreenshotCaptureFn;
    };
}
```

Then `OcrBase` passes it to `new OverlayExtension({ ..., captureScreenshot: config.overlay?.captureScreenshot })`.

## Files to Create/Change

| File | Change |
|------|--------|
| `summarizers/ocr/extensions/overlay.ts` | Accept optional `captureScreenshot` in init |
| `summarizers/ocr/screenshot.ts` | Export the `ScreenshotCaptureFn` type signature |
| `summarizers/ocr/ocr.ts` | Pass `captureScreenshot` from config to `OverlayExtension` |
| `summarizers/ocr/ocr-summarizer-base.ts` | Add `captureScreenshot` to `OcrSummarizerConfig.overlay` |
| `test/helpers/fake-page.ts` | New — reusable fake Page implementation |
| `test/helpers/mock-responses.ts` | New — response builders and mock usage |
| `test/helpers/testable-summarizer.ts` | New — testable subclass with response queue |
| `test/summarizers/ocr/extensions/overlay.test.ts` | New — overlay integration tests |

## Test Scenarios

All scenarios use `SummarizeOcrSummarizerV2` (has click + screenshot tools) or `ExploreOcrSummarizerV2` (has all tools).

### Happy path: dismiss cookie banner

```
Round 1: Model sees cookie banner in screenshot → calls dismiss-overlay(description="cookie banner")
         → OverlayExtension enters handling mode, returns screenshot + instructions
Round 2: Model clicks "Accept All" → click tool executes
Round 3: Model calls dismiss-overlay(status="success", message="Cookie banner dismissed")
         → OverlayExtension exits handling mode, restores viewport

Assert:
- overlayExtension.getResult() == { success: true, message: "Cookie banner dismissed" }
- Complete was called 4 times (initial + dismiss-overlay + click + status report + final summary)
- Viewport was set to overlay dimensions then restored
- Final summary is returned
```

### Failure path: captcha cannot be solved

```
Round 1: Model sees captcha → calls dismiss-overlay(description="reCAPTCHA")
Round 2: Model clicks checkbox → click tool executes
Round 3: Model clicks again → click tool executes  
Round 4: Model calls dismiss-overlay(status="failure", message="Captcha requires image selection")

Assert:
- overlayExtension.getResult() == { success: false, message: "Captcha requires image selection" }
- isError flag on the dismiss-overlay result
- Summarizer continues to final summary despite overlay failure
```

### Verification page: model waits it out

```
Round 1: Model sees Cloudflare check → calls dismiss-overlay(description="Cloudflare verification")
Round 2: Model calls wait(seconds=3)
Round 3: Model calls wait(seconds=3)
Round 4: Model sees main page → calls dismiss-overlay(status="success")

Assert:
- overlayExtension.getResult().success == true
- Two wait tool calls were made
- Viewport restored after success
```

### Max iterations exceeded

```
Round 1: Model calls dismiss-overlay()
Rounds 2-21: Model keeps clicking but never reports status
Round 22: onBeforeCompletion injects "Maximum overlay handling rounds reached"

Assert:
- overlayExtension.getResult().success == false
- overlayExtension.getResult().message contains "20 rounds"
- Model receives the max-rounds message in onBeforeCompletion
```

### No overlay: normal flow continues

```
Round 1: Model sees normal page → no dismiss-overlay call → scrolls
Round 2: Model provides summary

Assert:
- overlayExtension.getResult() == null
- overlayExtension.isInHandlingMode() == false
- Normal summary produced
```

### Prompt inspection: verify system prompt contains overlay handling section

```
Create a SummarizeOcrSummarizerV2 with overlay enabled.
Assert getSystemPrompt() contains "OVERLAY HANDLING"
Assert getSystemPrompt() contains "dismiss-overlay"
Assert tool definitions include dismiss-overlay with status parameter
```

### Prompt inspection: verify tool result content on enter handling mode

```
Mock a dismiss-overlay call without status.
Capture the ToolResultMessage returned by onToolCall.
Assert:
- content includes image (screenshot)
- content includes text with "Use your normal tools"
- isError == false
```

### Prompt inspection: verify tool result content on success

```
Mock a dismiss-overlay call with status="success", message="done".
Capture the ToolResultMessage.
Assert:
- content includes image placeholder (mimeType "image/png+raw")
- content includes text "Overlay dismissed: done"
- isError == false
```

### Reminder injection at round 5

```
Round 1: Model calls dismiss-overlay()
Rounds 2-5: Model clicks/interacts
Round 5: onBeforeCompletion injects reminder message (roundsSpent >= 5 && roundsSpent % 3 === 0)

Assert:
- At round 5 (or later), messages contain "still handling an overlay"
```

## Implementation Order

1. Extract `ScreenshotCaptureFn` type, make `OverlayExtension` accept optional override
2. Thread `captureScreenshot` through config to `OcrBase` → `OverlayExtension`
3. Create `test/helpers/fake-page.ts`
4. Create `test/helpers/mock-responses.ts` (extract from `full-integration.test.ts`)
5. Create `test/helpers/testable-summarizer.ts`
6. Create `test/summarizers/ocr/extensions/overlay.test.ts` with all scenarios
7. Run tests, iterate
