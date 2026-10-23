// todos の mod。Todo の読み書きは bin/todos.mjs（依存なしの Node スクリプト）に任せ、ここでは
// Claude Code の中で扱えるようにする。
// - /todos [検索語] で、検索・閲覧・状態の変更・担当（このセッション）の割り当てができるペインを開く
// - AI 向けの todo ツール（一覧、追加、更新、完了、担当）を登録する
// - 未完了の Todo（このセッションの担当を先に）をシステムプロンプトに添え、モデルが把握して進められるようにする
// - ステータス行に未完了の件数を出し続ける
// - 起動時に、完了して 7 日たった Todo を消す（保存先の settings.json の gc: false で止められる）
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodosView } from '../types'

type Todo = {
  id: string
  title: string
  tags: string[]
  status: 'open' | 'in_progress' | 'done'
  created_at: string
  updated_at: string | null
  done_at: string | null
  assigned_to_session: string | null
  body: string
}

type Summary = { total: number; open: number; inProgress: number; assigned: number; done: number }

const PANE = 'todos'
const STATUS_LABEL: Record<Todo['status'], string> = { open: '未着手', in_progress: '進行中', done: '完了' }
const view = atom({ plugin: 'todos', key: 'view' } as const, { query: '', showDone: false } satisfies TodosView)
const refresh = atom({ plugin: 'todos', key: 'refresh' } as const, 0)

let cache: Todo[] = []
let summary: Summary = { total: 0, open: 0, inProgress: 0, assigned: 0, done: 0 }
let sessionId = ''

async function cli($: EngineInterface, args: string[]): Promise<{ exitCode: number; json: unknown; text: string }> {
  const cwd = await $.session.cwd()
  if (!sessionId) sessionId = await $.session.id()
  const { exitCode, stdout, stderr } = await $.process.run(['node', `${$.plugin.root}/bin/todos.mjs`, ...args, '--root', cwd, '--json', '--session', sessionId], { cwd, timeoutMs: 30_000 })
  const line = stdout.trim().split('\n').pop() ?? ''
  let json: unknown = null
  try {
    json = line ? JSON.parse(line) : null
  } catch {
    json = null
  }
  return { exitCode, json, text: exitCode === 0 ? stdout.trim() : (stderr || stdout).trim() }
}

async function reload($: EngineInterface): Promise<void> {
  const { exitCode, json } = await cli($, ['list', '--all'])
  if (exitCode !== 0 || !json || typeof json !== 'object') return
  const data = json as { todos: Todo[]; summary: Summary }
  cache = data.todos
  summary = data.summary
  $.ui.status(statusLine())
  await update($, refresh, n => (n ?? 0) + 1)
}

function statusLine(): string | undefined {
  if (summary.open === 0) return undefined
  const parts = [`未完了 ${summary.open}`]
  if (summary.inProgress > 0) parts.push(`進行中 ${summary.inProgress}`)
  if (summary.assigned > 0) parts.push(`担当 ${summary.assigned}`)
  return `Todo: ${parts.join(' / ')}`
}

function line(todo: Todo): string {
  const mark = todo.status === 'done' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'
  const tags = todo.tags.length > 0 ? ` ${todo.tags.map(tag => `#${tag}`).join(' ')}` : ''
  const assigned = todo.assigned_to_session ? (todo.assigned_to_session === sessionId ? '（担当: このセッション）' : `（担当: ${todo.assigned_to_session.slice(0, 8)}）`) : ''
  return `${mark} ${todo.id} ${todo.title}${tags}${assigned}`
}

// モデルに添える Todo の一覧。このセッションの担当を先に、未完了だけ、多すぎれば切る。
function promptSection(): string | null {
  const open = cache.filter(todo => todo.status !== 'done')
  if (open.length === 0) return null
  const mine = open.filter(todo => todo.assigned_to_session === sessionId)
  const others = open.filter(todo => todo.assigned_to_session !== sessionId)
  const lines = [
    '# Todo（todos プラグイン）',
    'プロジェクトの Todo です。利用者から依頼されたこと、確認すべきことが入っています。`todo` ツールで追加・更新・完了できます。',
    '- 利用者に何かを依頼されたら、着手前に `todo` の add で残し、着手したら in_progress、終えたら done にします。',
    '- 動作確認や手動のテストのように「やったか」が問われることは、done にするときの note に、何をどの環境でどう確かめたかを書きます。確かめていないものを done にしません。',
    '- 利用者が自分で行う確認は、利用者の報告を受けてから done にします。',
    '',
  ]
  if (mine.length > 0) lines.push('## このセッションの担当', ...mine.slice(0, 20).map(line), '')
  if (others.length > 0) lines.push('## そのほかの未完了', ...others.slice(0, 20).map(line), '')
  if (open.length > 40) lines.push(`（ほか ${open.length - 40} 件。/todos で一覧できます）`)
  return lines.join('\n')
}

type ToolInput = {
  action?: string
  id?: string
  title?: string
  tags?: string[]
  body?: string
  note?: string
  status?: string
  query?: string
  all?: boolean
}

async function runTool($: EngineInterface, input: ToolInput): Promise<{ text: string; isError: boolean }> {
  const action = input.action ?? 'list'
  const need = (value: string | undefined, name: string) => {
    if (!value || !value.trim()) throw new Error(`${name} が必要です`)
    return value.trim()
  }
  try {
    let args: string[]
    switch (action) {
      case 'list':
        args = ['list', ...(input.query ? ['--query', input.query] : []), ...(input.all ? ['--all'] : [])]
        break
      case 'show':
        args = ['show', need(input.id, 'id')]
        break
      case 'add':
        args = ['add', need(input.title, 'title'), ...(input.tags?.length ? ['--tags', input.tags.join(',')] : []), ...(input.body ? ['--body', input.body] : []), ...(input.status ? ['--status', input.status] : [])]
        break
      case 'start':
        args = ['update', need(input.id, 'id'), '--status', 'in_progress', '--assign', sessionId, ...(input.note ? ['--append', input.note] : [])]
        break
      case 'done':
        args = ['done', need(input.id, 'id'), '--append', need(input.note, 'note（何をどの環境でどう確かめたか、または何をしたか）')]
        break
      case 'reopen':
        args = ['update', need(input.id, 'id'), '--status', 'open', ...(input.note ? ['--append', input.note] : [])]
        break
      case 'update':
        args = ['update', need(input.id, 'id'), ...(input.title ? ['--title', input.title] : []), ...(input.tags ? ['--tags', input.tags.join(',')] : []), ...(input.body !== undefined ? ['--body', input.body] : []), ...(input.note ? ['--append', input.note] : []), ...(input.status ? ['--status', input.status] : [])]
        break
      case 'assign':
        args = ['update', need(input.id, 'id'), '--assign', sessionId]
        break
      case 'unassign':
        args = ['update', need(input.id, 'id'), '--assign', 'none']
        break
      case 'remove':
        args = ['remove', need(input.id, 'id')]
        break
      default:
        throw new Error(`不明な action です: ${action}`)
    }
    const { exitCode, json, text } = await cli($, args)
    await reload($)
    if (exitCode !== 0) return { text: `todos: ${text}`, isError: true }
    if (action === 'list') {
      const data = json as { todos: Todo[] }
      return { text: data.todos.length === 0 ? 'Todo はありません' : data.todos.map(line).join('\n'), isError: false }
    }
    if (action === 'show') {
      const todo = json as Todo
      return { text: `${line(todo)}\n状態: ${STATUS_LABEL[todo.status]}\n作成: ${todo.created_at}${todo.done_at ? `\n完了: ${todo.done_at}` : ''}\n\n${todo.body}`.trim(), isError: false }
    }
    const todo = json as Todo
    return { text: `${action}: ${line(todo)}`, isError: false }
  } catch (error) {
    return { text: `todos: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    await $.tool.register({
      name: 'todo',
      description:
        'プロジェクトの Todo（利用者から依頼されたこと、確認すべきこと）を扱う。action: list（未完了の一覧。all で完了も）、show、add（title。tags、body）、start（着手。id。このセッションの担当になる）、done（完了。id と note に何をどの環境でどう確かめたか）、reopen、update、assign、unassign、remove。依頼を受けたら add で残し、終えたら done にする。確かめていないものを done にしない。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'add', 'start', 'done', 'reopen', 'update', 'assign', 'unassign', 'remove'] },
          id: { type: 'string', description: 'Todo の id（先頭の数文字でもよい）' },
          title: { type: 'string', description: 'add、update の題名' },
          tags: { type: 'array', items: { type: 'string' }, description: 'タグ（例: ui, windows）' },
          body: { type: 'string', description: '本文（背景、確認すること）' },
          note: { type: 'string', description: 'done などで本文の末尾に追記する記録。何をどの環境でどう確かめたか' },
          status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
          query: { type: 'string', description: 'list の検索語' },
          all: { type: 'boolean', description: 'list で完了済みも含める' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    })
    await $.command.register({ name: 'todos', description: 'Todo の一覧を開く（検索語を続けて書ける）', argumentHint: '[検索語]' })
    await $.command.register({ name: 'todo', description: 'Todo を1件追加する', argumentHint: '<題名>' })
    const started = await next(e)
    await cli($, ['gc'])
    await reload($)
    $.clock.every(60_000, () => void reload($))
    return started
  })

  on('tool.call', { tool: 'mcp__todos__todo' }, async ($, e) => {
    const { text, isError } = await runTool($, e as unknown as ToolInput)
    return isError ? { result: text, isError: true as const } : { result: text }
  })

  on('command.run', { command: 'todos' }, async ($, e) => {
    await update($, view, current => ({ ...(current ?? { query: '', showDone: false }), query: e.args.trim() }))
    await reload($)
    const opened = await $.ui.open({ id: PANE, title: 'Todo' })
    if (!opened.isPlaced) {
      const open = cache.filter(todo => todo.status !== 'done')
      return { text: open.length === 0 ? 'Todo はありません' : open.map(line).join('\n') }
    }
    return { text: `Todo の一覧を開きました（${statusLine() ?? '未完了なし'}）` }
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const title = e.args.trim()
    if (!title) return { text: '使い方: /todo <題名>' }
    const { text, isError } = await runTool($, { action: 'add', title })
    return { text: isError ? text : `追加しました。${text}` }
  })

  // 未完了の Todo をシステムプロンプトの末尾に添える。
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = promptSection()
    if (!text) return composed
    return { sections: [...composed.sections, { id: 'todos:open', text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // mobile には Input がないため、そこでは検索欄を出さない。
    const Input = 'Input' in table ? table.Input : null
    try {
      const current = (await read($, view)) ?? { query: '', showDone: false }
      await read($, refresh)
      const words = current.query.toLowerCase().split(/s+/).filter(Boolean)
      const shown = cache.filter(todo => {
        if (!current.showDone && todo.status === 'done') return false
        if (words.length === 0) return true
        const haystack = `${todo.id} ${todo.title} ${todo.tags.map(tag => `#${tag}`).join(' ')} ${todo.body}`.toLowerCase()
        return words.every(word => haystack.includes(word))
      })
      const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 8) / 2))
      const act = (args: string[]) => async () => {
        await cli($, args)
        await reload($)
      }
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold>Todo </Text>
            <Text dimColor>
              未完了 {summary.open} / 進行中 {summary.inProgress} / 完了 {summary.done}{' '}
            </Text>
            <Button key="toggle-done" label={current.showDone ? '完了を隠す' : '完了も表示'} onPress={() => update($, view, v => ({ ...(v ?? current), showDone: !(v ?? current).showDone }))} />
          </Box>
          {Input && (
            <Input key="query" placeholder="検索（題名、タグ、本文）" value={current.query} onSubmit={(value: string) => update($, view, v => ({ ...(v ?? current), query: value }))} />
          )}
          {shown.length === 0 && <Text dimColor>該当する Todo はありません。/todo &lt;題名&gt; か todo ツールで追加できます。</Text>}
          {shown.slice(0, room).map(todo => (
            <Box key={`row-${todo.id}`} flexDirection="column" marginTop={1}>
              <Text dimColor={todo.status === 'done'}>{line(todo)}</Text>
              <Box>
                {todo.status === 'open' && <Button key={`start-${todo.id}`} label="着手" onPress={act(['update', todo.id, '--status', 'in_progress', '--assign', sessionId])} />}
                {todo.status !== 'done' && <Button key={`done-${todo.id}`} label="完了" variant="primary" onPress={act(['done', todo.id, '--append', '/todos の画面で完了にした'])} />}
                {todo.status === 'in_progress' && <Button key={`open-${todo.id}`} label="未着手に戻す" onPress={act(['update', todo.id, '--status', 'open'])} />}
                {todo.status === 'done' && <Button key={`reopen-${todo.id}`} label="再開" onPress={act(['update', todo.id, '--status', 'open'])} />}
                {todo.status !== 'done' &&
                  (todo.assigned_to_session === sessionId ? (
                    <Button key={`unassign-${todo.id}`} label="担当を外す" onPress={act(['update', todo.id, '--assign', 'none'])} />
                  ) : (
                    <Button key={`assign-${todo.id}`} label="このセッションの担当にする" onPress={act(['update', todo.id, '--assign', sessionId])} />
                  ))}
              </Box>
            </Box>
          ))}
          {shown.length > room && <Text dimColor>ほか {shown.length - room} 件。検索で絞ってください。</Text>}
        </Box>
      )
    } catch (error) {
      // 描画の途中で失敗したときは、閉じてしまわずに理由を見せる。
      return <Text color="red">todos: 一覧を描けませんでした: {error instanceof Error ? error.message : String(error)}</Text>
    }
  })

  // ターンの終わりに、このセッションが担当する進行中の Todo があれば知らせる。
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active) return result
    await reload($)
    const mine = cache.filter(todo => todo.status === 'in_progress' && todo.assigned_to_session === sessionId)
    if (mine.length > 0) $.ui.toast(`Todo: 進行中 ${mine.length}件（${mine.map(todo => todo.title).join('、').slice(0, 80)}）`, { timeoutMs: 8000 })
    return result
  })
}
