export type OpenFile = { path: string; saved: string; draft: string }
/** `before` : le fichier avant les modifs de Claude du dernier prompt ; `stale` : un nouveau prompt est parti depuis */
/** `agent` : le sous-agent qui a fait la modif (absent pour Claude lui-même) */
export type Change = { path: string; before: string; stale: boolean; agent?: string }
export type Mode = 'view' | 'edit'
/** un fichier touché pendant un prompt : `before` null si Claude l'a créé */
/** `via` : l'outil qui a fait la modif quand ce n'est pas Edit/Write (Bash, NotebookEdit) */
export type HistFile = { path: string; before: string | null; after: string; agent?: string; via?: string }
export type Turn = { id: number; prompt: string; at: number; files: HistFile[] }
export type ReviewItem = {
  id: string
  kind: 'comment' | 'reject' | 'restore' | 'snippet' | 'tests'
  path?: string
  line?: number
  endLine?: number
  code?: string
  text: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'ide-for-claude': {
      file: Shaped<OpenFile | null>
      changes: Shaped<Change[]>
      mode: Shaped<Mode>
      notice: Shaped<string>
      undo: Shaped<{ path: string; text: string } | null>
      /** dossiers que la personne a ouverts ou fermés à la main dans l'arbre */
      toggled: Shaped<string[]>
      showTree: Shaped<boolean>
      full: Shaped<boolean>
      web: Shaped<{ port: number; token: string } | null>
      history: Shaped<Turn[]>
      review: Shaped<ReviewItem[]>
      accepted: Shaped<string[]>
      /** la personne a fermé le panneau : plus d'ouverture automatique */
      paneClosed: Shaped<boolean>
    }
  }
}
