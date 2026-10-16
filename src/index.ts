import { DurableObject } from "cloudflare:workers";

export interface Env {
  TASKS: DurableObjectNamespace<TaskStore>;
  ASSETS: Fetcher;
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
  due: string | null; // YYYY-MM-DD
  createdAt: number;
}

type TaskPatch = Partial<Pick<Task, "title" | "done" | "due">>;

type Row = { id: string; title: string; done: number; due: string | null; created_at: number };

const toTask = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  done: r.done === 1,
  due: r.due,
  createdAt: r.created_at,
});

// 個人用なので、全タスクを 1 つの Durable Object（SQLite）に保存する
export class TaskStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        due TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  list(): Task[] {
    return this.sql
      .exec<Row>(
        "SELECT * FROM tasks ORDER BY done, due IS NULL, due, created_at DESC",
      )
      .toArray()
      .map(toTask);
  }

  create(title: string, due: string | null): Task {
    const row: Row = {
      id: crypto.randomUUID(),
      title,
      done: 0,
      due,
      created_at: Date.now(),
    };
    this.sql.exec(
      "INSERT INTO tasks (id, title, done, due, created_at) VALUES (?, ?, ?, ?, ?)",
      row.id, row.title, row.done, row.due, row.created_at,
    );
    return toTask(row);
  }

  update(id: string, patch: TaskPatch): Task | null {
    const rows = this.sql.exec<Row>("SELECT * FROM tasks WHERE id = ?", id).toArray();
    if (rows.length === 0) return null;
    const cur = rows[0];
    const next: Row = {
      ...cur,
      title: patch.title ?? cur.title,
      done: patch.done === undefined ? cur.done : patch.done ? 1 : 0,
      due: patch.due === undefined ? cur.due : patch.due,
    };
    this.sql.exec(
      "UPDATE tasks SET title = ?, done = ?, due = ? WHERE id = ?",
      next.title, next.done, next.due, id,
    );
    return toTask(next);
  }

  remove(id: string): boolean {
    return this.sql.exec("DELETE FROM tasks WHERE id = ?", id).rowsWritten > 0;
  }
}

class BadRequest extends Error {}

const json = (data: unknown, status = 200) => Response.json(data, { status });

function parseTitle(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new BadRequest("title is required");
  if (v.length > 500) throw new BadRequest("title is too long");
  return v.trim();
}

function parseDue(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequest("due must be YYYY-MM-DD");
  }
  return v;
}

async function handleApi(req: Request, url: URL, store: DurableObjectStub<TaskStore>) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "tasks", id?]
  if (parts[1] !== "tasks" || parts.length > 3) return json({ error: "not found" }, 404);
  const id = parts[2];

  if (!id) {
    if (req.method === "GET") return json(await store.list());
    if (req.method === "POST") {
      const body = await req.json<Record<string, unknown>>();
      const task = await store.create(parseTitle(body.title), parseDue(body.due ?? null));
      return json(task, 201);
    }
  } else {
    if (req.method === "PATCH") {
      const body = await req.json<Record<string, unknown>>();
      const patch: TaskPatch = {};
      if ("title" in body) patch.title = parseTitle(body.title);
      if ("done" in body) {
        if (typeof body.done !== "boolean") throw new BadRequest("done must be boolean");
        patch.done = body.done;
      }
      if ("due" in body) patch.due = parseDue(body.due);
      const task = await store.update(id, patch);
      return task ? json(task) : json({ error: "not found" }, 404);
    }
    if (req.method === "DELETE") {
      return (await store.remove(id)) ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404);
    }
  }
  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const store = env.TASKS.get(env.TASKS.idFromName("default"));
    try {
      return await handleApi(req, url, store);
    } catch (e) {
      if (e instanceof BadRequest || e instanceof SyntaxError) {
        return json({ error: e.message }, 400);
      }
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;
