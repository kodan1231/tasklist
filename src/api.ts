import { ALL, HttpError, TAG_COLORS, type TaskPatch } from "./model";
import type { TaskStore } from "./store";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const noContent = () => new Response(null, { status: 204 });
const bad = (message: string) => new HttpError(400, message);

function parseText(v: unknown, label: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw bad(`${label}を入力してください`);
  if (v.trim().length > max) throw bad(`${label}は${max}文字以内にしてください`);
  return v.trim();
}

function parseDue(v: unknown): string | null {
  if (v === null || v === "" || v === undefined) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad("期限は YYYY-MM-DD 形式です");
  return v;
}

function parseAssignee(v: unknown): string {
  if (typeof v !== "string" || !v) throw bad("担当者を指定してください");
  return v === ALL ? ALL : v.toLowerCase();
}

function parseEmail(v: unknown): string {
  if (typeof v !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
    throw bad("メールアドレスの形式が正しくありません");
  }
  return v.trim().toLowerCase();
}

function parseColor(v: unknown): string {
  if (typeof v !== "string" || !TAG_COLORS.includes(v)) throw bad("色の指定が正しくありません");
  return v;
}

function parseTagIds(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw bad("tags は文字列の配列です");
  return [...new Set(v as string[])];
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {}
  throw bad("リクエストの形式が正しくありません");
}

export async function handleApi(req: Request, store: TaskStore, email: string): Promise<Response> {
  const me = store.member(email);
  if (!me) throw new HttpError(403, `${email || "このユーザー"} はメンバーではありません`);

  const [, resource, rawId, ...rest] = new URL(req.url).pathname.split("/").filter(Boolean);
  if (rest.length > 0) throw new HttpError(404, "not found");
  const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
  const method = req.method;

  switch (resource) {
    case "state":
      if (id === undefined && method === "GET") {
        return json({ me: me.email, members: store.members(), tags: store.tags(), tasks: store.tasks() });
      }
      break;

    case "tasks":
      if (id === undefined && method === "POST") {
        const b = await readBody(req);
        const task = store.createTask({
          title: parseText(b.title, "タスク名", 500),
          due: parseDue(b.due),
          assignee: b.assignee === undefined ? me.email : parseAssignee(b.assignee),
          tags: b.tags === undefined ? [] : parseTagIds(b.tags),
        });
        return json(task, 201);
      }
      if (id !== undefined && method === "PATCH") {
        const b = await readBody(req);
        const patch: TaskPatch = {};
        if ("title" in b) patch.title = parseText(b.title, "タスク名", 500);
        if ("due" in b) patch.due = parseDue(b.due);
        if ("assignee" in b) patch.assignee = parseAssignee(b.assignee);
        if ("tags" in b) patch.tags = parseTagIds(b.tags);
        if ("done" in b) {
          if (typeof b.done !== "boolean") throw bad("done は true / false です");
          patch.done = b.done;
        }
        return json(store.updateTask(id, patch, me.email));
      }
      if (id !== undefined && method === "DELETE") {
        store.removeTask(id);
        return noContent();
      }
      break;

    case "members":
      if (id === undefined && method === "POST") {
        const b = await readBody(req);
        return json(store.addMember(parseEmail(b.email), parseText(b.name, "表示名", 50)), 201);
      }
      if (id !== undefined && method === "PATCH") {
        const b = await readBody(req);
        return json(store.updateMember(id.toLowerCase(), parseText(b.name, "表示名", 50)));
      }
      if (id !== undefined && method === "DELETE") {
        store.removeMember(id.toLowerCase(), me.email);
        return noContent();
      }
      break;

    case "tags":
      if (id === undefined && method === "POST") {
        const b = await readBody(req);
        return json(store.addTag(parseText(b.name, "タグ名", 30), parseColor(b.color ?? "gray")), 201);
      }
      if (id !== undefined && method === "PATCH") {
        const b = await readBody(req);
        const patch: { name?: string; color?: string } = {};
        if ("name" in b) patch.name = parseText(b.name, "タグ名", 30);
        if ("color" in b) patch.color = parseColor(b.color);
        return json(store.updateTag(id, patch));
      }
      if (id !== undefined && method === "DELETE") {
        store.removeTag(id);
        return noContent();
      }
      break;

    default:
      throw new HttpError(404, "not found");
  }
  throw new HttpError(405, "method not allowed");
}
