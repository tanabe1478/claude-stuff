#!/usr/bin/env node
// verify-gate: 「コードを変えたのに検証していない」状態を機械的に見つける。
//
// 二つのことを見る。
// 1. 自動の検証（テスト、lint、型検査）。`run` が検証コマンドを順に実行し、すべて成功したときだけ
//    そのときのコード全体のハッシュを記録する。`status` は現在のハッシュと記録を比べる。
// 2. 手動の確認（画面の操作、インストールの確認など）。設定の `manual` に「どのファイルが変わったら
//    どの確認が必要か」を宣言しておく。該当ファイルが前回の確認から変わっていれば「未実施」になる。
//    証拠ファイル（スクリーンショットなど）が確認後に更新されていれば自動で「実施済み（証拠あり）」、
//    そうでなければ `manual <id> --reason` で何をどう確かめたかを書いて記録する（自己申告として残る）。
//
// プロジェクトの .claude/verify-gate.json に設定を書く。依存パッケージはなく、git と node だけで動く。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = path.join(".claude", "verify-gate.json");
const DEFAULT_STATE = path.join(".claude", "verify-gate.state.json");
const MODES = ["warn", "block", "off"];

// ---- 設定 ----

export function loadConfig(root) {
  const file = path.join(root, CONFIG_PATH);
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_PATH} を読み取れません: ${error.message}`);
  }
  const mode = parsed.mode ?? "warn";
  if (!MODES.includes(mode)) throw new Error(`${CONFIG_PATH} の mode は ${MODES.join("、")} のいずれかにしてください（指定値: ${mode}）`);
  if (!Array.isArray(parsed.code) || parsed.code.length === 0) throw new Error(`${CONFIG_PATH} の code に、コードとみなすパスのglobを1つ以上書いてください`);
  if (!Array.isArray(parsed.verify)) throw new Error(`${CONFIG_PATH} の verify に、検証コマンド（引数の配列）の配列を書いてください`);
  for (const command of parsed.verify) {
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
      throw new Error(`${CONFIG_PATH} の verify の各要素は、["npm", "test"] のような文字列の配列にしてください`);
    }
  }
  const manual = Array.isArray(parsed.manual) ? parsed.manual : [];
  const ids = new Set();
  for (const item of manual) {
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) throw new Error(`${CONFIG_PATH} の manual の id は英小文字、数字、ハイフンにしてください（指定値: ${item.id}）`);
    if (ids.has(item.id)) throw new Error(`${CONFIG_PATH} の manual の id が重複しています: ${item.id}`);
    ids.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim()) throw new Error(`${CONFIG_PATH} の manual.${item.id} に title（何を確かめるか）を書いてください`);
    if (!Array.isArray(item.when) || item.when.length === 0) throw new Error(`${CONFIG_PATH} の manual.${item.id} の when に、変わったら確認が必要になるパスのglobを書いてください`);
  }
  return {
    mode,
    code: parsed.code,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
    verify: parsed.verify,
    manual: manual.map((item) => ({
      id: item.id,
      title: item.title.trim(),
      when: item.when,
      evidence: {
        files: Array.isArray(item.evidence?.files) ? item.evidence.files : [],
        commands: Array.isArray(item.evidence?.commands) ? item.evidence.commands : [],
      },
    })),
    todo: typeof parsed.todo === "string" ? parsed.todo : null,
    state: typeof parsed.state === "string" ? parsed.state : DEFAULT_STATE,
    timeoutMs: Number.isFinite(parsed.timeoutMs) ? parsed.timeoutMs : 15 * 60 * 1000,
  };
}

// ---- git とハッシュ ----

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git を実行できません: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} が失敗しました: ${result.stderr.trim()}`);
  return result.stdout;
}

function pathspec(globs, exclude = []) {
  return [...globs.map((glob) => `:(glob)${glob}`), ...exclude.map((glob) => `:(exclude,glob)${glob}`)];
}

// glob に当たるファイルの一覧（追跡済み、および無視されていない未追跡）。削除済みは含めない。
export function listFiles(root, globs, exclude = []) {
  const spec = pathspec(globs, exclude);
  const tracked = git(root, ["ls-files", "-z", "--", ...spec]);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...spec]);
  const files = new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
  return [...files].filter((file) => existsSync(path.join(root, file))).sort();
}

// ファイル群の内容のハッシュ。パスと内容を順に混ぜるため、名前の変更も検出する。
export function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// HEAD と比べて変わっているファイル（作業ツリー上の差分と未追跡）。表示用。
export function changedFiles(root, globs, exclude = []) {
  const changed = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspec(globs, exclude)]);
  const files = [];
  for (const entry of changed.split("\0")) {
    if (!entry) continue;
    files.push(entry.slice(3));
  }
  return [...new Set(files)].sort();
}

// ---- 証拠ファイルの探索（git の管理外のファイルも対象にするため、自前で歩く） ----

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") pattern += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(char)) pattern += `\\${char}`;
    else pattern += char;
  }
  return new RegExp(`^${pattern}$`);
}

function staticPrefix(glob) {
  const segments = glob.split("/");
  const fixed = [];
  for (const segment of segments) {
    if (/[*?[]/.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join("/");
}

export function findEvidenceFiles(root, globs) {
  const found = [];
  for (const glob of globs) {
    const matcher = globToRegExp(glob);
    const start = path.join(root, staticPrefix(glob));
    if (!existsSync(start)) continue;
    const walk = (directory) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else {
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          if (matcher.test(relative)) found.push({ path: relative, mtimeMs: statSync(absolute).mtimeMs });
        }
      }
    };
    const stat = statSync(start);
    if (stat.isDirectory()) walk(start);
    else {
      const relative = path.relative(root, start).split(path.sep).join("/");
      if (matcher.test(relative)) found.push({ path: relative, mtimeMs: stat.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ---- 記録 ----

function emptyState() {
  return { version: 2, automated: null, manual: {} };
}

export function readState(root, config) {
  const file = path.join(root, config.state);
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // 旧形式（version 1）は自動の検証の記録だけ。
    if (parsed.version === 1) return { version: 2, automated: { codeHash: parsed.codeHash, verifiedAt: parsed.verifiedAt, by: parsed.by, commands: parsed.commands, reason: parsed.reason }, manual: {} };
    return { version: 2, automated: parsed.automated ?? null, manual: parsed.manual ?? {} };
  } catch {
    return emptyState();
  }
}

export function writeState(root, config, state) {
  const file = path.join(root, config.state);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function todoStale(root, config) {
  if (!config.todo) return false;
  if (changedFiles(root, config.code, config.exclude).length === 0) return false;
  const result = spawnSync("git", ["status", "--porcelain=v1", "--", config.todo], { cwd: root, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "";
}

// ---- 状態 ----

// 手動確認の項目ごとの状態を求める。記録の追跡情報（いつから変わったか）を更新するため、
// 必要なら state を書き換えて changed=true を返す。
function manualStatus(root, config, state, now) {
  let changed = false;
  const items = [];
  for (const item of config.manual) {
    const files = listFiles(root, item.when);
    const whenHash = hashFiles(root, files);
    let record = state.manual[item.id];
    if (!record) {
      // 初めて見る項目は、いまの状態を基準にする。次に該当ファイルが変わったときから「未実施」になる。
      record = { whenHash, since: now, satisfied: { whenHash, at: now, by: "baseline", reason: "導入時の基準" } };
      state.manual[item.id] = record;
      changed = true;
    } else if (record.whenHash !== whenHash) {
      record.whenHash = whenHash;
      record.since = now;
      changed = true;
    }
    let due = record.satisfied?.whenHash !== whenHash;
    let evidenceFiles = [];
    if (due && item.evidence.files.length > 0) {
      // 該当ファイルが変わった時刻より新しい証拠ファイルがあれば、確認は実施済みとみなす。
      const sinceMs = Date.parse(record.since);
      evidenceFiles = findEvidenceFiles(root, item.evidence.files).filter((file) => file.mtimeMs > sinceMs);
      if (evidenceFiles.length > 0) {
        record.satisfied = { whenHash, at: now, by: "evidence", reason: `証拠ファイルの更新: ${evidenceFiles.slice(0, 3).map((file) => file.path).join(", ")}` };
        changed = true;
        due = false;
      }
    }
    items.push({
      id: item.id,
      title: item.title,
      due,
      changed: due ? changedFiles(root, item.when) : [],
      satisfiedBy: due ? null : (record.satisfied?.by ?? null),
      satisfiedAt: due ? null : (record.satisfied?.at ?? null),
      reason: due ? null : (record.satisfied?.reason ?? null),
      evidenceCommands: item.evidence.commands,
      evidenceFiles: item.evidence.files,
    });
  }
  return { items, changed };
}

// 現在の状態。configured=false なら、このプロジェクトでは何も判定しない。
export function status(root, { now = new Date().toISOString() } = {}) {
  const config = loadConfig(root);
  if (!config) return { configured: false };
  const files = listFiles(root, config.code, config.exclude);
  const hash = hashFiles(root, files);
  const state = readState(root, config);
  const verified = config.verify.length === 0 || state.automated?.codeHash === hash;
  const manual = manualStatus(root, config, state, now);
  if (manual.changed) writeState(root, config, state);
  const dueManual = manual.items.filter((item) => item.due);
  return {
    configured: true,
    mode: config.mode,
    verified,
    outstanding: !verified || dueManual.length > 0,
    codeHash: hash,
    codeFiles: files.length,
    changed: changedFiles(root, config.code, config.exclude),
    verifiedAt: state.automated?.verifiedAt ?? null,
    verifiedBy: state.automated?.by ?? null,
    manual: manual.items,
    todo: config.todo,
    todoStale: todoStale(root, config),
    statePath: config.state,
  };
}

// ---- 自動の検証 ----

function resolveCommand(argv) {
  const [command, ...args] = argv;
  // Windows の npm/npx/pnpm/yarn は .cmd で、シェルなしでは起動できない。
  if (process.platform === "win32" && /^(npm|npx|pnpm|yarn|corepack)$/.test(command)) {
    return { command: `${command}.cmd`, args, shell: true };
  }
  return { command, args, shell: false };
}

// 検証コマンドを順に実行し、すべて成功したときだけ記録する。
export function run(root, { log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const config = loadConfig(root);
  if (!config) throw new Error(`${CONFIG_PATH} がありません。このプロジェクトでは verify-gate を使いません`);
  const results = [];
  for (const argv of config.verify) {
    const started = Date.now();
    log(`verify-gate: $ ${argv.join(" ")}`);
    const { command, args, shell } = resolveCommand(argv);
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell, timeout: config.timeoutMs, env: process.env });
    const ms = Date.now() - started;
    const exitCode = result.status ?? 1;
    results.push({ argv, exitCode, ms });
    if (result.error) {
      log(`verify-gate: 起動できませんでした: ${result.error.message}`);
      return { ok: false, results };
    }
    if (exitCode !== 0) {
      log(`verify-gate: 失敗（終了コード ${exitCode}）。記録は更新しません`);
      return { ok: false, results };
    }
  }
  const files = listFiles(root, config.code, config.exclude);
  const state = readState(root, config);
  state.automated = { codeHash: hashFiles(root, files), codeFiles: files.length, verifiedAt: new Date().toISOString(), by: "run", commands: results };
  writeState(root, config, state);
  log(`verify-gate: 自動の検証はすべて成功。記録しました（${config.state}）`);
  return { ok: true, results, state };
}

// ---- 手動の確認 ----

// 手動確認の項目を実施済みとして記録する。by は stamp（自己申告）か evidence（コマンドの実行などの証拠）。
export function markManual(root, id, { reason, by = "stamp" } = {}) {
  const config = loadConfig(root);
  if (!config) throw new Error(`${CONFIG_PATH} がありません`);
  const item = config.manual.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`manual の項目 ${id} は設定にありません（${config.manual.map((candidate) => candidate.id).join(", ") || "項目なし"}）`);
  if (!reason || !reason.trim()) throw new Error("--reason で、何をどの環境でどう確かめたかを書いてください");
  if (!["stamp", "evidence"].includes(by)) throw new Error("--by は stamp か evidence です");
  const state = readState(root, config);
  const now = new Date().toISOString();
  const whenHash = hashFiles(root, listFiles(root, item.when));
  const record = state.manual[id] ?? { whenHash, since: now };
  record.whenHash = whenHash;
  record.satisfied = { whenHash, at: now, by, reason: reason.trim() };
  state.manual[id] = record;
  writeState(root, config, state);
  return { id, title: item.title, ...record.satisfied };
}

// 自動の検証を、コマンドを実行せずに記録する。避けたい経路のため、理由を必須にする。
export function stampAutomated(root, reason) {
  const config = loadConfig(root);
  if (!config) throw new Error(`${CONFIG_PATH} がありません`);
  if (!reason || !reason.trim()) throw new Error("--reason で、なぜ検証コマンドを実行せずに記録するのかを書いてください");
  const files = listFiles(root, config.code, config.exclude);
  const state = readState(root, config);
  state.automated = { codeHash: hashFiles(root, files), codeFiles: files.length, verifiedAt: new Date().toISOString(), by: "stamp", reason: reason.trim() };
  writeState(root, config, state);
  return state.automated;
}

// ---- 表示 ----

export function describe(current) {
  if (!current.configured) return "verify-gate: このプロジェクトでは無効です（.claude/verify-gate.json がありません）";
  const parts = [];
  if (current.verified) {
    const when = current.verifiedAt ? new Date(current.verifiedAt).toLocaleString("ja-JP") : "不明";
    parts.push(`自動の検証: 済み（${when}${current.verifiedBy === "stamp" ? "、手動の記録" : ""}）`);
  } else {
    const changed = current.changed.length > 0 ? `変更 ${current.changed.length}件: ${current.changed.slice(0, 5).join(", ")}${current.changed.length > 5 ? " ほか" : ""}` : "コミット後に未実行";
    parts.push(`自動の検証: 未実行（${changed}）`);
  }
  const due = current.manual.filter((item) => item.due);
  if (due.length > 0) parts.push(`手動の確認: 未実施 ${due.length}件（${due.map((item) => `${item.id}: ${item.title}`).join("、")}）`);
  else if (current.manual.length > 0) parts.push("手動の確認: 済み");
  if (current.todoStale) parts.push(`${current.todo} の記録が未更新`);
  return `verify-gate: ${parts.join("。")}`;
}

// モデルへ渡す指示文。
export function instruction(current) {
  if (!current.configured) return "";
  const lines = [];
  if (!current.verified) {
    lines.push("自動の検証が実行されていません。verify_gate の run ツール（または npm run verify）で実行してください。失敗した確認も隠さず記録します。");
  }
  const due = current.manual.filter((item) => item.due);
  if (due.length > 0) {
    lines.push("次の手動の確認が必要です（該当するコードが変わっています）。実施したら、何をどの環境でどう確かめたかを verify_gate の stamp ツール（item を指定）で記録してください。実施できない場合は、その理由を記録してください。");
    for (const item of due) {
      const hint = item.evidenceCommands.length > 0 ? `証拠になるコマンド: ${item.evidenceCommands.join(" / ")}` : item.evidenceFiles.length > 0 ? `証拠になるファイル: ${item.evidenceFiles.join(", ")}` : "自己申告の記録になります";
      lines.push(`- ${item.id}: ${item.title}（変更: ${item.changed.slice(0, 5).join(", ")}${item.changed.length > 5 ? " ほか" : ""}。${hint}）`);
    }
  }
  if (current.todo) lines.push(`そのうえで ${current.todo} の「動作確認の記録」に結果を書いてください。`);
  return `verify-gate: ${describe(current).replace(/^verify-gate: /, "")}\n${lines.join("\n")}`;
}

// ---- hook（settings.json の command hook 用） ----

function readStdinJson() {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const CODE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function hook(kind, root) {
  const input = readStdinJson();
  const current = status(root);
  if (!current.configured || current.mode === "off" || !current.outstanding) return {};
  if (kind === "stop") {
    if (input.stop_hook_active) return {};
    if (current.mode === "block") return { decision: "block", reason: instruction(current) };
    return { systemMessage: describe(current) };
  }
  if (kind === "post-tool-use") {
    if (!CODE_EDIT_TOOLS.has(input.tool_name ?? "")) return {};
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: instruction(current) } };
  }
  throw new Error(`不明な hook です: ${kind}`);
}

// ---- CLI ----

function usage() {
  return [
    "使い方: node verify-gate.mjs <command> [--root <dir>] [--json]",
    "  status                         現在の状態（自動の検証が済んでいるか、未実施の手動確認があるか）",
    "  run                            設定の検証コマンドを順に実行し、成功したら記録する",
    "  manual <id> --reason <text>    手動の確認 <id> を実施済みとして記録する（--by evidence で証拠付き）",
    "  stamp --reason <text>          自動の検証を、コマンドを実行せずに記録する（避けたい経路）",
    "  hook stop | hook post-tool-use settings.json の command hook から使う（stdin に hook の JSON）",
    "  init                           .claude/verify-gate.json の雛形を作る",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { json: false, root: process.cwd(), reason: "", by: "stamp", positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = path.resolve(argv[++index] ?? ".");
    else if (arg === "--reason") options.reason = argv[++index] ?? "";
    else if (arg === "--by") options.by = argv[++index] ?? "stamp";
    else options.positional.push(arg);
  }
  return options;
}

const TEMPLATE = {
  mode: "warn",
  code: ["src/**", "package.json"],
  exclude: ["**/*.md"],
  verify: [["npm", "test"]],
  manual: [
    {
      id: "ui",
      title: "画面を実際に操作して確認する",
      when: ["src/client/**"],
      evidence: { files: ["test-results/**/*.png"], commands: ["playwright test"] },
    },
  ],
  todo: "TODO.md",
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [command, sub] = options.positional;
  const root = options.root;
  try {
    if (!command || command === "help" || command === "--help") {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (command === "status") {
      const current = status(root);
      process.stdout.write(options.json ? `${JSON.stringify(current)}\n` : `${describe(current)}\n`);
      process.exit(current.configured && current.outstanding ? 1 : 0);
    }
    if (command === "run") {
      const result = run(root);
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: result.ok, results: result.results })}\n`);
      process.exit(result.ok ? 0 : 1);
    }
    if (command === "manual") {
      if (!sub) throw new Error("manual には項目の id を指定してください");
      const record = markManual(root, sub, { reason: options.reason, by: options.by });
      process.stdout.write(options.json ? `${JSON.stringify(record)}\n` : `verify-gate: 手動の確認 ${record.id}（${record.title}）を${record.by === "evidence" ? "証拠付きで" : "自己申告として"}記録しました\n`);
      return;
    }
    if (command === "stamp") {
      const record = stampAutomated(root, options.reason);
      process.stdout.write(options.json ? `${JSON.stringify(record)}\n` : `verify-gate: 自動の検証を手動で記録しました（${record.verifiedAt}）\n`);
      return;
    }
    if (command === "hook") {
      process.stdout.write(`${JSON.stringify(hook(sub, root))}\n`);
      return;
    }
    if (command === "init") {
      const file = path.join(root, CONFIG_PATH);
      if (existsSync(file)) throw new Error(`${CONFIG_PATH} は既にあります`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(TEMPLATE, null, 2)}\n`, "utf8");
      process.stdout.write(`${CONFIG_PATH} を作りました。code、verify、manual をプロジェクトに合わせてください\n`);
      return;
    }
    throw new Error(`不明なコマンドです: ${command}\n${usage()}`);
  } catch (error) {
    process.stderr.write(`verify-gate: ${error.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
