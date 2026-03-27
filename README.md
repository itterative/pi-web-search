# pi-web-search

Web search and fetch tools for pi.

> [!WARNING]
> This extension is in active development and not ready for daily use.

## Features

- **Web search** using DuckDuckGo or Kagi
- **Web fetch** with LLM-powered summarization
- **OCR support** for image-based content
- **Interactive browsing** - click, scroll, and solve captchas before summarizing

## Tools

### web-search

Search the web using configured providers. Optionally summarizes the top result.

### web-fetch

Fetch content from a URL. Supports two modes:

- **summarize** (default) - Returns an LLM-generated summary
- **full** - Returns complete page content

Use the `focus` parameter to guide summarization toward specific information.

## Requirements

- For OCR/captcha solving: a vision-capable LLM model

## Configuration

Configuration is stored in JSON files:

- Project level: `.pi/web-search-config.json`
- Global level: `~/.pi/web-search-config.json`

### Quick Example

```json
{
    "$schema": "https://raw.githubusercontent.com/itterative/pi-web-search/refs/heads/main/docs/schema.json",
    "search": {
        "provider": "duckduckgo-web",
        "maxResults": 10
    },
    "fetch": {
        "model": {
            "provider": "anthropic",
            "modelId": "claude-3-haiku-20240307"
        },
        "useOcr": true
    }
}
```

### Environment Variables

| Variable             | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `KAGI_SESSION_TOKEN` | Kagi session token for authentication                   |
| `WEBSEARCH_PROVIDER` | Override search provider (`kagi-web`, `duckduckgo-web`) |

## Documentation

- [Configuration](./docs/CONFIGURATION.md) - Full configuration options, provider settings, fetch modes
- [Schema](./docs/schema.json) - JSON Schema for validation
