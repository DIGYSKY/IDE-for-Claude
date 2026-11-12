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
  kind: 'comment' | 'reject' | 'restore' | 'snippet' | 'tests' | 'idea'
  path?: string
  line?: number
  endLine?: number
  code?: string
  text: string
  at: number
}

export type IdeaStatus = 'new' | 'doing' | 'done'
/** une idée de la boîte à idées ; `n` est son numéro court (#i3), `path`/`line` la sélection d'où elle est née */
export type Idea = {
  id: string
  n: number
  text: string
  tags: string[]
  status: IdeaStatus
  path?: string
  line?: number
  endLine?: number
  code?: string
  at: number
  by: 'user' | 'claude'
}
/** une annotation posée par Claude dans le code */
export type Annotation = { id: string; path: string; line: number; endLine?: number; note: string; at: number }
/** une commande enregistrée de l'exécuteur */
export type SavedCommand = { id: string; name: string; command: string; description?: string; by: 'user' | 'claude'; at: number }
/** ce qui est gardé par projet, d'une session à l'autre */
export type Project = {
  cwd: string
  ideas: Idea[]
  annotations: Annotation[]
  commands: SavedCommand[]
  /** les derniers prompts envoyés depuis la page (flèche haut) */
  prompts: string[]
  nextIdea: number
}
/** un prompt en file d'attente : il part quand Claude a fini */
export type Queued = { id: string; text: string; at: number }
/** une étape du plan de Claude (sa liste TodoWrite) */
export type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }
/** de quoi remplir la barre d'état de la page */
/** `line` : la sortie de la statusLine de Claude Code, avec ses couleurs de terminal */
export type Status = { model?: string; tokens?: number; window?: number; percent?: number; usd?: number; at: number; line?: string }

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
      /** l'id de session dont l'historique est en mémoire */
      restoredFor: Shaped<string | null>
      project: Shaped<Project | null>
      queue: Shaped<Queued[]>
      plan: Shaped<PlanItem[]>
      busy: Shaped<boolean>
      status: Shaped<Status | null>
    }
  }
}
