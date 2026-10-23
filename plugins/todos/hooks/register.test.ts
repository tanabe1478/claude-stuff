// todos の mod のテスト。claude plugin test plugins/todos で実行する。
// テストの作業ディレクトリ（この mod のフォルダ）には .claude/todos がないため、一覧は空になる。
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
