import { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Browser } from "puppeteer";

export interface ProviderSearchResult {
    title: string;
    url: string;
    snippet?: string;
    children?: ProviderSearchResult[];
}

export interface Provider<TConfig> {
    get type(): string;
    process(
        browser: Browser,
        query: string,
        ctx: ExtensionContext,
        signal?: AbortSignal,
    ): Promise<ProviderSearchResult[] | undefined>;
}
