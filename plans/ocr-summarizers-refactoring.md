# OCR Summarizers V2 Refactoring Plan

Tracking file for the tool/extension architecture refactoring in `summarizers/ocr/`.

## Overview

The V2 architecture introduces:

- `OcrBase`: Base class orchestrating the interaction loop
- `OcrTool`: Tools for page interaction (click, scroll, type, etc.)
- `OcrExtension`: Cross-cutting concerns (screenshots, checkpoints, navigation)
- `OcrExtensionRegistry`: Type-safe extension management with lifecycle hooks
- Template-based instructions via Eta

## Status

- [x] Critical items complete
- [x] High priority items complete
- [x] Medium priority items complete
- [x] Low priority items complete

---

## Todo List

### Potential Enhancements (Feature Parity with V1)

- [ ] **ScrollTool: Add scroll state tracking**
    - V1 tracks `lastScrollFailed` to prevent repeated scroll attempts when at bottom
    - V2 returns warning but doesn't prevent future scroll down attempts
    - Could add state tracking via extension or tool context
    - Files: `tools/scroll.ts`, possibly new extension or state in base class
    - Low priority - model sees warning and should understand

- [ ] **TypeTool: Add fallback input finding**
    - V1 can find inputs by: coordinates, description, or first visible input
    - V2 requires cursor to be set first, only types at cursor position
    - Could add description-based input finding as fallback
    - File: `tools/type.ts`
    - Low priority - V2 design encourages explicit cursor positioning

- [ ] **NavigationExtension: Update history on back navigation**
    - V1 removes pages from history when going back
    - V2 keeps full history (just moves index)
    - This is intentional - V2 design preserves full navigation trail
    - No action needed - current behavior is preferable

---

## Completed

### Critical (User Feedback)

- [x] **Refactor `OcrBase` constructor to use registry pattern**
    - Added `registerTool()` / `registerExtension()` methods
    - Made registry and tools private in base class
    - Files: `ocr.ts`, `ocr-full-v2.ts`, `ocr-summarize-v2.ts`, `ocr-explore-v2.ts`

- [x] **Extract `OcrTool` base class to separate file**
    - Created `tools/base.ts` with `OcrTool`, `OcrToolValidationError`, etc.
    - `tools/index.ts` re-exports all tools
    - Keep `executeOcrToolCall` in `index.ts`

- [x] **Make `OcrBase` generic with state type**
    - `OcrBase<TCustom>` with `OcrBaseState<TCustom> = { base: OcrSharedState } & TCustom`
    - Subclasses pass only custom state fields to constructor
    - Removed `createInitialState()` (state created inline)

- [x] **Fix `onToolCall` hook return type**
    - Extensions can intercept by returning `ToolResultMessage`
    - All hooks return `Promise` only for consistency
    - Simplified `processToolCalls`: `interceptedResult ?? await executeOcrToolCall(...)`
    - `executeOcrToolCall` always returns a result, so no null checks needed

- [x] **Fix `updateUI` callback to use `SummarizerUpdateCallback`**
    - Added `SummarizerProgressUpdate` type: fields can be value (update), null (delete), undefined (keep)
    - `OcrBase.currentProgress` tracks state for merging partial updates
    - `buildUpdateUIHandler()` implements merge logic
    - Subclasses provide `readonly initialProgressMessage: string`
    - V2 summarizers: "Extracting page content...", "Summarizing page...", "Exploring page..."

### High Priority

- [x] **Reduce constructor duplication in V2 summarizers** — DECIDED NOT TO DO
    - Registry pattern already reduced duplication significantly
    - Remaining ~20 lines of extension setup is similar but has subtle differences
    - Abstracting further would add complexity without much benefit

- [x] **Refactor `handleCompression` pattern**
    - `handleCompression(ctx)` now takes `OcrExtensionExecutionContext`
    - `handleCompressionWithTemplates(ctx, options)` added for subclasses
    - Options include: `requestTemplateArgs`, `recoveryTemplateArgs`, `includeScreenshot`
    - `buildCompressionContext()`, `extractTextContent()` remain in base class
    - Extension registration remains in base class
    - Explore overrides `handleCompression` to pass extra recovery args via `handleCompressionWithTemplates`

- [x] **Clean up unused types in `state.ts`**
    - Removed: `InteractiveState`, `CheckpointTracking`, `InteractionContext`, `CheckpointState`
    - Deleted `context.ts` entirely (`OcrToolContext`/`OcrToolContextBuilder` were unused)
    - Moved cursor types to `extensions/cursor.ts`: `CursorState`, `CursorAction`, `CursorActionHistoryEntry`
    - Updated `screenshot.ts` to import from `./extensions/cursor`
    - Updated exports in `index-v2.ts` and `extensions/index.ts`

### Medium Priority

- [x] **Resolve `OcrToolContext` / `OcrToolContextBuilder` situation** — RESOLVED
    - Deleted `context.ts` entirely - these types were never used
    - Tools define their own context interfaces (e.g., `ClickToolContext`, `ScrollToolContext`)

- [x] **Consolidate callback mechanisms**
    - Created `OcrToolExecutionContext` (runtime context passed to `execute()`)
    - `OcrToolExecutionContext` includes: `toolName`, `toolCallId`, `updateUI`, `log`, `signal`
    - `OcrExtensionContext` renamed to `OcrExtensionExecutionContext` for consistency
    - Moved callbacks from construction time to runtime context
    - `updateUI` now takes `SummarizerProgressUpdate` (consistent with extension callbacks)
    - Updated all 10 tools: `execute(context, args)` signature
    - Helper methods now take `context` as first parameter
    - `executeOcrToolCall` takes `context` as first parameter
    - Removed `InteractionUIState` from `state.ts` (no longer needed)
    - Removed `toolOptions` parameter from V2 summarizer constructors

- [x] **Make extension dependencies explicit** — DOCUMENTED AS OPTIONAL
    - `cursorExtension` in `ScreenshotExtensionInit` is intentionally optional
    - If not provided, debug screenshots lack cursor history markers (documented behavior)
    - JSDoc already notes: `/** Optional reference to cursor extension for debug screenshots */`
    - No code changes needed - optional pattern is correct

### Low Priority

- [x] **Add missing type exports to `index.ts`**
    - Added exports: `ScreenshotMimeAddition`, `ScreenshotResult`, `ScreenshotOptions`, `GridOverlayOptions`
    - File: `index.ts`

- [x] **Document error handling in `executeOcrToolCall`**
    - Documented that unknown errors are intentionally re-thrown
    - Allows extension-specific errors to bubble up for debugging
    - Handles: `OcrToolValidationError`, `ProtocolError`, `TimeoutError` as tool results
    - File: `tools/index.ts`

- [x] **Document magic numbers in checkpoint extension**
    - `requestThreshold = checkpointThreshold - 0.1`: Requests checkpoint at 70% when default is 80%
    - `criticalThreshold = 0.9`: Fixed threshold to prevent context overflow
    - Added JSDoc to config interface and private methods explaining thresholds
    - File: `extensions/checkpoint.ts`

- [x] **Rename `screenshotSuccessMessage` to `screenshotPlaceholderSuccessMessage`**
    - New name clearly indicates it creates a placeholder filled by `ScreenshotExtension`
    - Added JSDoc explaining the placeholder mechanism
    - Kept deprecated alias for backward compatibility
    - Updated all 9 usages across tools: `keyboard.ts`, `navigate.ts` (2), `screenshot.ts`, `scroll.ts`, `click.ts` (4)
    - File: `tools/base.ts`

- [x] **Keep Eta trim options** — DECIDED NOT TO CHANGE
    - User wants to keep the options available for future use

- [x] **Remove unused `this.context` assignments in tools**
    - Removed `this.context = context` from: `click.ts`, `cursor.ts`, `find.ts`, `keyboard.ts`, `scroll.ts`
    - Removed unused `protected context!` field from `OcrTool` base class
    - Context is passed directly to helper methods instead

- [x] **Fix typos in error/success messages**
    - `tools/type.ts`: "Sucessfully" → "Successfully"
    - `ocr-explore-v2.ts`: "unsucessfull" → "unsuccessful"

- [x] **Fix TypeTool missing screenshot on submit**
    - V1 returns screenshot when `submit=true` because form submission may navigate
    - V2 was missing this - now returns screenshot placeholder on submit
    - File: `tools/type.ts`

- [x] **Add tool guidelines to system prompt rendering**
    - Tools define `promptSnippet` (short description) and `promptGuidelines` (detailed usage)
    - Added `getToolSnippets()` and `getToolGuidelines()` to `OcrBase`
    - Updated system.eta templates for all 3 modes to include guidelines
    - Updated V2 summarizers to pass tool data to templates
    - Fixed HTML escaping in templates (use `<%~` for raw output)
    - Added snapshot tests for all prompt methods:
        - `getSystemPrompt()` - system prompt with tool guidelines
        - `getForceSummaryPrompt()` - forced summary prompt
        - `getCheckpointRequestPrompt()` - checkpoint request prompt
        - `getCheckpointRecoveryPrompt()` - checkpoint recovery prompt
        - `buildInitialMessage()` - initial message with instruction/links variants
        - `formatCheckpoints()` - format checkpoints for display (explore only)
        - `getConsolidatePrompt()` - consolidation prompt for stalled progress (explore only)
        - `getCheckpointRecoveryPromptWithContext()` - recovery with navContext (explore only)
    - Made prompt methods public for testability
    - Removed `CompressionConfig` - now uses abstract methods instead of template paths
    - Explore overrides `handleCompression` to include navContext and checkpoints
    - Split tests into separate files per summarizer: `full.test.ts`, `summarize.test.ts`, `explore.test.ts`
    - Files: `ocr.ts`, `ocr-full-v2.ts`, `ocr-summarize-v2.ts`, `ocr-explore-v2.ts`, `ocr-summarizer-base.ts`, `instructions/*/system.eta`, `test/summarizers/ocr/v2/*.test.ts`
