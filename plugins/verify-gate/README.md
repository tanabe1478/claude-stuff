# verify-gate

コードを変えたのに検証を実施していない状態に気づくための仕組みです。Claude Codeのmod（関数hookのプラグイン）と、依存のないNodeスクリプトでできています。どのプロジェクトでも、設定ファイルを一つ置くだけで使えます。

見るのは二つです。

- 自動の検証（テスト、lint、型検査）。実行したかを、コードのハッシュで決定論的に判定します。
- 手動の確認（画面の操作、インストールの確認、実際のモデルでの往復など）。機械が実施を証明することはできません。その代わり、どのファイルが変わったらどの確認が必要になるかを宣言しておき、該当ファイルが変わると「未実施」として示します。証拠が残る確認（スクリーンショットの更新、通しテストのコマンドの成功）は自動で実施済みにし、証拠が残らない確認は、何をどう確かめたかを書いて記録します。記録には証拠付きか自己申告かが残ります。

## 仕組み

1. プロジェクトの`.claude/verify-gate.json`に、検証コマンド、「コードとみなすパス」、手動確認の項目を書きます。
2. `node bin/verify-gate.mjs run`（または`npm run verify`）が検証コマンドを順に実行し、すべて成功したときだけ、そのときのコード全体のハッシュを記録します。
3. `status`は、自動の検証について現在のコードのハッシュと記録を比べ、手動確認の各項目について`when`に挙げたファイルのハッシュが前回の実施時から変わったかを見ます。変わっていれば「未実施」です。`evidence.files`に挙げた証拠ファイルが変更後に更新されていれば、自動で「実施済み（証拠あり）」にします。
4. `manual <id> --reason "..."`で、手動確認を実施済みとして記録します。TODOファイルを指定していれば、コードが変わったのにTODOが更新されていないことも示します。

modは、この判定をClaude Codeの中で見えるようにします。

- ステータス行に「検証: 済み」か「検証: 自動 未実行（変更 n 件） / 手動 未実施 n 件（id）」を表示する
- コードを編集した直後に、必要な検証と手動確認を一度だけモデルへ指示する
- `evidence.commands`に当たるコマンド（通しテストなど）が成功したら、その手動確認を証拠付きで実施済みにする
- ターンの終わりに未実施があれば、`warn`では注意を出し、`block`では終了を止めて実施を求める
- 未実施のまま`git commit`しようとしたら、`warn`では注意、`block`では拒否する
- モデルが呼べるツール`run`、`status`、`stamp`（`item`と`reason`）と、人が打つ`/verify`、`/verify-status`を追加する

`.claude/verify-gate.json`のないプロジェクトでは、何も表示せず、何も止めません。導入した時点の状態を手動確認の基準にするため、導入直後に全項目が未実施になることはありません。

## 設定ファイル

```json
{
  "mode": "warn",
  "code": ["src/**", "tests/**", "package.json"],
  "exclude": ["**/*.md"],
  "verify": [["npm", "test"], ["npm", "run", "lint"]],
  "manual": [
    {
      "id": "ui",
      "title": "画面を実際に操作して確認する",
      "when": ["src/client/**"],
      "evidence": { "files": ["test-results/**/*.png"], "commands": ["playwright test"] }
    },
    {
      "id": "install",
      "title": "インストーラーを作り、インストールして起動を確かめる",
      "when": ["src-tauri/**"]
    }
  ],
  "todo": "TODO.md",
  "state": ".claude/verify-gate.state.json"
}
```

| 項目 | 内容 |
| --- | --- |
| `mode` | `warn`（注意だけ）、`block`（ターン終了とコミットを止める）、`off`（判定しない）。省略すると`warn` |
| `code` | コードとみなすパスのglob。gitの管理対象と、無視されていない未追跡ファイルを対象にする |
| `exclude` | `code`から除くglob |
| `verify` | 自動の検証コマンド。各要素は`["npm", "test"]`のような引数の配列で、シェルは使わない。Windowsでは`npm`などを自動で`.cmd`に読み替える。空の配列なら自動の検証は見ない |
| `manual` | 手動確認の項目。`id`（英小文字、数字、ハイフン）、`title`（何を確かめるか）、`when`（変わったら確認が必要になるパスのglob）、`evidence.files`（更新されていれば実施済みとみなす証拠ファイルのglob。gitの管理外でもよい）、`evidence.commands`（成功すれば実施済みとみなすコマンドの正規表現。modだけが見る） |
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
node bin/verify-gate.mjs manual ui --reason "Windows 11 の Web 版で原稿一覧と AI 設定の画面を操作して確かめた"  # 手動確認を記録する
node bin/verify-gate.mjs stamp --reason "..."   # 自動の検証をコマンドを実行せずに記録する（避けたい経路）
node bin/verify-gate.mjs hook stop         # settings.json のStop hookから使う
```

`manual`の記録は自己申告です。証拠になるコマンドの成功や証拠ファイルの更新で記録されたものは`evidence`、人やモデルが書いたものは`stamp`として残り、`status --json`で区別できます。`stamp`は自動の検証をコマンドなしで記録するためのもので、理由を必ず書きます。通常は使いません。

## 制限

- ハッシュは`code`や`when`に挙げたファイルの内容から作ります。設定ファイルや環境の違いによる動作の変化は検出できません。
- 手動確認が本当に行われたかは証明できません。できるのは、必要になった確認を示すこと、証拠がある場合にそれを見ること、記録に証拠付きか自己申告かを残すことです。
- `warn`では、注意を無視して作業を終えることができます。確実に止めるには`block`にします。
- 判定は`git`を使うため、Gitリポジトリの外では動きません。

## 開発

```sh
claude plugin validate plugins/verify-gate   # 構成とhookの検査（リポジトリのルートで）
claude plugin test plugins/verify-gate       # hooks/register.test.ts を実行する
```

プロジェクト側で`npm run verify`のような入口を用意する場合は、この`bin/verify-gate.mjs`を探して`run`を呼ぶ短いスクリプトを置きます。例は[jp-docs-harness](https://github.com/tanabe1478/jp-docs-harness)の`scripts/verify.mjs`にあります。
