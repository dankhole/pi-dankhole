import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
const CHILD_CONTEXT_KEY = Symbol.for("pi-subagents:child-session-context");
const processState = globalThis as typeof globalThis & {
  [CHILD_CONTEXT_KEY]?: AsyncLocalStorage<boolean>;
};
// Pi can load this module through multiple loaders. They must observe the same
// async-local store without marking unrelated, concurrent root activations.
processState[CHILD_CONTEXT_KEY] ??= new AsyncLocalStorage<boolean>();
const childSessionContext = processState[CHILD_CONTEXT_KEY];

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
