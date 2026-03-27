# Tools Overview

## Quick Reference

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `cursor` | Hover to inspect | `x`, `y`, `description?` |
| `click` | Click elements | `x?`, `y?`, `text?`, `exact?` |
| `scroll` | Scroll page | `direction?`, `to?`, `amount?` |
| `screenshot` | Capture viewport | `debug?` |
| `find` | Find elements | `role?`, `label?`, `text?`, `multiple?` |
| `navigate` | Go to URL | `url?`, `delta?` |
| `type` | Type in inputs | `text`, `description?`, `submit?` |
| `keyboard` | Send keys | `key`, `modifiers?`, `repeat?` |
| `wait` | Wait | `seconds?` |
| `checkpoint` | Save progress | `title`, `content` |
| `zoom` | Zoom area | `x`, `y`, `width`, `height`, `level` |

## Tool Execution Flow

```
Model → ToolCall
  │
  ▼
dispatchOnToolCall()
  ├─ Extensions can intercept (return result)
  └─ If not intercepted:
      ├─ validateToolCall()
      ├─ find tool by name
      └─ tool.execute(context, args)
  │
  ▼
dispatchOnToolResult()
  └─ Extensions can modify result
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

// 2. Define params
const Params = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
});

// 3. Create tool
export class MyTool extends OcrTool<MyToolContext> {
    constructor(ctx: MyToolContext) {
        super({
            name: "my-tool",
            description: "Do something",
            promptSnippet: "my-tool - do something",
            parameters: Params,
        }, ctx);
    }

    async execute(ctx, args): Promise<ToolResultMessage> {
        // Validate
        if (args.x < 0) {
            return this.simpleTextFailureMessage(ctx, "x must be positive");
        }

        // Execute
        await this.ctx.page.mouse.click(args.x, args.y);
        await this.waitForNetworkIdleAfterInteraction(ctx);

        // Return result
        return this.screenshotPlaceholderSuccessMessage(
            ctx,
            `Clicked at (${args.x}, ${args.y})`
        );
    }
}
```

## Key Methods

| Method | Returns | Use |
|--------|---------|-----|
| `simpleTextSuccessMessage(ctx, msg)` | ToolResultMessage | Simple success |
| `simpleTextFailureMessage(ctx, msg)` | ToolResultMessage | Simple failure |
| `screenshotPlaceholderSuccessMessage(ctx, msg)` | ToolResultMessage | Page changed (placeholder filled by extension) |

## Coordinate Systems

**Absolute** (pixels):
- Range: `0` to `viewport.width/height`
- Example: `click(x=150, y=300)`

**Relative** (0.0-1.0 scaled):
- Range: `0.0` to `positioning.x/y`
- Example: `click(x=0.5, y=0.5)` for center

Tools auto-convert based on config.

## Error Handling

```typescript
try {
    await this.ctx.page.click(selector);
} catch (e) {
    if (e instanceof TimeoutError) {
        return this.simpleTextFailureMessage(ctx, "Timeout");
    }
    if (e instanceof ProtocolError) {
        return this.simpleTextFailureMessage(ctx, `Browser error: ${e.message}`);
    }
    throw e; // Unexpected errors
}
```

## Screenshot Placeholders

Tools that change the page return placeholders:

```typescript
// Tool returns:
{
    role: "toolResult",
    content: [
        { type: "image", data: "", mimeType: "image/png+raw" }, // Placeholder
        { type: "text", text: "Clicked at (100, 200)" },
    ]
}

// ScreenshotExtension.onToolResult fills the placeholder:
{
    content: [
        { type: "image", data: "base64...", mimeType: "image/png+raw" }, // Real image
        { type: "text", text: "Clicked at (100, 200)" },
    ]
}
```

## Navigation Tracking

Tools that navigate register with NavigationExtension:

```typescript
constructor(ctx: ClickToolContext) {
    ctx.navigationExtension.registerNavigationTool("click");
    // ...
}
```

## Prompt Guidelines

Each tool provides guidelines for the model:

```typescript
promptGuidelines:
    "## click tool\n" +
    "- Three ways to click:\n" +
    "  1. Coordinates: click(x=100, y=200)\n" +
    "  2. Text: click(text='Submit')\n" +
    "  3. Cursor: click() after cursor tool\n" +
    "- Use exact=true for precise matching\n" +
    "- Check if page changed after click"
```
