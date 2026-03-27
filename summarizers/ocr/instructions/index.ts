import { Eta, EtaFileResolutionError, EtaNameResolutionError } from "eta";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Eta instance configured for instruction templates.
 * - Uses `<%~` for raw output (no HTML escaping)
 * - autoTrim: false to preserve newlines in templates
 *
 * @see cheatsheet.md for Eta syntax reference
 */
const eta = new Eta({
    views: __dirname,
    autoTrim: false,
});

/** Trim options for rendered templates */
export type TrimOption = "all" | "start" | "end";

/**
 * Render a template file with the given data.
 * @param templateName - Path to the template (without .eta extension)
 * @param data - Data to pass to the template
 * @param trim - How to trim whitespace: "all" (default), "start", or "end"
 * @throws EtaFileResolutionError or EtaNameResolutionError if template not found
 */
export function render(templateName: string, data: Record<string, unknown> = {}, trim: TrimOption = "all"): string {
    const result = eta.render(templateName, data) ?? "";

    switch (trim) {
        case "start":
            return result.trimStart();
        case "end":
            return result.trimEnd();
        case "all":
        default:
            return result.trim();
    }
}

/**
 * Render a template with fallback if the primary template is not found.
 * @param templateName - Primary template path (without .eta extension)
 * @param fallbackName - Fallback template path if primary not found
 * @param data - Data to pass to the template
 * @param trim - How to trim whitespace: "all" (default), "start", or "end"
 */
export function renderWithFallback(
    templateName: string,
    fallbackName: string,
    data: Record<string, unknown> = {},
    trim: TrimOption = "all",
): string {
    try {
        return render(templateName, data, trim);
    } catch (error) {
        if (isTemplateNotFoundError(error)) {
            return render(fallbackName, data, trim);
        }
        throw error;
    }
}

/**
 * Check if an error is a template resolution error (file not found or invalid name).
 */
export function isTemplateNotFoundError(error: unknown): boolean {
    return error instanceof EtaFileResolutionError || error instanceof EtaNameResolutionError;
}
