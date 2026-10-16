const $ = (sel) => document.querySelector(sel);

const ALL = "*";
const COLORS = [
  ["gray", "グレー"], ["red", "赤"], ["orange", "オレンジ"], ["yellow", "黄"], ["green", "緑"],
  ["teal", "青緑"], ["blue", "青"], ["purple", "紫"], ["pink", "ピンク"],
];

let state = { me: null, members: [], tags: [], tasks: [] };
let statusFilter = "active";
let assigneeFilter = "all"; // "all" | ALL | メールアドレス
let tagFilter = "all"; // "all" | "none" | タグ ID
let newTaskTags = [];

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function showError(e) {
  const el = $("#error");
  el.textContent = `エラー: ${e.message}`;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 5000);
}

async function load() {
  try {
    state = await api("/state");
    render();
  } catch (e) {
    showError(e);
  }
}

// 変更を送ってから全体を取り直す（並び順・完了状態はサーバー側で決まる）
async function mutate(path, method, body) {
  let ok = true;
  try {
    await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    ok = false;
    showError(e);
  }
  await load();
  return ok;
}

function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

const nameOf = (email) =>
  email === ALL ? "全員" : state.members.find((m) => m.email === email)?.name ?? email;
const tagById = (id) => state.tags.find((t) => t.id === id);

// 自分を先頭に並べたメンバー
const membersMeFirst = () =>
  [...state.members].sort((a, b) => (b.email === state.me) - (a.email === state.me));

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setOptions(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
  select.value = options.some(([v]) => v === value) ? value : options[0]?.[0] ?? "";
  return select.value;
}

function assigneeOptions() {
  return [
    ...membersMeFirst().map((m) => [m.email, m.email === state.me ? `${m.name}（自分）` : m.name]),
    [ALL, "全員"],
  ];
}

function tagChip(tag) {
  return el("span", { className: `chip tag c-${tag.color}`, textContent: tag.name });
}

// タグを選ぶドロップダウン。閉じたときに選択が変わっていれば onChange を呼ぶ
function tagPicker(selected, onChange) {
  const current = new Set(selected);
  const summary = el("summary");
  const renderSummary = () => {
    const chips = [...current].map(tagById).filter(Boolean).map(tagChip);
    summary.replaceChildren(...(chips.length ? chips : [el("span", { className: "placeholder", textContent: "＋タグ" })]));
  };

  const menu = el("div", { className: "menu" });
  if (state.tags.length === 0) {
    menu.append(el("p", { className: "note", textContent: "「設定」からタグを追加できます" }));
  }
  for (const tag of state.tags) {
    const box = el("input", { type: "checkbox", checked: current.has(tag.id) });
    box.addEventListener("change", () => {
      box.checked ? current.add(tag.id) : current.delete(tag.id);
      renderSummary();
    });
    menu.append(el("label", {}, box, tagChip(tag)));
  }

  const details = el("details", { className: "tag-picker" }, summary, menu);
  details.addEventListener("toggle", () => {
    const changed = current.size !== selected.length || selected.some((id) => !current.has(id));
    if (!details.open && changed) onChange([...current]);
  });
  renderSummary();
  return details;
}

// 開いているタグ選択は、外側をクリックしたら閉じる
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.tag-picker[open]")) {
    if (!d.contains(e.target)) d.open = false;
  }
});

// ある人から見て「自分の分が終わったか」。全員の作業は本人の分だけで判定する
function isDoneFor(task, email) {
  if (task.assignee === ALL && email) return task.completedBy.includes(email);
  return task.done;
}

function isVisible(task) {
  let viewer = null;
  if (assigneeFilter === ALL) {
    if (task.assignee !== ALL) return false;
  } else if (assigneeFilter !== "all") {
    if (task.assignee !== assigneeFilter && task.assignee !== ALL) return false;
    viewer = assigneeFilter;
  }
  if (tagFilter === "none" && task.tags.length > 0) return false;
  if (tagFilter !== "all" && tagFilter !== "none" && !task.tags.includes(tagFilter)) return false;

  const done = isDoneFor(task, viewer);
  return statusFilter === "all" || (statusFilter === "done" ? done : !done);
}

function render() {
  $("#me").textContent = `${nameOf(state.me)} としてログイン中`;
  renderNewTaskForm();
  renderFilters();
  renderTasks();
  if ($("#settings").open) renderSettings();
}

function renderNewTaskForm() {
  setOptions($("#assignee"), assigneeOptions(), $("#assignee").value || state.me);
  newTaskTags = newTaskTags.filter(tagById);
  $("#new-task-tags").replaceChildren(
    tagPicker(newTaskTags, (ids) => {
      newTaskTags = ids;
      renderNewTaskForm();
    }),
  );
}

function renderFilters() {
  assigneeFilter = setOptions($("#assignee-filter"), [
    ["all", "すべての担当"],
    ...membersMeFirst().map((m) => [m.email, m.email === state.me ? "自分のやること" : `${m.name}のやること`]),
    [ALL, "全員でやる作業"],
  ], assigneeFilter);
  tagFilter = setOptions($("#tag-filter"), [
    ["all", "すべてのタグ"],
    ...state.tags.map((t) => [t.id, t.name]),
    ["none", "タグなし"],
  ], tagFilter);
}

function renderTasks() {
  const list = $("#tasks");
  list.replaceChildren();
  const visible = state.tasks.filter(isVisible);
  const tpl = $("#task-template");
  const now = today();

  for (const task of visible) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    const shared = task.assignee === ALL;
    li.classList.toggle("done", task.done);
    li.classList.toggle("overdue", !task.done && task.due !== null && task.due < now);
    li.classList.toggle("shared", shared);
    const update = (changes) => mutate(`/tasks/${task.id}`, "PATCH", changes);

    // 全員の作業では、チェックボックスは自分の分の完了を表す
    const toggle = li.querySelector(".toggle");
    toggle.checked = shared ? task.completedBy.includes(state.me) : task.done;
    toggle.title = shared ? "自分の分を完了" : "完了";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.addEventListener("change", () => update({ done: toggle.checked }));

    const title = li.querySelector(".title");
    title.textContent = task.title;
    const edit = () => startEdit(title, task);
    title.addEventListener("dblclick", edit);
    title.addEventListener("keydown", (e) => e.key === "Enter" && edit());

    const assignee = li.querySelector(".assignee");
    setOptions(assignee, assigneeOptions(), task.assignee);
    assignee.addEventListener("change", () => update({ assignee: assignee.value }));

    if (shared) {
      li.querySelector(".progress").replaceChildren(
        ...membersMeFirst().map((m) => {
          const ok = task.completedBy.includes(m.email);
          return el("span", { className: ok ? "chip ok" : "chip", textContent: `${ok ? "✓" : "○"} ${m.name}` });
        }),
      );
    }

    li.querySelector(".tags").replaceChildren(tagPicker(task.tags, (ids) => update({ tags: ids })));

    const due = li.querySelector(".due");
    due.value = task.due ?? "";
    due.addEventListener("change", () => update({ due: due.value || null }));

    li.querySelector(".delete").addEventListener("click", () => {
      if (confirm(`「${task.title}」を削除しますか？`)) mutate(`/tasks/${task.id}`, "DELETE");
    });
    list.append(li);
  }
  $("#empty").hidden = visible.length > 0;
}

function startEdit(span, task) {
  const input = el("input", { type: "text", className: "title-edit", value: task.title, maxLength: 500 });
  span.replaceWith(input);
  input.focus();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== task.title) mutate(`/tasks/${task.id}`, "PATCH", { title: value });
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// ---- 設定（メンバー・タグ） ----

function renderSettings() {
  $("#member-list").replaceChildren(
    ...state.members.map((m) => {
      const isMe = m.email === state.me;
      const name = el("input", { type: "text", value: m.name, maxLength: 50, ariaLabel: "表示名" });
      name.addEventListener("change", () =>
        mutate(`/members/${encodeURIComponent(m.email)}`, "PATCH", { name: name.value }));
      const del = el("button", { type: "button", className: "delete", textContent: "×", disabled: isMe, title: isMe ? "自分は削除できません" : "削除" });
      del.addEventListener("click", () => {
        if (confirm(`${m.name} をメンバーから外しますか？\nこの人が担当のタスクは「全員」に変わります。`)) {
          mutate(`/members/${encodeURIComponent(m.email)}`, "DELETE");
        }
      });
      return el("li", {}, name, el("span", { className: "email", textContent: isMe ? `${m.email}（自分）` : m.email }), del);
    }),
  );

  $("#tag-list").replaceChildren(
    ...state.tags.map((t) => {
      const name = el("input", { type: "text", value: t.name, maxLength: 30, ariaLabel: "タグ名" });
      name.addEventListener("change", () => mutate(`/tags/${t.id}`, "PATCH", { name: name.value }));
      const color = el("select", { ariaLabel: "色" });
      setOptions(color, COLORS, t.color);
      color.addEventListener("change", () => mutate(`/tags/${t.id}`, "PATCH", { color: color.value }));
      const del = el("button", { type: "button", className: "delete", textContent: "×", title: "削除" });
      del.addEventListener("click", () => {
        if (confirm(`タグ「${t.name}」を削除しますか？\n付いているタスクからも外れます。`)) mutate(`/tags/${t.id}`, "DELETE");
      });
      return el("li", {}, tagChip(t), name, color, del);
    }),
  );
  if (state.tags.length === 0) {
    $("#tag-list").append(el("li", { className: "note", textContent: "タグはまだありません" }));
  }
}

$("#open-settings").addEventListener("click", () => {
  renderSettings();
  $("#settings").showModal();
});

$("#new-member").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await mutate("/members", "POST", { email: $("#member-email").value, name: $("#member-name").value });
  if (ok) e.target.reset();
});

setOptions($("#tag-color"), COLORS, "blue");
$("#new-tag").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await mutate("/tags", "POST", { name: $("#tag-name").value, color: $("#tag-color").value });
  if (ok) $("#tag-name").value = "";
});

// ---- タスク追加・絞り込み ----

$("#new-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#title").value.trim();
  if (!title) return;
  const ok = await mutate("/tasks", "POST", {
    title,
    due: $("#due").value || null,
    assignee: $("#assignee").value,
    tags: newTaskTags,
  });
  if (ok) {
    $("#title").value = "";
    $("#due").value = "";
    newTaskTags = [];
    renderNewTaskForm();
  }
});

$("#status-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  statusFilter = btn.dataset.filter;
  for (const b of document.querySelectorAll("#status-filter button")) {
    b.classList.toggle("selected", b === btn);
  }
  renderTasks();
});

$("#assignee-filter").addEventListener("change", (e) => {
  assigneeFilter = e.target.value;
  renderTasks();
});

$("#tag-filter").addEventListener("change", (e) => {
  tagFilter = e.target.value;
  renderTasks();
});

// 他の人の変更を反映するため、タブに戻ってきたら再取得する
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.me) load();
});

load();
