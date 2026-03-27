# OCR Summarizers Overlay Improvements

## Future: Transparent Overlay Handling (Option 3)

The current `OverlayExtension` (Option 1) handles overlays at initialization time as a blocking pre-check. A more sophisticated approach would handle overlays transparently during the main interaction loop.

### Concept: OverlayExtension with Tool Interception

**Hooks used:**

- `onInit`: Initial detection
- `onRoundStart`: Check for overlay, return `false` to inject overlay handling
- `onToolCall`: Intercept normal tools if overlay is active

**Special behavior:**

- Registers its own overlay tools (`overlay_click`, `overlay_wait`, `overlay_finish`)
- Temporarily replaces normal tool execution when overlay is detected
- After overlay is dismissed, resumes normal operation

**Benefits:**

- Transparent to main summarizer
- Can handle overlays that appear mid-session (e.g., after navigation)
- No blocking pre-check needed

**Challenges:**

- More complex state management
- Potential tool conflicts between overlay tools and normal tools
- Need to handle transition between overlay mode and normal mode cleanly

### Implementation Sketch

```typescript
class TransparentOverlayExtension extends OcrExtension {
  readonly name = "overlay";

  private mode: "normal" | "handling" = "normal";
  private overlayTools: OcrTool[];

  async onInit(ctx): Promise<void> {
    // Register overlay tools (disabled by default)
    this.overlayTools = [
      new OverlayClickTool(...),
      new OverlayWaitTool(...),
      new OverlayFinishTool(...),
    ];

    // Initial detection
    if (await this.detectOverlay(ctx)) {
      this.mode = "handling";
    }
  }

  async onRoundStart(ctx): Promise<boolean> {
    if (this.mode === "handling") {
      // Inject overlay handling tools temporarily
      // Return true to let the round proceed with overlay tools
    }
    return true;
  }

  async onToolCall(ctx, toolCall): Promise<ToolResultMessage | undefined> {
    if (this.mode === "handling") {
      // Intercept non-overlay tools and redirect or queue them
    }
    return undefined;
  }

  async onToolResult(ctx, toolCall, result): Promise<void> {
    if (toolCall.name === "overlay_finish") {
      // Check result, switch back to normal mode if successful
      this.mode = "normal";
    }
  }
}
```

### Use Cases

1. **Mid-session overlays**: User navigates to a new page that shows a cookie banner
2. **Delayed overlays**: Overlay appears after initial page load (e.g., after scrolling)
3. **Recurring overlays**: Site shows multiple overlays during interaction

---

## Other Future Improvements

### 1. Overlay Type Classification

Currently we detect "any overlay" but don't classify the type. Classification could enable specialized handling:

- `verification`: Cloudflare, hashing pages → wait patiently
- `captcha`: reCAPTCHA, hCaptcha → specialized solving strategies
- `cookie_consent`: GDPR banners → find accept button quickly
- `age_verification`: Age gates → look for "Yes" or date input
- `newsletter`: Newsletter popups → find close button

### 2. Multi-Modal Overlay Detection

Enhance detection with:

- DOM analysis (look for common overlay selectors/patterns)
- URL patterns (known captcha/verification URLs)
- Page metadata (csp headers, etc.)

### 3. Overlay Learning/Cache

Remember successful overlay dismissals:

- Store click coordinates that worked for specific domains
- Build a knowledge base of common overlay patterns
- Pre-fill likely button positions

### 4. Retry with Different Strategies

If one approach fails:

- Try different button positions
- Wait longer for verification pages
- Attempt keyboard navigation (Escape key)
- Try scrolling to trigger different UI state

### 5. Graceful Degradation

When overlay cannot be dismissed:

- Attempt to extract partial content anyway
- Report what was blocked
- Suggest manual intervention options

---

## Implementation Priority

1. **P1**: Current Option 1 implementation (blocking pre-check)
2. **P2**: Transparent handling (Option 3) for mid-session overlays
3. **P3**: Overlay type classification for specialized handling
4. **P4**: Learning/cache system for faster repeat handling
