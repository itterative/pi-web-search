import fs from "node:fs";
import path from "node:path";

import {
    KAGI_SESSION_TOKEN,
    WEBSEARCH_CONFIG_FILE_NAME,
    WEBSEARCH_CONFIG_PATH,
    WEBSEARCH_CONFIG_PATH_GLOBAL,
    WEBSEARCH_PROVIDER,
} from "./constants";

/**
 * Get the global config path, with environment variable override for testing.
 */
function getGlobalConfigPath(): string | undefined {
    return process.env.WEBSEARCH_CONFIG_PATH_GLOBAL ?? WEBSEARCH_CONFIG_PATH_GLOBAL;
}

interface EnvOverrides {
    search?: Partial<SearchConfig>;
    fetch?: Partial<FetchConfig> & { model?: Partial<FetchModelConfig> };
    providers?: {
        "kagi-web"?: Partial<KagiWebProviderConfig>;
        "duckduckgo-web"?: Partial<DuckDuckGoWebProviderConfig>;
    };
}

/**
 * Environment variables that can override config values.
 * Priority: env > project config > user config > defaults
 */
function getEnvOverrides(): EnvOverrides {
    const env: EnvOverrides = {};

    // Search provider
    if (WEBSEARCH_PROVIDER) {
        env.search = {
            provider: WEBSEARCH_PROVIDER as SearchProvider,
        };
    }

    // Kagi session token
    if (KAGI_SESSION_TOKEN) {
        env.providers = {
            ...env.providers,
            "kagi-web": {
                ...env.providers?.["kagi-web"],
                sessionToken: KAGI_SESSION_TOKEN,
            },
        };
    }

    return env;
}

/**
 * Provider types supported by the web-search tool.
 */
export type SearchProvider = "kagi-web" | "duckduckgo-web";

/**
 * Configuration for the web-search tool.
 */
export interface SearchConfig {
    /** Which search provider to use */
    provider: SearchProvider;
    /** Whether to summarize the top search result using an LLM */
    summarizeTopResult: boolean;
    /** Maximum number of search results to return */
    maxResults: number;
}

/**
 * Model configuration for fetch summarization.
 */
export interface FetchModelConfig {
    /** Provider name, e.g., "anthropic", "openai" */
    provider: string;
    /** Model identifier, e.g., "claude-3-haiku-20240307" */
    modelId: string;
}

/**
 * Configuration for the web-fetch tool.
 */
export interface FetchConfig {
    /** Model to use for content summarization */
    model: FetchModelConfig;
    /** Whether to use OCR for image-based content */
    useOcr: boolean;
    /** Screenshot viewport width in pixels (default: 1280) */
    screenshotWidth?: number;
    /** Maximum screenshot height in pixels (prevents huge screenshots) */
    screenshotMaxHeight?: number;
    /** Maximum content length to process, in characters */
    maxContentLength: number;
    /** Maximum number of interaction rounds (model can click/scroll before summarizing) */
    interactionRounds?: number;
    /** Milliseconds to wait after interactions for content to load */
    interactionDelay?: number;
    /** Maximum iterations for captcha solving (default: 20) */
    captchaMaxIterations?: number;
    /** Context usage threshold for checkpointing (0.0-1.0, default: 0.8) */
    checkpointThreshold?: number;
}

/**
 * Kagi web search provider configuration.
 * Requires a session token from kagi.com (obtained via /kagi-login command).
 */
export interface KagiWebProviderConfig {
    /** Session token from kagi.com authentication cookie */
    sessionToken: string;
    /** Optional lens ID to filter results through a custom Kagi lens */
    lenseId?: number;
    /** Override maxResults for this provider specifically */
    maxResults?: number;
}

/**
 * DuckDuckGo web search provider configuration.
 */
export interface DuckDuckGoWebProviderConfig {
    /** Maximum number of search results to return */
    maxResults: number;
}

/**
 * All provider-specific configurations.
 * Keys match the SearchProvider type for easy lookup.
 */
export interface ProvidersConfig {
    "kagi-web": KagiWebProviderConfig;
    "duckduckgo-web": DuckDuckGoWebProviderConfig;
}

/**
 * Root configuration for the pi-web-search extension.
 *
 * @example
 * ```json
 * {
 *   "search": {
 *     "provider": "kagi-web",
 *     "summarizeTopResult": true,
 *     "maxResults": 10
 *   },
 *   "fetch": {
 *     "model": {
 *       "provider": "anthropic",
 *       "modelId": "claude-3-haiku-20240307"
 *     },
 *     "useOcr": true,
 *     "maxContentLength": 50000
 *   },
 *   "providers": {
 *     "kagi-web": {
 *       "sessionToken": "your-token-here"
 *     }
 *   }
 * }
 * ```
 */
export interface WebSearchConfig {
    /** Web search tool configuration */
    search: SearchConfig;
    /** Web fetch tool configuration */
    fetch: FetchConfig;
    /** Provider-specific credentials and settings */
    providers: ProvidersConfig;
}

/**
 * Extract the config type for a specific search provider.
 * @example
 * type KagiConfig = ProviderConfig<"kagi-web">; // => KagiWebProviderConfig
 */
export type ProviderConfig<T extends SearchProvider> = ProvidersConfig[T];

function tryLoad(configPath: string): Partial<WebSearchConfig> | null {
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));

        if (!data || typeof data !== "object") {
            return null;
        }

        return data as Partial<WebSearchConfig>;
    } catch {
        return null;
    }
}

function findConfigLocations(cwd: string): {
    global: string | null;
    project: string | null;
} {
    let projectConfig: string | null = null;

    // Check for project config in directory tree
    let currentFolder = cwd;
    for (let i = 0; i < 20; i++) {
        if (!currentFolder) {
            break;
        }

        const configPath = path.join(currentFolder, ".pi", WEBSEARCH_CONFIG_FILE_NAME);

        if (fs.existsSync(configPath)) {
            projectConfig = configPath;
            break;
        }

        const parentFolder = path.dirname(currentFolder);

        if (parentFolder === currentFolder) {
            break;
        }

        currentFolder = parentFolder;
    }

    // Also check WEBSEARCH_CONFIG_PATH as fallback project config
    if (!projectConfig && WEBSEARCH_CONFIG_PATH) {
        projectConfig = WEBSEARCH_CONFIG_PATH;
    }

    return {
        global: getGlobalConfigPath() ?? null,
        project: projectConfig,
    };
}

let _config: WebSearchConfig | null = null;

/**
 * Returns the default configuration with sensible defaults.
 */
function defaultConfig(): WebSearchConfig {
    return {
        search: {
            provider: "duckduckgo-web",
            summarizeTopResult: false,
            maxResults: 10,
        },
        fetch: {
            model: {
                provider: "",
                modelId: "",
            },
            useOcr: false,
            screenshotWidth: 720,
            screenshotMaxHeight: 3000,
            maxContentLength: 50000,
            interactionRounds: 0,
            interactionDelay: 500,
            captchaMaxIterations: 20,
            checkpointThreshold: 0.6,
        },
        providers: {
            "kagi-web": {
                sessionToken: "",
            },
            "duckduckgo-web": {
                maxResults: 10,
            },
        },
    };
}

/**
 * Merges configs in order of priority (lowest to highest):
 * defaults → user config → project config → env variables
 */
function mergeConfigs(
    defaults: WebSearchConfig,
    user: Partial<WebSearchConfig> | null,
    project: Partial<WebSearchConfig> | null,
    env: EnvOverrides,
): WebSearchConfig {
    // Start with defaults
    let result = defaults;

    // Apply user config
    if (user) {
        result = deepMerge(result, user);
    }

    // Apply project config
    if (project) {
        result = deepMerge(result, project);
    }

    // Apply env overrides
    if (env.search) {
        result = {
            ...result,
            search: { ...result.search, ...env.search },
        };
    }
    if (env.fetch) {
        result = {
            ...result,
            fetch: {
                ...result.fetch,
                ...env.fetch,
                ...(env.fetch.model && {
                    model: { ...result.fetch.model, ...env.fetch.model },
                }),
            },
        };
    }
    if (env.providers) {
        result = {
            ...result,
            providers: {
                ...result.providers,
                ...(env.providers["kagi-web"] && {
                    "kagi-web": {
                        ...result.providers["kagi-web"],
                        ...env.providers["kagi-web"],
                    },
                }),
                ...(env.providers["duckduckgo-web"] && {
                    "duckduckgo-web": {
                        ...result.providers["duckduckgo-web"],
                        ...env.providers["duckduckgo-web"],
                    },
                }),
            },
        };
    }

    return result;
}

/**
 * Deep merge two config objects, with override taking precedence.
 */
function deepMerge(base: WebSearchConfig, override: Partial<WebSearchConfig>): WebSearchConfig {
    return {
        search: { ...base.search, ...override.search },
        fetch: {
            ...base.fetch,
            ...override.fetch,
            model: override.fetch?.model ?? base.fetch.model,
        },
        providers: {
            ...base.providers,
            ...override.providers,
            "kagi-web": {
                ...base.providers["kagi-web"],
                ...override.providers?.["kagi-web"],
            },
            "duckduckgo-web": {
                ...base.providers["duckduckgo-web"],
                ...override.providers?.["duckduckgo-web"],
            },
        },
    };
}

export default {
    get default(): WebSearchConfig {
        return defaultConfig();
    },

    get current(): WebSearchConfig {
        if (_config === null) {
            const locations = findConfigLocations(process.cwd());
            const userConfig = locations.global ? tryLoad(locations.global) : null;
            const projectConfig = locations.project ? tryLoad(locations.project) : null;
            const envOverrides = getEnvOverrides();

            _config = mergeConfigs(defaultConfig(), userConfig, projectConfig, envOverrides);
        }

        return _config;
    },

    load(cwd: string): WebSearchConfig {
        const locations = findConfigLocations(cwd);
        const userConfig = locations.global ? tryLoad(locations.global) : null;
        const projectConfig = locations.project ? tryLoad(locations.project) : null;
        const envOverrides = getEnvOverrides();

        _config = mergeConfigs(defaultConfig(), userConfig, projectConfig, envOverrides);
        return _config;
    },

    save(config: Partial<WebSearchConfig>, cwd?: string) {
        cwd = cwd ?? process.cwd();
        const locations = findConfigLocations(cwd);

        const config_path = locations.project ?? locations.global ?? WEBSEARCH_CONFIG_PATH ?? getGlobalConfigPath();

        if (!config_path) {
            throw new Error("no config path available for saving");
        }

        if (!fs.existsSync(config_path)) {
            fs.mkdirSync(path.dirname(config_path), {
                recursive: true,
                mode: 0o640,
            });
        }

        let newConfig: WebSearchConfig = _config ?? defaultConfig();
        newConfig = Object.assign(newConfig, config);

        fs.writeFileSync(config_path, JSON.stringify(newConfig), {
            mode: 0o600,
        });

        _config = newConfig;
        return _config;
    },
};
