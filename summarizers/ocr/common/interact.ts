import { Page } from "puppeteer";

/** Cursor and touch utilities */
export async function safeCursorMove(page: Page, x: number, y: number): Promise<{ success: boolean; error?: string }> {
    try {
        await page.cursor.moveTo({ x, y });
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Safely click using cursor.
 * Returns true if successful, false if cursor API is not available.
 */
export async function safeCursorClick(page: Page, x: number, y: number): Promise<{ success: boolean; error?: string }> {
    try {
        await page.cursor.moveTo({ x, y });
        await page.cursor.click();
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Safely tap using touchscreen.
 * Returns true if successful, false if touchscreen API is not available.
 */
export async function safeTouchTap(page: Page, x: number, y: number): Promise<{ success: boolean; error?: string }> {
    try {
        await page.touchscreen.tap(x, y);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
