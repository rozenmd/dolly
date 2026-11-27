import { env } from "cloudflare:workers";
import { listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";

/**
 * Clear every Durable Object's storage between Worker tests: use this instead of `reset()`.
 *
 * `reset()` from cloudflare:test deletes the storage of live objects only. An object stopped since
 * it last ran, as `abortAllDurableObjects()` in an `afterEach` stops them all, keeps its key-value
 * storage and its SQLite tables, so Pi's documents (automations, review receipts, GitHub threads)
 * and any key the next test doesn't overwrite leak into it. Waking each object first lets `reset()`
 * reach it.
 */
export async function resetStorage() {
  const namespaces: DurableObjectNamespace[] = [env.AGENT, env.SANDBOX, env.CLAUDE_CODE];

  for (const namespace of namespaces)
    for (const id of await listDurableObjectIds(namespace))
      await runInDurableObject(namespace.get(id), () => {});

  await reset();
}
