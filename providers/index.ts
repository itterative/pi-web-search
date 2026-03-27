import { Provider, ProviderSearchResult } from "./base";
import { DuckDuckGoWebProvider } from "./duckduckgo-web";
import { KagiWebProvider } from "./kagi-web";

// Re-export types
export { Provider, ProviderSearchResult } from "./base";
export { DuckDuckGoWebProvider } from "./duckduckgo-web";
export { KagiWebProvider } from "./kagi-web";

/** Provider registry and lookup functions */
export const providers: Record<string, Provider<unknown>[]> = {
    "duckduckgo-web": [new DuckDuckGoWebProvider()],
    "kagi-web": [new KagiWebProvider()],
};

/**
 * Get all providers for a given type.
 * Returns an empty array if no providers are registered for the type.
 */
export function getProviders(type: string): Provider<unknown>[] {
    return providers[type] ?? [];
}

/**
 * Get the first (default) provider for a given type.
 * Returns undefined if no providers are registered for the type.
 */
export function getProvider(type: string): Provider<unknown> | undefined {
    return providers[type]?.[0];
}

/**
 * Register a new provider implementation for a type.
 * Newly registered providers are added to the end of the list.
 */
export function registerProvider(provider: Provider<unknown>): void {
    const type = provider.type;
    if (!providers[type]) {
        providers[type] = [];
    }
    providers[type].push(provider);
}
