# Screenshot System

## Overview

Screenshots are captured at key points and used for:

- Initial page state (before interaction)
- Tool results (click, scroll, type) via placeholder mechanism
- Debug mode (coordinate grid overlay with cursor history)
- Overlay detection (captchas, modals)

## Screenshot Flow

```
[INITIAL]
  └─ takeScreenshot() → Base64 image → Initial user message

[TOOL EXECUTION]
  ├─ Tool returns placeholder (empty data, mimeType "image/png+raw" or "image/png+debug")
  ├─ ScreenshotExtension.onToolResult() → Detects placeholder, captures screenshot
  └─ ScreenshotExtension.onBeforeCompletion() → Fills user message placeholders

[DEBUG MODE]
  └─ captureScreenshot(debug=true) → takeScreenshot() + addCoordinateGrid()
```

## Screenshot Types

### Placeholder (returned by tools)

```typescript
{
    type: "image",
    data: "",                    // Empty data signals placeholder
    mimeType: "image/png+raw"    // "image/png+raw" or "image/png+debug"
}
```

### Filled (after ScreenshotExtension processes)

```typescript
{
    type: "image",
    data: "base64...",           // Actual screenshot data
    mimeType: "image/png"        // Base MIME type (addition stripped)
}
```

## ScreenshotResult

```typescript
interface ScreenshotResult {
    data: string; // Base64 image
    width: number; // Actual width in pixels (accounting for DPR)
    height: number; // Actual height in pixels (accounting for DPR)
    devicePixelRatio: number; // Screen DPR
    mimeType: string; // "image/png"
}
```

## Viewport Dimensions

The viewport is configured via `OcrSummarizerConfig`:

```typescript
// Default values from buildOcrConfig():
width: 1280,      // Viewport width
maxHeight: 800,   // Max viewport height

// Set in OcrBase.run():
await page.setViewport({ width: config.width, height: config.maxHeight });
```

Overlay handling uses a fixed viewport:

```typescript
OVERLAY_VIEWPORT_WIDTH = 1280;
OVERLAY_VIEWPORT_HEIGHT = 800;
```

## ScreenshotExtension

Fills placeholders after tool execution and before API calls:

```typescript
class ScreenshotExtension extends OcrExtension {
    readonly name = "screenshot";

    async onToolResult(ctx, toolCall, result) {
        // Process tool result content - find and fill placeholders
        for (const part of result.content) {
            if (part.type !== "image" || part.data !== "") continue;

            const match = part.mimeType?.match(/^image\/(png)\+(raw|debug)$/);
            if (!match) continue;

            // Capture screenshot with or without debug overlay
            const screenshotData = await captureScreenshot(this.page, {
                debug: match[2] === "debug",
                positioning: this.positioning,
                cursorHistory: await this.cursorExtension?.getRecentHistory(5),
            });

            part.data = screenshotData;
            part.mimeType = match[1]; // "image/png"
        }
    }

    async onBeforeCompletion(ctx, messages) {
        // Process user message placeholders (same logic)
        for (const msg of messages) {
            if (msg.role !== "user" || typeof msg.content === "string") continue;
            // ... same placeholder filling logic
        }
    }
}
```

## Key Functions

| Function                                   | Location        | Purpose                                          |
| ------------------------------------------ | --------------- | ------------------------------------------------ |
| `takeScreenshot(page, options?)`           | `screenshot.ts` | Capture viewport screenshot                      |
| `captureScreenshot(page, options?)`        | `screenshot.ts` | Wrapper: screenshot + optional debug overlay     |
| `addCoordinateGrid(base64, w, h, options)` | `screenshot.ts` | Draw coordinate grid overlay with cursor history |

### takeScreenshot

```typescript
async function takeScreenshot(page: Page, options?: ScreenshotOptions): Promise<ScreenshotResult>;
```

Captures the current viewport as a base64 PNG. Returns dimensions accounting for device pixel ratio.

### captureScreenshot

```typescript
async function captureScreenshot(
    page: Page,
    options?: {
        debug?: boolean;
        positioning: InteractionPositioning;
        cursorHistory?: NormalizedCursorActionHistoryEntry[];
        maxHistoryEntries?: number;
    },
): Promise<string>;
```

Takes a screenshot and optionally adds a debug coordinate grid overlay. Returns base64 data only (not `ScreenshotResult`).

### addCoordinateGrid

```typescript
async function addCoordinateGrid(
    base64Data: string,
    width: number,
    height: number,
    options: GridOverlayOptions,
): Promise<string>;
```

Draws an SVG coordinate grid over the screenshot using `sharp`. Features:

- Major grid lines at 25% intervals (dashed, 0.5 opacity)
- Minor grid lines at 12.5% intervals (dashed, 0.2 opacity)
- Corner coordinate labels (in positioning system units)
- Axis labels (pixel values for absolute, range values for relative)
- Cursor action history markers (up to 5 recent, colored by recency)

## Placeholder Mechanism

Tools use `screenshotPlaceholderSuccessMessage()` to return placeholders:

```typescript
// In OcrTool base class:
protected screenshotPlaceholderSuccessMessage(
    context: OcrToolExecutionContext,
    message: string,
    addition: "raw" | "debug" = "raw"
): ToolResultMessage {
    const result = this.simpleTextSuccessMessage(context, message);
    result.content.unshift({
        type: "image",
        data: "",                       // Empty = placeholder
        mimeType: `image/png+${addition}`,
    });
    return result;
}
```

The `ScreenshotExtension` detects these placeholders by checking:

1. `part.type === "image"`
2. `part.data === ""` (empty data)
3. `part.mimeType` matches `image/png+(raw|debug)`

## Configuration

```typescript
// From OcrSummarizerConfig / OcrConfig
{
    width: 1280; // Viewport width (default from buildOcrConfig)
    maxHeight: 800; // Max viewport height (default from buildOcrConfig)
}
```

The `DebugExtension` uses additional config from environment variables:

- `PI_WEB_SEARCH_DEBUG` - Enable debug logging
- `PI_WEB_SEARCH_DEBUG_SCREENSHOTS` - Save debug screenshots
- `PI_WEB_SEARCH_DEBUG_DIR` - Output directory (default: "debug")

## Key Files

| File                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `screenshot.ts`            | takeScreenshot, captureScreenshot, addCoordinateGrid, viewport constants |
| `extensions/screenshot.ts` | ScreenshotExtension (placeholder filling)                                |
| `extensions/debug.ts`      | DebugExtension (screenshot saving, conversation logging)                 |
| `tools/screenshot.ts`      | ScreenshotTool (model-facing screenshot tool)                            |
