import { describe, it, expect } from "vitest";
import { OcrExtension, type OcrExtensionExecutionContext } from "../../../../summarizers/ocr/extensions/base";

describe("OcrExtension", () => {
    it("should require name property", () => {
        class TestExtension extends OcrExtension {
            readonly name = "test";
        }

        const ext = new TestExtension();
        expect(ext.name).toBe("test");
    });

    it("should have optional lifecycle hooks that can be called safely", async () => {
        class TestExtension extends OcrExtension {
            readonly name = "test";
        }

        const ext = new TestExtension();
        const ctx = {} as OcrExtensionExecutionContext;

        // All hooks should be callable without error (even if they do nothing)
        await ext.onInit?.(ctx);
        await ext.onRoundStart?.(ctx);
        await ext.onResponse?.(ctx, {} as any);
        await ext.onToolCall?.(ctx, {} as any);
        await ext.onToolResult?.(ctx, {} as any, {} as any);
        await ext.onToolResultsComplete?.(ctx, [], []);
        await ext.onRoundEnd?.(ctx);
        await ext.onFinalSummary?.(ctx);
        await ext.onComplete?.(ctx);

        // If we get here without errors, the test passes
        expect(true).toBe(true);
    });

    it("should allow implementing lifecycle hooks", async () => {
        let called = false;

        class TestExtension extends OcrExtension {
            readonly name = "test";

            async onInit(_ctx: OcrExtensionExecutionContext) {
                called = true;
            }
        }

        const ext = new TestExtension();
        await ext.onInit!({} as OcrExtensionExecutionContext);

        expect(called).toBe(true);
    });

    it("should support inheritance", () => {
        class BaseExtension extends OcrExtension {
            readonly name: string = "base";

            baseMethod() {
                return "base";
            }
        }

        class DerivedExtension extends BaseExtension {
            readonly name: string = "derived";

            derivedMethod() {
                return "derived";
            }
        }

        const ext = new DerivedExtension();

        expect(ext.name).toBe("derived");
        expect(ext.baseMethod()).toBe("base");
        expect(ext.derivedMethod()).toBe("derived");
        expect(ext instanceof OcrExtension).toBe(true);
        expect(ext instanceof BaseExtension).toBe(true);
        expect(ext instanceof DerivedExtension).toBe(true);
    });
});
