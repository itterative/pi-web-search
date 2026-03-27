import os from "node:os";
import path from "node:path";

export const WEBSEARCH_CONFIG_FILE_NAME = "web-search-config.json";

/** Global config path (user-level, e.g., ~/.pi/web-search-config.json) */
export const WEBSEARCH_CONFIG_PATH_GLOBAL = path.join(os.homedir(), ".pi", WEBSEARCH_CONFIG_FILE_NAME);

/** Project config path override via environment variable */
export const WEBSEARCH_CONFIG_PATH = process.env.WEBSEARCH_CONFIG_PATH;

/** Kagi session token (for authentication via cookie) */
export const KAGI_SESSION_TOKEN = process.env.KAGI_SESSION_TOKEN;

/** Search provider override (e.g., "kagi-web", "duckduckgo-web") */
export const WEBSEARCH_PROVIDER = process.env.WEBSEARCH_PROVIDER;
