import { SESSION_COOKIE, clearSessionCookie, readCookie, sessionCookie } from "./auth";
import { ALL, HttpError, TAG_COLORS, type TaskPatch } from "./model";
import type { TaskStore } from "./store";

const json = (data: unknown, status = 200, setCookie?: string) =>
  Response.json(data, { status, headers: setCookie ? { "Set-Cookie": setCookie } : {} });
const noContent = () => new Response(null, { status: 204 });
const bad = (message: string) => new HttpError(400, message);

function parseText(v: unknown, label: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw bad(`${label}を入力してください`);
  if (v.trim().length > max) throw bad(`${label}は${max}文字以内にしてください`);
  return v.trim();
}

function parseUsername(v: unknown): string {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{2,20}$/.test(v.trim())) {
    throw bad("ユーザー名は半角英数字と _ - の 2〜20 文字にしてください");
  }
  return v.trim().toLowerCase();
}

function parsePin(v: unknown, label = "PIN"): string {
  if (typeof v !== "string" || !/^\d{4,8}$/.test(v)) throw bad(`${label}は 4〜8 桁の数字にしてください`);
  return v;
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

export async function handleApi(req: Request, store: TaskStore): Promise<Response> {
  const [, resource, rawId, ...rest] = new URL(req.url).pathname.split("/").filter(Boolean);
  if (rest.length > 0) throw new HttpError(404, "not found");
  const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
  const method = req.method;

  // 他サイトからのフォーム送信（CSRF）を防ぐため、更新系は JSON に限定する
  if (method !== "GET" && !req.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type は application/json にしてください");
  }

  const token = readCookie(req, SESSION_COOKIE);

  // ---- ログイン不要 ----
  switch (resource) {
    case "session":
      if (method === "GET") {
        const me = await store.sessionUser(token);
        return json({ setupRequired: !store.hasMembers(), me: me?.username ?? null });
      }
      break;

    case "setup":
      if (method === "POST") {
        const b = await readBody(req);
        const newToken = await store.setup(
          parseUsername(b.username),
          parseText(b.name, "表示名", 50),
          parsePin(b.pin),
        );
        return json({ ok: true }, 200, sessionCookie(newToken));
      }
      break;

    case "login":
      if (method === "POST") {
        const b = await readBody(req);
        const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
        const pin = typeof b.pin === "string" ? b.pin : "";
        return json({ ok: true }, 200, sessionCookie(await store.login(username, pin)));
      }
      break;

    case "logout":
      if (method === "POST") {
        await store.logout(token);
        return json({ ok: true }, 200, clearSessionCookie());
      }
      break;
  }

  // ---- ここから先はログインが必要 ----
  const me = await store.sessionUser(token);
  if (!me) throw new HttpError(401, "ログインしてください");

  switch (resource) {
    case "state":
      if (id === undefined && method === "GET") {
        return json({ me: me.username, members: store.members(), tags: store.tags(), tasks: store.tasks() });
      }
      break;

    case "me":
      if (id === "pin" && method === "POST") {
        const b = await readBody(req);
        await store.changeOwnPin(me.username, String(b.currentPin ?? ""), parsePin(b.newPin, "新しい PIN"));
        return noContent();
      }
      break;

    case "tasks":
      if (id === undefined && method === "POST") {
        const b = await readBody(req);
        const task = store.createTask({
          title: parseText(b.title, "タスク名", 500),
          due: parseDue(b.due),
          assignee: b.assignee === undefined ? me.username : parseAssignee(b.assignee),
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
        return json(store.updateTask(id, patch, me.username));
      }
      if (id !== undefined && method === "DELETE") {
        store.removeTask(id);
        return noContent();
      }
      break;

    case "members":
      if (id === undefined && method === "POST") {
        const b = await readBody(req);
        const member = await store.addMember(
          parseUsername(b.username),
          parseText(b.name, "表示名", 50),
          parsePin(b.pin),
        );
        return json(member, 201);
      }
      if (id !== undefined && method === "PATCH") {
        const b = await readBody(req);
        const patch: { name?: string; pin?: string } = {};
        if ("name" in b) patch.name = parseText(b.name, "表示名", 50);
        if ("pin" in b) {
          if (id.toLowerCase() === me.username) throw bad("自分の PIN は「PIN を変更」から変えてください");
          patch.pin = parsePin(b.pin);
        }
        return json(await store.updateMember(id.toLowerCase(), patch));
      }
      if (id !== undefined && method === "DELETE") {
        store.removeMember(id.toLowerCase(), me.username);
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
