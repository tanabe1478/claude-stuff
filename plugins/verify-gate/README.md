# verify-gate

コードを変えたのに検証（テスト、lint、型検査など）を実行していない状態に気づくための仕組みです。Claude Codeのmod（関数hookのプラグイン）と、依存のないNodeスクリプトでできています。どのプロジェクトでも、設定ファイルを一つ置くだけで使えます。

## 仕組み

1. プロジェクトの`.claude/verify-gate.json`に、検証コマンドと「コードとみなすパス」を書きます。
2. `node bin/verify-gate.mjs run`（または`npm run verify`）が検証コマンドを順に実行し、すべて成功したときだけ、そのときのコード全体のハッシュを記録します。
3. `status`は、現在のコードのハッシュと記録を比べます。違えば「未検証」です。TODOファイルを指定していれば、コードが変わったのにTODOが更新されていないことも示します。

modは、この判定をClaude Codeの中で見えるようにします。

- ステータス行に「検証: 済み」か「検証: 未実行（変更 n 件）」を表示する
- コードを編集した直後に、検証を実行するよう一度だけモデルへ指示する
- ターンの終わりに未検証なら、`warn`では注意を出し、`block`では終了を止めて検証を求める
- 未検証のまま`git commit`しようとしたら、`warn`では注意、`block`では拒否する
- モデルが呼べるツール`run`、`status`、`stamp`と、人が打つ`/verify`、`/verify-status`を追加する

`.claude/verify-gate.json`のないプロジェクトでは、何も表示せず、何も止めません。

## 設定ファイル

```json
{
  "mode": "warn",
  "code": ["src/**", "tests/**", "package.json"],
  "exclude": ["**/*.md"],
  "verify": [["npm", "test"], ["npm", "run", "lint"]],
  "todo": "TODO.md",
  "state": ".claude/verify-gate.state.json"
}
```

| 項目 | 内容 |
| --- | --- |
| `mode` | `warn`（注意だけ）、`block`（ターン終了とコミットを止める）、`off`（判定しない）。省略すると`warn` |
| `code` | コードとみなすパスのglob。gitの管理対象と、無視されていない未追跡ファイルを対象にする |
| `exclude` | `code`から除くglob |
| `verify` | 検証コマンド。各要素は`["npm", "test"]`のような引数の配列で、シェルは使わない。Windowsでは`npm`などを自動で`.cmd`に読み替える |
| `todo` | 動作確認の記録を書くファイル。省略できる |
| `state` | 記録の保存先。省略すると`.claude/verify-gate.state.json`。コミットしないなら`.gitignore`に加える |
| `timeoutMs` | 検証コマンド1つあたりの制限時間。省略すると15分 |

`node bin/verify-gate.mjs init`で雛形を作れます。

## 導入

リポジトリ[claude-stuff](https://github.com/tanabe1478/claude-stuff)がマーケットプレイスです。使いたいプロジェクトで次を実行すると、そのプロジェクトだけで有効になります（`--scope user`にすると全プロジェクトで読み込まれますが、設定ファイルのないプロジェクトでは何もしません）。

```sh
claude plugin marketplace add tanabe1478/claude-stuff --scope project
claude plugin install verify-gate@claude-stuff --scope project
```

一度だけ試すなら、プラグインをインストールせずに起動時に指定します。

```sh
claude --plugin-dir /path/to/claude-stuff/plugins/verify-gate
```

modを使わない環境では、`.claude/settings.json`のcommand hookから同じ判定を使えます。

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/claude-stuff/plugins/verify-gate/bin/verify-gate.mjs hook stop" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node /path/to/claude-stuff/plugins/verify-gate/bin/verify-gate.mjs hook post-tool-use" }] }]
  }
}
```

## コマンド

```sh
node bin/verify-gate.mjs status            # 状態を表示する。未検証なら終了コード1
node bin/verify-gate.mjs status --json     # 機械処理向け
node bin/verify-gate.mjs run               # 検証コマンドを順に実行し、成功したら記録する
node bin/verify-gate.mjs stamp --reason "画面の操作をWindowsで確かめた"  # 手で確かめた内容を記録する
node bin/verify-gate.mjs hook stop         # settings.json のStop hookから使う
```

`stamp`は、画面の操作やインストールの確認のように自動化できない検証のためのもので、理由を必ず書きます。自動の検証コマンドの代わりには使いません。

## 制限

- ハッシュは`code`に挙げたファイルの内容から作ります。設定ファイルや環境の違いによる動作の変化は検出できません。
- `warn`では、注意を無視して作業を終えることができます。確実に止めるには`block`にします。
- 判定は`git`を使うため、Gitリポジトリの外では動きません。

## 開発

```sh
claude plugin validate plugins/verify-gate   # 構成とhookの検査（リポジトリのルートで）
claude plugin test plugins/verify-gate       # hooks/register.test.ts を実行する
```

プロジェクト側で`npm run verify`のような入口を用意する場合は、この`bin/verify-gate.mjs`を探して`run`を呼ぶ短いスクリプトを置きます。例は[jp-docs-harness](https://github.com/tanabe1478/jp-docs-harness)の`scripts/verify.mjs`にあります。
