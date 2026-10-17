import type { Env } from "./env";

export { TaskStore } from "./store";

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    // ログイン判定も含め、API はすべて TaskStore で処理する
    const store = env.TASKS.get(env.TASKS.idFromName("default"));
    return store.fetch(req);
  },
} satisfies ExportedHandler<Env>;
