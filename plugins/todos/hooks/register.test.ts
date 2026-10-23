// todos の mod のテスト。claude plugin test plugins/todos で実行する。
// テストの作業ディレクトリ（この mod のフォルダ）には .claude/todos がないため、一覧は空になる。
import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

test('todo ツールの list は、Todo がなければそう答える', async ($, on) => {
  // テストの土台には作業ディレクトリの実装がないため、この mod のフォルダを答える。
  on('session.cwd', () => ({ value: '.' }))
  on('session.id', () => ({ value: 'test-session' }))
  // 外部プロセスも土台にはないため、bin/todos.mjs の list --json の答え（Todo なし）を返す。
  const empty = JSON.stringify({ todos: [], summary: { total: 0, open: 0, inProgress: 0, assigned: 0, done: 0 }, dir: '.claude/todos' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${empty}
`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const ran = await $.tool.call({ tool: 'mcp__todos__todo', action: 'list' })
  expect(ran.deny).toBeUndefined()
  expect(String(ran.result ?? ran.text ?? '')).toContain('Todo はありません')
})

test('todo ツールの done は note がなければ失敗する', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__todos__todo', action: 'done', id: 't-none' })
  expect(ran.isError).toBe(true)
  expect(String(ran.result ?? ran.text ?? '')).toContain('note')
})

test('Todo がなければシステムプロンプトに節を足さない', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const composed = await $.prompt.compose({ model: 'test', promptModel: 'test', surfaces: [], tools: [] } as unknown as Parameters<typeof $.prompt.compose>[0])
  expect(composed.sections.some(section => section.id === 'todos:open')).toBe(false)
})

test('/todo は題名がなければ使い方を答える', async $ => {
  const ran = await $.command.run({ command: 'todo', args: '' } as Parameters<typeof $.command.run>[0])
  expect(ran.text ?? '').toContain('使い方')
})

test('/todos のペインは、Todo の一覧と操作のボタンを描く', async ($, on) => {
  on('session.cwd', () => ({ value: '.' }))
  on('session.id', () => ({ value: 'test-session' }))
  const todos = [
    { id: 't-aaa111', title: '文字の大きさをブラウザで確かめる', tags: ['ui'], status: 'open', created_at: '2026-10-24T00:00:00.000Z', updated_at: null, done_at: null, assigned_to_session: null, body: '' },
    { id: 't-bbb222', title: 'AI設定を実際のモデルで確かめる', tags: [], status: 'in_progress', created_at: '2026-10-24T00:00:00.000Z', updated_at: null, done_at: null, assigned_to_session: 'test-session', body: '' },
  ]
  const listed = JSON.stringify({ todos, summary: { total: 2, open: 2, inProgress: 1, assigned: 1, done: 0 }, dir: '.claude/todos' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${listed}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.tool.call({ tool: 'mcp__todos__todo', action: 'list' })
  for (const surface of ['terminal', 'desktop'] as const) {
    // ペインの props のうち、この mod が読むのは title と bodyColumns だけ。
    const props = { title: 'Todo', bodyColumns: 100 } as unknown as RenderPropsOf['Pane']
    const ui = await $.ui.mount({ plugin: 'todos', surface, component: 'Pane', props, requestId: 'todos' })
    expect(await ui.find({ type: 'Text', text: /文字の大きさ/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /AI設定/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).length).toBeGreaterThan(3)
    await ui.unmount()
  }
})
