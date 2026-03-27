import { OcrExtension, type OcrExtensionExecutionContext } from "./base";
import type { ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Page } from "puppeteer";

/**
 * An entry in the page history.
 */
export interface PageHistoryEntry {
    title: string;
    url: string;
    /** What caused this navigation (default: "direct") */
    source: string;
    /** For click/keyboard navigation, the tool call ID that caused it */
    toolCallId?: string;
}

/**
 * Callback fired when navigation occurs.
 */
export type NavigationCallback = (entry: PageHistoryEntry, historyIndex: number) => void | Promise<void>;

/**
 * Context needed for the navigation extension.
 */
export interface NavigationExtensionInit {
    page: Page;
    /** Callback(s) to fire when navigation occurs */
    onNavigate?: NavigationCallback | NavigationCallback[];
}

/**
 * Options for navigation methods.
 */
export interface NavigateOptions {
    /** Abort signal to cancel navigation */
    signal?: AbortSignal;
    /** Wait condition for page load (default: "domcontentloaded") */
    waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
}

/**
 * Callback for tools to notify navigation changes.
 */
export type NavigationNotifier = (entry: PageHistoryEntry, historyIndex: number) => void | Promise<void>;

/**
 * Extension that tracks page navigation and provides navigation context.
 *
 * Handles:
 * - Tracking page history (titles, URLs, and navigation sources)
 * - Detecting navigation from click/keyboard tool calls
 * - Providing navigation callback that tracks history automatically
 * - Navigating back through history
 * - Building navigation context for prompts
 * - Registering tools that can cause navigation dynamically
 */
export class NavigationExtension extends OcrExtension {
    readonly name = "navigation";

    private page: Page;
    private pageHistory: PageHistoryEntry[] = [];
    private historyIndex: number = -1;
    private callbacks: NavigationCallback[];
    /** URL before a tool call, used to detect navigation */
    private urlBeforeToolCall: string | undefined;
    /** Tool names that can cause navigation */
    private navigationToolNames: Set<string> = new Set(["click", "keyboard", "type"]);

    constructor(init: NavigationExtensionInit) {
        super();

        this.page = init.page;

        const onNavigate = init.onNavigate ?? [];
        this.callbacks = Array.isArray(onNavigate) ? onNavigate : [onNavigate];
    }

    async onInit(ctx: OcrExtensionExecutionContext): Promise<void> {
        // Initialize with current page
        const title = await this.page.title();
        const url = this.page.url();
        this.pageHistory = [{ title, url, source: "direct" }];
        this.historyIndex = 0;
        ctx.log?.(`[navigation] Initialized with page: ${title}`);
    }

    async onToolCall(_ctx: OcrExtensionExecutionContext, toolCall: ToolCall): Promise<ToolResultMessage | undefined> {
        // Store URL before tool execution to detect navigation
        if (this.navigationToolNames.has(toolCall.name)) {
            this.urlBeforeToolCall = this.page.url();
        }
        return undefined;
    }

    async onToolResult(
        ctx: OcrExtensionExecutionContext,
        toolCall: ToolCall,
        result: ToolResultMessage,
    ): Promise<void> {
        // Check if registered navigation tool caused navigation
        if (this.navigationToolNames.has(toolCall.name)) {
            const newUrl = this.page.url();

            if (this.urlBeforeToolCall !== undefined && this.urlBeforeToolCall !== newUrl) {
                // Truncate forward history if we're not at the end
                if (this.historyIndex < this.pageHistory.length - 1) {
                    this.pageHistory = this.pageHistory.slice(0, this.historyIndex + 1);
                }

                const source: string = toolCall.name;
                const title = await this.page.title();

                const entry: PageHistoryEntry = {
                    title,
                    url: newUrl,
                    source,
                    toolCallId: toolCall.id,
                };

                this.pageHistory.push(entry);
                this.historyIndex = this.pageHistory.length - 1;

                ctx.log?.(`[navigation] Navigation via ${source}: ${title} (${newUrl})`);

                // Append navigation info to the tool result so the model knows
                this.appendNavigationToResult(result, title, newUrl);

                await this.fireCallbacks(entry);
            }

            this.urlBeforeToolCall = undefined;
        }
    }

    /**
     * Append navigation information to a tool result message.
     */
    private appendNavigationToResult(result: ToolResultMessage, title: string, url: string): void {
        for (const content of result.content) {
            if (content.type === "text") {
                content.text += `\n\n**Navigated to new page:** ${title}\n**URL:** ${url}`;
                return;
            }
        }
        // No text content found, add one
        result.content.push({
            type: "text",
            text: `**Navigated to new page:** ${title}\n**URL:** ${url}`,
        });
    }

    // --- Public API ---

    /**
     * Register a callback to be fired when navigation occurs.
     */
    onNavigate(callback: NavigationCallback): void {
        this.callbacks.push(callback);
    }

    /**
     * Remove a registered callback.
     */
    offNavigate(callback: NavigationCallback): void {
        const index = this.callbacks.indexOf(callback);
        if (index !== -1) {
            this.callbacks.splice(index, 1);
        }
    }

    /**
     * Navigate to a URL and track it in history.
     * Truncates forward history if we're not at the end of the history.
     */
    async navigateTo(url: string, options?: NavigateOptions): Promise<void> {
        options?.signal?.throwIfAborted();

        await this.page.goto(url, {
            waitUntil: options?.waitUntil ?? "domcontentloaded",
            signal: options?.signal,
        });

        // Truncate forward history if we're not at the end
        if (this.historyIndex < this.pageHistory.length - 1) {
            this.pageHistory = this.pageHistory.slice(0, this.historyIndex + 1);
        }

        const title = await this.page.title();
        const entry: PageHistoryEntry = { title, url, source: "direct" };
        this.pageHistory.push(entry);
        this.historyIndex = this.pageHistory.length - 1;

        await this.fireCallbacks(entry);
    }

    /**
     * Go back in history by a delta amount.
     * @param delta - Number of steps to go back (default: 1)
     * @param options - Navigation options
     * @returns The history entry navigated to, or undefined if can't go that far back
     */
    async goBack(delta: number = 1, options?: NavigateOptions): Promise<PageHistoryEntry | undefined> {
        options?.signal?.throwIfAborted();

        const newIndex = this.historyIndex - delta;
        if (newIndex < 0) {
            return undefined;
        }

        this.historyIndex = newIndex;
        const entry = this.pageHistory[this.historyIndex];

        await this.page.goto(entry.url, {
            waitUntil: options?.waitUntil ?? "domcontentloaded",
            signal: options?.signal,
        });

        // Update the entry's source to "back" (don't add a new entry)
        entry.source = "back";

        await this.fireCallbacks(entry);
        return entry;
    }

    /**
     * Go forward in history by a delta amount.
     * @param delta - Number of steps to go forward (default: 1)
     * @param options - Navigation options
     * @returns The history entry navigated to, or undefined if can't go that far forward
     */
    async goForward(delta: number = 1, options?: NavigateOptions): Promise<PageHistoryEntry | undefined> {
        options?.signal?.throwIfAborted();

        const newIndex = this.historyIndex + delta;
        if (newIndex >= this.pageHistory.length) {
            return undefined;
        }

        this.historyIndex = newIndex;
        const entry = this.pageHistory[this.historyIndex];

        await this.page.goto(entry.url, {
            waitUntil: options?.waitUntil ?? "domcontentloaded",
            signal: options?.signal,
        });

        // Update the entry's source to "forward" (don't add a new entry)
        entry.source = "forward";

        await this.fireCallbacks(entry);
        return entry;
    }

    /**
     * Check if we can go back in history.
     */
    canGoBack(delta: number = 1): boolean {
        return this.historyIndex - delta >= 0;
    }

    /**
     * Check if we can go forward in history.
     */
    canGoForward(delta: number = 1): boolean {
        return this.historyIndex + delta < this.pageHistory.length;
    }

    /**
     * Get the current page entry.
     */
    getCurrentPage(): PageHistoryEntry | undefined {
        return this.pageHistory[this.historyIndex];
    }

    /**
     * Get the current navigation context for prompts.
     */
    async getNavigationContext(): Promise<string> {
        const currentTitle = await this.page.title();
        return this.buildNavigationContext(currentTitle);
    }

    /**
     * Get the current navigation context synchronously using cached data.
     */
    getNavigationContextSync(): string {
        // FIXME: unknown mostly shows up cause of the navigation
        const currentEntry = this.pageHistory[this.historyIndex];
        const currentTitle = currentEntry?.title ?? "Unknown";
        return this.buildNavigationContext(currentTitle);
    }

    /**
     * Build navigation context string.
     */
    private buildNavigationContext(currentTitle: string): string {
        let context = `**Current page:** ${currentTitle}\n**URL:** ${this.page.url()}`;

        if (this.pageHistory.length > 1) {
            const historyWithPosition = this.pageHistory.map((p, i) => {
                const entry = `${p.title} (${p.url}) [via ${p.source}]`;
                return i === this.historyIndex ? `${entry} <- current` : entry;
            });
            context += `\n**Navigation history:**\n${historyWithPosition.map((h) => `  - ${h}`).join("\n")}`;
        }

        return context;
    }

    /**
     * Get the current history index.
     */
    getHistoryIndex(): number {
        return this.historyIndex;
    }

    /**
     * Register a tool name as one that can cause navigation.
     * @param toolName - The name of the tool
     */
    registerNavigationTool(toolName: string): void {
        this.navigationToolNames.add(toolName);
    }

    /**
     * Unregister a tool name from navigation tracking.
     * @param toolName - The name of the tool
     */
    unregisterNavigationTool(toolName: string): void {
        this.navigationToolNames.delete(toolName);
    }

    /**
     * Check if a tool name is registered as causing navigation.
     * @param toolName - The name of the tool
     */
    isNavigationTool(toolName: string): boolean {
        return this.navigationToolNames.has(toolName);
    }

    /**
     * Get all registered navigation tool names.
     */
    getNavigationTools(): string[] {
        return Array.from(this.navigationToolNames);
    }

    // --- Helper methods ---

    private async fireCallbacks(entry: PageHistoryEntry): Promise<void> {
        for (const callback of this.callbacks) {
            await callback(entry, this.historyIndex);
        }
    }
}
