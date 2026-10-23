// verify-gate の mod のテスト。claude plugin test tools/verify-gate で実行する。
// テストの作業ディレクトリ（この mod のフォルダ）には .claude/verify-gate.json がないため、
// mod は「無効」として振る舞い、何も止めず、何も注入しない。
import { expect, test } from 'claude-code/testing'

test('起動時に登録した status ツールは、設定ファイルがなければ無効だと答える', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__verify-gate__status' })
  expect(ran.deny).toBeUndefined()
  expect(String(ran.result ?? ran.text ?? '')).toContain('.claude/verify-gate.json')
})

test('起動時に登録した /verify-status は、設定ファイルがなければ無効だと答える', async $ => {
  const ran = await $.command.run({ command: 'verify-status', args: '' } as Parameters<typeof $.command.run>[0])
  expect(ran.text ?? '').toContain('無効')
})

test('設定ファイルのないプロジェクトでは、ターン終了を止めない', async ($, on) => {
  on('classic.Stop', () => ({}))
  const result = await $.classic.Stop({ stop_hook_active: false })
  expect(result.block).toBeUndefined()
})

test('設定ファイルのないプロジェクトでは、コードの編集後に指示を注入しない', async ($, on) => {
  on('classic.PostToolUse', () => ({}))
  const result = await $.classic.PostToolUse({
    tool_name: 'Edit',
    tool_input: { file_path: 'src/a.ts' },
    tool_response: {},
    tool_use_id: 'toolu_test',
  })
  expect(result.additionalContext).toBeUndefined()
})

test('stamp は理由がなければ拒否する', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__verify-gate__stamp', reason: '   ' })
  expect(ran.deny ?? '').toContain('reason')
})
