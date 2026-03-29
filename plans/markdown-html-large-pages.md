# Large Page Handling for markdown-html Summarizer

## Problem

The `markdown-html` summarizer extracts the full text content of a page and sends it as a single LLM call. Large pages (e.g., Wikipedia articles) can produce over 100k tokens of content, exceeding most model context windows. There is currently no size check or content reduction strategy.

## Approach: Two-Phase Outline + Select

When extracted content exceeds a character threshold, switch from the current single-call flow to a two-phase approach.

## Trigger Heuristic

After `extractRawContent()`, check if `rawContent.content.length` exceeds a configurable threshold (default: ~30k chars). If below threshold, use existing single-call flow. No regression risk for small/medium pages.

```
if (rawContent.content.length <= charThreshold) {
    // existing single-call flow
} else {
    // two-phase outline + select flow
}
```

## Phase 1: Extract Structural Outline

New function `extractOutline(page: Page)` that runs in `page.evaluate()` and:

1. Walks the main content area (reuse existing selectors: `article`, `[role='main']`, `main`, etc.)
2. Finds block-level containers with significant text content
3. Splits or merges nodes so each outline entry is **5k-20k characters**:
   - Nodes < 5k chars are too small to be useful as standalone selections — skip or merge with adjacent siblings
   - Nodes > 20k chars are split at heading boundaries or paragraph boundaries
4. For each qualifying node, records internally:
   - A stable reference to the DOM node (e.g., CSS path, XPath, or injected `data-outline-id` attribute)
   - Character count
5. Returns the outline entries with their internal references + character counts

The outline presented to the model uses **sequential indices** (1, 2, 3, ...) and shows for each entry:
- **Preview text** — first ~100 characters of the entry's content
- **Character count**

Headings are NOT required. When a heading precedes a section, include it as context. When no headings exist, the preview text serves as the sole identifier.

Example outline:

```
[1] 18k chars — "The history of the United Kingdom begins with..."
[2] 12k chars — "Settlement by anatomically modern humans of..."
[3] 8k chars — "The Romans conquered most of the island of..."
[4] 16k chars — "Following the withdrawal of Roman forces..."
[5] 32k chars — "The total area of the United Kingdom is..."
[6] 8k chars — "The UK has a temperate climate, with..."
[7] 40k chars — "The UK has a partially regulated market economy..."
```

## Phase 2: Model Selects Relevant Entries

Send the outline + instruction to the model using an Eta template. The model returns a **JSON response** indicating which entries to include.

### JSON Response Format

The model is prompted to return a JSON block, e.g.:

```json
{"selected": [1, 4, 5, 7]}
```

### JSON Extraction

Parse the model's response with a regex to find a JSON object (handles cases where the model wraps it in markdown code blocks or adds commentary). Example regex:

```
/\{[\s\S]*"selected"[\s\S]*\}/
```

### Retry Logic

If JSON parsing fails or the response is malformed, retry up to `maxSelectionRetries` times (default: 3, configurable). On each retry, re-send the same prompt (or append the failed response + correction instruction).

## Phase 3: Extract + Process Selected Content

New function `extractSelectedContent(page: Page, entries: OutlineEntry[]): string` that re-extracts text from only the selected DOM nodes, using the internal references from phase 1. Concatenates the results and sends to the model for the actual summarization/extraction pass (using the existing prompts).

## Package Structure

New package at `summarizers/outline/` (mirroring the `summarizers/ocr/` pattern):

```
summarizers/
  outline/
    index.ts          — exports
    extract.ts        — extractOutline(), extractSelectedContent()
    select.ts         — model selection call + JSON parsing + retry logic
    instructions/
      index.ts        — Eta render setup (same pattern as ocr/instructions/index.ts)
      select.eta      — prompt for outline selection
      summarize.eta   — system prompt for summarization of selected content
      full.eta        — system prompt for full extraction of selected content
      instruct.eta    — system prompt for instruction mode
```

The Eta templates follow the same setup as `summarizers/ocr/instructions/` (same `Eta` config with `autoTrim: false`, `<%~` for raw output).

## Implementation Steps

1. **Create `summarizers/outline/` package** — extract, select, instructions
2. **Implement `extractOutline()`** — DOM traversal with 5k-20k char node sizing
3. **Implement selection Eta templates** — outline presentation + JSON response instruction
4. **Implement `selectSections()`** — model call, JSON parsing, retry loop
5. **Implement `extractSelectedContent()`** — scoped text extraction using internal node refs
6. **Integrate into `markdown-html.ts`** — threshold check + branching logic
7. **Add config** — `outlineThreshold` (char count trigger), `maxSelectionRetries`

## Config Additions

Add to `FetchConfig` in `common/config.ts`:

```typescript
/** Character threshold to trigger outline-based selection (default: 30000) */
outlineThreshold?: number;
/** Max retries for model section selection JSON parsing (default: 3) */
maxSelectionRetries?: number;
```

## Edge Cases

- **Outline produces no qualifying nodes** (all content is in tiny fragments): fall back to truncation of the full extracted content
- **Model selects zero entries**: treat as "summarize what you can" with a truncated version
- **Selected content still exceeds context window**: this is unlikely given the 20k char max per node, but if it happens, truncate the concatenated result to fit
