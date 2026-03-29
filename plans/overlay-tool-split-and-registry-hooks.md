# Overlay Tool Split & Extension Tool Registry Hooks

## Problem

Two interrelated issues with the current overlay extension takeover:

### 1. Single tool schema with dual purpose

`DismissOverlayTool` exposes optional `status`/`message` parameters alongside `description`. The model sees all three fields at all times. Outside handling mode, the model can call `dismiss-overlay(status='success')` directly — it has no way to know this is invalid. When it does, `handleStatusReport` calls `exitHandlingMode` → `popMessages`, which throws `"Cannot pop messages: stack is empty"` because the model never went through `enterHandlingMode`.

The root cause: the tool schema conflates two operations (enter handling, report result) into one tool definition. The model should only see the schema relevant to the current mode.

### 2. Encapsulation violation in OcrBase

`OcrBase` reaches into overlay extension internals in two places:

```ts
// ocr.ts — processToolCalls
const allTools = [...this.tools];
if (this.overlayExtension && extCtx.state.overlay.mode === "handling") {
    allTools.push(...this.overlayExtension.getHandlingTools());
}

// ocr.ts — buildContext
const extensionTools: OcrTool<any>[] = [];
if (this.overlayExtension && extCtx.state.overlay.mode === "handling") {
    extensionTools.push(...this.overlayExtension.getHandlingTools());
}
```

`OcrBase` knows about overlay state (`mode === "handling"`) and calls overlay-specific methods (`getHandlingTools()`). No other extension gets this treatment. If a second extension needed to contribute or modify tools, `OcrBase` would need more hardcoded branches.

---

## Solution

### Part A: Split `dismiss-overlay` into two tool schemas

| Tool | Name | Parameters | When visible |
|------|------|------------|-------------|
| `DismissOverlayTool` | `dismiss-overlay` | `description?` | Main conversation (idle mode) |
| `ReportOverlayResultTool` | `dismiss-overlay` | `status`, `message?` | Handling mode only |

Both use the same tool name (`dismiss-overlay`). Only one is present in the tool list at a time. The schema itself prevents misuse — the model cannot call with `status` outside handling mode because the parameter doesn't exist in the schema it sees.

### Part B: Registry hooks for tool contribution

Add two new hooks to `OcrExtensionHooks` and dispatch methods to `OcrExtensionRegistry`:

1. **`onFilterTools(ctx, tools)`** — Called before building the API context. Extensions can remove, replace, or add tools. Returns the modified tool list.
2. **`onFilterExecutionTools(ctx, tools)`** — Called before executing tool calls. Same signature but operates on `OcrTool[]` (with `execute()`), not just tool definitions.

This replaces the hardcoded overlay checks in `OcrBase`. The `OverlayExtension` manages its own tool swaps through these hooks. Any future extension can do the same without `OcrBase` changes.

---

## Implementation Plan

### Step 1: Add registry hooks

**File: `extensions/base.ts`**

Add two new optional hooks to `OcrExtensionHooks`:

```ts
/**
 * Called before building the API context (tool definitions sent to the model).
 * Extensions can filter, replace, or add tool definitions.
 * Receives the current tool definition list, returns the modified list.
 */
onFilterTools?(ctx: OcrExtensionExecutionContext<TState>, tools: Tool[]): Promise<Tool[]>;

/**
 * Called before executing tool calls (tools with execute()).
 * Extensions can filter, replace, or add executable tools.
 * Receives the current tool list, returns the modified list.
 */
onFilterExecutionTools?(ctx: OcrExtensionExecutionContext<TState>, tools: OcrTool<any>[]): Promise<OcrTool<any>[]>;
```

Add default no-op implementations to `OcrExtension` base class:

```ts
onFilterTools?(_ctx: OcrExtensionExecutionContext<TState>, tools: Tool[]): Promise<Tool[]> {
    return Promise.resolve(tools);
}
onFilterExecutionTools?(_ctx: OcrExtensionExecutionContext<TState>, tools: OcrTool<any>[]): Promise<OcrTool<any>[]> {
    return Promise.resolve(tools);
}
```

**File: `extensions/registry.ts`**

Add dispatch methods:

```ts
async dispatchOnFilterTools(ctx: OcrExtensionExecutionContext<TState>, tools: Tool[]): Promise<Tool[]> {
    let filtered = tools;
    for (const ext of this.extensions) {
        if (ext.onFilterTools) {
            filtered = await ext.onFilterTools(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, filtered);
        }
    }
    return filtered;
}

async dispatchOnFilterExecutionTools(ctx: OcrExtensionExecutionContext<TState>, tools: OcrTool<any>[]): Promise<OcrTool<any>[]> {
    let filtered = tools;
    for (const ext of this.extensions) {
        if (ext.onFilterExecutionTools) {
            filtered = await ext.onFilterExecutionTools(ctx as OcrExtensionExecutionContext<OcrBaseStateInterface>, filtered);
        }
    }
    return filtered;
}
```

### Step 2: Create `ReportOverlayResultTool`

**File: `tools/report-overlay-result.ts`** (new)

```ts
export class ReportOverlayResultTool extends OcrTool<Record<string, never>> {
    constructor() {
        super({
            name: "dismiss-overlay",
            description:
                "Report the result of overlay handling. " +
                "Call with status='success' when the overlay is gone. " +
                "Call with status='failure' if it cannot be dismissed.",
            parameters: Type.Object({
                status: Type.Union([Type.Literal("success"), Type.Literal("failure")], {
                    description: "Report whether the overlay was dismissed.",
                }),
                message: Type.Optional(Type.String({
                    description: "Explanation of the result",
                })),
            }),
            promptSnippet: "dismiss-overlay - Report overlay handling result (success/failure).",
            promptGuidelines:
                "## dismiss-overlay tool\n" +
                "- Call with status='success' when the overlay is gone and main content is visible\n" +
                "- Call with status='failure' if the overlay cannot be dismissed\n" +
                "- Always include a message explaining what happened",
        }, {});
    }

    async execute(): Promise<never> {
        throw new Error("report-overlay-result tool was not intercepted by OverlayExtension");
    }
}
```

### Step 3: Update `DismissOverlayTool`

**File: `tools/dismiss-overlay.ts`**

Remove `status` and `message` parameters. Update description, snippet, and guidelines to only describe entering handling mode:

```ts
parameters: Type.Object({
    description: Type.Optional(Type.String({
        description: "Description of the overlay you see",
    })),
}),
```

### Step 4: Update `OverlayExtension` to use registry hooks

**File: `extensions/overlay.ts`**

1. Add `ReportOverlayResultTool` to `handlingTools` (replacing the implicit reliance on the main `DismissOverlayTool`).

2. Implement `onFilterTools` — during handling mode, remove the normal `dismiss-overlay` tool and ensure the report variant is present:

```ts
async onFilterTools(ctx: OcrExtensionExecutionContext, tools: Tool[]): Promise<Tool[]> {
    if (ctx.state.overlay.mode !== "handling") return tools;
    // Remove normal dismiss-overlay, let handling tools (including report variant) through
    return [
        ...tools.filter(t => t.name !== "dismiss-overlay"),
        ...this.handlingTools.map(t => t.tool),
    ];
}
```

3. Implement `onFilterExecutionTools` — same swap logic for executable tools:

```ts
async onFilterExecutionTools(ctx: OcrExtensionExecutionContext, tools: OcrTool<any>[]): Promise<OcrTool<any>[]> {
    if (ctx.state.overlay.mode !== "handling") return tools;
    return [
        ...tools.filter(t => t.tool.name !== "dismiss-overlay"),
        ...this.handlingTools,
    ];
}
```

4. Simplify `onToolCall` — since schemas are now mode-specific, use mode-based dispatch instead of `args.status !== undefined`:

```ts
async onToolCall(ctx: OcrExtensionExecutionContext, toolCall: ToolCall): Promise<ToolResultMessage | undefined> {
    if (toolCall.name !== "dismiss-overlay") return undefined;

    if (ctx.state.overlay.mode === "handling") {
        // Must be the report variant — status is required by schema
        const args = toolCall.arguments as { status: "success" | "failure"; message?: string };
        return this.handleStatusReport(ctx, args);
    }

    // Must be the normal variant — no status in schema
    const args = toolCall.arguments as { description?: string };
    return this.enterHandlingMode(ctx, toolCall, args);
}
```

5. Remove `getHandlingTools()` — no longer needed since `onFilterTools`/`onFilterExecutionTools` handle the swap.

### Step 5: Remove overlay-specific code from `OcrBase`

**File: `ocr.ts`**

1. **`processToolCalls`** — replace hardcoded overlay check with registry dispatch:

```ts
// Before:
const allTools = [...this.tools];
if (this.overlayExtension && extCtx.state.overlay.mode === "handling") {
    allTools.push(...this.overlayExtension.getHandlingTools());
}

// After:
const allTools = await this.registry.dispatchOnFilterExecutionTools(extCtx, [...this.tools]);
```

2. **`buildContext`** — same pattern:

```ts
// Before:
const extensionTools: OcrTool<any>[] = [];
if (this.overlayExtension && extCtx.state.overlay.mode === "handling") {
    extensionTools.push(...this.overlayExtension.getHandlingTools());
}
return {
    systemPrompt: this.getSystemPrompt(),
    messages: extCtx.state.base.messages,
    tools: [...this.tools.map((t) => t.tool), ...extensionTools.map((t) => t.tool)],
};

// After:
const filteredToolDefs = await this.registry.dispatchOnFilterTools(
    extCtx,
    this.tools.map((t) => t.tool),
);
return {
    systemPrompt: this.getSystemPrompt(),
    messages: extCtx.state.base.messages,
    tools: filteredToolDefs,
};
```

3. **Remove** `overlayExtension` field and the `getHandlingTools()` calls. The extension still exists (registered like any other), but `OcrBase` no longer references it directly.

4. **Remove** the `getHandlingTools()` method from `OverlayExtension` — no longer needed.

### Step 6: Update exports

**File: `tools/index.ts`** — export `ReportOverlayResultTool`.

### Step 7: Update documentation

- `docs/agent/extension-lifecycle.md` — add `onFilterTools`/`onFilterExecutionTools` to the hook timeline and common patterns table.
- `docs/agent/tools-overview.md` — update the dismiss-overlay section to describe the two-variant approach.
- `summarizers/ocr/extensions/base.ts` — update `OverlayExtension` docblock if needed.

---

## Files Changed

| File | Change |
|------|--------|
| `extensions/base.ts` | Add `onFilterTools`, `onFilterExecutionTools` hooks + defaults |
| `extensions/registry.ts` | Add `dispatchOnFilterTools`, `dispatchOnFilterExecutionTools` |
| `extensions/overlay.ts` | Implement filter hooks, add `ReportOverlayResultTool` to handling tools, simplify `onToolCall`, remove `getHandlingTools()` |
| `tools/dismiss-overlay.ts` | Remove `status`/`message` params, update prompt text |
| `tools/report-overlay-result.ts` | New file — handling-mode variant with `status`/`message` |
| `tools/index.ts` | Export `ReportOverlayResultTool` |
| `ocr.ts` | Replace overlay-specific code with registry dispatch, remove `overlayExtension` field |
| `docs/agent/extension-lifecycle.md` | Document new hooks |
| `docs/agent/tools-overview.md` | Update dismiss-overlay section |

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Model sees `status` outside handling | Yes | No — field doesn't exist in schema |
| Stack crash from premature `status` call | Possible | Impossible — schema validation rejects it |
| OcrBase knows about overlay internals | Yes — checks `overlay.mode`, calls `getHandlingTools()` | No — registry dispatch is generic |
| Adding tool-modifying extensions | Requires OcrBase changes | Implement `onFilterTools` — no base changes |
| `onToolCall` branching | `args.status !== undefined` heuristic | Clean mode-based dispatch |
| Dead `getHandlingTools()` API | Exists | Removed |
