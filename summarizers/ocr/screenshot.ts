import sharp from "sharp";
import type { Page } from "puppeteer";
import type { NormalizedCursorActionHistoryEntry } from "./extensions/cursor";
import { InteractionPositioning } from "./state";

/**
 * Fixed viewport dimensions for overlay detection and interaction.
 * Using consistent dimensions ensures the model sees stable coordinates.
 */
export const OVERLAY_VIEWPORT_WIDTH = 1280;
export const OVERLAY_VIEWPORT_HEIGHT = 800;

/**
 * Mime type additions for screenshot images.
 * - "raw": plain screenshot
 * - "debug": screenshot with coordinate grid overlay
 */
export type ScreenshotMimeAddition = "raw" | "debug";

/**
 * Result of taking a screenshot.
 */
export interface ScreenshotResult {
    data: string;
    width: number;
    height: number;
    devicePixelRatio: number;
    mimeType: string;
}

/**
 * Options for takeScreenshot function.
 */
export interface ScreenshotOptions {
    /** Viewport width in CSS pixels */
    width: number;
    /** Maximum viewport height in CSS pixels */
    maxHeight: number;
}

/**
 * Options for coordinate grid overlay.
 */
export interface GridOverlayOptions {
    positioning: InteractionPositioning;
    /** Click history to display as markers */
    clickHistory?: Array<{
        x: number;
        y: number;
        normalizedX?: number;
        normalizedY?: number;
    }>;
}

/**
 * Take a screenshot of the current page state.
 * Returns the base64 image data and the actual dimensions.
 *
 * @param page - Puppeteer page instance
 * @param options - Screenshot dimensions
 * @returns Screenshot data with dimensions
 */
export async function takeScreenshot(page: Page, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    // Wait briefly for body to become available (may be null during navigation or on pages using <frameset>)
    await page.waitForSelector("body", { timeout: 5000 }).catch(() => {});

    // Get current scroll position and page dimensions, falling back to documentElement if body is null
    const { scrollY, bodyWidth, bodyHeight, devicePixelRatio } = await page.evaluate(() => {
        const el = document.body ?? document.documentElement;
        return {
            scrollY: window.scrollY,
            bodyWidth: el.offsetWidth,
            bodyHeight: el.scrollHeight,
            devicePixelRatio: window.devicePixelRatio,
        };
    });

    const { width, maxHeight } = options ?? {
        width: bodyWidth,
        maxHeight: bodyHeight,
    };

    // Calculate visible area
    const remainingHeight = bodyHeight - scrollY;
    const viewportHeight = Math.min(remainingHeight, maxHeight);

    const data = (await page.screenshot({
        encoding: "base64",
        fullPage: false,
    })) as string;

    // Use actual screenshot dimensions (accounting for device pixel ratio)
    const actualWidth = Math.round(width * devicePixelRatio);
    const actualHeight = Math.round(viewportHeight * devicePixelRatio);

    return {
        data,
        width: actualWidth,
        height: actualHeight,
        devicePixelRatio,
        mimeType: "image/png",
    };
}

/**
 * Draw a coordinate grid overlay on the screenshot with labels based on positioning mode.
 * - Absolute positioning: shows pixel coordinates
 * - Relative positioning: shows percentages
 *
 * Returns base64 encoded PNG with grid lines and labels.
 *
 * @param base64Data - Base64 encoded screenshot
 * @param width - Expected width (used for coordinate calculations, actual size read from image)
 * @param height - Expected height (used for coordinate calculations, actual size read from image)
 * @param options - Grid overlay options
 * @returns Base64 encoded PNG with grid overlay
 */
export async function addCoordinateGrid(
    base64Data: string,
    width: number,
    height: number,
    options: GridOverlayOptions,
): Promise<string> {
    const { positioning, clickHistory = [] } = options;
    const isAbsolute = positioning.type === "absolute";

    const imageBuffer = Buffer.from(base64Data, "base64");

    // Get actual image dimensions to ensure overlay matches
    const metadata = await sharp(imageBuffer).metadata();
    const actualWidth = metadata.width ?? width;
    const actualHeight = metadata.height ?? height;

    // Create grid SVG overlay
    const gridLines: string[] = [];

    // Grid line percentages - major at 25% intervals, minor at 12.5% intervals
    const majorPercentages = [0.25, 0.5, 0.75];
    const minorPercentages = [0.125, 0.375, 0.625, 0.875];

    // Helper to format label based on positioning mode
    const formatLabel = (pct: number, isX: boolean): string => {
        if (isAbsolute) {
            // Show pixel position
            const pixels = Math.round(pct * (isX ? actualWidth : actualHeight));
            return `${pixels}px`;
        } else {
            // Show percentage (relative positioning uses range like 0-1000)
            const range = isX ? positioning.x : positioning.y;
            const value = Math.round(pct * range);
            return `${value}`;
        }
    };

    // Helper to format corner coordinate
    const formatCorner = (xPct: number, yPct: number): string => {
        if (isAbsolute) {
            const x = Math.round(xPct * actualWidth);
            const y = Math.round(yPct * actualHeight);
            return `(${x},${y})`;
        } else {
            const x = Math.round(xPct * positioning.x);
            const y = Math.round(yPct * positioning.y);
            return `(${x},${y})`;
        }
    };

    // Vertical minor lines
    for (const pct of minorPercentages) {
        const x = Math.round(actualWidth * pct);
        gridLines.push(
            `<line x1="${x}" y1="0" x2="${x}" y2="${actualHeight}" stroke="rgba(255,0,0,0.2)" stroke-width="1" stroke-dasharray="2,2"/>`,
        );
    }

    // Horizontal minor lines
    for (const pct of minorPercentages) {
        const y = Math.round(actualHeight * pct);
        gridLines.push(
            `<line x1="0" y1="${y}" x2="${actualWidth}" y2="${y}" stroke="rgba(255,0,0,0.2)" stroke-width="1" stroke-dasharray="2,2"/>`,
        );
    }

    // Vertical major lines with labels
    for (const pct of majorPercentages) {
        const x = Math.round(actualWidth * pct);
        gridLines.push(
            `<line x1="${x}" y1="0" x2="${x}" y2="${actualHeight}" stroke="rgba(255,0,0,0.5)" stroke-width="2" stroke-dasharray="5,5"/>`,
        );
        const label = formatLabel(pct, true);
        gridLines.push(`<text x="${x + 3}" y="15" fill="red" font-size="11" font-family="monospace">${label}</text>`);
    }

    // Horizontal major lines with labels
    for (const pct of majorPercentages) {
        const y = Math.round(actualHeight * pct);
        gridLines.push(
            `<line x1="0" y1="${y}" x2="${actualWidth}" y2="${y}" stroke="rgba(255,0,0,0.5)" stroke-width="2" stroke-dasharray="5,5"/>`,
        );
        const label = formatLabel(pct, false);
        gridLines.push(`<text x="3" y="${y - 3}" fill="red" font-size="11" font-family="monospace">${label}</text>`);
    }

    // Add corner labels
    const topLeft = formatCorner(0, 0);
    const topRight = formatCorner(1, 0);
    const bottomLeft = formatCorner(0, 1);
    const bottomRight = formatCorner(1, 1);

    gridLines.push(`<text x="3" y="15" fill="red" font-size="13" font-family="monospace">${topLeft}</text>`);
    gridLines.push(
        `<text x="${actualWidth - 55}" y="15" fill="red" font-size="13" font-family="monospace">${topRight}</text>`,
    );
    gridLines.push(
        `<text x="3" y="${actualHeight - 5}" fill="red" font-size="13" font-family="monospace">${bottomLeft}</text>`,
    );
    gridLines.push(
        `<text x="${actualWidth - 55}" y="${actualHeight - 5}" fill="red" font-size="13" font-family="monospace">${bottomRight}</text>`,
    );

    // Add click markers (up to last 5)
    const recentClicks = clickHistory.slice(-5);
    const colors = ["#0066ff", "#0099ff", "#00ccff", "#00ffff", "#66ffff"]; // Blue gradient for recency

    for (let i = 0; i < recentClicks.length; i++) {
        const click = recentClicks[i];
        const isMostRecent = i === recentClicks.length - 1;
        const color = colors[i];
        const clickNumber = clickHistory.length - recentClicks.length + i + 1;

        // Use normalized coordinates (0-1) if available, otherwise fall back to raw
        const normalizedX = click.normalizedX ?? click.x;
        const normalizedY = click.normalizedY ?? click.y;

        // Convert normalized coordinates to pixel position
        const pixelX = Math.round(normalizedX * actualWidth);
        const pixelY = Math.round(normalizedY * actualHeight);

        // Draw a crosshair at the click position
        const radius = isMostRecent ? 15 : 10;
        const strokeWidth = isMostRecent ? 2 : 1;

        gridLines.push(
            `<circle cx="${pixelX}" cy="${pixelY}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>`,
        );
        gridLines.push(`<circle cx="${pixelX}" cy="${pixelY}" r="3" fill="${color}"/>`);
        gridLines.push(
            `<line x1="${pixelX - 20}" y1="${pixelY}" x2="${pixelX + 20}" y2="${pixelY}" stroke="${color}" stroke-width="1"/>`,
        );
        gridLines.push(
            `<line x1="${pixelX}" y1="${pixelY - 20}" x2="${pixelX}" y2="${pixelY + 20}" stroke="${color}" stroke-width="1"/>`,
        );

        // Label showing click number and coordinates (click.x/y are already in positioning system format)
        const fontSize = isMostRecent ? 11 : 9;
        const fontWeight = isMostRecent ? "bold" : "normal";
        const xLabel = Number.isInteger(click.x) ? click.x.toString() : click.x.toFixed(1);
        const yLabel = Number.isInteger(click.y) ? click.y.toString() : click.y.toFixed(1);
        gridLines.push(
            `<text x="${pixelX + 5}" y="${pixelY - 18}" fill="${color}" font-size="${fontSize}" font-family="monospace" font-weight="${fontWeight}">#${clickNumber} (${xLabel}, ${yLabel})</text>`,
        );
    }

    const svgOverlay = `<svg width="${actualWidth}" height="${actualHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="none"/>
        ${gridLines.join("\n")}
    </svg>`;

    const overlayBuffer = Buffer.from(svgOverlay);

    const result = await sharp(imageBuffer)
        .composite([{ input: overlayBuffer, top: 0, left: 0 }])
        .png()
        .toBuffer();

    return result.toString("base64");
}

/**
 * Captures a screenshot and optionally adds a debug coordinate grid.
 * Used by the screenshot extension to populate image content.
 *
 * @param page - Puppeteer page instance
 * @param options - Screenshot options
 * @returns Base64 encoded screenshot data
 */
export async function captureScreenshot(
    page: Page,
    options?: {
        debug?: boolean;
        positioning: InteractionPositioning;
        cursorHistory?: NormalizedCursorActionHistoryEntry[];
        /** Max number of history entries to show in debug overlay (default: 5) */
        maxHistoryEntries?: number;
    },
): Promise<string> {
    const result = await takeScreenshot(page);

    if (options?.debug) {
        const maxHistory = options.maxHistoryEntries ?? 5;
        return addCoordinateGrid(result.data, result.width, result.height, {
            positioning: options.positioning,
            clickHistory: options.cursorHistory?.slice(-maxHistory) ?? [],
        });
    }

    return result.data;
}
