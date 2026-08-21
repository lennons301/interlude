/**
 * State that must exist once per *process*, not once per module instance
 * (issue #159).
 *
 * A module-level `const` is only a singleton if the module is evaluated once,
 * and in this app it is not. Next.js compiles `instrumentation.ts` — where the
 * orchestrator boots — and the app-router route handlers into **separate module
 * graphs**. They run in the same Node process, but each graph has its own
 * registry, so a module imported from both is evaluated twice and its
 * module-level state exists twice. Measured on Next 16.1.6 against the
 * production entrypoint (`output: standalone`): `turn-manager` loads twice, and
 * a route handler holds the *second* copy while the queue poll loop and the
 * autonomy sweep hold the first.
 *
 * That is what wedged the box on 2026-08-19. `POST /api/tasks/[id]/complete`
 * deleted the finished session's `activeTasks` entry from the route's copy of
 * the map; the queue kept counting the entry in the orchestrator's copy, so one
 * normal UI close held the only slot on a `CAPACITY_SLOTS=1` box until the app
 * was restarted. Nothing in the code re-added the entry — there were two maps,
 * and the delete landed in the wrong one. Completing the same task from Discord
 * always worked, because that path is a dynamic import from inside the
 * orchestrator's own graph.
 *
 * `globalThis` is the only registry the two graphs share, so it is where any
 * state a route handler and the orchestrator both touch has to live. Reach for
 * this whenever that is true; a plain module-level value is still right for
 * state only one side ever sees.
 */

/** Symbol-keyed so the registry cannot collide with anything else on the global
 * object, and is invisible to code enumerating it. */
const REGISTRY = Symbol.for("interlude.process-singletons");

type Registry = Map<string, unknown>;

function registry(): Registry {
  const g = globalThis as unknown as { [REGISTRY]?: Registry };
  return (g[REGISTRY] ??= new Map());
}

/**
 * The one value stored under `key` for the lifetime of this process, creating it
 * on first use. Every module instance that asks for the same key gets the same
 * value back, whichever graph it was compiled into.
 *
 * `key` is a plain string so it stays greppable and stable across a rebuild —
 * a `Symbol()` would be per-module-instance and defeat the point. Prefix it with
 * the owning module so two owners cannot pick the same name by accident.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const store = registry();
  if (!store.has(key)) store.set(key, create());
  return store.get(key) as T;
}
