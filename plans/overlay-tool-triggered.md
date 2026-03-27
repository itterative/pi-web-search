# Overlay Extension: Tool-Triggered Handling

## Problem

The overlay extension runs at `onBeforeRun` (before the main summarizer loop starts). Overlays like cookie banners, Cloudflare challenges, and newsletter popups often appear after the page has partially loaded, so the detection screenshot captures a page without the overlay yet visible. The extension reports "no overlay detected" and the main loop proceeds into an overlay it can't handle.

## Completed Phases

- **Phase 1** — Tool-triggered handling via `onToolCall` interception with internal handling loop
- **Phase 2** — Removed internal loop; model uses its normal tools in "handling mode" activated by dismiss-overlay
- **Phase 3** — Production hardening (message stack, ctx.state, handling tools, handling-guide template)
- **Phase 4** — Bug fixes and robustness (message boundary, cleanup, round budget, re-entry guard)

---

## Phase 3: Production Hardening (Completed)

### Problems (now resolved)

1. **Message pollution** — overlay handling messages accumulated in the main conversation, wasting tokens and confusing the model.
2. **State stored on class instance** — mode, handlingStartRound, and result were on `this` instead of `ctx.state`, not resetting between runs.
3. **Debug log pollution** — every intermediate overlay handling message was logged without clear markers.
4. **Missing tools for minimal summarizers** — `FullOcrSummarizerV2` only has `scroll`, but overlay handling needs `click`, `cursor`, `screenshot`, `wait`.

### Decisions Taken

1. **Generic message stack on `ctx`** — `pushMessages`/`popMessages` with `"push"`/`"pop"` `MessageChange` variants. Not overlay-specific; any extension can use it for sub-conversations.
2. **Debug extension write-position stack** — saves `(fingerprint, index)` on push, restores on pop. Handles sub-conversations generically with no overlay knowledge.
3. **Extension-owned tools** — overlay creates its own `ClickTool`, `CursorTool`, `ScreenshotTool`, `WaitTool` instances. Injected by `OcrBase.buildContext()`/`processToolCalls()` when `mode === "handling"`. Solves the minimal-summarizer problem (`FullOcrSummarizerV2` only has `scroll`).
4. **State on `ctx.state.overlay`** — via `getInitialState()`, three fields: `mode`, `handlingStartRound`, `result`.
5. **Handling guide via `onBeforeCompletion`** — prepended to messages each round. Only affects the sub-conversation (original messages are on the stack).
6. **`OcrExtension.getTools()` unused** — added to base class but `OcrBase` calls `overlayExtension.getHandlingTools()` directly instead.

### Files Changed

| File                                      | Change                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/base.ts`                      | Added `overlay: OverlayState` to `OcrBaseStateInterface`, added `messageStack`/`pushMessages`/`popMessages` to context, added `"push"`/`"pop"` to `MessageChange`, added `getTools()` on base class                                                                 |
| `extensions/overlay.ts`                   | Moved state to `getInitialState()` + `ctx.state.overlay`, uses `pushMessages`/`popMessages`, creates own handling tools, injects handling-guide via `onBeforeCompletion`, removed class instance state                                                              |
| `extensions/debug.ts`                     | Handles push/pop generically in `onMessagesChanged`, maintains `writePositionStack` for correct incremental writing                                                                                                                                                 |
| `extensions/index.ts`                     | Added `createOverlayState` export                                                                                                                                                                                                                                   |
| `ocr.ts`                                  | Reordered extension creation (cursor/navigation before overlay), added extension tools to `buildContext()` and `processToolCalls()`, wired up `messageStack`/`pushMessages`/`popMessages` in `buildExtensionContext()`, added `OverlayState` to `OcrBaseState` type |
| `instructions/overlay/handling-guide.eta` | New template with overlay-specific instructions (tool snippets, guidelines, strategy)                                                                                                                                                                               |

---

## Phase 4: Bug Fixes and Robustness

Review of Phase 3 implementation. Issues 1, 2, and 6 are interrelated — the fix for issue 1 provides the foundation for issues 2 and 6.

### 1. Broken message boundary between main and overlay conversations (Medium)

The message flow across the push/pop boundary is broken in both directions.

**Entry** (model calls `dismiss-overlay` without status):

1. `runRound` pushes the assistant response onto messages: `[..., assistant(dismiss-overlay(id=X))]`
2. `enterHandlingMode` calls `pushMessages()` — saves `[..., assistant(dismiss-overlay(id=X))]` to stack, clears messages
3. `enterHandlingMode` returns `toolResult(id=X, screenshot)` — this lands in the now-empty overlay sub-conversation

Result: the original `dismiss-overlay(id=X)` call is saved in the main conversation, but its tool result ends up in the overlay sub-conversation. They're split across two conversations.

**Exit** (model calls `dismiss-overlay` with status):

1. `handleStatusReport` calls `popMessages()` — restores `[..., assistant(dismiss-overlay(id=X))]`, discards overlay sub-conversation
2. `handleStatusReport` returns `toolResult(id=Y, status message)` using the **status call's** tool call ID
3. This tool result is pushed onto the restored main conversation

Result: main conversation ends up with `[assistant(dismiss-overlay(id=X)), toolResult(id=Y)]` — mismatched IDs, and the model sees a tool result for a call it never made in this conversation.

**Fix**: On exit from handling mode (success, failure, or cleanup), reconstruct a clean boundary in the restored main conversation:

- Save the original `dismiss-overlay` tool call (ID + arguments) in `OverlayState` when entering handling mode
- On `popMessages()`, discard the overlay sub-conversation's tool result entirely (it references IDs from discarded messages)
- Re-inject the saved original tool call + a synthetic tool result using the **original** tool call ID:

```
[..., assistant(dismiss-overlay(description="cookie banner")),
     toolResult(id=original_id, "Overlay dismissed: ...")]
```

This gives the model a complete, coherent tool call → result pair. The main loop's `forceSummary` then works natively because the conversation ends with a normal tool result, not an orphaned one.

Implementation note: since `onToolCall` must return a `ToolResultMessage` (otherwise the tool gets executed normally), the pop + injection should happen inside `handleStatusReport`. The returned `ToolResultMessage` uses the original tool call ID, and the overlay sub-conversation's tool calls/results are all discarded by the pop.

### 2. No cleanup on error or forceSummary (Medium)

`OverlayExtension` doesn't implement `onRoundEnd`, `onComplete`, or `onError`. If the main loop runs out of rounds while in handling mode, `forceSummary()` is called. At that point:

- `buildContext()` sees `mode === "handling"` and injects overlay tools into the API call
- `complete()` calls `onBeforeCompletion` which injects the overlay handling guide
- The forced summary runs with overlay instructions and overlay tools instead of the summarizer's normal context

If an error occurs during handling mode, the messages are left on the stack (not popped). While state is fresh per `run()`, the viewport is never restored to its original dimensions.

**Fix**: Unifies with issue 1. Add a private `exitHandlingMode(ctx, resultMessage)` method that centralizes the cleanup:

1. Pop messages
2. Restore viewport
3. Transition mode to `"done"`
4. Re-inject the original dismiss-overlay call + synthetic tool result (per issue 1 fix)

Call this from:

- `handleStatusReport` (normal exit)
- `onRoundStart` — detect stale handling mode when overlay round budget is exhausted (see issue 6), force-exit with failure
- `onError` — pop + restore viewport on error

This makes `forceSummary` work without changes: by the time the main loop reaches `forceSummary`, handling mode is already cleaned up and the conversation is in a normal state.

### 3. No guard against re-entering handling mode (Low)

If the model calls `dismiss-overlay` without a status while already in handling mode, `enterHandlingMode` pushes messages again, creating a second nesting level. There is no check for `mode === "handling"` before entering.

**Fix**: Guard at the top of `enterHandlingMode`:

```typescript
if (ctx.state.overlay.mode === "handling") {
    return error toolResult: "Already in overlay handling mode. Call dismiss-overlay with a status first."
}
```

### 4. Dead `getTools()` API (Low)

`OcrExtension.getTools()` (base class) and its override in `OverlayExtension` are never called. `OcrBase` uses `overlayExtension.getHandlingTools()` directly. The base class method is dead API surface.

**Fix**: Remove `getTools()` from both classes unless there's a concrete plan to use it. It can be added back when a second consumer needs it.

### 5. Redundant error handling in waitForPageSettle (Trivial)

```typescript
try {
    await this.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
} catch {
    // Ignore timeout
}
```

Both `.catch(() => {})` and the outer `try/catch` swallow the timeout. One is sufficient.

**Fix**: Remove the `.catch(() => {})` or the outer `try/catch`.

### 6. Overlay handling round budget not enforced (Medium)

The overlay round budget (`maxIterations`, default 20) is only enforced in `onBeforeCompletion` by injecting a message telling the model to report failure. If the model doesn't comply (keeps calling other tools), handling mode continues indefinitely. The overlay handling burns through the main loop's `maxRounds` budget — a summarizer with 50 rounds could spend all 50 on overlay handling.

There are two concerns:

1. **Budget is not hard-enforced**: the model can ignore the soft message and keep going
2. **Overlay rounds consume the main budget**: the model has fewer rounds left for its actual task after overlay handling

**Fix**:

- Hard-enforce in `onRoundStart`: when `currentRound - handlingStartRound >= maxIterations`, call `exitHandlingMode` with a failure result (per issue 2's centralized cleanup). Skip the round. The main loop continues normally on the next round with the restored conversation.
- Track overlay rounds separately: the main loop's `maxRounds` should not count overlay handling rounds, OR the overlay budget should be a hard cap that's enforced independently. The simplest approach is the `onRoundStart` hard-enforcement above — it guarantees at most `maxIterations` rounds are spent on overlay handling, and the remaining `maxRounds - handlingStartRound` rounds are available for the main task.
