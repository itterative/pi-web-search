import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions, OcrToolValidationError } from "./base";
import { InteractionConfig, InteractionPositioning } from "../state";

interface ZoomToolParameters {
    x: number;
    y: number;
    width: number;
    height: number;
    level: 1.5 | 2 | 3;
}

interface ZoomToolContext {
    page: Page;
    config: InteractionConfig;
    positioning: InteractionPositioning;
}

/** Minimum output image dimensions in pixels (after zoom is applied) */
const MIN_OUTPUT_SIZE = 400;

interface BoundingBoxResult {
    original: BoundingBox;
    clamped: BoundingBox;
    relativeClamped: BoundingBox;
    /** Warning messages if bounding box was out of viewport */
    warnings: string[];
}

interface BoundingBox {
    /** Top-left X in absolute pixels */
    x: number;
    /** Top-left Y in absolute pixels */
    y: number;
    /** Bottom-right X in absolute pixels */
    x2: number;
    /** Bottom-right Y in absolute pixels */
    y2: number;
    /** Width in absolute pixels */
    width: number;
    /** Height in absolute pixels */
    height: number;
    /** Center X in absolute pixels */
    centerX: number;
    /** Center Y in absolute pixels */
    centerY: number;
}

interface ConversionOptions {
    toRelativeX: (pos: number) => number;
    toRelativeY: (pos: number) => number;
    toAbsoluteX: (pos: number) => number;
    toAbsoluteY: (pos: number) => number;
    /** Convert a dimension value to absolute pixels using uniform scaling (preserves aspect ratio) */
    toAbsoluteDimension: (dim: number) => number;
    /** Convert a dimension value to relative coordinates using uniform scaling */
    toRelativeDimension: (dim: number) => number;
}

export class ZoomTool extends OcrTool<ZoomToolContext> {
    /**
     * Calculate minimum input size for a zoom level.
     * @param minOutputSize Minimum output image size in pixels
     * @param level Zoom level
     * @param positioning Positioning configuration
     * @param rounding Rounding increment (default: 10 for absolute, auto-detected for relative)
     * @param viewportWidth Viewport width for accurate relative conversion (optional, uses estimate if not provided)
     */
    static getMinInputSize(
        minOutputSize: number,
        level: number,
        positioning: InteractionPositioning,
        rounding?: number,
        viewportWidth?: number,
    ): number {
        const absolute = minOutputSize / level;

        if (positioning.type === "absolute") {
            const r = rounding ?? 10;
            return Math.ceil(absolute / r) * r;
        }

        // For relative: convert absolute to relative units
        // If viewportWidth provided, use accurate conversion; otherwise estimate
        const effectiveViewportWidth = viewportWidth ?? 1000;
        const relative = (absolute * positioning.x) / effectiveViewportWidth;

        // Auto-detect rounding based on positioning range
        const r = rounding ?? (positioning.x <= 1 ? 0.1 : 10);
        return Math.ceil(relative / r) * r;
    }

    constructor(ctx: ZoomToolContext, options?: OcrToolOptions) {
        const minOutputSize = ctx.config.minZoomDimension ?? MIN_OUTPUT_SIZE;
        const rounding = ctx.config.minZoomRounding;
        const precision = ctx.config.coordinatePrecision ?? (ctx.positioning.type === "absolute" ? 0 : 2);

        const formatMinSize = (level: number) => {
            const size = ZoomTool.getMinInputSize(minOutputSize, level, ctx.positioning, rounding);
            return ctx.positioning.type === "absolute" ? `${size.toFixed(precision)}px` : size.toFixed(precision);
        };

        const coordDescX =
            ctx.positioning.type === "absolute"
                ? "Absolute X coordinate of the bounding box center in pixels."
                : `Relative X coordinate of bounding box center (0.0 = left edge, ${ctx.positioning.x} = right edge).`;

        const coordDescY =
            ctx.positioning.type === "absolute"
                ? "Absolute Y coordinate of the bounding box center in pixels."
                : `Relative Y coordinate of bounding box center (0.0 = top edge, ${ctx.positioning.y} = bottom edge).`;

        const coordDescWidth =
            ctx.positioning.type === "absolute"
                ? `Width of the bounding box in pixels.`
                : `Relative width of bounding box (${ctx.positioning.x} = full viewport width).`;

        const coordDescHeight =
            ctx.positioning.type === "absolute"
                ? `Height of the bounding box in pixels.`
                : `Relative height of bounding box (${ctx.positioning.y} = full viewport height).`;

        // Show coordinate range for relative, or just "pixels" for absolute
        const unitLabel = ctx.positioning.type === "absolute" ? "pixels" : `coordinates (0 to ${ctx.positioning.x})`;

        super(
            {
                name: "zoom",
                description:
                    "Zoom into a specific bounding area of the page to see more detail. Use this to inspect small text or detailed elements.",
                promptSnippet: "zoom - Zoom into a bounding area for detailed inspection",
                promptGuidelines:
                    "## zoom tool\n" +
                    "- Zoom into a specific area to see fine details or small text\n" +
                    "- Define a bounding box: `x`, `y` (center), `width`, `height`\n" +
                    "- Choose zoom `level`: 1.5x, 2x, or 3x magnification\n" +
                    "- The bounding box is centered and scaled in the viewport\n" +
                    "- Use when screenshots show small or unclear content, or you have trouble using the cursor\n" +
                    `- Coordinates use same system as cursor tool (${ctx.positioning.type})${ctx.positioning.type !== "absolute" ? " with the area of " + ctx.positioning.x + "x" + ctx.positioning.y : ""}\n` +
                    `- Minimum bounding box size (in ${unitLabel}):\n` +
                    `  - 1.5x: ${formatMinSize(1.5)} (produces ${minOutputSize}px output)\n` +
                    `  - 2x: ${formatMinSize(2)} (produces ${minOutputSize}px output)\n` +
                    `  - 3x: ${formatMinSize(3)} (produces ${minOutputSize}px output)`,
                parameters: Type.Object({
                    x: Type.Number({
                        description: coordDescX,
                    }),
                    y: Type.Number({
                        description: coordDescY,
                    }),
                    width: Type.Number({
                        description: coordDescWidth,
                    }),
                    height: Type.Number({
                        description: coordDescHeight,
                    }),
                    level: Type.Union(
                        [
                            Type.Literal(1.5, { description: "Zoom to 150% (1.5x)" }),
                            Type.Literal(2, { description: "Zoom to 200% (2x)" }),
                            Type.Literal(3, { description: "Zoom to 300% (3x)" }),
                        ],
                        {
                            description: "Zoom level: 1.5, 2, or 3",
                        },
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: ZoomToolParameters): Promise<ToolResultMessage> {
        const { x: centerX, y: centerY, width, height, level } = args;

        // note: convert to top-left since model will call on the center (i.e., we it tries to focus)
        const x = centerX - width / 2;
        const y = centerY - height / 2;

        context.updateUI?.({
            message: `Zooming ${level}x into area (${x.toFixed(2)}, ${y.toFixed(2)})...`,
        });

        const viewport = this.ctx.page.viewport();
        if (!viewport) {
            return this.simpleTextFailureMessage(context, "Could not get viewport dimensions");
        }

        // Calculate minimum input size based on zoom level to ensure minimum output size
        const minOutputSize = this.ctx.config.minZoomDimension ?? MIN_OUTPUT_SIZE;
        const rounding = this.ctx.config.minZoomRounding;

        // Convert to absolute for comparison
        const toAbsoluteDim = this.toAbsoluteDimension(viewport.width);
        const absoluteWidth = toAbsoluteDim(width);
        const absoluteHeight = toAbsoluteDim(height);

        // Get minimum in absolute pixels for comparison
        const minInputSizeAbsolute = ZoomTool.getMinInputSize(minOutputSize, level, { type: "absolute" }, rounding);

        if (absoluteWidth < minInputSizeAbsolute || absoluteHeight < minInputSizeAbsolute) {
            const minSize = ZoomTool.getMinInputSize(
                minOutputSize,
                level,
                this.ctx.positioning,
                rounding,
                viewport.width,
            );
            const precision = this.ctx.config.coordinatePrecision ?? (this.ctx.positioning.type === "absolute" ? 0 : 2);
            const minDisplay =
                this.ctx.positioning.type === "absolute"
                    ? `${minSize.toFixed(precision)}px`
                    : minSize.toFixed(precision);
            throw new OcrToolValidationError(
                `Bounding box is too small for ${level}x zoom. ` +
                    `Minimum size is ${minDisplay}x${minDisplay} ` +
                    `(to produce ${minOutputSize}px output image).`,
            );
        }

        const bbox = this.calculateBoundingBox(x, y, width, height, viewport.width, viewport.height, {
            toAbsoluteX: this.toAbsolute(viewport.width, "x"),
            toAbsoluteY: this.toAbsolute(viewport.height, "y"),
            toRelativeX: this.toRelative(viewport.width, "x"),
            toRelativeY: this.toRelative(viewport.height, "y"),
            toAbsoluteDimension: this.toAbsoluteDimension(viewport.width),
            toRelativeDimension: this.toRelativeDimension(viewport.width),
        });

        if (bbox.original.centerX < 0 || bbox.original.centerX > viewport.width) {
            throw new OcrToolValidationError(
                `X position (${this.formatValue(bbox.original.centerX)}) is not within viewport (${this.formatValue(viewport.width)}). Try using the screenshot tool.`,
            );
        }

        if (bbox.original.centerY < 0 || bbox.original.centerY > viewport.height) {
            throw new OcrToolValidationError(
                `Y position (${this.formatValue(bbox.original.centerY)}) is not within viewport (${this.formatValue(viewport.height)}). Try using the screenshot tool.`,
            );
        }

        // Calculate transform using UNCLAMPED center - we want to center what the user requested
        const viewportCenterX = viewport.width / 2;
        const viewportCenterY = viewport.height / 2;

        // Transform origin is at (0,0), so after scaling, point (centerX, centerY)
        // moves to (centerX * level, centerY * level). We want it at viewport center.
        const translateX = viewportCenterX - bbox.original.centerX * level;
        const translateY = viewportCenterY - bbox.original.centerY * level;

        let originalStyles: { transform: string; transformOrigin: string } | undefined;

        try {
            // Apply zoom transform and capture original values
            originalStyles = await this.ctx.page.evaluate((transform) => {
                const original = {
                    transform: document.body.style.transform,
                    transformOrigin: document.body.style.transformOrigin,
                };

                document.body.style.transform = transform;
                document.body.style.transformOrigin = "0 0";

                return original;
            }, `translate(${translateX}px, ${translateY}px) scale(${level})`);

            // Calculate where the clamped bbox appears after transform
            // We use clamped values because content outside the viewport doesn't exist
            const screenX1 = bbox.clamped.x * level + translateX;
            const screenY1 = bbox.clamped.y * level + translateY;
            const screenX2 = bbox.clamped.x2 * level + translateX;
            const screenY2 = bbox.clamped.y2 * level + translateY;

            // Clip to screen bounds (intersection of transformed bbox and viewport)
            const transformedX = Math.max(0, screenX1);
            const transformedY = Math.max(0, screenY1);
            const transformedWidth = Math.max(0, Math.min(viewport.width, screenX2) - transformedX);
            const transformedHeight = Math.max(0, Math.min(viewport.height, screenY2) - transformedY);

            // Take screenshot of zoomed view
            const screenshot = await this.ctx.page.screenshot({
                encoding: "base64",
                fullPage: false,
                clip: {
                    x: transformedX,
                    y: transformedY,
                    width: transformedWidth,
                    height: transformedHeight,
                },
            });

            // Build response message
            let message = `Zoomed ${level}x into bounding box with center (${this.formatValue(bbox.relativeClamped.centerX)}, ${this.formatValue(bbox.relativeClamped.centerY)}) with size ${this.formatValue(bbox.relativeClamped.width)} x ${this.formatValue(bbox.relativeClamped.height)}`;

            if (bbox.warnings.length > 0) {
                message += "\n\n" + bbox.warnings.join("\n");
            }

            return {
                role: "toolResult",
                toolCallId: context.toolCallId,
                toolName: context.toolName,
                content: [
                    {
                        type: "image",
                        data: screenshot,
                        mimeType: "image/png",
                    },
                    {
                        type: "text",
                        text: message,
                    },
                ],
                isError: false,
                timestamp: Date.now(),
            };
        } catch (error) {
            return this.simpleTextFailureMessage(
                context,
                `Failed to zoom: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            // ensure we restore at the end
            if (originalStyles) {
                try {
                    await this.ctx.page.evaluate((original) => {
                        if (original.transform) {
                            document.body.style.transform = original.transform;
                        } else {
                            document.body.style.removeProperty("transform");
                        }

                        if (original.transformOrigin) {
                            document.body.style.transformOrigin = original.transformOrigin;
                        } else {
                            document.body.style.removeProperty("transform-origin");
                        }
                    }, originalStyles);
                } catch {
                    // Ignore cleanup errors
                }
            }
        }
    }

    /**
     * Calculate the bounding box and generate warnings if out of bounds.
     * Returns original and clamped position in absolute positioning.
     */
    private calculateBoundingBox(
        x: number,
        y: number,
        width: number,
        height: number,
        viewportWidth: number,
        viewportHeight: number,
        options: ConversionOptions,
    ): BoundingBoxResult {
        // Note: x, y are TOP-LEFT coordinates in relative space
        // Calculate center in relative space first
        const relativeCenterX = x + width / 2;
        const relativeCenterY = y + height / 2;

        // Convert center position with axis-specific scaling (correct for positions)
        const absoluteCenterX = options.toAbsoluteX(relativeCenterX);
        const absoluteCenterY = options.toAbsoluteY(relativeCenterY);

        // Convert dimensions with uniform scaling to preserve aspect ratio
        const absoluteWidth = options.toAbsoluteDimension(width);
        const absoluteHeight = options.toAbsoluteDimension(height);

        // Calculate top-left from center in absolute space
        const originalX = absoluteCenterX - absoluteWidth / 2;
        const originalY = absoluteCenterY - absoluteHeight / 2;
        const originalX2 = originalX + absoluteWidth;
        const originalY2 = originalY + absoluteHeight;

        // clamped values
        let clampedX = originalX;
        let clampedY = originalY;
        let clampedX2 = originalX2;
        let clampedY2 = originalY2;

        // Check if bounding box is within viewport
        const outOfView: string[] = [];

        if (clampedX < 0) {
            outOfView.push("left");

            clampedX2 = clampedX2 - clampedX;
            clampedX = 0;
        }

        if (clampedY < 0) {
            outOfView.push("top");

            clampedY2 = clampedY2 - clampedY;
            clampedY = 0;
        }

        if (clampedX2 > viewportWidth) {
            outOfView.push("right");

            clampedX = clampedX - (clampedX2 - viewportWidth);
            clampedX2 = viewportWidth;
        }

        if (clampedY2 > viewportHeight) {
            outOfView.push("bottom");

            clampedY = clampedY - (clampedY2 - viewportHeight);
            clampedY2 = viewportHeight;
        }

        // just in case, make sure they are not too large (X2 and Y2 already handled)
        if (clampedX < 0) {
            clampedX = 0;
        }

        if (clampedY < 0) {
            clampedY = 0;
        }

        // Generate warnings if out of bounds
        const warnings: string[] = [];
        if (outOfView.length > 0) {
            warnings.push(
                `Note: Bounding box position was adjusted to stay within viewport bounds (${outOfView.join(", ")} edge${outOfView.length > 1 ? "s" : ""}).`,
            );
        }

        return {
            original: {
                x: originalX,
                y: originalY,
                x2: originalX2,
                y2: originalY2,
                width: originalX2 - originalX,
                height: originalY2 - originalY,
                centerX: originalX + (originalX2 - originalX) / 2,
                centerY: originalY + (originalY2 - originalY) / 2,
            },
            clamped: {
                x: clampedX,
                y: clampedY,
                x2: clampedX2,
                y2: clampedY2,
                width: clampedX2 - clampedX,
                height: clampedY2 - clampedY,
                centerX: clampedX + (clampedX2 - clampedX) / 2,
                centerY: clampedY + (clampedY2 - clampedY) / 2,
            },
            relativeClamped: {
                x: options.toRelativeX(clampedX),
                y: options.toRelativeY(clampedY),
                x2: options.toRelativeX(clampedX2),
                y2: options.toRelativeY(clampedY2),
                width: options.toRelativeDimension(clampedX2 - clampedX),
                height: options.toRelativeDimension(clampedY2 - clampedY),
                centerX: options.toRelativeX(clampedX + (clampedX2 - clampedX) / 2),
                centerY: options.toRelativeY(clampedY + (clampedY2 - clampedY) / 2),
            },
            warnings,
        };
    }

    /**
     * Convert a coordinate to absolute pixels based on positioning type.
     */
    private toAbsolute(viewportDimension: number, axis: "x" | "y"): (pos: number) => number {
        if (this.ctx.positioning.type === "absolute") {
            return (pos) => pos;
        }

        const max = axis === "x" ? this.ctx.positioning.x : this.ctx.positioning.y;
        return (pos) => (pos * viewportDimension) / max;
    }

    /**
     * Convert a pixel value to relative coordinates based on positioning type.
     * Returns the value unchanged if using absolute positioning.
     */
    private toRelative(viewportDimension: number, axis: "x" | "y"): (pos: number) => number {
        if (this.ctx.positioning.type === "absolute") {
            return (pos) => pos;
        }

        const max = axis === "x" ? this.ctx.positioning.x : this.ctx.positioning.y;
        return (pos) => (pos * max) / viewportDimension;
    }

    /**
     * Convert a dimension to absolute pixels using uniform scaling (x-axis).
     * This preserves aspect ratio when converting width/height.
     */
    private toAbsoluteDimension(viewportWidth: number): (dim: number) => number {
        if (this.ctx.positioning.type === "absolute") {
            return (dim) => dim;
        }

        // Always use x-axis scale for dimensions to preserve aspect ratio
        const maxX = this.ctx.positioning.x;
        return (dim) => (dim * viewportWidth) / maxX;
    }

    /**
     * Convert a dimension to relative coordinates using uniform scaling (x-axis).
     */
    private toRelativeDimension(viewportWidth: number): (dim: number) => number {
        if (this.ctx.positioning.type === "absolute") {
            return (dim) => dim;
        }

        const maxX = this.ctx.positioning.x;
        return (dim) => (dim * maxX) / viewportWidth;
    }

    /**
     * Format a value as a string based on positioning type and configured precision.
     */
    private formatValue(value: number): string {
        const precision = this.ctx.config.coordinatePrecision ?? (this.ctx.positioning.type === "absolute" ? 0 : 2);

        if (this.ctx.positioning.type === "absolute") {
            return `${value.toFixed(precision)}px`;
        }

        return value.toFixed(precision);
    }
}
