#!/usr/bin/env node
// todos: プロジェクトの Todo を 1 件 1 ファイルで管理する。Claude Code の mod（hooks/register.tsx）から呼ばれるほか、
// 端末からも同じコマンドで扱える。依存パッケージはなく、node だけで動く。
//
// 保存先は <project>/.claude/todos/<id>.md。環境変数 CLAUDE_TODO_PATH で変えられる（相対パスはプロジェクト基準）。
// ファイルの形は、1 行目が JSON のメタデータ、空行、本文（Markdown）。
//   {"id":"t-abc12","title":"...","tags":["ui"],"status":"open","created_at":"...","updated_at":"...","assigned_to_session":null}
//
// 状態は open（未着手）、in_progress（進行中）、done（完了）。done は closed とも書ける。
// 完了して 7 日たった Todo は gc で消す（保存先の settings.json に {"gc": false} で止められる）。
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATUSES = ["open", "in_progress", "done"];
const STATUS_LABEL = { open: "未着手", in_progress: "進行中", done: "完了" };
const DEFAULT_GC_DAYS = 7;

export function todoDir(root, env = process.env) {
  const configured = env.CLAUDE_TODO_PATH?.trim();
  return configured ? path.resolve(root, configured) : path.join(root, ".claude", "todos");
}

export function normalizeStatus(value) {
  const text = String(value ?? "open").trim().toLowerCase().replace(/-/g, "_");
  if (text === "closed" || text === "完了") return "done";
  if (text === "progress" || text === "doing" || text === "進行中") return "in_progress";
  if (text === "todo" || text === "未着手") return "open";
  if (!STATUSES.includes(text)) throw new Error(`status は ${STATUSES.join("、")} のいずれかにしてください（指定値: ${value}）`);
  return text;
}

export function isClosed(status) {
  return status === "done";
}

function newId(existing) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `t-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
    if (!existing.has(id)) return id;
  }
  throw new Error("id を作れませんでした");
}

export function parseTodo(text, fallbackId) {
  const newline = text.indexOf("\n");
  const head = newline < 0 ? text : text.slice(0, newline);
  let meta;
  try {
    meta = JSON.parse(head);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || typeof meta.title !== "string") return null;
  const body = newline < 0 ? "" : text.slice(newline + 1).replace(/^\n/, "");
  return {
    id: typeof meta.id === "string" ? meta.id : fallbackId,
    title: meta.title,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    status: STATUSES.includes(meta.status) ? meta.status : "open",
    created_at: typeof meta.created_at === "string" ? meta.created_at : new Date(0).toISOString(),
    updated_at: typeof meta.updated_at === "string" ? meta.updated_at : null,
    done_at: typeof meta.done_at === "string" ? meta.done_at : null,
    assigned_to_session: typeof meta.assigned_to_session === "string" ? meta.assigned_to_session : null,
    body,
  };
}

export function serializeTodo(todo) {
  const { body, ...meta } = todo;
  return `${JSON.stringify(meta)}\n\n${body ?? ""}`.replace(/\s+$/, "") + "\n";
}

export function readAll(dir) {
  if (!existsSync(dir)) return [];
  const todos = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const parsed = parseTodo(readFileSync(path.join(dir, name), "utf8"), name.slice(0, -3));
    if (parsed) todos.push(parsed);
  }
  return todos.sort(compareTodos);
}

// 未完了を先に、進行中を未着手より先に、同じ状態なら新しいものを先に。
function compareTodos(a, b) {
  const rank = (todo) => (todo.status === "in_progress" ? 0 : todo.status === "open" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at);
}

function save(dir, todo) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${todo.id}.md`), serializeTodo(todo), "utf8");
  return todo;
}

function find(dir, id) {
  const todos = readAll(dir);
  const exact = todos.find((todo) => todo.id === id);
  if (exact) return exact;
  const prefix = todos.filter((todo) => todo.id.startsWith(id));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) throw new Error(`id ${id} に当たる Todo が複数あります: ${prefix.map((todo) => todo.id).join(", ")}`);
  throw new Error(`Todo ${id} が見つかりません`);
}

export function add(dir, { title, tags = [], body = "", status = "open", assign = null }) {
  if (!title || !title.trim()) throw new Error("title を書いてください");
  const now = new Date().toISOString();
  const todo = {
    id: newId(new Set(readAll(dir).map((todo) => todo.id))),
    title: title.trim(),
    tags: tags.map((tag) => String(tag).trim()).filter(Boolean),
    status: normalizeStatus(status),
    created_at: now,
    updated_at: now,
    done_at: null,
    assigned_to_session: assign || null,
    body: body ?? "",
  };
  if (todo.status === "done") todo.done_at = now;
  return save(dir, todo);
}

export function update(dir, id, changes) {
  const todo = find(dir, id);
  const now = new Date().toISOString();
  if (changes.title !== undefined) {
    if (!String(changes.title).trim()) throw new Error("title は空にできません");
    todo.title = String(changes.title).trim();
  }
  if (changes.tags !== undefined) todo.tags = changes.tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (changes.body !== undefined) todo.body = String(changes.body);
  if (changes.appendBody) todo.body = `${todo.body.replace(/\s+$/, "")}\n\n${changes.appendBody}`.replace(/^\n+/, "");
  if (changes.status !== undefined) {
    const next = normalizeStatus(changes.status);
    if (next === "done" && todo.status !== "done") todo.done_at = now;
    if (next !== "done") todo.done_at = null;
    todo.status = next;
  }
  if (changes.assign !== undefined) todo.assigned_to_session = changes.assign === null || changes.assign === "none" || changes.assign === "" ? null : String(changes.assign);
  todo.updated_at = now;
  return save(dir, todo);
}

export function remove(dir, id) {
  const todo = find(dir, id);
  unlinkSync(path.join(dir, `${todo.id}.md`));
  return todo;
}

export function readSettings(dir) {
  const file = path.join(dir, "settings.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// 完了して一定日数たった Todo を消す。settings.json の gc が false なら何もしない。
export function gc(dir, { days = DEFAULT_GC_DAYS, now = Date.now() } = {}) {
  const settings = readSettings(dir);
  if (settings.gc === false) return { removed: [], disabled: true };
  const limit = Number.isFinite(settings.gcDays) ? settings.gcDays : days;
  const removed = [];
  for (const todo of readAll(dir)) {
    if (!isClosed(todo.status)) continue;
    const doneAt = Date.parse(todo.done_at ?? todo.updated_at ?? todo.created_at);
    if (Number.isFinite(doneAt) && now - doneAt > limit * 24 * 60 * 60 * 1000) {
      unlinkSync(path.join(dir, `${todo.id}.md`));
      removed.push(todo);
    }
  }
  return { removed, disabled: false, days: limit };
}

export function search(todos, { query = "", all = false, session = null, status = null } = {}) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return todos.filter((todo) => {
    if (!all && isClosed(todo.status)) return false;
    if (status && todo.status !== status) return false;
    if (session && todo.assigned_to_session !== session) return false;
    if (words.length === 0) return true;
    const haystack = `${todo.id} ${todo.title} ${todo.tags.map((tag) => `#${tag}`).join(" ")} ${todo.status} ${todo.body}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function summarize(todos, session = null) {
  const open = todos.filter((todo) => !isClosed(todo.status));
  return {
    total: todos.length,
    open: open.length,
    inProgress: open.filter((todo) => todo.status === "in_progress").length,
    assigned: session ? open.filter((todo) => todo.assigned_to_session === session).length : 0,
    done: todos.length - open.length,
  };
}

export function formatLine(todo, session = null) {
  const mark = todo.status === "done" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]";
  const tags = todo.tags.length > 0 ? ` ${todo.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  const assigned = todo.assigned_to_session ? (todo.assigned_to_session === session ? "（担当: このセッション）" : `（担当: ${todo.assigned_to_session.slice(0, 8)}）`) : "";
  return `${mark} ${todo.id} ${todo.title}${tags}${assigned}`;
}

export function formatDetail(todo, session = null) {
  const lines = [
    `${todo.id} ${todo.title}`,
    `状態: ${STATUS_LABEL[todo.status]}${todo.tags.length > 0 ? `　タグ: ${todo.tags.map((tag) => `#${tag}`).join(" ")}` : ""}`,
    `作成: ${todo.created_at}${todo.updated_at ? `　更新: ${todo.updated_at}` : ""}${todo.done_at ? `　完了: ${todo.done_at}` : ""}`,
    `担当: ${todo.assigned_to_session ? (todo.assigned_to_session === session ? "このセッション" : todo.assigned_to_session) : "なし"}`,
  ];
  if (todo.body.trim()) lines.push("", todo.body.trim());
  return lines.join("\n");
}

// ---- CLI ----

function usage() {
  return [
    "使い方: node todos.mjs <command> [--root <dir>] [--json]",
    "  list [--query <text>] [--all] [--session <id>] [--status <s>]   Todo の一覧（既定は未完了だけ）",
    "  show <id>                                                       1 件の詳細",
    "  add <title> [--tags a,b] [--body <text>] [--status <s>] [--assign <session>]",
    "  update <id> [--title <t>] [--tags a,b] [--body <text>] [--append <text>] [--status <s>] [--assign <session>|none]",
    "  done <id> [--append <text>]                                      完了にする（確かめた内容を --append で残す）",
    "  remove <id>                                                      消す",
    "  gc [--days 7]                                                    完了して一定日数たった Todo を消す",
    "  summary [--session <id>]                                         件数",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { json: false, root: process.cwd(), positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--all") options.all = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      options[key] = argv[index + 1] !== undefined && !argv[index + 1].startsWith("--") ? argv[++index] : "";
    } else options.positional.push(arg);
  }
  if (options.root) options.root = path.resolve(options.root);
  return options;
}

function splitTags(value) {
  return value === undefined ? undefined : String(value).split(",").map((tag) => tag.trim()).filter(Boolean);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [command, ...rest] = options.positional;
  const dir = todoDir(options.root);
  const session = options.session || null;
  const out = (json, text) => process.stdout.write(options.json ? `${JSON.stringify(json)}\n` : `${text}\n`);
  try {
    if (!command || command === "help") {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (command === "list") {
      const todos = search(readAll(dir), { query: options.query ?? rest.join(" "), all: Boolean(options.all), session, status: options.status ? normalizeStatus(options.status) : null });
      out({ todos, summary: summarize(readAll(dir), session), dir }, todos.length === 0 ? "Todo はありません" : todos.map((todo) => formatLine(todo, session)).join("\n"));
      return;
    }
    if (command === "summary") {
      const summary = summarize(readAll(dir), session);
      out({ summary, dir }, `未完了 ${summary.open}件（進行中 ${summary.inProgress}件${session ? `、このセッションの担当 ${summary.assigned}件` : ""}）、完了 ${summary.done}件`);
      return;
    }
    if (command === "show") {
      const todo = find(dir, rest[0] ?? "");
      out(todo, formatDetail(todo, session));
      return;
    }
    if (command === "add") {
      const todo = add(dir, { title: rest.join(" ") || options.title, tags: splitTags(options.tags) ?? [], body: options.body ?? "", status: options.status ?? "open", assign: options.assign ?? null });
      out(todo, `追加しました: ${formatLine(todo, session)}`);
      return;
    }
    if (command === "update" || command === "done") {
      const changes = {};
      if (options.title !== undefined) changes.title = options.title;
      if (options.tags !== undefined) changes.tags = splitTags(options.tags);
      if (options.body !== undefined) changes.body = options.body;
      if (options.append !== undefined) changes.appendBody = options.append;
      if (options.status !== undefined) changes.status = options.status;
      if (options.assign !== undefined) changes.assign = options.assign;
      if (command === "done") changes.status = "done";
      const todo = update(dir, rest[0] ?? "", changes);
      out(todo, `更新しました: ${formatLine(todo, session)}`);
      return;
    }
    if (command === "remove") {
      const todo = remove(dir, rest[0] ?? "");
      out(todo, `消しました: ${todo.id} ${todo.title}`);
      return;
    }
    if (command === "gc") {
      const result = gc(dir, { days: options.days !== undefined ? Number(options.days) : undefined });
      out(result, result.disabled ? "gc は settings.json で止められています" : `完了して ${result.days} 日以上たった Todo を ${result.removed.length} 件消しました`);
      return;
    }
    throw new Error(`不明なコマンドです: ${command}\n${usage()}`);
  } catch (error) {
    process.stderr.write(`todos: ${error.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
