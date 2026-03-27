import type { Page } from "puppeteer";
import { OcrExtension, type OcrExtensionExecutionContext } from "./base";
import { InteractionPositioning } from "../state";

/** Cursor state types */
export type CursorAction = "click" | "hover";

/**
 * An action in the cursor history (for debug screenshots).
 */
export interface CursorActionHistoryEntry {
    type: CursorAction;
    /** X coordinate in page pixels */
    x: number;
    /** Y coordinate in page pixels */
    y: number;
    /** Viewport width at time of action */
    viewportWidth: number;
    /** Viewport height at time of action */
    viewportHeight: number;
    /** Scroll X at time of action */
    scrollX: number;
    /** Scroll Y at time of action */
    scrollY: number;
}

/**
 * A normalized entry for display in debug overlays.
 */
export interface NormalizedCursorActionHistoryEntry {
    type: CursorAction;
    /** X coordinate in positioning system (e.g., 0-1000 for relative) */
    x: number;
    /** Y coordinate in positioning system (e.g., 0-1000 for relative) */
    y: number;
    /** X coordinate normalized to 0-1 for screenshot overlay positioning */
    normalizedX: number;
    /** Y coordinate normalized to 0-1 for screenshot overlay positioning */
    normalizedY: number;
}

/**
 * State for cursor tracking.
 */
export interface CursorState {
    x: number;
    y: number;
    isSet: boolean;
    history: CursorActionHistoryEntry[];
}

/**
 * Tracking state for repeated cursor results.
 */
export interface CursorRepetitionState {
    /** Hash of the last hover result */
    lastHash: string | null;
    /** Number of times the same result has been found in a row */
    repetitionCount: number;
}

/**
 * Configuration for the cursor extension.
 */
export interface CursorExtensionInit {
    page: Page;
    /** Positioning mode for coordinate normalization */
    positioning: InteractionPositioning;
}

/**
 * Extension that manages cursor state for interactive tools.
 *
 * The cursor extension tracks:
 * - Current cursor position (x, y in relative 0.0-1.0 coordinates)
 * - Whether the cursor has been set
 * - History of cursor actions (clicks and hovers)
 * - Repetition tracking for cursor hover results
 *
 * Tools like `cursor`, `click`, and `type` use this extension to:
 * - Set cursor position (cursor tool)
 * - Click at cursor position (click tool)
 * - Type at cursor position (type tool)
 * - Show recent cursor positions in debug screenshots (screenshot tool)
 *
 * @example
 * ```ts
 * const cursorExt = new CursorExtension({ page });
 * registry.register(cursorExt);
 *
 * // Tools can access cursor state via the extension
 * const cursor = cursorExt.getCursor();
 * cursorExt.setCursor(0.5, 0.5);
 * await cursorExt.addHistoryEntry("click", pageX, pageY);
 * ```
 */
export class CursorExtension extends OcrExtension {
    readonly name = "cursor";

    private page: Page;
    private cursor: CursorState;
    private positioning: InteractionPositioning;
    private repetition: CursorRepetitionState;

    constructor(init: CursorExtensionInit) {
        super();
        this.page = init.page;
        this.positioning = init.positioning;
        this.cursor = this.createInitialCursorState();
        this.repetition = this.createInitialRepetitionState();
    }

    private createInitialCursorState(): CursorState {
        return {
            x: 0.5,
            y: 0.5,
            isSet: false,
            history: [],
        };
    }

    private createInitialRepetitionState(): CursorRepetitionState {
        return {
            lastHash: null,
            repetitionCount: 0,
        };
    }

    // --- Lifecycle hooks ---

    async onInit(_ctx: OcrExtensionExecutionContext): Promise<void> {
        // Reset cursor state for a fresh run
        this.cursor = this.createInitialCursorState();
        this.repetition = this.createInitialRepetitionState();
    }

    // --- Public API ---

    /**
     * Get the current cursor state.
     */
    getCursor(): CursorState {
        return this.cursor;
    }

    /**
     * Set the cursor position.
     * @param x - Relative X coordinate (0.0-1.0)
     * @param y - Relative Y coordinate (0.0-1.0)
     */
    setCursor(x: number, y: number): void {
        this.cursor.x = x;
        this.cursor.y = y;
        this.cursor.isSet = true;
    }

    /**
     * Check if the cursor has been set.
     */
    isCursorSet(): boolean {
        return this.cursor.isSet;
    }

    /**
     * Get the current cursor position.
     * @returns The cursor position, or undefined if not set
     */
    getCursorPosition(): { x: number; y: number } | undefined {
        if (!this.cursor.isSet) {
            return undefined;
        }
        return { x: this.cursor.x, y: this.cursor.y };
    }

    /**
     * Add an entry to the cursor action history.
     * Captures viewport and scroll position for later normalization.
     * @param type - The action type (click or hover)
     * @param pageX - X coordinate in page pixels
     * @param pageY - Y coordinate in page pixels
     */
    async addHistoryEntry(type: CursorAction, pageX: number, pageY: number): Promise<void> {
        const viewport = this.page.viewport();
        if (!viewport) {
            return;
        }

        // Capture current scroll position
        const scroll = await this.page.evaluate(() => ({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
        }));

        this.cursor.history.push({
            type,
            x: pageX,
            y: pageY,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            scrollX: scroll.scrollX,
            scrollY: scroll.scrollY,
        });
    }

    /**
     * Get the cursor action history.
     */
    getHistory(): CursorActionHistoryEntry[] {
        return this.cursor.history;
    }

    /**
     * Get recent cursor actions with coordinates normalized to the positioning system.
     * Accounts for scroll position changes - coordinates are relative to current viewport.
     * @param count - Number of recent entries to return (default: 5)
     */
    async getRecentHistory(count: number = 5): Promise<NormalizedCursorActionHistoryEntry[]> {
        const recent = this.cursor.history.slice(-count);
        if (recent.length === 0) {
            return [];
        }

        // Get current viewport and scroll position
        const viewport = this.page.viewport();
        if (!viewport) {
            return [];
        }

        const currentScroll = await this.page.evaluate(() => ({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
        }));

        return recent.map((entry) => {
            // Calculate position relative to current visible viewport
            const visibleX = entry.x - currentScroll.scrollX;
            const visibleY = entry.y - currentScroll.scrollY;

            // Normalize to 0-1 for overlay positioning
            const normalizedX = visibleX / viewport.width;
            const normalizedY = visibleY / viewport.height;

            // Convert to positioning system coordinates
            let x: number;
            let y: number;

            if (this.positioning.type === "absolute") {
                // Absolute: coordinates relative to current viewport origin
                x = visibleX;
                y = visibleY;
            } else {
                // Relative: normalize to positioning range (e.g., 0-1000)
                x = normalizedX * this.positioning.x;
                y = normalizedY * this.positioning.y;
            }

            return {
                type: entry.type,
                x,
                y,
                normalizedX,
                normalizedY,
            };
        });
    }

    /**
     * Clear the cursor history.
     */
    clearHistory(): void {
        this.cursor.history = [];
    }

    // --- Repetition Tracking ---

    /**
     * Record a cursor hover result and check for repetition.
     * Returns the repetition count if the same result was found again.
     *
     * @param hash - Hash of the current hover result
     * @returns Object with repetition count and whether this is a repeated result
     */
    recordCursorResult(hash: string): { count: number; isRepeated: boolean } {
        if (hash === this.repetition.lastHash) {
            this.repetition.repetitionCount++;
            return { count: this.repetition.repetitionCount, isRepeated: true };
        } else {
            this.repetition.lastHash = hash;
            this.repetition.repetitionCount = 1;
            return { count: 1, isRepeated: false };
        }
    }

    /**
     * Get the current repetition count.
     */
    getRepetitionCount(): number {
        return this.repetition.repetitionCount;
    }

    /**
     * Reset the repetition tracking.
     */
    resetRepetition(): void {
        this.repetition = this.createInitialRepetitionState();
    }

    /**
     * Reset the cursor state completely.
     */
    reset(): void {
        this.cursor = this.createInitialCursorState();
        this.repetition = this.createInitialRepetitionState();
    }
}
