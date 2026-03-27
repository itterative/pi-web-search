/**
 * State types for interactive OCR summarizers.
 */

/** A checkpoint saved during exploration */
export interface Checkpoint {
    title: string;
    content: string;
}

export interface InteractionConfig {
    defaultSleepMillis: number;
    minSleepMillis: number;
    maxSleepMillis: number;
    delayMillis: number;
    scrollRelativeMultiplier: number;
    /** Maximum number of matching elements to list when text search finds multiple (default: 5) */
    maxTextMatchResults: number;
    /** Minimum output image dimension in pixels (default: 400) */
    minZoomDimension?: number;
    /** Rounding increment for minimum size suggestions (default: 10 for absolute, 0.1 for 0-1 relative, 10 for 0-1000 relative) */
    minZoomRounding?: number;
    /** Decimal places for coordinate display (default: 0 for absolute, 2 for relative) */
    coordinatePrecision?: number;
}

export type InteractionPositioning =
    | {
          type: "absolute";
      }
    | {
          type: "relative";
          x: number;
          y: number;
      };
