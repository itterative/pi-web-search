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

| Option                 | Type    | Default | Description                                  |
| ---------------------- | ------- | ------- | -------------------------------------------- |
| `model.provider`       | string  | `""`    | LLM provider (e.g., `"anthropic"`)           |
| `model.modelId`        | string  | `""`    | Model ID (e.g., `"claude-3-haiku-20240307"`) |
| `useOcr`               | boolean | `false` | Enable OCR for image-based content           |
| `screenshotWidth`      | number  | `720`   | Viewport width in pixels                     |
| `screenshotMaxHeight`  | number  | `3000`  | Max screenshot height                        |
| `maxContentLength`     | number  | `50000` | Max content length in chars                  |
| `interactionRounds`    | number  | `0`     | Click/scroll rounds before summarizing       |
| `interactionDelay`     | number  | `500`   | Delay after interactions (ms)                |
| `captchaMaxIterations` | number  | `20`    | Max captcha solving iterations               |

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

| Option       | Type   | Required | Description               |
| ------------ | ------ | -------- | ------------------------- |
| `maxResults` | number | Yes      | Maximum results to return |

## Environment Variables

| Variable                       | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `KAGI_SESSION_TOKEN`           | Kagi authentication token                        |
| `WEBSEARCH_PROVIDER`           | Override provider (`kagi-web`, `duckduckgo-web`) |
| `WEBSEARCH_CONFIG_PATH`        | Custom project config path                       |
| `WEBSEARCH_CONFIG_PATH_GLOBAL` | Custom global config path                        |

## Fetch Modes

The `web-fetch` tool supports two modes:

- **summarize** (default) - Returns an LLM-generated summary
- **full** - Returns complete page content without summarization

Optionally provide a `focus` parameter to guide summarization toward specific information.
