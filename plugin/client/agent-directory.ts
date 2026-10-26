import type { PluginClientContext } from "@getpaseo/plugin/client";

export type DirectoryAgent = {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  archivedAt?: string | null;
  title?: string | null;
  availableModes?: { id: string }[];
};
type Observer = {
  snapshot(agents: DirectoryAgent[]): void;
  upsert(agent: DirectoryAgent): void;
  remove(id: string): void;
};

// Installation-local, never keyed by workspace/parent or shared between hosts.
const directories = new WeakMap<PluginClientContext, ReturnType<typeof createDirectory>>();
const contributions = new WeakMap<PluginClientContext, Map<string, { users: number; stop: () => void }>>();

/** Repeated consumers own leases, not duplicate buttons or subscriptions. */
export function retainContribution(client: PluginClientContext, id: string, start: () => () => void) {
  let entries = contributions.get(client);
  if (!entries) contributions.set(client, entries = new Map());
  let entry = entries.get(id);
  if (!entry) {
    entry = { users: 0, stop: start() };
    entries.set(id, entry);
  }
  entry.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.users === 0) {
      entries.delete(id);
      if (!entries.size) contributions.delete(client);
      entry.stop();
    }
  };
}

/** One background-inclusive catalogue for all controls in an installation. */
export function observeAgentDirectory(client: PluginClientContext, observer: Observer) {
  let directory = directories.get(client);
  if (!directory) {
    directory = createDirectory(client);
    directories.set(client, directory);
  }
  const listener = { ...observer };
  directory.observers.add(listener);
  if (directory.ready()) listener.snapshot(directory.snapshot());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    directory.observers.delete(listener);
    if (!directory.observers.size) {
      directories.delete(client);
      directory.stop();
    }
  };
}

function createDirectory(client: PluginClientContext) {
  const observers = new Set<Observer>();
  let agents = new Map<string, DirectoryAgent>();
  let ready = false, stopped = false, generation = 0;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let changes = new Map<string, DirectoryAgent | null>();
  let loading = false;
  const notify = (run: (observer: Observer) => void) => {
    for (const observer of observers) {
      try { run(observer); } catch (error) { console.error("Pi control catalogue consumer failed", error); }
    }
  };
  const close = () => {
    controller?.abort();
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const failed = (error: unknown) => {
    if (stopped) return;
    generation++;
    close();
    console.error("Pi control catalogue unavailable; retrying", error);
    // Keep the last known controls during a transport outage. Their RPCs still
    // enforce session/runtime identity; an incomplete page is not a removal.
    retry = setTimeout(connect, 5000);
  };
  function connect() {
    if (stopped) return;
    retry = undefined;
    const lifetime = new AbortController();
    controller = lifetime;
    const current = () => !stopped && controller === lifetime && !lifetime.signal.aborted;
    const options = { includeBackground: true, signal: lifetime.signal,
      sort: [{ key: "updated_at" as const, direction: "desc" as const }] };
    void client.paseo.agents.list({ ...options, subscribe: {}, page: { limit: 200 } }).then(({ subscription }) => {
      if (!current()) return;
      const release = subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          if (!current()) return;
          const version = ++generation;
          changes = new Map();
          loading = true;
          const next = new Map<string, DirectoryAgent>(entries.map(({ agent }) => [agent.id, agent]));
          const valid = () => current() && generation === version;
          const nextCursor = (page: typeof pageInfo) => {
            if (!page?.hasMore) return null;
            if (!page.nextCursor) throw new Error("Missing Pi catalogue cursor");
            return page.nextCursor;
          };
          void (async () => {
            let cursor = nextCursor(pageInfo);
            const seen = new Set<string>();
            while (cursor) {
              if (seen.has(cursor)) throw new Error("Repeated Pi catalogue cursor");
              seen.add(cursor);
              const page = await client.paseo.agents.list({ ...options, page: { limit: 200, cursor } });
              if (!valid()) return;
              for (const { agent } of page.entries) next.set(agent.id, agent);
              cursor = nextCursor(page.pageInfo);
            }
            if (!valid()) return;
            // Updates received while older pages load win over those pages,
            // including removals. A reconnect snapshot invalidates older work.
            for (const [id, agent] of changes) agent ? next.set(id, agent) : next.delete(id);
            changes.clear();
            loading = false;
            agents = next;
            ready = true;
            notify(observer => observer.snapshot([...agents.values()]));
          })().catch(error => { if (valid()) failed(error); });
        },
        update: message => {
          if (!current() || message.type !== "agent_update") return;
          if (message.payload.kind === "remove") {
            const id = message.payload.agentId;
            if (loading) changes.set(id, null);
            agents.delete(id);
            notify(observer => observer.remove(id));
          } else {
            const agent = message.payload.agent;
            if (loading) changes.set(agent.id, agent);
            agents.set(agent.id, agent);
            notify(observer => observer.upsert(agent));
          }
        },
      });
      if (typeof release === "function") {
        if (current()) unsubscribe = release;
        else release();
      }
    }).catch(error => { if (current()) failed(error); });
  }
  connect();
  return { observers, ready: () => ready, snapshot: () => [...agents.values()], stop() {
    stopped = true;
    generation++;
    clearTimeout(retry);
    close();
    agents.clear();
    changes.clear();
  } };
}
