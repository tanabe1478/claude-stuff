# claude-stuff

自分用のClaude Code拡張をまとめたリポジトリです。リポジトリ自体がプラグインのマーケットプレイスで、`plugins/`の下に拡張を一つずつ置きます。Pi用の拡張は[agent-stuff](https://github.com/tanabe1478/agent-stuff)にあります。

## 導入済みの拡張

| 名前 | 内容 |
| --- | --- |
| [`verify-gate`](./plugins/verify-gate/) | コードを変えたのに検証（テスト、lint、型検査）を実行していない状態をステータス行に示し、ターン終了やコミットの前に注意するか止める。モデルが呼べる`run`、`status`、`stamp`ツールと、`/verify`、`/verify-status`を追加する |

## インストール

Claude Codeのプロンプトで、マーケットプレイスを追加してから拡張を入れます。

```text
/plugin marketplace add tanabe1478/claude-stuff
/plugin install verify-gate@claude-stuff
```

プロジェクトごとに有効にするなら、そのプロジェクトの端末で次を実行します。設定は`.claude/settings.json`に書き込まれ、リポジトリで共有できます。

```sh
claude plugin marketplace add tanabe1478/claude-stuff --scope project
claude plugin install verify-gate@claude-stuff --scope project
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
    └── verify-gate/
        ├── .claude-plugin/plugin.json
        ├── bin/verify-gate.mjs   # 判定と検証の本体（依存なしのNodeスクリプト）
        ├── hooks/hooks.json
        ├── hooks/register.ts     # Claude Codeのmod（関数hook）
        ├── hooks/register.test.ts
        └── README.md
```

## 動作確認

各拡張のフォルダで次を実行します。

```sh
claude plugin validate .                      # マーケットプレイスの検査（リポジトリのルートで）
claude plugin validate plugins/verify-gate    # 拡張の構成とhookの検査
claude plugin test plugins/verify-gate        # 拡張のテスト
```

Claude Code 2.1.292で確認しています。modのAPIは早期アクセスのため、Claude Codeの更新で変わることがあります。
