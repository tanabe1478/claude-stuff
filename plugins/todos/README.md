# todos

依頼されたことや確認すべきことをTodoとして残し、人は`/todos`の画面で、AIは`todo`ツールで扱うClaude Codeのmodです。Pi用の[agent-stuff](https://github.com/tanabe1478/agent-stuff)の`/todos`と同じ考え方を、Claude Codeの仕組みで作り直したものです。

## できること

- `/todos [検索語]`で、Todoの一覧をペインに開きます。検索、着手、完了、未着手に戻す、再開、担当（このセッション）の割り当てができます
- `/todo <題名>`で1件追加します
- AIは`todo`ツールで一覧、追加、着手、完了、更新、担当の割り当てができます。完了にするときは`note`に「何をどの環境でどう確かめたか」を書く約束にしています
- 未完了のTodo（このセッションの担当を先に）をシステムプロンプトに添えます。AIは依頼を受けたら`add`で残し、終えたら`done`にするよう指示されます
- ステータス行に「Todo: 未完了 n / 進行中 m / 担当 k」を表示します
- 起動時に、完了して7日たったTodoを消します

## 保存先

1件1ファイルで`<プロジェクト>/.claude/todos/<id>.md`に保存します。環境変数`CLAUDE_TODO_PATH`で変えられます（相対パスはプロジェクト基準）。個人のタスクを誤って公開しないよう、`.gitignore`に`.claude/todos/`を加えておくことを勧めます。

ファイルの形は、1行目がJSONのメタデータ、空行、本文（Markdown）です。

```text
{"id":"t-fe9kzi","title":"AI設定を実際のモデルで確かめる","tags":["ai"],"status":"open","created_at":"2026-10-23T17:44:47.048Z","updated_at":"2026-10-23T17:44:47.048Z","done_at":null,"assigned_to_session":null}

確認すること: ログイン直後に標準モデルで使えること。
```

状態は`open`（未着手）、`in_progress`（進行中）、`done`（完了）です。自動削除を止めるには、保存先に`settings.json`を置きます。

```json
{ "gc": false }
```

`gcDays`で日数も変えられます。

## 端末から使う

modと同じスクリプトを端末からも使えます。

```sh
node bin/todos.mjs list                      # 未完了の一覧
node bin/todos.mjs list --all --query 画面    # 完了も含めて検索
node bin/todos.mjs add "文字の大きさをブラウザで確認する" --tags ui --body "A−/A+ で変わること"
node bin/todos.mjs done t-fe9k --append "Windows 11 の Chrome で確認した"
node bin/todos.mjs show t-fe9k
node bin/todos.mjs gc
```

## 導入

```sh
claude plugin marketplace add tanabe1478/claude-stuff --scope project
claude plugin install todos@claude-stuff --scope project
```

## 開発

```sh
claude plugin validate plugins/todos
claude plugin test plugins/todos
```

## 制限

- Todoの完了は、AIや人が記録するものです。本当に確かめたかを機械が保証することはできません。完了時の`note`を読んで判断します
- モバイルの画面には検索欄を出しません（文字の入力部品がないため）
