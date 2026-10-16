const $ = (sel) => document.querySelector(sel);

let tasks = [];
let filter = "active";

async function api(path, options = {}) {
  const res = await fetch(`/api/tasks${path}`, {
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
  setTimeout(() => (el.hidden = true), 4000);
}

function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function render() {
  const list = $("#tasks");
  list.replaceChildren();
  const visible = tasks.filter((t) =>
    filter === "all" ? true : filter === "done" ? t.done : !t.done,
  );
  const tpl = $("#task-template");
  const now = today();

  for (const task of visible) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.classList.toggle("done", task.done);
    li.classList.toggle("overdue", !task.done && task.due !== null && task.due < now);

    const toggle = li.querySelector(".toggle");
    toggle.checked = task.done;
    toggle.addEventListener("change", () => patch(task.id, { done: toggle.checked }));

    const title = li.querySelector(".title");
    title.textContent = task.title;
    const edit = () => startEdit(title, task);
    title.addEventListener("dblclick", edit);
    title.addEventListener("keydown", (e) => e.key === "Enter" && edit());

    const due = li.querySelector(".due");
    due.value = task.due ?? "";
    due.addEventListener("change", () => patch(task.id, { due: due.value || null }));

    li.querySelector(".delete").addEventListener("click", () => remove(task.id));
    list.append(li);
  }
  $("#empty").hidden = visible.length > 0;
}

function startEdit(span, task) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "title-edit";
  input.value = task.title;
  input.maxLength = 500;
  span.replaceWith(input);
  input.focus();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== task.title) patch(task.id, { title: value });
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function load() {
  try {
    tasks = await api("");
    render();
  } catch (e) {
    showError(e);
  }
}

async function patch(id, changes) {
  try {
    await api(`/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
  } catch (e) {
    showError(e);
  }
  await load(); // 並び順はサーバー側で決まるので再取得する
}

async function remove(id) {
  try {
    await api(`/${id}`, { method: "DELETE" });
    tasks = tasks.filter((t) => t.id !== id);
    render();
  } catch (e) {
    showError(e);
  }
}

$("#new-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#title").value.trim();
  if (!title) return;
  try {
    await api("", {
      method: "POST",
      body: JSON.stringify({ title, due: $("#due").value || null }),
    });
    $("#title").value = "";
    $("#due").value = "";
    await load();
  } catch (err) {
    showError(err);
  }
});

$("#filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  filter = btn.dataset.filter;
  for (const b of document.querySelectorAll("#filters button")) {
    b.classList.toggle("selected", b === btn);
  }
  render();
});

load();
