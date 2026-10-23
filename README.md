# claude-stuff

自分用のClaude Code拡張をまとめたリポジトリです。リポジトリ自体がプラグインのマーケットプレイスで、`plugins/`の下に拡張を一つずつ置きます。Pi用の拡張は[agent-stuff](https://github.com/tanabe1478/agent-stuff)にあります。

## 導入済みの拡張

| 名前 | 内容 |
| --- | --- |
| [`todos`](./plugins/todos/) | 依頼されたことや確認すべきことをTodoとして残す。人は`/todos`の画面で検索・着手・完了・担当の割り当てを行い、AIは`todo`ツールで扱う。未完了のTodoはシステムプロンプトに添えられ、完了時には何をどう確かめたかを記録する。1件1ファイルで`.claude/todos/`に保存し、完了して7日たったものは消す |

## インストール

Claude Codeのプロンプトで、マーケットプレイスを追加してから拡張を入れます。

```text
/plugin marketplace add tanabe1478/claude-stuff
/plugin install todos@claude-stuff
```

プロジェクトごとに有効にするなら、そのプロジェクトの端末で次を実行します。設定は`.claude/settings.json`に書き込まれ、リポジトリで共有できます。

```sh
claude plugin marketplace add tanabe1478/claude-stuff --scope project
claude plugin install todos@claude-stuff --scope project
```

ローカルの変更を試す場合は、クローンしたフォルダを指定します。フォルダから入れた拡張は、そのフォルダを直接読むため、編集後に`/reload-plugins`で反映できます。

```sh
claude plugin marketplace add /path/to/claude-stuff --scope project
claude plugin install verify-gate@claude-stuff --scope project
```

## 構成

```text
.
├── .claude-plugin/
│   └── marketplace.json      # このリポジトリをマーケットプレイスにする
└── plugins/
    └── todos/
        ├── .claude-plugin/plugin.json
        ├── bin/todos.mjs         # Todo の読み書き（依存なしのNodeスクリプト）
        ├── hooks/register.tsx    # /todos のペイン、todo ツール、プロンプトへの注入
        ├── types/index.d.ts      # $.state の契約
        └── README.md

## 動作確認

各拡張のフォルダで次を実行します。

```sh
claude plugin validate .                      # マーケットプレイスの検査（リポジトリのルートで）
claude plugin validate plugins/<name>    # 拡張の構成とhookの検査
claude plugin test plugins/<name>        # 拡張のテスト
```

Claude Code 2.1.292で確認しています。modのAPIは早期アクセスのため、Claude Codeの更新で変わることがあります。
