// verify-gate の mod。判定そのものは bin/verify-gate.mjs（依存なしの Node スクリプト）に任せ、
// ここでは Claude Code の中で「気づける」ようにする。
// - ステータス行に「検証: 済み」「検証: 未実行（変更 n 件）」を出し続ける
// - コードを編集した直後に、モデルへ検証の指示を注入する（同じ未検証の状態につき1度）
// - ターン終了時に、未検証なら注意（warn）か、終了を止めて検証を求める（block）
// - 未検証のまま git commit しようとしたら、注意（warn）か拒否（block）
// プロジェクトに .claude/verify-gate.json がなければ何もしない。
import type { EngineInterface, Register } from 'claude-code'

type Status =
  | { configured: false }
  | {
      configured: true
      mode: 'warn' | 'block' | 'off'
      verified: boolean
      codeHash: string
      codeFiles: number
      changed: string[]
      verifiedAt: string | null
      verifiedBy: 'run' | 'stamp' | null
      todo: string | null
      todoStale: boolean
      statePath: string
    }

type Active = Extract<Status, { configured: true }>

const CODE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMIT = /(^|[\s;&|])git\s+(?:[\w-]+\s+)*commit(\s|$)/
const RUN_TIMEOUT_MS = 15 * 60_000

let current: Status = { configured: false }
// 同じ未検証の状態について、モデルへの指示は一度だけにする（編集のたびに繰り返さない）。
let instructedFor: string | null = null

async function gate($: EngineInterface, args: string[], timeoutMs = 30_000) {
  const cwd = await $.session.cwd()
  return $.process.run(['node', `${$.plugin.root}/bin/verify-gate.mjs`, ...args, '--root', cwd, '--json'], { cwd, timeoutMs })
}

async function refresh($: EngineInterface): Promise<Status> {
  try {
    const { stdout, exitCode } = await gate($, ['status'])
    // status は未検証のとき終了コード 1 を返すが、JSON は出ている。2 は設定の誤りなど。
    if (exitCode > 1) throw new Error(stdout)
    current = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Status
  } catch {
    current = { configured: false }
  }
  $.ui.status(statusLine(current))
  return current
}

function isActive(status: Status): status is Active {
  return status.configured && status.mode !== 'off'
}

function statusLine(status: Status): string | undefined {
  if (!isActive(status)) return undefined
  if (status.verified) return '検証: 済み'
  const changed = status.changed.length > 0 ? `変更 ${status.changed.length}件` : 'コミット後に未実行'
  return `検証: 未実行（${changed}${status.todoStale ? `、${status.todo} 未更新` : ''}）`
}

function instruction(status: Active): string {
  const todo = status.todo ? `そのうえで ${status.todo} の「動作確認の記録」に結果を書いてください。` : ''
  const changed =
    status.changed.length > 0
      ? `変更: ${status.changed.slice(0, 8).join(', ')}${status.changed.length > 8 ? ' ほか' : ''}`
      : '前回の検証のあとにコードが変わっています'
  return `verify-gate: コードが変わっていますが、検証が実行されていません（${changed}）。終える前に verify_gate の run ツール（または npm run verify）で検証してください。失敗した確認も隠さず記録します。${todo}`
}

function tail(text: string, lines = 30): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}

async function runVerification($: EngineInterface): Promise<{ exitCode: number; text: string }> {
  const before = await refresh($)
  if (!before.configured) return { exitCode: 0, text: 'verify-gate: このプロジェクトには .claude/verify-gate.json がありません' }
  $.ui.status('検証: 実行中…')
  const { exitCode, stdout, stderr } = await gate($, ['run'], RUN_TIMEOUT_MS)
  const after = await refresh($)
  const summary =
    exitCode === 0
      ? 'verify-gate: すべての検証に成功し、記録しました。'
      : `verify-gate: 検証に失敗しました（終了コード ${exitCode}）。記録は更新していません。失敗を直すか、失敗したまま TODO に記録してください。`
  return { exitCode, text: `${summary}\n${statusLine(after) ?? ''}\n\n${tail(stderr)}\n${tail(stdout)}`.trim() }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run',
      description:
        'プロジェクトの .claude/verify-gate.json に書かれた検証コマンド（テスト、lint、型検査など）を順に実行し、すべて成功したら「検証済み」として記録する。コードを変えたあと、作業を終える前に呼ぶ。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    await $.tool.register({
      name: 'status',
      description: 'verify-gate の現在の状態（検証済みか、前回の検証のあとに変わったコード、TODO の記録が未更新か）を返す。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    await $.tool.register({
      name: 'stamp',
      description:
        '手で確かめた内容（画面の操作、インストールの確認など、コマンドで自動化できない検証）を、理由を添えて「検証済み」として記録する。自動の検証コマンドの代わりには使わない。',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: '何をどの環境でどう確かめたか' } },
        required: ['reason'],
        additionalProperties: false,
      },
    })
    await $.command.register({ name: 'verify', description: 'verify-gate の検証コマンドを実行して記録する' })
    await $.command.register({ name: 'verify-status', description: 'verify-gate の状態を表示する' })
    const started = await next(e)
    await refresh($)
    // エディタなど外からの変更にも追いつくため、ときどき見直す。
    $.clock.every(60_000, () => void refresh($))
    return started
  })

  on('tool.call', { tool: 'mcp__verify-gate__run' }, async $ => {
    const { exitCode, text } = await runVerification($)
    return exitCode === 0 ? { result: { text } } : { result: { text }, isError: true as const }
  })

  on('tool.call', { tool: 'mcp__verify-gate__status' }, async $ => {
    const status = await refresh($)
    return {
      result: {
        text: status.configured ? JSON.stringify(status, null, 2) : 'verify-gate: このプロジェクトには .claude/verify-gate.json がありません',
      },
    }
  })

  on('tool.call', { tool: 'mcp__verify-gate__stamp' }, async ($, e) => {
    const input = e as unknown as { reason?: unknown }
    const reason = typeof input.reason === 'string' ? input.reason : ''
    if (!reason.trim()) return { deny: 'verify-gate: stamp には reason（何をどう確かめたか）が必要です' }
    const { exitCode, stdout, stderr } = await gate($, ['stamp', '--reason', reason])
    const after = await refresh($)
    if (exitCode !== 0) return { result: { text: `verify-gate: 記録できませんでした。${stderr || stdout}` }, isError: true as const }
    return { result: { text: `verify-gate: 手動の確認を記録しました。${statusLine(after) ?? ''}` } }
  })

  on('command.run', { command: 'verify' }, async $ => {
    const { text } = await runVerification($)
    return { text }
  })

  on('command.run', { command: 'verify-status' }, async $ => {
    const status = await refresh($)
    return {
      text: status.configured
        ? `${statusLine(status) ?? '検証: 無効'}\n${JSON.stringify(status, null, 2)}`
        : 'このプロジェクトでは verify-gate は無効です（.claude/verify-gate.json がありません）',
    }
  })

  // コードの編集を見て状態を更新し、最初の一度だけモデルに検証を促す。
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (!CODE_EDIT_TOOLS.has(e.tool_name)) return result
    const status = await refresh($)
    if (!isActive(status) || status.verified) return result
    if (instructedFor === status.codeHash) return result
    instructedFor = status.codeHash
    return { ...result, additionalContext: [...(result.additionalContext ?? []), instruction(status)] }
  })

  // 未検証のままの git commit は、warn では注意、block では拒否する。実行後は状態を見直す。
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (COMMIT.test(e.command)) {
      const before = await refresh($)
      if (isActive(before) && !before.verified) {
        if (before.mode === 'block') return { deny: `verify-gate: 検証が未実行のためコミットを止めました。${instruction(before)}` }
        $.ui.toast('verify-gate: 検証が未実行のままコミットしています', { timeoutMs: 8000 })
      }
    }
    const ran = await next(e)
    void refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  // ターンの終わり。warn では注意を出すだけ、block では終了を止めて検証を求める。
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active) return result
    const status = await refresh($)
    if (!isActive(status) || status.verified) return result
    if (status.mode === 'block') return { ...result, block: instruction(status) }
    $.ui.toast(`verify-gate: 検証が未実行のままターンが終わりました（${statusLine(status) ?? ''}）`, { timeoutMs: 10_000 })
    return result
  })
}
