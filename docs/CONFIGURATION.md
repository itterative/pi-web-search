# Configuration Reference

Configuration file: `~/.pi/web-search-config.json` (global) or `.pi/web-search-config.json` (project).

Add the `$schema` property to enable autocomplete and validation in your editor:

```json
{
    "$schema": "https://raw.githubusercontent.com/itterative/pi-web-search/refs/heads/main/docs/schema.json"
}
```

Priority: environment variables > project config > global config > defaults

## Full Example

```json
{
    "search": {
        "provider": "kagi-web",
        "summarizeTopResult": true,
        "maxResults": 10
    },
    "fetch": {
        "model": {
            "provider": "anthropic",
            "modelId": "claude-3-haiku-20240307"
        },
        "useOcr": true,
        "screenshotWidth": 1280,
        "screenshotMaxHeight": 3000,
        "maxContentLength": 50000
    },
    "providers": {
        "kagi-web": {
            "sessionToken": "your-token-here",
            "lenseId": 12345
        },
        "duckduckgo-web": {
            "maxResults": 10
        }
    }
}
```

## Search Configuration

| Option               | Type                               | Default            | Description                    |
| -------------------- | ---------------------------------- | ------------------ | ------------------------------ |
| `provider`           | `"kagi-web"` \| `"duckduckgo-web"` | `"duckduckgo-web"` | Search provider to use         |
| `summarizeTopResult` | boolean                            | `false`            | Summarize top result using LLM |
| `maxResults`         | number                             | `10`               | Maximum results to return      |

## Fetch Configuration

| Option                 | Type    | Default | Description                                         |
| ---------------------- | ------- | ------- | --------------------------------------------------- |
| `model.provider`       | string  | `""`    | LLM provider (e.g., `"anthropic"`)                  |
| `model.modelId`        | string  | `""`    | Model ID (e.g., `"claude-3-haiku-20240307"`)        |
| `useOcr`               | boolean | `false` | Enable OCR for image-based content                  |
| `screenshotWidth`      | number  | `720`   | Viewport width in pixels (used as 1280 for OCR)     |
| `screenshotMaxHeight`  | number  | `3000`  | Max screenshot height                               |
| `maxContentLength`     | number  | `50000` | Max content length in chars                         |
| `interactionRounds`    | number  | `0`     | Click/scroll rounds before summarizing              |
| `interactionDelay`     | number  | `500`   | Delay after interactions (ms)                       |
| `captchaMaxIterations` | number  | `20`    | Max captcha solving iterations                      |
| `checkpointThreshold`  | number  | `0.6`   | Context usage threshold for checkpointing (0.0-1.0) |
| `outlineThreshold`     | number  | `30000` | Character count to trigger outline-based selection for large pages |
| `maxSelectionRetries`  | number  | `3`     | Max retries for model section selection JSON parsing |

**Note**: When `useOcr` is true, the effective viewport width is `max(screenshotWidth, 1280)`. The `checkpointThreshold` default is 0.6 in the config, but the OCR summarizer uses 0.8 internally when not specified.

### Large Page Handling

When the `markdown-html` summarizer extracts content exceeding `outlineThreshold` characters (default: 30,000), it switches from a single LLM call to a two-phase approach:

1. **Phase 1 — Extract outline**: The page DOM is split into sections of 5k–20k characters. The model receives an outline (preview text + char counts) and selects relevant section indices.
2. **Phase 2 — Process selected content**: Only selected sections are extracted and sent to the model for summarization/extraction.

This prevents large pages (e.g., Wikipedia articles) from exceeding model context windows.

## Provider Configuration

### Kagi (`kagi-web`)

| Option         | Type   | Required | Description                        |
| -------------- | ------ | -------- | ---------------------------------- |
| `sessionToken` | string | Yes      | Session token from kagi.com cookie |
| `lenseId`      | number | No       | Custom lens ID for filtering       |
| `maxResults`   | number | No       | Override global maxResults         |

To get your session token:

1. Log in to kagi.com
2. Open browser dev tools → Application → Cookies
3. Copy the value of the `kagi_session` cookie

### DuckDuckGo (`duckduckgo-web`)

| Option       | Type   | Required | Description                             |
| ------------ | ------ | -------- | --------------------------------------- |
| `maxResults` | number | No       | Maximum results to return (default: 10) |

## Environment Variables

| Variable                          | Description                                        |
| --------------------------------- | -------------------------------------------------- |
| `KAGI_SESSION_TOKEN`              | Kagi authentication token                          |
| `WEBSEARCH_PROVIDER`              | Override provider (`kagi-web`, `duckduckgo-web`)   |
| `WEBSEARCH_CONFIG_PATH`           | Custom project config path                         |
| `WEBSEARCH_CONFIG_PATH_GLOBAL`    | Custom global config path                          |
| `PI_WEB_SEARCH_DEBUG`             | Enable debug logging (`"1"` or `"true"`)           |
| `PI_WEB_SEARCH_DEBUG_SCREENSHOTS` | Enable debug screenshot saving (`"1"` or `"true"`) |
| `PI_WEB_SEARCH_DEBUG_DIR`         | Debug output directory (default: `"debug"`)        |

## Fetch Modes

The `web-fetch` tool supports three modes:

- **summarize** (default) - Returns an LLM-generated summary
- **full** - Returns complete page content without summarization
- **instruct** - Interactive exploration following a specific instruction (requires `instruction` parameter)
