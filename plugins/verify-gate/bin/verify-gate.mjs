#!/usr/bin/env node
// verify-gate: 「コードを変えたのに検証していない」状態を機械的に見つける。
//
// プロジェクトの .claude/verify-gate.json に、検証コマンドと「コードとみなすパス」を書いておく。
// `run` は検証コマンドを順に実行し、すべて成功したときだけ、そのときのコードのハッシュを記録（stamp）する。
// `status` は現在のコードのハッシュと記録を比べ、検証済みかどうかを返す。
// `hook stop` と `hook post-tool-use` は、settings.json の command hook からそのまま使える。
// 依存パッケージはなく、git と node だけで動く。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = path.join(".claude", "verify-gate.json");
const DEFAULT_STATE = path.join(".claude", "verify-gate.state.json");
const MODES = ["warn", "block", "off"];

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
  if (!Array.isArray(parsed.verify) || parsed.verify.length === 0) throw new Error(`${CONFIG_PATH} の verify に、検証コマンド（引数の配列）を1つ以上書いてください`);
  for (const command of parsed.verify) {
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
      throw new Error(`${CONFIG_PATH} の verify の各要素は、["npm", "test"] のような文字列の配列にしてください`);
    }
  }
  return {
    mode,
    code: parsed.code,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
    verify: parsed.verify,
    todo: typeof parsed.todo === "string" ? parsed.todo : null,
    state: typeof parsed.state === "string" ? parsed.state : DEFAULT_STATE,
    timeoutMs: Number.isFinite(parsed.timeoutMs) ? parsed.timeoutMs : 15 * 60 * 1000,
  };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git を実行できません: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} が失敗しました: ${result.stderr.trim()}`);
  return result.stdout;
}

function pathspec(config) {
  return [...config.code.map((glob) => `:(glob)${glob}`), ...config.exclude.map((glob) => `:(exclude,glob)${glob}`)];
}

// コードとみなすファイルの一覧（追跡済み、および無視されていない未追跡）。削除済みは含めない。
export function listCodeFiles(root, config) {
  const spec = pathspec(config);
  const tracked = git(root, ["ls-files", "-z", "--", ...spec]);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...spec]);
  const files = new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
  return [...files].filter((file) => existsSync(path.join(root, file))).sort();
}

// コード全体の内容のハッシュ。パスと内容を順に混ぜるため、名前の変更も検出する。
export function codeHash(root, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// HEAD と比べて変わっているコード（作業ツリー上の差分と未追跡）。表示用。
export function changedCodeFiles(root, config) {
  const spec = pathspec(config);
  const changed = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...spec]);
  const files = [];
  for (const entry of changed.split("\0")) {
    if (!entry) continue;
    // 名前の変更は "R  old -> new" ではなく、-z では次の要素が旧名になる。ここでは新名だけを扱う。
    files.push(entry.slice(3));
  }
  return [...new Set(files)].sort();
}

export function readState(root, config) {
  const file = path.join(root, config.state);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(root, config, state) {
  const file = path.join(root, config.state);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function todoStale(root, config) {
  if (!config.todo) return false;
  const codeChanged = changedCodeFiles(root, config).length > 0;
  if (!codeChanged) return false;
  const result = spawnSync("git", ["status", "--porcelain=v1", "--", config.todo], { cwd: root, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "";
}

// 現在の状態。configured=false なら、このプロジェクトでは何も判定しない。
export function status(root) {
  const config = loadConfig(root);
  if (!config) return { configured: false };
  const files = listCodeFiles(root, config);
  const hash = codeHash(root, files);
  const state = readState(root, config);
  const verified = state?.codeHash === hash;
  return {
    configured: true,
    mode: config.mode,
    verified,
    codeHash: hash,
    codeFiles: files.length,
    changed: changedCodeFiles(root, config),
    verifiedAt: state?.verifiedAt ?? null,
    verifiedBy: state?.by ?? null,
    todo: config.todo,
    todoStale: todoStale(root, config),
    statePath: config.state,
  };
}

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
    const exitCode = result.status ?? (result.signal ? 1 : 1);
    results.push({ argv, exitCode, ms });
    if (result.error) {
      log(`verify-gate: 起動できませんでした: ${result.error.message}`);
      return { ok: false, results, config };
    }
    if (exitCode !== 0) {
      log(`verify-gate: 失敗（終了コード ${exitCode}）。記録は更新しません`);
      return { ok: false, results, config };
    }
  }
  const files = listCodeFiles(root, config);
  const state = {
    version: 1,
    codeHash: codeHash(root, files),
    codeFiles: files.length,
    verifiedAt: new Date().toISOString(),
    by: "run",
    commands: results,
  };
  writeState(root, config, state);
  log(`verify-gate: すべて成功。記録しました（${config.state}）`);
  return { ok: true, results, config, state };
}

// 手で確かめた内容を、コマンドを実行せずに記録する。理由を必須にする。
export function stamp(root, reason) {
  const config = loadConfig(root);
  if (!config) throw new Error(`${CONFIG_PATH} がありません`);
  if (!reason || !reason.trim()) throw new Error("stamp には --reason で、何をどう確かめたかを書いてください");
  const files = listCodeFiles(root, config);
  const state = { version: 1, codeHash: codeHash(root, files), codeFiles: files.length, verifiedAt: new Date().toISOString(), by: "stamp", reason: reason.trim() };
  writeState(root, config, state);
  return state;
}

export function describe(current) {
  if (!current.configured) return "verify-gate: このプロジェクトでは無効です（.claude/verify-gate.json がありません）";
  if (current.verified) {
    const when = current.verifiedAt ? new Date(current.verifiedAt).toLocaleString("ja-JP") : "不明";
    return `verify-gate: 検証済み（${when}${current.verifiedBy === "stamp" ? "、手動の記録" : ""}）`;
  }
  const changed = current.changed.length > 0 ? `変更 ${current.changed.length}件: ${current.changed.slice(0, 5).join(", ")}${current.changed.length > 5 ? " ほか" : ""}` : "コミット後に未検証";
  const todo = current.todoStale ? `。${current.todo} の記録も未更新` : "";
  return `verify-gate: 未検証（${changed}）${todo}`;
}

// モデルへ渡す指示文。TODO の更新も促す。
export function instruction(current) {
  const todo = current.todo ? `そのうえで ${current.todo} の「動作確認の記録」に結果を書いてください。` : "";
  return `${describe(current)}。コードが変わっています。終える前に検証（verify_gate の run、または npm run verify）を実行してください。失敗した確認も隠さず記録します。${todo}`;
}

function readStdinJson() {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const CODE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// settings.json の command hook として使う入口。stdin の JSON を読み、hook の JSON を返す。
function hook(kind, root) {
  const input = readStdinJson();
  const current = status(root);
  if (!current.configured || current.mode === "off" || current.verified) return {};
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

function usage() {
  return [
    "使い方: node verify-gate.mjs <command> [--root <dir>] [--json]",
    "  status                 現在の状態（検証済みか、何が変わったか）",
    "  run                    .claude/verify-gate.json の検証コマンドを順に実行し、成功したら記録する",
    "  stamp --reason <text>  手で確かめた内容を、コマンドを実行せずに記録する",
    "  hook stop              settings.json の Stop hook から使う（stdin に hook の JSON）",
    "  hook post-tool-use     settings.json の PostToolUse hook から使う",
    "  init                   .claude/verify-gate.json の雛形を作る",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { json: false, root: process.cwd(), reason: "", positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = path.resolve(argv[++index] ?? ".");
    else if (arg === "--reason") options.reason = argv[++index] ?? "";
    else options.positional.push(arg);
  }
  return options;
}

const TEMPLATE = {
  mode: "warn",
  code: ["src/**", "package.json"],
  exclude: ["**/*.md"],
  verify: [["npm", "test"]],
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
      process.exit(current.configured && !current.verified ? 1 : 0);
    }
    if (command === "run") {
      const result = run(root);
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: result.ok, results: result.results, state: result.state ?? null })}\n`);
      process.exit(result.ok ? 0 : 1);
    }
    if (command === "stamp") {
      const state = stamp(root, options.reason);
      process.stdout.write(options.json ? `${JSON.stringify(state)}\n` : `verify-gate: 記録しました（${state.verifiedAt}）\n`);
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
      process.stdout.write(`${CONFIG_PATH} を作りました。code と verify をプロジェクトに合わせてください\n`);
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
