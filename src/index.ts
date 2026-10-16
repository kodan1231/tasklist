import { authenticate } from "./auth";
import type { Env } from "./env";
import { HttpError } from "./model";

export { TaskStore } from "./store";

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    let email: string;
    try {
      email = await authenticate(req, env);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }

    // 認証済みのメールアドレスを付けて TaskStore に渡す（クライアントが送った値は上書きする）
    const headers = new Headers(req.headers);
    headers.set("X-User-Email", email);
    const store = env.TASKS.get(env.TASKS.idFromName("default"));
    return store.fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;
