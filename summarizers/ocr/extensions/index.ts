// Base extension types
export {
    OcrExtension,
    type OcrExtensionExecutionContext as OcrExtensionExecutionContext,
    type OcrExtensionHooks,
    type OcrExtensionConstructor,
    type OcrSharedState,
    type OcrBaseStateInterface,
    type OcrState,
    type MessageChange,
} from "./base";

// Re-export SummarizerProgressUpdate from base types
export type { SummarizerProgressUpdate } from "../../base";

// Registry
export { OcrExtensionRegistry, type RegisterOptions } from "./registry";

// Screenshot extension - fills in screenshot placeholders in tool results
export { ScreenshotExtension, type ScreenshotExtensionInit } from "./screenshot";

// Checkpoint extension - handles compression and context limits
export {
    CheckpointExtension,
    type CheckpointExtensionInit,
    type CheckpointCompressionHost,
    type CheckpointRecoveryArgs,
    type CheckpointState,
    type CompressionState,
    createCheckpointState,
} from "./checkpoint";

// Debug extension - saves debug screenshots with coordinate grids
export { DebugExtension, type DebugExtensionInit } from "./debug";

// Navigation extension - tracks page history and provides nav context
export {
    NavigationExtension,
    type NavigationExtensionInit,
    type PageHistoryEntry,
    type NavigationCallback,
    type NavigateOptions,
} from "./navigation";

// Cursor extension - manages cursor state for interactive tools
export {
    CursorExtension,
    type CursorExtensionInit,
    type CursorState,
    type CursorAction,
    type CursorActionHistoryEntry,
    type NormalizedCursorActionHistoryEntry,
} from "./cursor";

// Overlay extension - detects and handles page overlays (captchas, cookie consent)
export {
    OverlayExtension,
    type OverlayExtensionInit,
    type OverlayState,
    type OverlayResult,
    type SavedDismissCall,
    createOverlayState,
} from "./overlay";
