// todos の mod が $.state に置く値の契約。画面（/todos のペイン）が読む値だけを置く。
export type TodosView = { query: string; showDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    todos: {
      // 画面の表示条件（検索語、完了済みを出すか）
      view: TodosView
      // 一覧を読み直した回数。増えるとペインが描き直される
      refresh: number
    }
  }
}
