import { Eta, EtaFileResolutionError, EtaNameResolutionError } from "eta";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Eta instance configured for outline instruction templates.
 * - Uses `<%~` for raw output (no HTML escaping)
 * - autoTrim: false to preserve newlines in templates
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
