import type { SummarizerUpdateCallback } from "../base";

/**
 * Options for running the OCR interaction.
 */
export interface OcrRunOptions {
    /** Optional instruction to follow */
    instruction?: string;

    /** Formatted links context */
    linksContext: string;

    /** Initial screenshot data (base64) */
    screenshot: string;

    /** Progress update callback */
    onUpdate?: SummarizerUpdateCallback;

    /** Notification callback for debug messages */
    notify?: (message: string, type?: "info" | "warning" | "error") => void;

    /** Abort signal */
    signal?: AbortSignal;
}
