import { describe, it, expect } from "vitest";
import {
    OcrExtension,
    OcrExtensionRegistry,
    type OcrExtensionExecutionContext,
} from "../../../../summarizers/ocr/extensions";

// Test fixtures
class NavigationExtension extends OcrExtension {
    readonly name = "navigation";
    getNavContext() {
        return "nav context";
    }
}

class CheckpointExtension extends OcrExtension {
    readonly name = "checkpoint";
    getCheckpoints() {
        return ["cp1", "cp2"];
    }
}

class DebugExtension extends OcrExtension {
    readonly name = "debug";
    debug() {
        return "debug info";
    }
}

// Inheritance test fixtures
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

describe("OcrExtensionRegistry", () => {
    describe("register", () => {
        it("should register an extension", () => {
            const registry = new OcrExtensionRegistry();
            const nav = new NavigationExtension();

            registry.register(nav);

            expect(registry.get(NavigationExtension)).toBe(nav);
        });

        it("should throw if extension is already registered", () => {
            const registry = new OcrExtensionRegistry();
            registry.register(new NavigationExtension());

            expect(() => registry.register(new NavigationExtension())).toThrow("is already registered");
        });

        it("should overwrite extension with overwrite option", () => {
            const registry = new OcrExtensionRegistry();
            const first = new NavigationExtension();
            const second = new NavigationExtension();

            registry.register(first);
            registry.register(second, { overwrite: true });

            expect(registry.get(NavigationExtension)).toBe(second);
        });

        it("should register multiple different extensions", () => {
            const registry = new OcrExtensionRegistry();
            const nav = new NavigationExtension();
            const checkpoint = new CheckpointExtension();
            const debug = new DebugExtension();

            registry.register(nav);
            registry.register(checkpoint);
            registry.register(debug);

            expect(registry.get(NavigationExtension)).toBe(nav);
            expect(registry.get(CheckpointExtension)).toBe(checkpoint);
            expect(registry.get(DebugExtension)).toBe(debug);
        });
    });

    describe("get", () => {
        it("should return extension by exact class", () => {
            const registry = new OcrExtensionRegistry();
            const nav = new NavigationExtension();
            registry.register(nav);

            const result = registry.get(NavigationExtension);

            expect(result).toBe(nav);
            expect(result?.getNavContext()).toBe("nav context");
        });

        it("should return undefined for unregistered extension", () => {
            const registry = new OcrExtensionRegistry();

            expect(registry.get(NavigationExtension)).toBeUndefined();
        });

        it("should match derived class when querying base class (polymorphic)", () => {
            const registry = new OcrExtensionRegistry();
            const derived = new DerivedExtension();
            registry.register(derived);

            // get() uses instanceof (polymorphic)
            expect(registry.get(BaseExtension)).toBe(derived);
            expect(registry.get(DerivedExtension)).toBe(derived);
        });

        it("should return first match when multiple extensions match", () => {
            const registry = new OcrExtensionRegistry();
            const nav = new NavigationExtension();
            const checkpoint = new CheckpointExtension();
            registry.register(nav);
            registry.register(checkpoint);

            // Both extend OcrExtension, should return first registered
            const result = registry.get(OcrExtension);
            expect(result).toBe(nav);
        });

        it("should return correct type for type-safe access", () => {
            const registry = new OcrExtensionRegistry();
            const checkpoint = new CheckpointExtension();
            registry.register(checkpoint);

            const result = registry.get(CheckpointExtension);

            // TypeScript should infer correct type
            expect(result?.getCheckpoints()).toEqual(["cp1", "cp2"]);
        });
    });

    describe("getAll", () => {
        it("should return all registered extensions", () => {
            const registry = new OcrExtensionRegistry();
            const nav = new NavigationExtension();
            const checkpoint = new CheckpointExtension();
            registry.register(nav);
            registry.register(checkpoint);

            const all = registry.getAll();

            expect(all).toHaveLength(2);
            expect(all).toContain(nav);
            expect(all).toContain(checkpoint);
        });

        it("should return copy of array", () => {
            const registry = new OcrExtensionRegistry();
            registry.register(new NavigationExtension());

            const all1 = registry.getAll();
            const all2 = registry.getAll();

            expect(all1).not.toBe(all2); // Different array references
            expect(all1).toEqual(all2); // Same contents
        });
    });

    describe("lifecycle dispatch", () => {
        it("should dispatch onInit to all extensions", async () => {
            const registry = new OcrExtensionRegistry();
            let initCount = 0;

            class InitTrackingExtension extends OcrExtension {
                readonly name = "init-tracking";
                async onInit() {
                    initCount++;
                }
            }

            registry.register(new InitTrackingExtension());
            registry.register(new NavigationExtension());

            await registry.dispatchOnInit({} as OcrExtensionExecutionContext);

            expect(initCount).toBe(1);
        });

        it("should stop round if onRoundStart returns false", async () => {
            const registry = new OcrExtensionRegistry();

            class StopRoundExtension extends OcrExtension {
                readonly name = "stop-round";
                onRoundStart() {
                    return Promise.resolve(false);
                }
            }

            registry.register(new StopRoundExtension());

            const result = await registry.dispatchOnRoundStart({} as OcrExtensionExecutionContext);

            expect(result).toBe(false);
        });

        it("should continue round if onRoundStart returns true or void", async () => {
            const registry = new OcrExtensionRegistry();

            class ContinueExtension extends OcrExtension {
                readonly name = "continue";
                onRoundStart() {
                    return Promise.resolve(true);
                }
            }

            registry.register(new ContinueExtension());
            registry.register(new NavigationExtension());

            const result = await registry.dispatchOnRoundStart({} as OcrExtensionExecutionContext);

            expect(result).toBe(true);
        });
    });
});
