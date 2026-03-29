# Tools Overview

## Quick Reference

| Tool              | Purpose          | Key Parameters                                |
| ----------------- | ---------------- | --------------------------------------------- |
| `cursor`          | Hover to inspect | `x`, `y`, `description?`                      |
| `click`           | Click elements   | `x?`, `y?`, `text?`, `exact?`, `description?` |
| `scroll`          | Scroll page      | `direction?`, `to?`, `mode?`                  |
| `screenshot`      | Capture viewport | `debug?`                                      |
| `find`            | Find elements    | `role?`, `label?`, `text?`, `multiple?`       |
| `navigate`        | Go to URL        | `url?`, `delta?`                              |
| `type`            | Type in inputs   | `text`, `description?`, `submit?`             |
| `keyboard`        | Send keys        | `key`, `modifiers?`, `repeat?`                |
| `wait`            | Wait             | `seconds?`                                    |
| `checkpoint`      | Save progress    | `title`, `content`                            |
| `zoom`            | Zoom area        | `x`, `y`, `width`, `height`, `level`          |
| `dismiss-overlay` | Dismiss overlays | `description?`                                 |

## Tool Availability by Mode

| Tool              | Full | Summarize | Explore |
| ----------------- | ---- | --------- | ------- |
| `scroll`          | x    | x         | x       |
| `cursor`          |      | x         | x       |
| `click`           |      | x         | x       |
| `screenshot`      |      | x         | x       |
| `find`            |      |           | x       |
| `navigate`        |      |           | x       |
| `type`            |      |           | x       |
| `keyboard`        |      |           | x       |
| `wait`            |      |           | x       |
| `checkpoint`      |      |           | x       |
| `zoom`            |      |           | x       |
| `dismiss-overlay` | x\*  | x\*       | x\*     |

\* `dismiss-overlay` is registered by `OcrBase` when overlay handling is enabled, regardless of mode. It is conditionally added to the tool list when the model is in overlay handling mode.

## Tool Execution Flow

```
Model → ToolCall
  │
  ▼
dispatchOnToolCall()
  ├─ Extensions can intercept (return ToolResultMessage)
  │   ├─ OverlayExtension: intercepts dismiss-overlay
  │   └─ CheckpointExtension: blocks tools during compression
  └─ If not intercepted:
      ├─ validateToolCall() (via pi-ai)
      ├─ Find tool by name
      └─ tool.execute(context, args)
  │
  ▼
dispatchOnToolResult()
  ├─ ScreenshotExtension: fill placeholder images
  ├─ NavigationExtension: detect URL change, append nav info
  └─ DebugExtension: save debug screenshots
  │
  ▼
dispatchOnToolResultsComplete()
  └─ CheckpointExtension: log checkpoint usage
  │
  ▼
Add to messages → Model continues
```

## Tool Implementation Pattern

```typescript
// 1. Define context
interface MyToolContext {
    page: Page;
    config: InteractionConfig;
    cursorExtension: CursorExtension;
}

// 2. Create tool
export class MyTool extends OcrTool<MyToolContext> {
    constructor(ctx: MyToolContext) {
        super(
            {
                name: "my-tool",
                description: "Do something",
                promptSnippet: "my-tool - do something",
                promptGuidelines: "## my-tool tool\n- Usage instructions...",
                parameters: Type.Object({
                    x: Type.Number(),
                    y: Type.Number(),
                }),
            },
            ctx,
        );
    }

    async execute(ctx, args): Promise<ToolResultMessage> {
        // Validate
        if (args.x < 0) {
            throw new OcrToolValidationError("x must be positive");
        }

        // Execute
        await this.ctx.page.mouse.click(args.x, args.y);
        await this.waitForNetworkIdleAfterInteraction(ctx);

        // Return result with screenshot placeholder
        return this.screenshotPlaceholderSuccessMessage(ctx, `Clicked at (${args.x}, ${args.y})`);
    }
}
```

## Key Methods

| Method                                                    | Returns           | Use                                                      |
| --------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `simpleTextSuccessMessage(ctx, msg)`                      | ToolResultMessage | Simple success (no screenshot)                           |
| `simpleTextFailureMessage(ctx, msg)`                      | ToolResultMessage | Simple failure                                           |
| `screenshotPlaceholderSuccessMessage(ctx, msg, addition)` | ToolResultMessage | Page changed (placeholder filled by ScreenshotExtension) |
| `waitForNetworkIdleAfterInteraction(ctx, delay?)`         | void              | Wait for network idle after actions                      |

## Coordinate Systems

Tools use the `InteractionPositioning` system defined in the summarizer config:

**Absolute** (pixels):

```typescript
{
    type: "absolute";
}
```

- Coordinates: `0` to `viewport.width/height`

**Relative** (configurable range):

```typescript
{ type: "relative", x: 1000, y: 1000 }
```

- Coordinates: `0` to `positioning.x/y`
- Example: `click(x=500, y=500)` for center of a 1000x1000 system
- Scales to viewport: `x * viewport.width / positioning.x`

The default positioning used by `ocr-v2.ts` is `{ type: "relative", x: 1000, y: 1000 }`.

## Error Handling

Tools handle errors at two levels:

1. **Validation errors** - throw `OcrToolValidationError`:

    ```typescript
    throw new OcrToolValidationError("x must be positive");
    ```

    These are caught by `executeOcrToolCall()` and returned as error tool results.

2. **Browser errors** - caught by `executeOcrToolCall()`:
    - `ProtocolError` → "Browser error: ..."
    - `TimeoutError` → "Browser timeout: ..."
    - Unknown errors → re-thrown (crashes the run)

## Screenshot Placeholders

Tools that change the page return placeholders:

```typescript
// Tool returns:
{
    role: "toolResult",
    toolCallId: "...",
    toolName: "my-tool",
    content: [
        { type: "image", data: "", mimeType: "image/png+raw" }, // Placeholder (empty data)
        { type: "text", text: "Clicked at (100, 200)" },
    ],
    isError: false,
    timestamp: Date.now(),
}

// ScreenshotExtension.onToolResult fills the placeholder:
// - Detects images with empty data and "image/png+raw" or "image/png+debug" MIME type
// - Captures actual screenshot (with optional debug coordinate grid)
// - Updates part.data with real screenshot, part.mimeType with "image/png"
```

## Navigation Tracking

Tools that can cause navigation register with `NavigationExtension`:

```typescript
// In OcrBase constructor, tools pass navigationExtension:
new ClickTool({
    ...
    navigationExtension: this.navigationExtension,
});

// NavigationExtension tracks these tool names: click, keyboard, type
// Additional tools can be registered:
navigationExtension.registerNavigationTool("my-tool");
```

When navigation is detected (URL change), `NavigationExtension`:

1. Records the page history entry
2. Appends navigation info to the tool result text
3. Fires registered callbacks

## dismiss-overlay Tool

This tool is special — it exists as two separate tool classes that share the same name (`dismiss-overlay`). Only one is present in the tool list at a time, controlled by `OverlayExtension`'s `onFilterTools`/`onFilterExecutionTools` hooks:

**`DismissOverlayTool`** (idle mode):
- Parameters: `description?`
- Visible in the main conversation
- Calling it enters overlay handling mode

**`ReportOverlayResultTool`** (handling mode):
- Parameters: `status` (required), `message?`
- Only visible during overlay handling mode
- Calling it exits handling mode with the reported result

Both tools' `execute()` methods throw errors because they're always intercepted by `OverlayExtension.onToolCall`. The tool definitions exist only to:

1. Register the tool schema so the model knows about it
2. Provide `promptSnippet` and `promptGuidelines` for the system prompt

This two-variant approach prevents the model from calling with `status` outside handling mode — the parameter doesn't exist in the schema it sees.

## Prompt Guidelines

Each tool provides guidelines for the model:

```typescript
promptGuidelines: "## click tool\n" +
    "- Three ways to click:\n" +
    "  1. Coordinates: click(x=100, y=200)\n" +
    "  2. Text: click(text='Submit')\n" +
    "  3. Cursor: click() after cursor tool\n" +
    "- Use exact=true for precise matching\n" +
    "- Check if page changed after click";
```

These are collected by `OcrBase.getToolGuidelines()` and injected into the system prompt via Eta templates.
