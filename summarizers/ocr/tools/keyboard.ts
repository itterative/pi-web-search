import { ToolResultMessage, Type } from "@mariozechner/pi-ai";
import { KeyInput, Page } from "puppeteer";

import { OcrTool, OcrToolExecutionContext, OcrToolOptions, OcrToolValidationError } from "./base";
import { sleep } from "../../../common/utils";
import { InteractionConfig } from "../state";
import { NavigationExtension } from "../extensions/navigation";

interface KeyboardToolParameters {
    key: string;
    modifiers?: ("Alt" | "Control" | "Meta" | "Shift")[];
    repeat?: number;
}

interface KeyboardToolContext {
    config: InteractionConfig;
    page: Page;
    navigationExtension: NavigationExtension;
}

// Valid keys for keyboard input (subset of puppeteer KeyInput)
const VALID_KEYS: ReadonlySet<string> = new Set([
    // Navigation keys
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    // Action keys
    "Tab",
    "Enter",
    "Escape",
    "Space",
    "Backspace",
    "Delete",
    "Insert",
    // Function keys
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
]);

const VALID_MODIFIERS: ReadonlySet<string> = new Set(["Alt", "Control", "Meta", "Shift"]);

function isValidKey(key: string): boolean {
    // Check if it's a known special key
    if (VALID_KEYS.has(key)) {
        return true;
    }
    // Single character keys are valid (a-z, A-Z, 0-9, symbols)
    if (key.length === 1) {
        return true;
    }
    return false;
}

export class KeyboardTool extends OcrTool<KeyboardToolContext> {
    constructor(ctx: KeyboardToolContext, options?: OcrToolOptions) {
        // Register this tool as capable of causing navigation
        ctx.navigationExtension.registerNavigationTool("keyboard");

        super(
            {
                name: "keyboard",
                description:
                    "Send keyboard input to the page. Use this for keyboard navigation (arrow keys, tab, etc.) or keyboard shortcuts. Examples: ArrowLeft/ArrowRight to navigate galleries, Tab to move focus, Escape to close modals.",
                promptSnippet: "keyboard - Send keystrokes (arrows, tab, escape, shortcuts)",
                promptGuidelines:
                    "## keyboard tool\n" +
                    "- Send keyboard input for navigation and shortcuts\n" +
                    "- `key`: the key to press\n" +
                    "  - Navigation: ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Home, End, PageUp, PageDown\n" +
                    "  - Actions: Tab, Enter, Escape, Space, Backspace, Delete\n" +
                    "  - Single characters: a-z, 0-9, symbols\n" +
                    "- `modifiers`: hold keys while pressing (Alt, Control, Meta, Shift)\n" +
                    '  - Example: `key="c", modifiers=["Control"]` for Ctrl+C\n' +
                    "- `repeat`: press key multiple times (e.g., repeat=3 for 3 arrow presses)\n" +
                    "- Use for: gallery navigation, closing modals (Escape), keyboard shortcuts",
                parameters: Type.Object({
                    key: Type.String({
                        description:
                            "The key to press. Examples: 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape', 'Space', 'Home', 'End', 'PageUp', 'PageDown'. For regular keys, just use the character (e.g., 'a', '1').",
                    }),
                    modifiers: Type.Optional(
                        Type.Array(
                            Type.Union([
                                Type.Literal("Alt"),
                                Type.Literal("Control"),
                                Type.Literal("Meta"),
                                Type.Literal("Shift"),
                            ]),
                            {
                                description:
                                    "Modifier keys to hold while pressing. E.g., ['Control'] for Ctrl+key shortcuts.",
                            },
                        ),
                    ),
                    repeat: Type.Optional(
                        Type.Number({
                            description: "Number of times to press the key (default: 1)",
                        }),
                    ),
                }),
            },
            ctx,
            options,
        );
    }

    async execute(context: OcrToolExecutionContext, args: KeyboardToolParameters): Promise<ToolResultMessage> {
        const { key, modifiers = [], repeat = 1 } = args;

        // Validate key
        if (!key || typeof key !== "string") {
            throw new OcrToolValidationError("Key is required and must be a string");
        }

        if (!isValidKey(key)) {
            throw new OcrToolValidationError(
                `Invalid key: '${key}'. Use navigation keys (ArrowLeft, ArrowRight, etc.), action keys (Tab, Enter, Escape, etc.), or single characters.`,
            );
        }

        // Validate modifiers
        const invalidModifiers = modifiers.filter((m) => !VALID_MODIFIERS.has(m));
        if (invalidModifiers.length > 0) {
            throw new OcrToolValidationError(
                `Invalid modifier(s): ${invalidModifiers.join(", ")}. Valid modifiers: Alt, Control, Meta, Shift`,
            );
        }

        // Clamp repeat to reasonable range
        const clampedRepeat = Math.min(Math.max(1, Math.floor(repeat)), 20);

        const modifierStr = modifiers.length > 0 ? `${modifiers.join("+")}+` : "";
        const repeatStr = clampedRepeat > 1 ? ` (${clampedRepeat}x)` : "";
        const keyDesc = `${modifierStr}${key}${repeatStr}`;

        context.updateUI?.({ message: `Pressing ${keyDesc}...` });

        for (let i = 0; i < clampedRepeat; i++) {
            // Press modifier keys down first
            for (const mod of modifiers) {
                await this.ctx.page.keyboard.down(mod as KeyInput);
            }

            // Press the main key
            await this.ctx.page.keyboard.press(key as KeyInput);

            // Release modifier keys
            for (const mod of modifiers) {
                await this.ctx.page.keyboard.up(mod as KeyInput);
            }

            if (i < clampedRepeat - 1) {
                await sleep(100, context.signal); // Small delay between repeats
            }
        }

        await this.waitForNetworkIdleAfterInteraction(context);

        return this.screenshotPlaceholderSuccessMessage(context, `Pressed ${keyDesc}`);
    }
}
