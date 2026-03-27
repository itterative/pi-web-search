import type { Page } from "puppeteer";

import { OcrBase, type OcrConfig } from "./ocr";
import { InteractionConfig, InteractionPositioning } from "./state";
import { OcrRunOptions } from "./config";

/**
 * Configuration for OCR summarizers.
 * Extends the base OcrConfig with convenience options.
 */
export interface OcrSummarizerConfig {
    /** The page to interact with */
    page: Page;

    /** The vision model to use */
    model: OcrConfig["model"];

    /** API key for the model */
    apiKey: string | undefined;
    headers?: Record<string, string>;

    /** Template path for checkpoint extension (e.g., "explore", "full", "summarize") */
    templatePath?: string;

    /** Screenshot width (default: 1280) */
    width?: number;

    /** Maximum screenshot height (default: 800) */
    maxHeight?: number;

    /** Maximum interaction rounds (default: 50) */
    maxRounds?: number;

    /** Delay after interactions in ms (default: 500) */
    delay?: number;

    /** Context usage threshold for checkpointing (default: 0.8) */
    checkpointThreshold?: number;

    /** Positioning mode (default: relative 1x1) */
    positioning?: InteractionPositioning;

    /** Interaction config (default: sensible defaults) */
    interaction?: Partial<InteractionConfig>;

    /** Overlay handling config (default: enabled with 20 iterations) */
    overlay?: OcrConfig["overlay"];
}

/**
 * Options for running an OCR summarizer.
 */
export interface OcrSummarizerOptions extends OcrRunOptions {}

export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
    defaultSleepMillis: 2,
    minSleepMillis: 0.5,
    maxSleepMillis: 10,
    delayMillis: 500,
    scrollRelativeMultiplier: 0.75,
    maxTextMatchResults: 15,
};

/**
 * Build an OcrConfig from OcrSummarizerConfig.
 */
export function buildOcrConfig(config: OcrSummarizerConfig): OcrConfig {
    return {
        page: config.page,
        model: config.model,
        apiKey: config.apiKey,
        headers: config.headers,
        templatePath: config.templatePath ?? "base",
        width: config.width ?? 1280,
        maxHeight: config.maxHeight ?? 800,
        maxRounds: config.maxRounds ?? 50,
        delay: config.delay ?? 500,
        checkpointThreshold: config.checkpointThreshold ?? 0.8,
        positioning: config.positioning ?? { type: "relative", x: 1, y: 1 },
        interaction: {
            ...DEFAULT_INTERACTION_CONFIG,
            ...config.interaction,
        },
        overlay: config.overlay,
    };
}

/**
 * Factory function type for creating OCR summarizers.
 * Since tools and extensions need access to shared state (cursor, checkpoints, etc.),
 * we use a factory pattern to create the summarizer with all its dependencies.
 */
export type OcrSummarizerFactory<T extends OcrBase> = (config: OcrSummarizerConfig) => T;
