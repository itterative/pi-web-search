import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions, OcrToolValidationError } from "./base";
import { InteractionConfig, InteractionPositioning } from "../state";
import { formatMatchText } from "../../../common/utils";

interface FindToolParameters {
    role?: string;
    label?: string;
    text?: string;
    multiple?: boolean;
}

interface FindToolContext {
    page: Page;
    config: InteractionConfig;
    positioning: InteractionPositioning;
}

// Interactive element selectors focused on navigation and input
const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    "[role='button']",
    "[role='link']",
    "input[type='button']",
    "input[type='submit']",
    "input[type='reset']",
    "summary",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[role='textbox']",
    "[role='searchbox']",
    "[role='combobox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[contenteditable='true']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='option']",
    "[tabindex]",
    "[onclick]",
].join(", ");

// Map of common ARIA roles to CSS selectors
const ROLE_SELECTORS: Record<string, string> = {
    button: "button, [role='button'], input[type='button'], input[type='submit'], input[type='reset'], summary",
    link: "a[href], [role='link']",
    textbox: "input[type='search'], input[type='text'], textarea, [role='textbox'], [contenteditable='true']",
    searchbox: "input[type='search'], input[type='text'], [role='searchbox']",
    checkbox: "input[type='checkbox'], [role='checkbox']",
    radio: "input[type='radio'], [role='radio']",
    switch: "[role='switch']",
    combobox: "select, [role='combobox']",
    tab: "[role='tab']",
    menuitem: "[role='menuitem']",
    option: "option, [role='option']",
};

// Element type classification
type ElementType = "link" | "input" | "button" | "select" | "other";

interface ElementTypeInfo {
    type: ElementType;
    subtype?: string;
    href?: string;
    text?: string;
    label?: string;
    placeholder?: string;
    options?: string[];
}

export class FindTool extends OcrTool<FindToolContext> {
    constructor(ctx: FindToolContext, options?: OcrToolOptions) {
        super(
            {
                name: "find",
                description:
                    "Find interactive elements on the page (buttons, links, inputs, etc.) by role, label, or text. Returns element positions for use with the cursor tool.",
                promptSnippet: "find - Find interactive elements by role, label, or text",
                promptGuidelines:
                    "## find tool\n" +
                    "- Use to locate interactive elements before interacting with them\n" +
                    "- Search by `role` (button, link, textbox, searchbox, checkbox, radio, switch, combobox, tab, menuitem, option)\n" +
                    "- Search by `label` for accessible names (aria-label, label element, placeholder, title)\n" +
                    "- Search by `text` for visible text content\n" +
                    "- Set `multiple=true` to get all matches; otherwise fails if multiple found\n" +
                    "- Returns positions formatted for the cursor tool\n" +
                    "- Use results to move cursor before clicking or typing",
                parameters: Type.Object({
                    role: Type.Optional(
                        Type.String({
                            description:
                                "ARIA role: button, link, textbox, searchbox, checkbox, radio, switch, combobox, tab, menuitem, option",
                        }),
                    ),
                    label: Type.Optional(
                        Type.String({
                            description:
                                "Accessible label to match (aria-label, label element, placeholder, title). Case-insensitive partial match.",
                        }),
                    ),
                    text: Type.Optional(
                        Type.String({
                            description: "Text content to match. Case-insensitive partial match.",
                        }),
                    ),
                    multiple: Type.Optional(
                        Type.Boolean({
                            description: "If true, returns all matches. If false (default), fails if multiple found.",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: FindToolParameters): Promise<ToolResultMessage> {
        const { role, label, text, multiple = false } = args;

        if (!role && !label && !text) {
            throw new OcrToolValidationError("At least one of 'role', 'label', or 'text' must be provided");
        }

        context.updateUI?.({ message: this.getUserMessage(args) });

        let selector: string = "";
        try {
            selector = role ? ROLE_SELECTORS[role.toLowerCase()] || `[role='${role}']` : INTERACTIVE_SELECTOR;
        } catch (e) {
            // caught below
        }

        if (!selector) {
            return this.simpleTextFailureMessage(
                context,
                `Internal error, failed finding any elements for the role: ${role}`,
            );
        }

        const elements = await this.ctx.page.$$(selector);
        const matches: FoundElement[] = [];

        for (const el of elements) {
            const info = await el.evaluate((e) => {
                try {
                    const style = window.getComputedStyle(e);
                    const rect = e.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;
                    const viewportHeight = window.innerHeight;

                    // Check basic visibility
                    const isVisible =
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        style.opacity !== "0" &&
                        rect.width > 0 &&
                        rect.height > 0;

                    if (!isVisible) return null;

                    // Check if element center is within viewport (clickable)
                    const centerX = rect.x + rect.width / 2;
                    const centerY = rect.y + rect.height / 2;
                    const isClickable =
                        centerX >= 0 && centerX <= viewportWidth && centerY >= 0 && centerY <= viewportHeight;

                    if (!isClickable) return null;

                    const labelledBy = e.getAttribute("aria-labelledby");
                    const label = (
                        e.getAttribute("aria-label") ||
                        (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ||
                        (e as HTMLInputElement).labels?.[0]?.textContent ||
                        e.getAttribute("placeholder") ||
                        e.getAttribute("title") ||
                        ""
                    ).trim();

                    const content = (e.textContent || "").trim();
                    const value = (e as HTMLInputElement).value || "";

                    // Determine element type
                    let typeInfo: ElementTypeInfo = { type: "other" };

                    // Check for link
                    if (e.tagName === "A" || e.getAttribute("role") === "link") {
                        typeInfo = {
                            type: "link",
                            href: (e as HTMLAnchorElement).href || undefined,
                            text: content.substring(0, 100) || undefined,
                        };
                    }
                    // Check for button
                    else if (
                        e.tagName === "BUTTON" ||
                        e.getAttribute("role") === "button" ||
                        (e.tagName === "INPUT" && ["button", "submit", "reset"].includes((e as HTMLInputElement).type))
                    ) {
                        typeInfo = {
                            type: "button",
                            subtype: (e as HTMLButtonElement).type || undefined,
                            text: content.substring(0, 100) || value || undefined,
                        };
                    }
                    // Check for select
                    else if (e.tagName === "SELECT" || e.getAttribute("role") === "combobox") {
                        const selectEl = e as HTMLSelectElement;
                        const options = Array.from(selectEl.options)
                            .slice(0, 10)
                            .map((opt) => opt.text)
                            .filter(Boolean);
                        typeInfo = {
                            type: "select",
                            label: label || undefined,
                            placeholder: selectEl.getAttribute("placeholder") || undefined,
                            options: options.length > 0 ? options : undefined,
                        };
                    }
                    // Check for input/textarea
                    else if (
                        e.tagName === "INPUT" ||
                        e.tagName === "TEXTAREA" ||
                        e.getAttribute("role") === "textbox" ||
                        e.getAttribute("contenteditable") === "true"
                    ) {
                        const inputEl = e as HTMLInputElement;
                        typeInfo = {
                            type: "input",
                            subtype: inputEl.type || "text",
                            label: label || undefined,
                            placeholder: inputEl.placeholder || undefined,
                        };
                    }
                    // Other interactive elements
                    else {
                        typeInfo = {
                            type: "other",
                            text: content.substring(0, 100) || undefined,
                        };
                    }

                    // Helper to format text (inlined since we're in browser context)
                    const formatText = (t: string, maxLen: number = 50) => {
                        const lines = t.split("\n");
                        let result = lines.length > 1 ? lines[0] : t;
                        if (result.length > maxLen + 3) {
                            result = result.substring(0, maxLen) + "...";
                        }
                        if (lines.length > 1) {
                            result = `${result} [+${lines.length - 1} line(s)]`;
                        }
                        return result;
                    };

                    return {
                        label,
                        text: formatText(content),
                        value: formatText(value),
                        rect: {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                        },
                        viewport: { width: viewportWidth, height: viewportHeight },
                        typeInfo,
                    };
                } catch {
                    // FIXME: log this later
                    return null;
                }
            });

            if (!info) {
                continue;
            }

            if (label && !info.label.toLowerCase().includes(label.toLowerCase())) {
                continue;
            }

            if (text) {
                const searchText = `${info.label} ${info.text} ${info.value}`.toLowerCase();
                if (!searchText.includes(text.toLowerCase())) {
                    continue;
                }
            }

            const posX = info.rect.x + info.rect.width / 2;
            const posY = info.rect.y + info.rect.height / 2;

            let x: number, y: number;
            if (this.ctx.positioning.type === "absolute") {
                x = posX;
                y = posY;
            } else {
                x = (posX / info.viewport.width) * this.ctx.positioning.x;
                y = (posY / info.viewport.height) * this.ctx.positioning.y;
            }

            matches.push({
                label: info.label || undefined,
                text: info.text || undefined,
                x,
                y,
                typeInfo: info.typeInfo,
            });
        }

        if (matches.length === 0) {
            return this.simpleTextFailureMessage(
                context,
                `No visible elements found matching: ${this.formatCriteria(args)}`,
            );
        }

        if (matches.length > 1 && !multiple) {
            const max = this.ctx.config.maxTextMatchResults;
            const list = matches
                .slice(0, max)
                .map((m, i) => this.formatElement(i + 1, m))
                .join("\n\n");
            return this.simpleTextFailureMessage(
                context,
                `Found ${matches.length} elements. Set multiple=true for all results.\n\n${list}${matches.length > max ? `\n\n... and ${matches.length - max} more` : ""}`,
            );
        }

        const max = this.ctx.config.maxTextMatchResults;
        const list = matches
            .slice(0, max)
            .map((m, i) => this.formatElement(i + 1, m))
            .join("\n\n");
        const message =
            matches.length === 1
                ? `Found element:\n\n${list}`
                : `Found ${matches.length} elements:\n\n${list}${matches.length > max ? `\n\n... and ${matches.length - max} more` : ""}`;

        return this.simpleTextSuccessMessage(context, message);
    }

    private formatCriteria(args: FindToolParameters): string {
        const parts: string[] = [];
        if (args.role) parts.push(`role="${args.role}"`);
        if (args.label) parts.push(`label~="${args.label}"`);
        if (args.text) parts.push(`text~="${args.text}"`);
        return parts.join(", ");
    }

    private formatElement(index: number, el: FoundElement): string {
        const coordStr = `(${el.x.toFixed(2)}, ${el.y.toFixed(2)})`;
        const typeInfo = el.typeInfo;
        const parts: string[] = [];

        // Format based on element type
        switch (typeInfo.type) {
            case "link":
                parts.push(`${index}. **Link** at ${coordStr}`);
                if (typeInfo.text) parts.push(`   Text: "${typeInfo.text}"`);
                if (typeInfo.href) parts.push(`   URL: ${typeInfo.href}`);
                break;

            case "button":
                parts.push(`${index}. **Button**${typeInfo.subtype ? ` [${typeInfo.subtype}]` : ""} at ${coordStr}`);
                if (typeInfo.text) parts.push(`   Text: "${typeInfo.text}"`);
                break;

            case "select":
                parts.push(`${index}. **Select** at ${coordStr}`);
                if (typeInfo.label) parts.push(`   Label: "${typeInfo.label}"`);
                if (typeInfo.placeholder) parts.push(`   Placeholder: "${typeInfo.placeholder}"`);
                if (typeInfo.options && typeInfo.options.length > 0) {
                    const opts = typeInfo.options.slice(0, 5).join(", ");
                    const more = typeInfo.options.length > 5 ? "..." : "";
                    parts.push(`   Options: ${opts}${more}`);
                }
                break;

            case "input":
                parts.push(`${index}. **Input** [${typeInfo.subtype || "text"}] at ${coordStr}`);
                if (typeInfo.label) parts.push(`   Label: "${typeInfo.label}"`);
                if (typeInfo.placeholder) parts.push(`   Placeholder: "${typeInfo.placeholder}"`);
                break;

            default:
                parts.push(`${index}. **Element** at ${coordStr}`);
                if (typeInfo.text) parts.push(`   Text: "${typeInfo.text}"`);
                break;
        }

        return parts.join("\n");
    }

    private getUserMessage(args: FindToolParameters): string {
        return `Finding: ${this.formatCriteria(args)}...`;
    }
}

interface FoundElement {
    label?: string;
    text?: string;
    x: number;
    y: number;
    typeInfo: ElementTypeInfo;
}
