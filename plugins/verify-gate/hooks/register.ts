// verify-gate の mod。判定そのものは bin/verify-gate.mjs（依存なしの Node スクリプト）に任せ、
// ここでは Claude Code の中で「気づける」ようにする。
// - ステータス行に「検証: 済み」「検証: 自動 未実行 / 手動 未実施 n 件」を出し続ける
// - コードを編集した直後に、必要な検証と手動確認をモデルへ一度だけ指示する
// - 手動確認の証拠になるコマンド（通しテストなど）が成功したら、その項目を証拠付きで実施済みにする
// - ターン終了時に、未実施があれば注意（warn）か、終了を止めて実施を求める（block）
// - 未実施のまま git commit しようとしたら、注意（warn）か拒否（block）
// プロジェクトに .claude/verify-gate.json がなければ何もしない。
import type { EngineInterface, Register } from 'claude-code'

type ManualItem = {
  id: string
  title: string
  due: boolean
  changed: string[]
  satisfiedBy: 'baseline' | 'evidence' | 'stamp' | null
  satisfiedAt: string | null
  reason: string | null
  evidenceCommands: string[]
  evidenceFiles: string[]
}

type Status =
  | { configured: false }
  | {
      configured: true
      mode: 'warn' | 'block' | 'off'
      verified: boolean
      outstanding: boolean
      codeHash: string
      codeFiles: number
      changed: string[]
      verifiedAt: string | null
      verifiedBy: 'run' | 'stamp' | null
      manual: ManualItem[]
      todo: string | null
      todoStale: boolean
      statePath: string
    }

type Active = Extract<Status, { configured: true }>

const CODE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMIT = /(^|[\s;&|])git\s+(?:[\w-]+\s+)*commit(\s|$)/
const RUN_TIMEOUT_MS = 15 * 60_000

let current: Status = { configured: false }
// 同じ未実施の状態について、モデルへの指示は一度だけにする（編集のたびに繰り返さない）。
let instructedFor: string | null = null

async function gate($: EngineInterface, args: string[], timeoutMs = 30_000) {
  const cwd = await $.session.cwd()
  return $.process.run(['node', `${$.plugin.root}/bin/verify-gate.mjs`, ...args, '--root', cwd, '--json'], { cwd, timeoutMs })
}

async function refresh($: EngineInterface): Promise<Status> {
  try {
    const { stdout, exitCode } = await gate($, ['status'])
    // status は未実施があるとき終了コード 1 を返すが、JSON は出ている。2 は設定の誤りなど。
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

function dueItems(status: Active): ManualItem[] {
  return status.manual.filter(item => item.due)
}

function outstandingKey(status: Active): string {
  return `${status.verified ? 'ok' : status.codeHash}|${dueItems(status).map(item => item.id).join(',')}`
}

function statusLine(status: Status): string | undefined {
  if (!isActive(status)) return undefined
  if (!status.outstanding) return '検証: 済み'
  const parts: string[] = []
  if (!status.verified) parts.push(`自動 未実行（変更 ${status.changed.length}件）`)
  const due = dueItems(status)
  if (due.length > 0) parts.push(`手動 未実施 ${due.length}件（${due.map(item => item.id).join(', ')}）`)
  if (status.todoStale) parts.push(`${status.todo} 未更新`)
  return `検証: ${parts.join(' / ')}`
}

function instruction(status: Active): string {
  const lines: string[] = []
  if (!status.verified) {
    const changed = status.changed.length > 0 ? `変更: ${status.changed.slice(0, 8).join(', ')}${status.changed.length > 8 ? ' ほか' : ''}` : '前回の検証のあとにコードが変わっています'
    lines.push(`自動の検証（テスト、lint、型検査）が実行されていません（${changed}）。verify_gate の run ツール（または npm run verify）で実行してください。失敗した確認も隠さず記録します。`)
  }
  const due = dueItems(status)
  if (due.length > 0) {
    lines.push('次の手動の確認が必要です（該当するコードが変わっています）。実施したら、何をどの環境でどう確かめたかを verify_gate の stamp ツール（item を指定）で記録してください。実施できない場合は、その理由を記録してください。')
    for (const item of due) {
      const hint =
        item.evidenceCommands.length > 0
          ? `証拠になるコマンド: ${item.evidenceCommands.join(' / ')}（成功すると自動で実施済みになる）`
          : item.evidenceFiles.length > 0
            ? `証拠になるファイル: ${item.evidenceFiles.join(', ')}`
            : '自己申告の記録になります'
      lines.push(`- ${item.id}: ${item.title}（変更: ${item.changed.slice(0, 5).join(', ')}${item.changed.length > 5 ? ' ほか' : ''}。${hint}）`)
    }
  }
  if (status.todo) lines.push(`そのうえで ${status.todo} の「動作確認の記録」に結果を書いてください。`)
  return `verify-gate:\n${lines.join('\n')}`
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
      ? 'verify-gate: 自動の検証はすべて成功し、記録しました。'
      : `verify-gate: 自動の検証に失敗しました（終了コード ${exitCode}）。記録は更新していません。失敗を直すか、失敗したまま TODO に記録してください。`
  const remaining = isActive(after) && dueItems(after).length > 0 ? `\n手動の確認が未実施です: ${dueItems(after).map(item => `${item.id}（${item.title}）`).join('、')}` : ''
  return { exitCode, text: `${summary}${remaining}\n${statusLine(after) ?? ''}\n\n${tail(stderr)}\n${tail(stdout)}`.trim() }
}

// 証拠になるコマンドが成功したら、該当する手動確認を証拠付きで実施済みにする。
async function recordEvidence($: EngineInterface, command: string, status: Status): Promise<string[]> {
  if (!isActive(status)) return []
  const recorded: string[] = []
  for (const item of dueItems(status)) {
    if (!item.evidenceCommands.some(pattern => matches(command, pattern))) continue
    const { exitCode } = await gate($, ['manual', item.id, '--by', 'evidence', '--reason', `コマンドの成功: ${command.slice(0, 200)}`])
    if (exitCode === 0) recorded.push(item.id)
  }
  return recorded
}

function matches(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(command)
  } catch {
    return command.includes(pattern)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run',
      description:
        'プロジェクトの .claude/verify-gate.json に書かれた自動の検証コマンド（テスト、lint、型検査など）を順に実行し、すべて成功したら「検証済み」として記録する。コードを変えたあと、作業を終える前に呼ぶ。手動の確認は別に stamp で記録する。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    await $.tool.register({
      name: 'status',
      description: 'verify-gate の現在の状態（自動の検証が済んでいるか、未実施の手動確認とその対象、TODO の記録が未更新か）を返す。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    await $.tool.register({
      name: 'stamp',
      description:
        '手動の確認（画面の操作、インストールの確認など、コマンドで自動化できない検証）を実施済みとして記録する。item に設定の manual の id を、reason に何をどの環境でどう確かめたかを書く。記録は自己申告として残る。item を省くと自動の検証を手動で記録するが、これは避ける。',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', description: '手動確認の id（status の manual にある）' },
          reason: { type: 'string', description: '何をどの環境でどう確かめたか。実施できない場合はその理由' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    })
    await $.command.register({ name: 'verify', description: 'verify-gate の自動の検証を実行して記録する' })
    await $.command.register({ name: 'verify-status', description: 'verify-gate の状態（自動の検証、手動の確認）を表示する' })
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
    const input = e as unknown as { item?: unknown; reason?: unknown }
    const reason = typeof input.reason === 'string' ? input.reason : ''
    const item = typeof input.item === 'string' ? input.item.trim() : ''
    if (!reason.trim()) return { deny: 'verify-gate: stamp には reason（何をどう確かめたか）が必要です' }
    const args = item ? ['manual', item, '--reason', reason] : ['stamp', '--reason', reason]
    const { exitCode, stdout, stderr } = await gate($, args)
    const after = await refresh($)
    if (exitCode !== 0) return { result: { text: `verify-gate: 記録できませんでした。${stderr || stdout}` }, isError: true as const }
    const label = item ? `手動の確認 ${item} を自己申告として記録しました。` : '自動の検証を手動で記録しました（検証コマンドは実行していません）。'
    return { result: { text: `verify-gate: ${label}${statusLine(after) ?? ''}` } }
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

  // コードの編集を見て状態を更新し、新しい未実施の状態になったときに一度だけモデルに指示する。
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (!CODE_EDIT_TOOLS.has(e.tool_name)) return result
    const status = await refresh($)
    if (!isActive(status) || !status.outstanding) return result
    const key = outstandingKey(status)
    if (instructedFor === key) return result
    instructedFor = key
    return { ...result, additionalContext: [...(result.additionalContext ?? []), instruction(status)] }
  })

  // Bash: 未実施のままの git commit は warn で注意、block で拒否。証拠になるコマンドの成功は記録する。
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (COMMIT.test(e.command)) {
      const before = await refresh($)
      if (isActive(before) && before.outstanding) {
        if (before.mode === 'block') return { deny: `verify-gate: 検証が未実施のためコミットを止めました。\n${instruction(before)}` }
        $.ui.toast('verify-gate: 検証が未実施のままコミットしています', { timeoutMs: 8000 })
      }
    }
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const recorded = await recordEvidence($, e.command, current)
      if (recorded.length > 0) $.ui.toast(`verify-gate: 手動の確認 ${recorded.join(', ')} を証拠付きで実施済みにしました`, { timeoutMs: 6000 })
    }
    void refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  // ターンの終わり。warn では注意を出すだけ、block では終了を止めて実施を求める。
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active) return result
    const status = await refresh($)
    if (!isActive(status) || !status.outstanding) return result
    if (status.mode === 'block') return { ...result, block: instruction(status) }
    $.ui.toast(`verify-gate: 未実施のままターンが終わりました（${statusLine(status) ?? ''}）`, { timeoutMs: 10_000 })
    return result
  })
}
