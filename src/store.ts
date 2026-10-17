import { DurableObject } from "cloudflare:workers";
import { handleApi } from "./api";
import { SESSION_TTL_MS, hashPin, randomHex, safeEqual, sha256Hex } from "./auth";
import type { Env } from "./env";
import { ALL, HttpError, type Member, type Tag, type Task, type TaskInput, type TaskPatch } from "./model";

type TaskRow = { id: string; title: string; due: string | null; assignee: string; created_at: number };
type MemberRow = {
  username: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
  failed_count: number;
  locked_until: number;
};

const SCHEMA_VERSION = 2;
const MAX_PIN_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

// 全データを 1 つの Durable Object（SQLite）に保存する
export class TaskStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => this.migrate());
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await handleApi(req, this);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }

  private migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'").toArray();
    const version = rows.length ? Number(rows[0].value) : 0;

    if (version < 1) {
      // v1: 最初のバージョン（担当者なし）
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
    if (version < 2) {
      // v2: メンバー・担当者・タグ・ログインを追加
      this.sql.exec(`ALTER TABLE tasks ADD COLUMN assignee TEXT NOT NULL DEFAULT '${ALL}'`);
      // v1 で完了済みだったタスクは、最初のメンバー登録時にそのメンバーの完了として引き継ぐ
      this.sql.exec("CREATE TABLE legacy_done (task_id TEXT PRIMARY KEY)");
      this.sql.exec("INSERT INTO legacy_done (task_id) SELECT id FROM tasks WHERE done = 1");
      this.sql.exec("ALTER TABLE tasks DROP COLUMN done");
      this.sql.exec(`
        CREATE TABLE completions (
          task_id TEXT NOT NULL,
          member TEXT NOT NULL,
          PRIMARY KEY (task_id, member)
        )
      `);
      this.sql.exec(`
        CREATE TABLE members (
          username TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          pin_hash TEXT NOT NULL,
          pin_salt TEXT NOT NULL,
          failed_count INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE task_tags (
          task_id TEXT NOT NULL,
          tag_id TEXT NOT NULL,
          PRIMARY KEY (task_id, tag_id)
        )
      `);
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)",
      String(SCHEMA_VERSION),
    );
  }

  // ---- ログイン・セッション ----

  hasMembers(): boolean {
    return this.sql.exec("SELECT 1 FROM members LIMIT 1").toArray().length > 0;
  }

  private memberRow(username: string): MemberRow | null {
    return this.sql.exec<MemberRow>("SELECT * FROM members WHERE username = ?", username).toArray()[0] ?? null;
  }

  private async pinFields(pin: string) {
    const salt = randomHex(16);
    return { salt, hash: await hashPin(pin, salt) };
  }

  private async createSession(username: string): Promise<string> {
    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.sql.exec(
      "INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)",
      tokenHash, username, now + SESSION_TTL_MS,
    );
    return token;
  }

  // 最初のメンバーを登録する（メンバーが 0 人のときだけ）
  async setup(username: string, name: string, pin: string): Promise<string> {
    const { salt, hash } = await this.pinFields(pin);
    if (this.hasMembers()) throw new HttpError(409, "初期設定はすでに完了しています");
    this.sql.exec(
      "INSERT INTO members (username, name, pin_hash, pin_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      username, name, hash, salt, Date.now(),
    );
    this.sql.exec("INSERT INTO completions (task_id, member) SELECT task_id, ? FROM legacy_done", username);
    this.sql.exec("DELETE FROM legacy_done");
    return this.createSession(username);
  }

  async login(username: string, pin: string): Promise<string> {
    const invalid = new HttpError(401, "ユーザー名か PIN が違います");
    const row = this.memberRow(username);
    if (!row) {
      await hashPin(pin, randomHex(16)); // 存在しないユーザーでも応答時間をそろえる
      throw invalid;
    }
    const now = Date.now();
    if (row.locked_until > now) {
      const minutes = Math.ceil((row.locked_until - now) / 60000);
      throw new HttpError(429, `PIN を続けて間違えたためロック中です。${minutes} 分後にもう一度お試しください`);
    }

    if (!safeEqual(await hashPin(pin, row.pin_salt), row.pin_hash)) {
      this.sql.exec("UPDATE members SET failed_count = failed_count + 1 WHERE username = ?", username);
      const failures = this.memberRow(username)?.failed_count ?? 0;
      if (failures >= MAX_PIN_FAILURES) {
        this.sql.exec(
          "UPDATE members SET failed_count = 0, locked_until = ? WHERE username = ?",
          now + LOCK_MS, username,
        );
      }
      throw invalid;
    }
    this.sql.exec("UPDATE members SET failed_count = 0, locked_until = 0 WHERE username = ?", username);
    return this.createSession(username);
  }

  async sessionUser(token: string | null): Promise<Member | null> {
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    return (
      this.sql
        .exec<{ username: string; name: string }>(
          `SELECT m.username, m.name FROM sessions s JOIN members m ON m.username = s.username
           WHERE s.token_hash = ? AND s.expires_at > ?`,
          tokenHash, Date.now(),
        )
        .toArray()[0] ?? null
    );
  }

  async logout(token: string | null) {
    if (token) this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(token));
  }

  async changeOwnPin(username: string, currentPin: string, newPin: string) {
    const row = this.memberRow(username);
    if (!row || !safeEqual(await hashPin(currentPin, row.pin_salt), row.pin_hash)) {
      throw new HttpError(400, "現在の PIN が違います");
    }
    await this.setPin(username, newPin);
  }

  private async setPin(username: string, pin: string) {
    const { salt, hash } = await this.pinFields(pin);
    this.sql.exec(
      "UPDATE members SET pin_hash = ?, pin_salt = ?, failed_count = 0, locked_until = 0 WHERE username = ?",
      hash, salt, username,
    );
  }

  // ---- メンバー ----

  members(): Member[] {
    return this.sql
      .exec<{ username: string; name: string }>("SELECT username, name FROM members ORDER BY created_at")
      .toArray()
      .map(({ username, name }) => ({ username, name }));
  }

  member(username: string): Member | null {
    return this.members().find((m) => m.username === username) ?? null;
  }

  async addMember(username: string, name: string, pin: string): Promise<Member> {
    const { salt, hash } = await this.pinFields(pin);
    if (this.member(username)) throw new HttpError(409, `ユーザー名「${username}」はすでに使われています`);
    // 完了済みの「全員」タスクが、新メンバーの追加で未完了に戻らないようにする
    const doneShared = this.tasks().filter((t) => t.assignee === ALL && t.done);
    this.sql.exec(
      "INSERT INTO members (username, name, pin_hash, pin_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      username, name, hash, salt, Date.now(),
    );
    for (const t of doneShared) {
      this.sql.exec("INSERT OR IGNORE INTO completions (task_id, member) VALUES (?, ?)", t.id, username);
    }
    return { username, name };
  }

  // 他のメンバーの表示名変更・PIN 再設定（PIN を忘れたとき用）
  async updateMember(username: string, patch: { name?: string; pin?: string }): Promise<Member> {
    const cur = this.member(username);
    if (!cur) throw new HttpError(404, "メンバーが見つかりません");
    if (patch.pin !== undefined) {
      await this.setPin(username, patch.pin);
      this.sql.exec("DELETE FROM sessions WHERE username = ?", username);
    }
    if (patch.name !== undefined) {
      this.sql.exec("UPDATE members SET name = ? WHERE username = ?", patch.name, username);
    }
    return { username, name: patch.name ?? cur.name };
  }

  // 削除したメンバーの担当タスクは「全員」に付け替える（完了済みのものは完了のまま）
  removeMember(username: string, requester: string) {
    if (username === requester) throw new HttpError(400, "自分は削除できません");
    if (!this.member(username)) throw new HttpError(404, "メンバーが見つかりません");

    const remaining = this.members().filter((m) => m.username !== username);
    for (const t of this.tasks().filter((t) => t.assignee === username && t.done)) {
      for (const m of remaining) {
        this.sql.exec("INSERT OR IGNORE INTO completions (task_id, member) VALUES (?, ?)", t.id, m.username);
      }
    }
    this.sql.exec("UPDATE tasks SET assignee = ? WHERE assignee = ?", ALL, username);
    this.sql.exec("DELETE FROM completions WHERE member = ?", username);
    this.sql.exec("DELETE FROM sessions WHERE username = ?", username);
    this.sql.exec("DELETE FROM members WHERE username = ?", username);
  }

  // ---- タグ ----

  tags(): Tag[] {
    return this.sql
      .exec<{ id: string; name: string; color: string }>("SELECT id, name, color FROM tags ORDER BY created_at")
      .toArray()
      .map(({ id, name, color }) => ({ id, name, color }));
  }

  private assertTagNameFree(name: string, exceptId?: string) {
    const lower = name.toLowerCase();
    if (this.tags().some((t) => t.id !== exceptId && t.name.toLowerCase() === lower)) {
      throw new HttpError(409, `タグ「${name}」はすでにあります`);
    }
  }

  addTag(name: string, color: string): Tag {
    this.assertTagNameFree(name);
    const tag = { id: crypto.randomUUID(), name, color };
    this.sql.exec(
      "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)",
      tag.id, tag.name, tag.color, Date.now(),
    );
    return tag;
  }

  updateTag(id: string, patch: { name?: string; color?: string }): Tag {
    const cur = this.tags().find((t) => t.id === id);
    if (!cur) throw new HttpError(404, "タグが見つかりません");
    if (patch.name !== undefined) this.assertTagNameFree(patch.name, id);
    const next = { ...cur, ...patch };
    this.sql.exec("UPDATE tags SET name = ?, color = ? WHERE id = ?", next.name, next.color, id);
    return next;
  }

  removeTag(id: string) {
    this.sql.exec("DELETE FROM task_tags WHERE tag_id = ?", id);
    if (this.sql.exec("DELETE FROM tags WHERE id = ?", id).rowsWritten === 0) {
      throw new HttpError(404, "タグが見つかりません");
    }
  }

  // ---- タスク ----

  private groupBy(query: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const { k, v } of this.sql.exec<{ k: string; v: string }>(query)) {
      const list = map.get(k) ?? [];
      list.push(v);
      map.set(k, list);
    }
    return map;
  }

  tasks(): Task[] {
    const members = this.members().map((m) => m.username);
    const completions = this.groupBy("SELECT task_id AS k, member AS v FROM completions");
    const taskTags = this.groupBy("SELECT task_id AS k, tag_id AS v FROM task_tags");

    return this.sql
      .exec<TaskRow>("SELECT * FROM tasks")
      .toArray()
      .map((r): Task => {
        const completedBy = completions.get(r.id) ?? [];
        const required = r.assignee === ALL ? members : [r.assignee];
        return {
          id: r.id,
          title: r.title,
          due: r.due,
          assignee: r.assignee,
          tags: taskTags.get(r.id) ?? [],
          completedBy,
          done: required.length > 0 && required.every((m) => completedBy.includes(m)),
          createdAt: r.created_at,
        };
      })
      .sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          Number(a.due === null) - Number(b.due === null) ||
          (a.due ?? "").localeCompare(b.due ?? "") ||
          b.createdAt - a.createdAt,
      );
  }

  private task(id: string): Task {
    const task = this.tasks().find((t) => t.id === id);
    if (!task) throw new HttpError(404, "タスクが見つかりません");
    return task;
  }

  private assertAssignee(assignee: string) {
    if (assignee !== ALL && !this.member(assignee)) {
      throw new HttpError(400, "担当者がメンバーにいません");
    }
  }

  private setTaskTags(taskId: string, tagIds: string[]) {
    const known = new Set(this.tags().map((t) => t.id));
    if (!tagIds.every((id) => known.has(id))) throw new HttpError(400, "存在しないタグです");
    this.sql.exec("DELETE FROM task_tags WHERE task_id = ?", taskId);
    for (const tagId of tagIds) {
      this.sql.exec("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)", taskId, tagId);
    }
  }

  createTask(input: TaskInput): Task {
    this.assertAssignee(input.assignee);
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO tasks (id, title, due, assignee, created_at) VALUES (?, ?, ?, ?, ?)",
      id, input.title, input.due, input.assignee, Date.now(),
    );
    this.setTaskTags(id, input.tags);
    return this.task(id);
  }

  // done は「誰の分か」を担当者から決める：個人担当ならその人の分、全員ならリクエストした本人の分
  updateTask(id: string, patch: TaskPatch, requester: string): Task {
    const cur = this.task(id);
    const assignee = patch.assignee ?? cur.assignee;
    this.assertAssignee(assignee);

    this.sql.exec(
      "UPDATE tasks SET title = ?, due = ?, assignee = ? WHERE id = ?",
      patch.title ?? cur.title,
      patch.due === undefined ? cur.due : patch.due,
      assignee,
      id,
    );
    if (patch.tags !== undefined) this.setTaskTags(id, patch.tags);

    if (patch.done !== undefined) {
      const who = assignee === ALL ? requester : assignee;
      if (patch.done) {
        this.sql.exec("INSERT OR IGNORE INTO completions (task_id, member) VALUES (?, ?)", id, who);
      } else {
        this.sql.exec("DELETE FROM completions WHERE task_id = ? AND member = ?", id, who);
      }
    }
    return this.task(id);
  }

  removeTask(id: string) {
    this.sql.exec("DELETE FROM completions WHERE task_id = ?", id);
    this.sql.exec("DELETE FROM task_tags WHERE task_id = ?", id);
    if (this.sql.exec("DELETE FROM tasks WHERE id = ?", id).rowsWritten === 0) {
      throw new HttpError(404, "タスクが見つかりません");
    }
  }
}
