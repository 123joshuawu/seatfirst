import { describe, expect, it } from "vitest";

import { ROOT_CONTEXT, type Context } from "@opentelemetry/api";

import { AsyncLocalStorageContextManager } from "../src/context.js";

/**
 * Behavioral contract of `AsyncLocalStorageContextManager` (see `src/context.ts`):
 * `active()` reflects the current async execution, `with()` scopes a context across
 * awaits, `bind()` is identity, and `enable()`/`disable()` return `this`.
 *
 * Falsifiability note: every identity assertion here uses `toBe` against a distinct
 * fixture object per context, so a manager that leaks, drops, or confuses contexts
 * (e.g. a single shared field instead of `AsyncLocalStorage`) fails immediately.
 * `Context` is an opaque interface, so fixtures are plain objects cast at the
 * boundary — the same test-fixture-cast pattern used elsewhere in this repo.
 */
function fixture(name: string): Context {
  return { __ctx: name } as unknown as Context;
}

function timer(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("AsyncLocalStorageContextManager", () => {
  it("active() returns ROOT_CONTEXT when no context was set", () => {
    const manager = new AsyncLocalStorageContextManager();
    expect(manager.active()).toBe(ROOT_CONTEXT);
  });

  it("with() exposes the context inside fn, including across awaits", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const context = fixture("a");
    await manager.with(context, async () => {
      expect(manager.active()).toBe(context);
      await Promise.resolve();
      expect(manager.active()).toBe(context);
      // A real macrotask hop (new async resource), not just a microtask.
      await timer(5);
      expect(manager.active()).toBe(context);
    });
  });

  it("with() restores the previous context after fn returns", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const context = fixture("a");
    manager.with(context, () => {
      expect(manager.active()).toBe(context);
    });
    expect(manager.active()).toBe(ROOT_CONTEXT);
    await manager.with(context, async () => {
      await Promise.resolve();
      expect(manager.active()).toBe(context);
    });
    expect(manager.active()).toBe(ROOT_CONTEXT);
  });

  it("nested with() restores the outer context after the inner call completes", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const outer = fixture("outer");
    const inner = fixture("inner");
    await manager.with(outer, async () => {
      expect(manager.active()).toBe(outer);
      await manager.with(inner, async () => {
        await Promise.resolve();
        expect(manager.active()).toBe(inner);
      });
      expect(manager.active()).toBe(outer);
      await Promise.resolve();
      expect(manager.active()).toBe(outer);
    });
    expect(manager.active()).toBe(ROOT_CONTEXT);
  });

  it("with() forwards thisArg and args and returns fn's return value unchanged", () => {
    const manager = new AsyncLocalStorageContextManager();
    const context = fixture("a");
    const receiver = { name: "receiver" };
    const sentinel = { total: "41:answer" };
    const seen: Array<readonly [number, string]> = [];
    function fn(this: typeof receiver, a: number, b: string): typeof sentinel {
      expect(this).toBe(receiver);
      seen.push([a, b] as const);
      return sentinel;
    }
    const result = manager.with(context, fn, receiver, 41, "answer");
    expect(seen).toEqual([[41, "answer"]]);
    expect(result).toBe(sentinel);
  });

  it("with() hands an async fn's eventual value back to the caller", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const context = fixture("a");
    const result = await manager.with(context, async () => {
      await Promise.resolve();
      return 42;
    });
    expect(result).toBe(42);
  });

  it("keeps interleaved concurrent with() executions isolated", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const ctxA = fixture("a");
    const ctxB = fixture("b");
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    // Each task records the context it still sees AFTER the other task ran.
    const resumed: Context[] = [];
    const taskA = manager.with(ctxA, async () => {
      expect(manager.active()).toBe(ctxA);
      releaseB();
      await gateA;
      // B started and yielded while A was suspended: A must be intact.
      expect(manager.active()).toBe(ctxA);
      resumed.push(manager.active());
    });
    const taskB = manager.with(ctxB, async () => {
      // A started first and is still suspended on gateA: B must be intact.
      await gateB;
      expect(manager.active()).toBe(ctxB);
      releaseA();
      await Promise.resolve();
      expect(manager.active()).toBe(ctxB);
      resumed.push(manager.active());
    });
    await Promise.all([taskA, taskB]);
    expect(resumed).toHaveLength(2);
    expect(resumed).toContain(ctxA);
    expect(resumed).toContain(ctxB);
  });

  it("bind() returns the target unchanged", () => {
    const manager = new AsyncLocalStorageContextManager();
    const context = fixture("a");
    const fn = (): void => {};
    expect(manager.bind(context, fn)).toBe(fn);
    const obj = { run: (): number => 1 };
    expect(manager.bind(context, obj)).toBe(obj);
  });

  it("enable() returns the same instance", () => {
    const manager = new AsyncLocalStorageContextManager();
    expect(manager.enable()).toBe(manager);
  });

  it("disable() returns the same instance and active() is ROOT_CONTEXT afterwards", () => {
    const manager = new AsyncLocalStorageContextManager();
    expect(manager.disable()).toBe(manager);
    expect(manager.active()).toBe(ROOT_CONTEXT);
  });

  it("disable() exits the current execution so later resources see ROOT_CONTEXT", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const context = fixture("a");
    let syncAfterDisable: Context | undefined;
    let afterTimer: Context | undefined;
    await manager.with(context, async () => {
      expect(manager.active()).toBe(context);
      manager.disable();
      syncAfterDisable = manager.active();
      await timer(5);
      afterTimer = manager.active();
    });
    expect(syncAfterDisable).toBe(ROOT_CONTEXT);
    expect(afterTimer).toBe(ROOT_CONTEXT);
    expect(manager.active()).toBe(ROOT_CONTEXT);
  });
});
