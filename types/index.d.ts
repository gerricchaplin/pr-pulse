export type Check = {
  name: string
  workflow: string
  status: string
  conclusion: string
  url: string
}
export type Pr = {
  repo: string
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  review: string
  mergeable: string
  checks: Check[]
  unresolved: number
  threads: number
  mergeState: string
  base: string
  behind: number
  required: string[]
  latestReviews: { author: string; state: string }[]
  commentCount: number
  lastCommenter: string
}
export type Alert = { at: number; text: string; tone: 'ok' | 'fail' | 'run' | 'info'; url: string }
export type PrRow = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: string
  when: string
  // open-PR rows carry a check and review summary for the collapsed band
  checks?: 'failed' | 'running' | 'passed' | 'skipped' | 'none'
  failing?: number
  review?: string
}
export type ReviewRow = PrRow & { direct: boolean; teams: string[] }
export type Step = { name: string; status: string; conclusion: string }
export type View = { workflow?: string; job?: Check; comments?: boolean }
export type Comment = { author: string; body: string; when: string; url: string; state: string }
export type Thread = { path: string; line: number; isResolved: boolean; isOutdated: boolean; url: string; comments: Comment[] }

declare module 'claude-code' {
  interface PluginState {
    'pr-pulse': {
      pr: Pr | null
      error: string
      loadedAt: number
      view: View
      steps: Step[]
      failedLog: string[]
      repo: string
      openPrs: PrRow[]
      history: PrRow[]
      teamMerged: PrRow[]
      reviews: ReviewRow[]
      selected: number
      threads: Thread[]
      conversation: Comment[]
      commentsLoaded: boolean
      watching: boolean
      target: string
      repoCache: string
      alerts: Alert[]
      collapsed: boolean
    }
  }
}
