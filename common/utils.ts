export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            resolve();
        }, ms);

        if (signal?.aborted) {
            reject(new Error("Aborted"));
        }

        signal?.addEventListener("abort", () => {
            clearTimeout(timeoutId);
            reject(new Error("Aborted"));
        });
    });
}

/**
 * FNV-1a 64-bit hash function.
 * Good avalanche properties and fewer collisions than 32-bit alternatives.
 * Returns a 16-character hex string.
 *
 * @param str - The string to hash
 * @returns 16-character hex hash string
 */
export function hashString(str: string): string {
    const FNV_OFFSET_BASIS = 14695981039346656037n;
    const FNV_PRIME = 1099511628211n;
    const MASK64 = 0xffffffffffffffffn;

    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < str.length; i++) {
        hash ^= BigInt(str.charCodeAt(i));
        hash = (hash * FNV_PRIME) & MASK64;
    }
    return hash.toString(16).padStart(16, "0");
}

export function formatMatchText(text: string, maxLength: number = 100) {
    const lines = text.split("\n");

    if (lines.length > 1) {
        text = lines[0];
    }

    if (text.length > maxLength + 3) {
        text = `${text.substring(0, maxLength)}...`;
    }

    if (lines.length > 1) {
        text = `${text} [+${lines.length - 1} line(s)]`;
    }

    return text;
}
