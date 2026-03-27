/**
 * V2 OCR Summarizers - Refactored implementations using the new tool/extension architecture.
 *
 * This module provides three summarizer variants:
 *
 * - **FullOcrSummarizerV2**: Extracts all content from web pages (scroll tool only)
 * - **SummarizeOcrSummarizerV2**: Creates concise summaries (cursor, click, scroll, screenshot)
 * - **ExploreOcrSummarizerV2**: Follows instructions with full tool access (all tools)
 *
 * ## Architecture
 *
 * The v2 summarizers are built on:
 * - `OcrBase`: Base class that orchestrates the interaction loop
 * - `OcrTool`: Tools for page interaction (click, scroll, type, etc.)
 * - `OcrExtension`: Cross-cutting concerns (screenshots, checkpoints, navigation)
 *
 * ## Usage
 *
 * ```typescript
 * import { createExploreOcrSummarizerV2, type OcrSummarizerConfig } from "./ocr/index-v2";
 *
 * const config: OcrSummarizerConfig = {
 *   page: puppeteerPage,
 *   model: visionModel,
 *   apiKey: "your-api-key",
 * };
 *
 * const summarizer = createExploreOcrSummarizerV2(config);
 * const result = await summarizer.run({
 *   screenshot: base64Screenshot,
 *   instruction: "Find the pricing information",
 *   linksContext: "...",
 * });
 * ```
 */

// Re-export configuration types
export {
    type OcrSummarizerConfig,
    type OcrSummarizerOptions,
    DEFAULT_INTERACTION_CONFIG,
    buildOcrConfig,
} from "./ocr-summarizer-base";

// Full summarizer - extracts all content
export { FullOcrSummarizerV2, createFullOcrSummarizerV2 } from "./ocr-full-v2";

// Summarize summarizer - creates concise summaries
export { SummarizeOcrSummarizerV2, createSummarizeOcrSummarizerV2 } from "./ocr-summarize-v2";

// Explore summarizer - follows instructions with full tool access
export { ExploreOcrSummarizerV2, createExploreOcrSummarizerV2 } from "./ocr-explore-v2";

// Re-export base types for advanced usage
export { OcrBase, type OcrBaseState, type OcrConfig, type OverlayConfig } from "./ocr";

export { type OcrRunOptions } from "./config";

// Re-export extension types for custom extensions
export {
    OcrExtension,
    type OcrExtensionExecutionContext,
    type OcrSharedState,
    type SummarizerProgressUpdate,
    type CheckpointRecoveryArgs,
    OcrExtensionRegistry,
    CheckpointExtension,
    CursorExtension,
    DebugExtension,
    NavigationExtension,
    OverlayExtension,
    ScreenshotExtension,
} from "./extensions";
export type { OverlayExtensionInit, OverlayState, OverlayResult } from "./extensions";

// Re-export tool types for custom tools
export { OcrTool, type OcrToolOptions } from "./tools";

// Re-export state types
export type { Checkpoint, InteractionConfig, InteractionPositioning } from "./state";

// Re-export screenshot types
export type { ScreenshotMimeAddition, ScreenshotResult, ScreenshotOptions, GridOverlayOptions } from "./screenshot";

// Re-export cursor types from extensions (co-located with CursorExtension)
export type {
    CursorState,
    CursorAction,
    CursorActionHistoryEntry,
    NormalizedCursorActionHistoryEntry,
    CursorExtensionInit,
} from "./extensions";
