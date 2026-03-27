# Screenshot System

## Overview

Screenshots are captured at key points and used for:
- Initial page state (before interaction)
- Tool results (click, scroll, type)
- Debug mode (coordinate grid overlay)
- Overlay detection (captchas, modals)

## Screenshot Flow

```
[INITIAL]
  └─ takeScreenshot() → Base64 image → Initial message

[TOOL EXECUTION]
  ├─ Before: capture screenshot (for change detection)
  ├─ Execute action (click, scroll, etc.)
  ├─ After: capture screenshot
  ├─ Compare: if different → return placeholder
  └─ ScreenshotExtension.onToolResult() → Fill placeholder

[DEBUG MODE]
  └─ takeScreenshot(debug=true) → Add coordinate grid overlay
```

## Screenshot Types

### Raw Screenshot
```typescript
{
    type: "image",
    data: "base64...",
    mimeType: "image/png+raw"
}
```

### Debug Screenshot
```typescript
{
    type: "image",
    data: "base64...",
    mimeType: "image/png+debug"  // Includes coordinate grid
}
```

## ScreenshotResult

```typescript
{
    data: string;              // Base64 image
    width: number;             // Viewport width
    height: number;            // Viewport height
    devicePixelRatio: number;  // Screen DPI
    mimeType: string;          // "image/png+raw" or "image/png+debug"
}
```

## Overlay Detection

Fixed viewport for overlay detection:
```typescript
OVERLAY_VIEWPORT_WIDTH = 1280;
OVERLAY_VIEWPORT_HEIGHT = 800;
```

OverlayExtension uses this to detect captchas/modals and intercept tool calls.

## ScreenshotExtension

Fills placeholders after tool execution:

```typescript
class ScreenshotExtension extends OcrExtension {
    async onToolResult(ctx, toolCall, result) {
        // Find placeholder images
        const placeholderIndex = result.content.findIndex(
            c => c.type === "image" && c.mimeType?.includes("png+")
        );

        if (placeholderIndex >= 0) {
            // Capture actual screenshot
            const screenshot = await this.page.screenshot({
                encoding: "base64"
            });

            // Replace placeholder
            result.content[placeholderIndex] = {
                type: "image",
                data: screenshot,
                mimeType: result.content[placeholderIndex].mimeType
            };
        }
    }
}
```

## Key Functions

| Function | Purpose |
|----------|---------|
| `takeScreenshot(page, options)` | Capture viewport |
| `captureScreenshot(ctx)` | Wrapper with context |
| `screenshotPlaceholderSuccessMessage()` | Create placeholder result |
| `fillScreenshotPlaceholders(content)` | Replace placeholders |

## Configuration

```typescript
{
    screenshotWidth: 720;        // Viewport width
    screenshotMaxHeight: 3000;   // Max viewport height
}
```

## Common Patterns

**Detect page change:**
```typescript
const before = await page.screenshot({ encoding: "base64" });
await page.click(selector);
const after = await page.screenshot({ encoding: "base64" });

if (before === after) {
    return failure("Page did not change");
}
```

**Add debug overlay:**
```typescript
const screenshot = await takeScreenshot(page, {
    width: 720,
    maxHeight: 3000,
    debug: true  // Adds coordinate grid
});
```

**Fill placeholder:**
```typescript
result.content = result.content.map(c =>
    c.isPlaceholder ? { ...c, data: actualScreenshot } : c
);
```

## Key Files

| File | Purpose |
|------|---------|
| `screenshot.ts` | takeScreenshot, overlay detection |
| `extensions/screenshot.ts` | ScreenshotExtension |
| `tools/screenshot_tool.ts` | ScreenshotTool implementation |
