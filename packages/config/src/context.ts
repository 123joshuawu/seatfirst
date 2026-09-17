/**
 * A dependency-free `AsyncLocalStorage`-backed OTel `ContextManager`, promoted verbatim
 * in spirit from the test-only class proven in
 * `apps/server/test/provider-fetch-actor.test.ts:463-474` (O7.5 / ADR 0031 §2). O3's
 * review found `@opentelemetry/api`'s default context manager does not propagate active
 * context across async boundaries — and the SDK's own
 * `@opentelemetry/context-async-hooks` package is deliberately NOT used here: node's
 * built-in `AsyncLocalStorage` does everything the manager needs, so registering working
 * async context propagation costs zero dependencies.
 *
 * Semantics match the contract every `ContextManager` must honor:
 * - `active()` returns the context stored for the current async execution, or
 *   `ROOT_CONTEXT` when none was set.
 * - `with(ctx, fn)` runs `fn` with `ctx` as the active context for the duration of the
 *   call AND across every `await` inside it (that cross-await survival is the entire
 *   point — it is what lets a dispatch handler opened inside an extracted remote context
 *   keep that context through its own awaits).
 * - `bind` returns the target unchanged: this manager scopes context by async execution,
 *   so there is nothing to bake into callbacks ahead of time.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { ROOT_CONTEXT, type Context, type ContextManager } from "@opentelemetry/api";

export class AsyncLocalStorageContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    // `AsyncLocalStorage.run` has no thisArg parameter — every argument after the
    // callback is forwarded to it — so the receiver is applied here instead of being
    // passed through (passing it through would shift `fn`'s real arguments by one).
    return this.#storage.run(ctx, function (this: unknown) {
      return fn.apply(thisArg, args);
    });
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}
