import { DurableObject } from "cloudflare:workers";
import { handleApi } from "./api";
import { parseUsers } from "./auth";
import type { Env } from "./env";
import { ALL, HttpError, type Member, type Tag, type Task, type TaskInput, type TaskPatch } from "./model";

type TaskRow = { id: string; title: string; due: string | null; assignee: string; created_at: number };

const SCHEMA_VERSION = 3;

// 全データを 1 つの Durable Object（SQLite）に保存する。
// メソッドはすべて同期処理なので、1 リクエスト内の書き込みはまとめて反映される
export class TaskStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => this.migrate());
  }

  // Worker で認証済みのリクエストを受け取る（X-User-Email にログイン中のメールアドレス）
  async fetch(req: Request): Promise<Response> {
    try {
      this.seedMembers();
      return await handleApi(req, this, req.headers.get("X-User-Email") ?? "");
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
      // v2: 担当者を追加し、完了状態をメンバーごとに記録する
      this.sql.exec(`ALTER TABLE tasks ADD COLUMN assignee TEXT NOT NULL DEFAULT '${ALL}'`);
      this.sql.exec(`
        CREATE TABLE completions (
          task_id TEXT NOT NULL,
          email TEXT NOT NULL,
          PRIMARY KEY (task_id, email)
        )
      `);
      for (const { email } of parseUsers(this.env.USERS)) {
        this.sql.exec(
          "INSERT INTO completions (task_id, email) SELECT id, ? FROM tasks WHERE done = 1",
          email,
        );
      }
      this.sql.exec("ALTER TABLE tasks DROP COLUMN done");
    }
    if (version < 3) {
      // v3: メンバーとタグを DB で管理する
      this.sql.exec(`
        CREATE TABLE members (
          email TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
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

  // メンバーが 0 人のときだけ、環境変数 USERS から最初のメンバーを登録する
  private seedMembers() {
    if (this.members().length > 0) return;
    const now = Date.now();
    parseUsers(this.env.USERS).forEach((m, i) => {
      this.sql.exec(
        "INSERT OR IGNORE INTO members (email, name, created_at) VALUES (?, ?, ?)",
        m.email, m.name, now + i,
      );
    });
    if (this.members().length === 0) {
      throw new HttpError(500, "メンバーがいません。環境変数 USERS に最初のメンバーを設定してください");
    }
  }

  // ---- メンバー ----

  members(): Member[] {
    return this.sql
      .exec<{ email: string; name: string }>("SELECT email, name FROM members ORDER BY created_at")
      .toArray()
      .map(({ email, name }) => ({ email, name }));
  }

  member(email: string): Member | null {
    return this.members().find((m) => m.email === email) ?? null;
  }

  addMember(email: string, name: string): Member {
    if (this.member(email)) throw new HttpError(409, `${email} はすでにメンバーです`);
    // 完了済みの「全員」タスクが、新メンバーの追加で未完了に戻らないようにする
    const doneShared = this.tasks().filter((t) => t.assignee === ALL && t.done);
    this.sql.exec(
      "INSERT INTO members (email, name, created_at) VALUES (?, ?, ?)",
      email, name, Date.now(),
    );
    for (const t of doneShared) {
      this.sql.exec("INSERT OR IGNORE INTO completions (task_id, email) VALUES (?, ?)", t.id, email);
    }
    return { email, name };
  }

  updateMember(email: string, name: string): Member {
    if (this.sql.exec("UPDATE members SET name = ? WHERE email = ?", name, email).rowsWritten === 0) {
      throw new HttpError(404, "メンバーが見つかりません");
    }
    return { email, name };
  }

  // 削除したメンバーの担当タスクは「全員」に付け替える（完了済みのものは完了のまま）
  removeMember(email: string, requester: string) {
    if (email === requester) throw new HttpError(400, "自分は削除できません");
    if (!this.member(email)) throw new HttpError(404, "メンバーが見つかりません");

    const remaining = this.members().filter((m) => m.email !== email);
    for (const t of this.tasks().filter((t) => t.assignee === email && t.done)) {
      for (const m of remaining) {
        this.sql.exec("INSERT OR IGNORE INTO completions (task_id, email) VALUES (?, ?)", t.id, m.email);
      }
    }
    this.sql.exec("UPDATE tasks SET assignee = ? WHERE assignee = ?", ALL, email);
    this.sql.exec("DELETE FROM completions WHERE email = ?", email);
    this.sql.exec("DELETE FROM members WHERE email = ?", email);
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
    const members = this.members().map((m) => m.email);
    const completions = this.groupBy("SELECT task_id AS k, email AS v FROM completions");
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
          done: required.length > 0 && required.every((e) => completedBy.includes(e)),
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
        this.sql.exec("INSERT OR IGNORE INTO completions (task_id, email) VALUES (?, ?)", id, who);
      } else {
        this.sql.exec("DELETE FROM completions WHERE task_id = ? AND email = ?", id, who);
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
