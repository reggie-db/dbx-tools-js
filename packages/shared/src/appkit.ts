// Helpers for working with the AppKit plugin context (`this.context` on
// any class that extends `Plugin` from `@databricks/appkit`).
//
// Why these live here instead of in `@databricks/appkit`: AppKit exposes
// `this.context.getPlugins()`, which returns
// `ReadonlyMap<string, BasePlugin>`, but provides no typed lookup
// helper. Every caller ends up writing the same
// `as InstanceType<ReturnType<typeof someFactory>["plugin"]>` cast.
// These wrappers absorb that boilerplate.
//
// API shape: pass the plugin's factory (`lakebase`, `serving`, `genie`,
// or any `toPlugin(...)` result) directly. TypeScript infers both the
// instance type (so `.exports()` resolves) and the registered name (so
// the runtime lookup works) from that single value. No `<T>` annotation
// or string literal needed at the call site.

import {
  createApp,
  getExecutionContext,
  InitializationError,
} from "@databricks/appkit";
import type { NameLike } from "./common.js";

// Minimal structural shape of `this.context`. We mirror only the method
// we touch instead of depending on AppKit's `PluginContext` type, which
// is not part of the package's `exports` map and therefore cannot be
// imported. Any compatible object (real `PluginContext`, mocks, tests)
// satisfies this shape.
export interface PluginContextLike {
  getPlugins(): ReadonlyMap<string, unknown>;
}

// The AppKit per-request execution context returned by
// `getExecutionContext()` - the OBO-scoped workspace client plus the
// surrounding request metadata. Derived from AppKit's own return type so
// it tracks the installed version, and re-exported here so add-on
// packages can type a context parameter without each re-deriving the
// same `ReturnType<typeof getExecutionContext>` inline.
export type ExecutionContextLike = ReturnType<typeof getExecutionContext>;

// The auth-scoped Databricks workspace client carried on an
// `ExecutionContextLike` (`getExecutionContext().client`). Typed
// structurally off AppKit so consumers don't take a direct
// `@databricks/sdk-experimental` dependency - the dep flows in
// transitively through `@databricks/appkit`.
export type WorkspaceClientLike = ExecutionContextLike["client"];

type PluginData = {
  plugin: abstract new (...args: never[]) => unknown;
  name: string;
};

// Structural shape of an AppKit plugin factory (the result of
// `toPlugin(SomePluginClass)`). Calling it returns a `PluginData` tuple
// whose `plugin` field is the *class constructor* and whose `name`
// field carries the registered plugin name as a literal string.
//
// Defined structurally so we don't pull `@databricks/appkit` into this
// package as a runtime or type dependency. Any function returning the
// same shape (e.g. `lakebase`, `serving`, `genie`, or a user-defined
// `toPlugin(MyPlugin)`) satisfies the bound.
type PluginDataFactory = (...args: never[]) => PluginData;

// Maps a plugin factory back to the *instance* type of its plugin
// class. Mirrors the inline pattern users would otherwise write:
// `InstanceType<ReturnType<typeof factory>["plugin"]>`.
type PluginInstanceOf<F extends PluginDataFactory> = InstanceType<
  ReturnType<F>["plugin"]
>;

// Registry name returned by `factory().name`, keyed by the factory
// function. Typical AppKit factories return stable metadata; caching
// avoids invoking `factory()` on every sibling lookup (which would
// allocate a fresh descriptor tuple each time).
const dataCache = new WeakMap<PluginDataFactory, PluginData>();

/**
 * Returns the static `{ plugin, name }` descriptor for an AppKit plugin
 * factory, caching per factory so repeated lookups do not allocate.
 */
export function data<F extends PluginDataFactory, D extends ReturnType<F>>(
  factory: F,
): D {
  const cached = dataCache.get(factory);
  if (cached !== undefined) {
    return cached as D;
  }
  const result = factory();
  dataCache.set(factory, result);
  return result as D;
}

/**
 * Look up a sibling plugin instance from the AppKit plugin context,
 * keyed off the factory's registered name and typed via its plugin
 * class.
 *
 * Returns `undefined` when the context is missing or the plugin is not
 * registered. For required siblings prefer {@link require}.
 *
 * @example
 * ```ts
 * import { lakebase } from "@databricks/appkit";
 * import { appkitUtils } from "@dbx-tools/shared";
 *
 * const lake = appkitUtils.instance(this.context, lakebase);
 * //    ^^ inferred as LakebasePlugin | undefined
 * lake?.exports().pool;
 * ```
 */
export function instance<F extends PluginDataFactory>(
  ctx: PluginContextLike | undefined,
  factory: F,
): PluginInstanceOf<F> | undefined {
  if (!ctx) return undefined;
  const name = data(factory).name;
  return ctx.getPlugins().get(name) as PluginInstanceOf<F> | undefined;
}

/**
 * Like {@link instance} but throws when the plugin is not registered.
 * Use for siblings whose absence is a wiring bug rather than a runtime
 * condition (e.g. requiring `lakebase` when the caller has `storage` /
 * `memory` enabled).
 *
 * `caller` is prepended to the error message so cross-plugin failures
 * are easy to attribute in logs.
 *
 * Always accessed through the namespace as `appkitUtils.require(...)`;
 * the bare identifier is legal here because this package is pure ESM.
 *
 * @example
 * ```ts
 * import { lakebase } from "@databricks/appkit";
 * import { appkitUtils } from "@dbx-tools/shared";
 *
 * const pool = appkitUtils.require(this.context, lakebase, "mastra")
 *   .exports().pool;
 * ```
 */
export function require<F extends PluginDataFactory>(
  ctx: PluginContextLike | undefined,
  factory: F,
  caller?: NameLike | string,
): PluginInstanceOf<F> {
  const plugin = instance(ctx, factory);
  if (plugin) return plugin;
  const prefix =
    typeof caller === "string" ? `${caller}: ` : caller?.name ? `${caller.name}: ` : "";
  const registeredName = data(factory).name;
  throw new Error(`${prefix}required plugin not registered: ${registeredName}`);
}

export function isInitialized(): boolean {
  try {
    const ctx = getExecutionContext();
    if (ctx?.client) {
      return true;
    }
  } catch (error) {
    if (!(error instanceof InitializationError)) {
      throw error;
    }
  }
  return false;
}

export async function ensureInitialized() {
  if (!isInitialized()) {
    await createApp({
      plugins: [],
    });
  }
}
