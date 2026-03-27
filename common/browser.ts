import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import UndetectableBrowser from "undetected-browser";
import type { Browser } from "puppeteer";

// Apply stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Browser instance cache with idle timeout
let cachedBrowser: Browser | null = null;
let lastBrowserInteractionMillis: number = 0;
let idleCheckTimer: NodeJS.Timeout | null = null;

const BROWSER_IDLE_MS = 0; // Close browser after 5 minutes of inactivity
const IDLE_CHECK_INTERVAL_MS = 15_000; // Check for idle every 15 seconds

export async function getBrowser(): Promise<Browser> {
    // Update last activity timestamp
    lastBrowserInteractionMillis = Date.now();

    // Reuse existing browser if available
    if (cachedBrowser && cachedBrowser.connected) {
        return cachedBrowser;
    }

    // Launch with puppeteer-extra (stealth plugin) and wrap with undetected-browser
    const wrapper = new UndetectableBrowser(
        await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        }),
    );

    cachedBrowser = await wrapper.getBrowser();

    // Start idle check loop
    scheduleIdleCheck();

    return cachedBrowser;
}

function scheduleIdleCheck(): void {
    if (idleCheckTimer) {
        clearTimeout(idleCheckTimer);
    }

    idleCheckTimer = setTimeout(() => {
        const idleTime = Date.now() - lastBrowserInteractionMillis;

        if (BROWSER_IDLE_MS > 0 && idleTime >= BROWSER_IDLE_MS && cachedBrowser) {
            closeBrowser().catch(() => {}); // Ignore errors
        } else if (cachedBrowser) {
            // Browser still active, schedule next check
            scheduleIdleCheck();
        }
    }, IDLE_CHECK_INTERVAL_MS);
}

export async function closeBrowser(browser: Browser | null = null): Promise<void> {
    const targetBrowser = browser ?? cachedBrowser;

    if (targetBrowser) {
        try {
            await targetBrowser.close();
        } catch {
            // Ignore errors when closing
        }
    }

    // Clear cache if we're closing the cached browser
    if (browser === null || browser === cachedBrowser) {
        cachedBrowser = null;

        if (idleCheckTimer) {
            clearTimeout(idleCheckTimer);
            idleCheckTimer = null;
        }
    }
}
