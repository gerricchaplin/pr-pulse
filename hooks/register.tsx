import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Alert, Armed, Check, Comment, Pr, PrRow, ReviewRow, Step, Thread, View } from '../types'

const PANE = 'pr-pulse'
const HISTORY = 'pr-pulse-history'
const REVIEWS = 'pr-pulse-reviews'
const POLL_MS = 15_000
const HISTORY_DAYS = 7
const SLOW_POLL_MS = 60_000 // history and review queue change slowly
const IDLE_POLL_MS = 60_000 // nothing is running, so nothing changes quickly
const MINIMISED_IDLE_POLL_MS = 120_000 // band only and nothing running: alerts can wait a little
const BACKOFF_MAX_MS = 300_000
const POST_MERGE_WAIT_MS = 120_000 // runs on the merge commit start a few seconds after the merge
const RATE_LIMITED = /rate limit|abuse detection|secondary rate/i

const prAtom = atom({ plugin: 'pr-pulse', key: 'pr' } as const, null as Pr | null)
const errorAtom = atom({ plugin: 'pr-pulse', key: 'error' } as const, '')
const loadedAtom = atom({ plugin: 'pr-pulse', key: 'loadedAt' } as const, 0)
const viewAtom = atom({ plugin: 'pr-pulse', key: 'view' } as const, {} as View)
const stepsAtom = atom({ plugin: 'pr-pulse', key: 'steps' } as const, [] as Step[])
const logAtom = atom({ plugin: 'pr-pulse', key: 'failedLog' } as const, [] as string[])
const repoAtom = atom({ plugin: 'pr-pulse', key: 'repo' } as const, '')
const openAtom = atom({ plugin: 'pr-pulse', key: 'openPrs' } as const, [] as PrRow[])
const historyAtom = atom({ plugin: 'pr-pulse', key: 'history' } as const, [] as PrRow[])
const teamAtom = atom({ plugin: 'pr-pulse', key: 'teamMerged' } as const, [] as PrRow[])
const reviewsAtom = atom({ plugin: 'pr-pulse', key: 'reviews' } as const, [] as ReviewRow[])
const threadsAtom = atom({ plugin: 'pr-pulse', key: 'threads' } as const, [] as Thread[])
const conversationAtom = atom({ plugin: 'pr-pulse', key: 'conversation' } as const, [] as Comment[])
const commentsLoadedAtom = atom({ plugin: 'pr-pulse', key: 'commentsLoaded' } as const, false)
const watchingAtom = atom({ plugin: 'pr-pulse', key: 'watching' } as const, false)
const targetAtom = atom({ plugin: 'pr-pulse', key: 'target' } as const, '')
const repoCacheAtom = atom({ plugin: 'pr-pulse', key: 'repoCache' } as const, '')
const followedAtom = atom({ plugin: 'pr-pulse', key: 'followed' } as const, [] as string[])
const notesAtom = atom({ plugin: 'pr-pulse', key: 'notes' } as const, [] as string[])
const armedAtom = atom({ plugin: 'pr-pulse', key: 'armed' } as const, { key: '', at: 0 } as Armed)
const collapsedAtom = atom({ plugin: 'pr-pulse', key: 'collapsed' } as const, false)
const alertsAtom = atom({ plugin: 'pr-pulse', key: 'alerts' } as const, [] as Alert[])
const selectedAtom = atom({ plugin: 'pr-pulse', key: 'selected' } as const, 0)

let target = '' // "owner/repo#N" pinned by /pr-pulse <arg>; empty = latest PR of mine
let repoCache = '' // repo of the session's cwd, else of my latest PR
let autoFollow = true // userConfig: follow the PRs claude opens or pushes to
let ciContext = true // userConfig: tell claude, with your next prompt, when CI fails on a followed PR
let me = '' // github login of the gh user
let slowAt = 0 // when history and reviews were last fetched
let slowRepo = ''
let extrasAt = 0 // when the behind-count was last fetched
let extrasFor = 0
let required: string[] = []
let behind = 0
let queueSeen: Set<number> | undefined // review-queue PR numbers already announced
let watchedRoot = '' // git toplevel the pane currently follows
let nextPollAt = 0 // the 15s heartbeat skips ticks until this, which stretches the interval without new timer calls
let failures = 0
let timer: { cancel: () => void } | undefined
let running = false // panes opened and polling for this session

type Theme = {
  brand: string
  brandBg: string
  onBrand: string
  accent: string
  muted: string
  rule: string
  ok: string
  fail: string
  run: string
  skip: string
}
// purple theme: #6000F0 primary with lavender tints and slate neutrals; soft status tones for long viewing
const DARK: Theme = {
  brand: '#A37BFF', brandBg: '#6000F0', onBrand: '#F4F0FF', accent: '#C9B8FB', muted: '#A7B1C2', rule: '#48566A',
  ok: '#86D9A8', fail: '#F2A0A0', run: '#E9CB7C', skip: '#A7B1C2',
}
const LIGHT: Theme = {
  brand: '#6000F0', brandBg: '#6000F0', onBrand: '#FFFFFF', accent: '#6000F0', muted: '#48566A', rule: '#C6D2E1',
  ok: '#15803D', fail: '#B91C1C', run: '#B45309', skip: '#64748B',
}
let theme = DARK

async function loadTheme($: any) {
  try {
    const row = (await $.config.list()).find((r: { key: string }) => r.key === 'theme')
    theme = /light/i.test(String(row?.value ?? '')) ? LIGHT : DARK
  } catch {
    theme = DARK
  }
}

const icon = (status: string, conclusion: string): { glyph: string; tone: Outcome } => {
  if (status !== 'COMPLETED' && status !== 'completed') {
    return { glyph: status === 'QUEUED' || status === 'queued' ? '○' : '◐', tone: 'running' }
  }
  const c = conclusion.toUpperCase()
  if (c === 'SUCCESS') return { glyph: '✓', tone: 'passed' }
  if (c === 'SKIPPED' || c === 'NEUTRAL') return { glyph: '–', tone: 'skipped' }
  if (c === 'CANCELLED') return { glyph: '⊘', tone: 'failed' }
  return { glyph: '✗', tone: 'failed' }
}
const isPending = (c: { status: string }) => c.status.toUpperCase() !== 'COMPLETED'
// github treats a cancelled required check as failing, so a cancelled run must never read as green
const isFailed = (c: Check) => !isPending(c) && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion.toUpperCase())
const OUTCOMES = ['failed', 'running', 'passed', 'skipped'] as const
type Outcome = (typeof OUTCOMES)[number]
const outcome = (c: Check): Outcome =>
  isPending(c) ? 'running' : isFailed(c) ? 'failed' : c.conclusion.toUpperCase() === 'SUCCESS' ? 'passed' : 'skipped'
const tone = (o: Outcome) => ({ failed: theme.fail, running: theme.run, passed: theme.ok, skipped: theme.skip })[o]
const GLYPH: Record<Outcome, string> = { failed: '✗', running: '◐', passed: '✓', skipped: '–' }
const BAR_WIDTH = 30
const LOG_LINES = 20
const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required',
  NONE: 'no review needed',
}
const ALERTS_KEPT = 8
const FOLLOWED_KEPT = 20
const NOTES_KEPT = 5
const NOTE_CHARS = 1500
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const CREATES_PR = /\bgh\s+pr\s+create\b/
const PUSHES = /\bgit\s+push\b/
const BAND_ALERT_MS = 60_000 // how long the newest alert stays on the collapsed band
const BODY_CHARS = 700
const BODY_LINES = 10

let opener = '' // 'open' on macOS, 'xdg-open' elsewhere

// the mod api has no open-url call; the person's own opener does it
async function openUrl($: any, url: string) {
  if (!/^https:\/\//.test(url)) return
  if (!opener) opener = (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  const r = await $.process.run([opener, url])
  if (r.exitCode !== 0) $.ui.toast(`Couldn't open ${url}`)
}

async function gh($: any, args: string[]) {
  const r = await $.process.run(['gh', ...args], { timeoutMs: 30_000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout || 'gh failed').trim().split('\n')[0])
  return JSON.parse(r.stdout)
}

async function refresh($: any, force = false) {
  try {
    let repo: string
    if (target) {
      repo = /^(.+)#\d+$/.exec(target)![1]!
    } else {
      if (!repoCache) {
        const here = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner'])
        if (here.exitCode === 0) {
          repoCache = JSON.parse(here.stdout).nameWithOwner
        } else {
          const found = await gh($, [
            'search', 'prs', '--author', '@me', '--sort', 'created', '--order', 'desc',
            '--limit', '1', '--json', 'repository',
          ])
          if (!found.length) throw new Error('Not in a GitHub repo and no PRs found for your account')
          repoCache = found[0].repository.nameWithOwner
        }
      }
      repo = repoCache
    }
    const rows = (list: any[]): PrRow[] =>
      list.map(p => ({
        number: p.number, title: p.title, url: p.url, state: p.state, isDraft: !!p.isDraft,
        author: p.author?.login ?? '',
        when: String(p.mergedAt || p.closedAt || p.updatedAt || '').slice(0, 16).replace('T', ' '),
      }))
    if (!me) me = (await gh($, ['api', 'user'])).login
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10)
    const prevRepo: string = await read($, repoAtom)
    const pinned = target ? Number(/#(\d+)$/.exec(target)![1]) : 0
    const known: PrRow[] = prevRepo === repo ? [...(await read($, openAtom)), ...(await read($, historyAtom))] : []
    const wanted: number = await read($, selectedAtom)
    const guess = [pinned, wanted].find(n => n && known.some(p => p.number === n)) || pinned || known[0]?.number || 0
    const [owner, name] = repo.split('/')
    const slowDue = force || repo !== slowRepo || Date.now() - slowAt >= SLOW_POLL_MS
    const fast = await gh($, ['api', 'graphql', ...gqlArgs(owner!, name!, {
      list: `repo:${repo} is:pr is:open author:${me} sort:created-desc`,
      merged: slowDue ? `repo:${repo} is:pr is:merged merged:>=${since} sort:updated-desc` : undefined,
      queue: slowDue ? `repo:${repo} is:pr is:open review-requested:@me` : undefined,
      num: guess,
    })])
    const openRaw = (fast.data.open.nodes as any[]).filter(n => n?.number)
    const open: PrRow[] = openRaw.map(n => {
      const cs = latestRuns(rollupOf(n))
      const failing = cs.filter(isFailed).length
      const checks = !cs.length ? 'none' : failing ? 'failed' : cs.some(isPending) ? 'running' : 'passed'
      return {
        number: n.number, title: n.title, url: n.url, state: n.state, isDraft: !!n.isDraft, author: n.author?.login ?? '',
        when: String(n.updatedAt ?? '').slice(0, 16).replace('T', ' '), checks, failing, review: n.reviewDecision || 'NONE',
      }
    })
    await update($, repoAtom, () => repo)
    await update($, openAtom, () => open)
    let history: PrRow[] = await read($, historyAtom)
    if (slowDue) {
      const teamMerged = rows(fast.data.merged.nodes.filter((n: any) => n?.number)).sort((a, b) => b.when.localeCompare(a.when))
      history = teamMerged.filter(p => p.author === me)
      const requested = fast.data.queue.nodes.filter((n: any) => n?.number)
      const reviews: ReviewRow[] = rows(requested).map((r, i) => {
        const asked = (requested[i].reviewRequests?.nodes ?? []).map((q: any) => q.requestedReviewer ?? {}) as { login?: string; slug?: string; name?: string }[]
        return {
          ...r,
          direct: asked.some(q => q.login === me),
          teams: asked.filter(q => !q.login).map(q => (q.slug ?? q.name ?? '').replace(/^[^/]+\//, '')),
        }
      })
      await update($, historyAtom, () => history)
      await update($, teamAtom, () => teamMerged)
      await update($, reviewsAtom, () => reviews)
      if (queueSeen && repo === slowRepo) {
        for (const r of reviews.filter(r => !queueSeen!.has(r.number))) {
          await alert($, `👀 Review requested${r.direct ? ' from you' : ''}: #${r.number} ${r.title} (${r.author})`, 'info', r.url)
        }
      }
      queueSeen = new Set(reviews.map(r => r.number))
      slowAt = Date.now()
      slowRepo = repo
      $.ui.log(`${repo} open=${open.length} mine-merged=${history.length} all-merged=${teamMerged.length} reviews=${reviews.length}`, { to: 'debug' })
    }

    const chosen: number = await read($, selectedAtom)
    const number = [pinned, chosen].find(n => n && [...open, ...history].some(p => p.number === n)) || pinned || open[0]?.number || history[0]?.number
    if (!number) {
      await update($, prAtom, () => null)
      throw new Error(`No PRs of yours in ${repo}`)
    }
    await update($, selectedAtom, () => number)
    const v = number === guess ? fast.data.repository.pullRequest : (await gh($, ['api', 'graphql', ...gqlArgs(owner!, name!, { num: number })])).data.repository.pullRequest
    if (!v) throw new Error(`#${number} not found in ${repo}`)
    // once merged, what matters is what ran on the merge commit; before those runs appear, say so
    let checks = latestRuns(rollupOf(v))
    let checksOn: Pr['checksOn'] = 'pr'
    if (v.state === 'MERGED' && v.mergeCommit) {
      const post = latestRuns(contextsOf(v.mergeCommit.statusCheckRollup))
      if (post.length) {
        checks = post
        checksOn = 'merge'
      } else if (Date.now() - Date.parse(v.mergedAt) < POST_MERGE_WAIT_MS) {
        checks = []
        checksOn = 'waiting'
      }
    }
    const nodes = v.reviewThreads.nodes as { isResolved: boolean; comments: { totalCount: number; nodes: Latest[] } }[]
    const threads = nodes.length
    const unresolved = nodes.filter(n => !n.isResolved).length
    const commentCount = v.comments.totalCount + nodes.reduce((a, n) => a + n.comments.totalCount, 0)
    const latest = [...v.comments.nodes, ...nodes.flatMap(n => n.comments.nodes)] as Latest[]
    latest.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const lastCommenter = latest[0]?.author?.login ?? ''
    if (force || number !== extrasFor || Date.now() - extrasAt >= SLOW_POLL_MS) {
      try {
        behind = (await gh($, ['api', `repos/${repo}/compare/${v.baseRefName}...${encodeURIComponent(v.headRefName)}`])).behind_by ?? 0
      } catch {
        behind = 0
      }
      extrasAt = Date.now()
      extrasFor = number
    }
    required = checksOn === 'pr' ? rollupOf(v).filter((c: any) => c.isRequired).map((c: any) => c.name ?? c.context) : []
    const pr: Pr = {
      repo, number, title: v.title, url: v.url, state: v.state, isDraft: v.isDraft,
      review: v.reviewDecision || 'NONE', mergeable: v.mergeable, checks, checksOn, unresolved, threads,
      mergeState: v.mergeStateStatus ?? 'UNKNOWN', base: v.baseRefName ?? 'main', head: v.headRefName ?? '', behind, required,
      latestReviews: (v.latestReviews?.nodes ?? []).map((r: any) => ({ author: r.author?.login ?? '', state: r.state ?? '' })),
      commentCount, lastCommenter,
    }
    const prev: Pr | null = await read($, prAtom)
    await update($, prAtom, () => pr)
    await announcePrChanges($, prev, pr)
    await update($, errorAtom, () => '')
    await update($, loadedAtom, () => Date.now())
    const running = checks.filter(isPending).length
    const failed = checks.filter(isFailed).length
    $.ui.status(
      `PR #${number} ${pr.state.toLowerCase()}${unresolved > 0 ? ` · ${unresolved} unresolved` : ''} · ${failed ? `${failed} failed` : running ? `${running} running` : 'checks ok'}`,
    )
    failures = 0
    const busy = running > 0 || pr.checksOn === 'waiting' || open.some(r => r.checks === 'running')
    const idleMs = (await read($, collapsedAtom)) ? MINIMISED_IDLE_POLL_MS : IDLE_POLL_MS
    nextPollAt = (await $.clock.now()) + (busy ? POLL_MS : idleMs)
    const view: View = await read($, viewAtom)
    if (view.job) await loadSteps($, pr, view.job)
    if (view.comments) await loadComments($, pr)
  } catch (err) {
    const reason = String((err as Error).message ?? err)
    failures++
    nextPollAt = (await $.clock.now()) + Math.min(BACKOFF_MAX_MS, (RATE_LIMITED.test(reason) ? SLOW_POLL_MS : POLL_MS) * 2 ** (failures - 1))
    $.ui.log(`refresh failed: ${reason}`, { to: 'debug' })
    await update($, errorAtom, () => String((err as Error).message ?? err))
  }
}

// the rollup keeps superseded runs (a re-run, or a title edit re-triggering a check); keep each check's newest
function latestRuns(rollup: any[]): Check[] {
  // a queued re-run has no real start time yet (github reports 0001-01-01); it still supersedes finished runs
  const rank = (c: any) => {
    const live = String(c.status ?? '').toUpperCase() !== 'COMPLETED' && c.state !== 'SUCCESS' && c.state !== 'FAILURE'
    const at = String(c.startedAt ?? c.createdAt ?? '')
    return live && (!at || at.startsWith('0001')) ? '9999' : at
  }
  const newest = new Map<string, any>()
  for (const c of rollup) {
    const key = `${c.workflowName ?? ''}|${c.name ?? c.context ?? '?'}`
    const seen = newest.get(key)
    if (!seen || rank(c) >= rank(seen)) newest.set(key, c)
  }
  return [...newest.values()].map(c => ({
    name: c.name ?? c.context ?? '?',
    workflow: c.workflowName || 'Other checks',
    status: c.status ?? (c.state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED'),
    conclusion: c.conclusion ?? c.state ?? '',
    url: c.detailsUrl ?? c.targetUrl ?? '',
  }))
}

const contexts = (required: boolean) => `contexts(first:100){nodes{__typename
...on CheckRun{name status conclusion detailsUrl startedAt checkSuite{workflowRun{workflow{name}}}${required ? ' isRequired(pullRequestNumber:$num)' : ''}}
...on StatusContext{context state targetUrl createdAt${required ? ' isRequired(pullRequestNumber:$num)' : ''}}}}`
const rollup = (required: boolean) => `commits(last:1){nodes{commit{statusCheckRollup{${contexts(required)}}}}}`
const ROW_FIELDS = 'number title url state isDraft updatedAt mergedAt closedAt author{login}'
const LIST_FIELDS = `${ROW_FIELDS} reviewDecision ${rollup(false)}`
const QUEUE_FIELDS = `${ROW_FIELDS} reviewRequests(first:20){nodes{requestedReviewer{__typename ...on User{login} ...on Team{slug name}}}}`
const DETAIL_FIELDS = `title url state isDraft mergedAt mergeCommit{statusCheckRollup{${contexts(false)}}} reviewDecision mergeable mergeStateStatus baseRefName headRefName
latestReviews(first:20){nodes{author{login} state}} ${rollup(true)}
reviewThreads(first:100){nodes{isResolved comments(last:1){totalCount nodes{author{login} createdAt}}}}
comments(last:1){totalCount nodes{author{login} createdAt}}`

type GqlPart = { list?: string; num?: number; merged?: string; queue?: string }
// one request carries the open-PR list, the selected PR's detail and, when due, history and the review queue
function gqlArgs(owner: string, name: string, part: GqlPart): string[] {
  const search = (alias: string, v: string, fields: string) => `${alias}:search(query:${v},type:ISSUE,first:${alias === 'open' ? 20 : 100}){nodes{...on PullRequest{${fields}}}}`
  const decl = [
    '$o:String!', '$n:String!',
    ...(part.list ? ['$q:String!'] : []), ...(part.merged ? ['$mq:String!'] : []), ...(part.queue ? ['$rq:String!'] : []),
    ...(part.num ? ['$num:Int!'] : []),
  ].join(',')
  const body = [
    part.num ? `repository(owner:$o,name:$n){pullRequest(number:$num){${DETAIL_FIELDS}}}` : 'repository(owner:$o,name:$n){id}',
    part.list ? search('open', '$q', LIST_FIELDS) : '',
    part.merged ? search('merged', '$mq', ROW_FIELDS) : '',
    part.queue ? search('queue', '$rq', QUEUE_FIELDS) : '',
  ].join('\n')
  return [
    '-f', `query=query(${decl}){${body}}`, '-f', `o=${owner}`, '-f', `n=${name}`,
    ...(part.list ? ['-f', `q=${part.list}`] : []), ...(part.merged ? ['-f', `mq=${part.merged}`] : []),
    ...(part.queue ? ['-f', `rq=${part.queue}`] : []), ...(part.num ? ['-F', `num=${part.num}`] : []),
  ]
}

// gh's own rollup shape, which latestRuns already reads
function rollupOf(pr: any): any[] {
  return contextsOf(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup)
}

function contextsOf(rollup: any): any[] {
  const nodes = rollup?.contexts?.nodes ?? []
  return nodes.map((c: any) => (c.__typename === 'CheckRun' ? { ...c, workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? '' } : c))
}

type Latest = { author?: { login: string }; createdAt?: string }

// a failing check on a PR claude opened or pushed to becomes context on your next prompt, never a prompt of its own
async function noteForClaude($: any, prev: Pr, pr: Pr, failedBefore: Set<string>) {
  if (!ciContext || !(await read($, followedAtom)).includes(`${pr.repo}#${pr.number}`)) return
  const tag = `PR #${pr.number} (${pr.url})`
  for (const c of pr.checks.filter(c => isFailed(c) && !failedBefore.has(c.name) && c.conclusion.toUpperCase() !== 'CANCELLED')) {
    const log = await fetchFailureLog($, pr, c)
    const note = [
      `PR Pulse: the "${c.name}" check (${c.workflow}) failed on ${tag}, which you opened or pushed to.`,
      log.length ? `Log excerpt:\n${log.join('\n')}` : `Logs: ${c.url}`,
    ].join('\n').slice(0, NOTE_CHARS)
    await queueNote($, note, `✦ Will tell Claude at your next prompt: ${c.name} failed on #${pr.number}`, c.url)
  }
  const green = (p: Pr) => p.checks.length > 0 && !p.checks.some(isPending) && !p.checks.some(isFailed)
  if (failedBefore.size && green(pr) && !green(prev)) {
    await queueNote($, `PR Pulse: CI is green again on ${tag}.`, `✦ Will tell Claude at your next prompt: CI green again on #${pr.number}`, pr.url)
  }
}

async function queueNote($: any, note: string, shown: string, url: string) {
  await update($, notesAtom, (list: string[]) => [...list.filter(n => n !== note), note].slice(-NOTES_KEPT))
  await alert($, shown, 'info', url)
}

// claude's own `gh pr create` or `git push`: follow the PR it opened or updated
async function followFromCommand($: any, command: string, output: string) {
  let found = CREATES_PR.test(command) ? PR_URL.exec(output) : null
  if (!found && PUSHES.test(command)) {
    const r = await $.process.run(['gh', 'pr', 'view', '--json', 'url'], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return
    try {
      found = PR_URL.exec(JSON.parse(r.stdout).url ?? '')
    } catch {
      return
    }
  }
  if (found) await follow($, found[1]!, Number(found[2]), CREATES_PR.test(command) ? 'opened' : 'pushed to')
}

async function follow($: any, repo: string, number: number, verb: string) {
  const key = `${repo}#${number}`
  const isNew = !(await read($, followedAtom)).includes(key)
  await update($, followedAtom, (list: string[]) => [key, ...list.filter(k => k !== key)].slice(0, FOLLOWED_KEPT))
  target = ''
  repoCache = repo
  await update($, targetAtom, () => target)
  await update($, repoCacheAtom, () => repoCache)
  await update($, selectedAtom, () => number)
  await update($, viewAtom, () => ({}))
  if (!running) {
    // started by claude rather than by you: stay out of the way as the band until expanded
    running = true
    await update($, watchingAtom, () => true)
    await update($, collapsedAtom, () => true)
    await loadTheme($)
    if (!timer) timer = $.clock.every(POLL_MS, () => void tick($))
  }
  if (isNew) $.ui.toast(`PR Pulse is following #${number}, which Claude just ${verb}`, { timeoutMs: 6000 })
  await refresh($, true)
}

async function alert($: any, text: string, tone: Alert['tone'], url = '') {
  $.ui.toast(text, { timeoutMs: 8000 })
  await update($, alertsAtom, (list: Alert[]) => [{ at: Date.now(), text, tone, url }, ...list].slice(0, ALERTS_KEPT))
}

// compare against the previous poll of the same PR; the first poll only records
async function announcePrChanges($: any, prev: Pr | null, pr: Pr) {
  if (!prev || prev.number !== pr.number || prev.repo !== pr.repo || !prev.mergeState) return
  const tag = `#${pr.number}`
  const failedBefore = new Set(prev.checks.filter(isFailed).map(c => c.name))
  for (const c of pr.checks.filter(c => isFailed(c) && !failedBefore.has(c.name))) {
    const cancelled = c.conclusion.toUpperCase() === 'CANCELLED'
    await alert($, `${cancelled ? '⊘' : '✗'} ${c.name} ${cancelled ? 'cancelled' : 'failed'} on ${tag}`, 'fail', c.url)
  }
  const settled = (p: Pr) => p.checks.length > 0 && !p.checks.some(isPending)
  if (!settled(prev) && settled(pr) && !pr.checks.some(isFailed)) await alert($, `✓ All checks passed on ${tag}`, 'ok', pr.url)
  await noteForClaude($, prev, pr, failedBefore)
  const before = new Map(prev.latestReviews.map(r => [r.author, r.state]))
  for (const r of pr.latestReviews) {
    if (r.author === me || before.get(r.author) === r.state) continue
    if (r.state === 'APPROVED') await alert($, `✅ ${tag} approved by ${r.author}`, 'ok', pr.url)
    else if (r.state === 'CHANGES_REQUESTED') await alert($, `✋ ${r.author} requested changes on ${tag}`, 'fail', pr.url)
    else if (r.state === 'COMMENTED') await alert($, `💬 ${r.author} reviewed ${tag}`, 'info', pr.url)
  }
  if (pr.commentCount > prev.commentCount && pr.lastCommenter && pr.lastCommenter !== me) {
    const n = pr.commentCount - prev.commentCount
    await alert($, `💬 ${n} new comment${n === 1 ? '' : 's'} on ${tag} from ${pr.lastCommenter}`, 'info', pr.url)
  }
  if (pr.state === 'OPEN' && !prev.behind && pr.behind > 0) {
    await alert($, `⇣ ${tag} is ${pr.behind} commit${pr.behind === 1 ? '' : 's'} behind ${pr.base}`, pr.mergeState === 'BEHIND' ? 'fail' : 'info', pr.url)
  }
  if (pr.state === 'OPEN' && prev.mergeable !== 'CONFLICTING' && pr.mergeable === 'CONFLICTING') {
    await alert($, `✗ ${tag} has merge conflicts with ${pr.base}`, 'fail', pr.url)
  }
  if (prev.mergeState !== 'CLEAN' && pr.mergeState === 'CLEAN') await alert($, `● ${tag} is ready to merge`, 'ok', pr.url)
  if (prev.state !== pr.state && pr.state === 'MERGED') await alert($, `⑂ ${tag} merged`, 'ok', pr.url)
  if (prev.state !== pr.state && pr.state === 'CLOSED') await alert($, `⊘ ${tag} closed`, 'fail', pr.url)
}

// keep the lines leading up to the last ##[error] (else the tail), minus runner bookkeeping
function failureExcerpt(raw: string) {
  const lines = raw
    .split('\n')
    .map(l => (l.split('\t').length >= 3 ? l.split('\t').slice(2).join('\t') : l).replace(/^\S+Z /, '').replace(/\x1b\[[0-9;]*m/g, ''))
    .filter(l => l.trim() && !/^##\[(end)?group\]/.test(l) && !/^Cleaning up orphan processes/.test(l))
  const lastError = lines.map(l => l.startsWith('##[error]')).lastIndexOf(true)
  const end = lastError >= 0 ? lastError + 1 : lines.length
  return lines.slice(Math.max(0, end - LOG_LINES), end).map(l => l.replace(/^##\[error\]/, '✗ '))
}

const COMMENTS_QUERY = `query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){
reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:30){nodes{author{login} body createdAt url}}}}
comments(last:30){nodes{author{login} body createdAt url}}
reviews(last:30){nodes{author{login} state body submittedAt url}}}}}`

const clip = (body: string) => {
  const lines = body.replace(/\r/g, '').trim().split('\n')
  let text = lines.slice(0, BODY_LINES).join('\n')
  if (text.length > BODY_CHARS) text = text.slice(0, BODY_CHARS)
  return text.length < body.trim().length ? `${text.trimEnd()} …` : text
}
const stamp = (iso: string) => String(iso ?? '').slice(5, 16).replace('T', ' ')

async function loadComments($: any, pr: Pr) {
  try {
    const [owner, name] = pr.repo.split('/')
    const g = await gh($, ['api', 'graphql', '-f', `query=${COMMENTS_QUERY}`, '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `num=${pr.number}`])
    const p = g.data.repository.pullRequest
    const comment = (c: any): Comment => ({
      author: c.author?.login ?? 'ghost', body: clip(c.body ?? ''), when: stamp(c.createdAt ?? c.submittedAt), url: c.url ?? '',
      state: c.state && c.state !== 'COMMENTED' ? c.state : '',
    })
    const threads: Thread[] = p.reviewThreads.nodes.map((t: any) => ({
      path: t.path ?? '', line: t.line ?? 0, isResolved: !!t.isResolved, isOutdated: !!t.isOutdated,
      url: t.comments.nodes[0]?.url ?? pr.url, comments: t.comments.nodes.map(comment),
    }))
    const conversation: Comment[] = [
      ...p.comments.nodes.map(comment),
      ...p.reviews.nodes.filter((r: any) => (r.body ?? '').trim() || (r.state && r.state !== 'COMMENTED')).map(comment),
    ].sort((a, b) => a.when.localeCompare(b.when))
    await update($, threadsAtom, () => threads)
    await update($, conversationAtom, () => conversation)
    await update($, commentsLoadedAtom, () => true)
  } catch (err) {
    await update($, errorAtom, () => String((err as Error).message ?? err))
  }
}

async function fetchFailureLog($: any, pr: Pr, job: Check): Promise<string[]> {
  const m = /runs\/(\d+)\/job\/(\d+)/.exec(job.url)
  if (!m) return []
  // --log-failed prints "<job>\t<step>\t<timestamp> <message>" per line
  const log = await $.process.run(['gh', 'run', 'view', m[1]!, '-R', pr.repo, '--job', m[2]!, '--log-failed'], { timeoutMs: 60_000 })
  return failureExcerpt(log.exitCode === 0 ? log.stdout : log.stderr)
}

// a draft in the person's prompt box, never sent on their behalf
async function draftPrompt($: any, text: string) {
  try {
    const box = await $.prompt.read()
    const r = await $.prompt.fill({ text: box.text.trim() ? `\n\n${text}` : text, mode: 'append' })
    $.ui.toast(r.isFilled ? 'Draft added to your prompt: review it, then press Enter' : "Couldn't fill the prompt (is a dialog open?)", { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`Couldn't fill the prompt: ${String((err as Error).message ?? err)}`, { timeoutMs: 6000 })
  }
}

async function fixCheck($: any, pr: Pr, job: Check) {
  const log = await fetchFailureLog($, pr, job)
  await draftPrompt($, [
    `The "${job.name}" check (${job.workflow}) failed on PR #${pr.number} in ${pr.repo}: ${pr.url}`,
    `Job: ${job.url}`,
    log.length ? `Failure log excerpt:\n\`\`\`\n${log.join('\n')}\n\`\`\`` : 'Fetch the failing log with `gh run view --log-failed`.',
    'Find the root cause and fix it on this branch. Tell me what you changed.',
  ].join('\n'))
}

async function addressThread($: any, pr: Pr, th: Thread) {
  const quoted = th.comments.map(c => `> **${c.author}**: ${c.body.replace(/\n/g, '\n> ')}`).join('\n>\n')
  await draftPrompt($, [
    `Address this review thread on PR #${pr.number} (${th.url}) at \`${th.path}${th.line ? `:${th.line}` : ''}\`:`,
    quoted,
    'Make the change if it is right, or tell me why not. Summarise what you did so I can reply on the thread.',
  ].join('\n'))
}

let rerunning = false // one re-run at a time, like branch updates
let updating = false // one branch update at a time; a second press while it runs is ignored
const CONFIRM_MS = 5000

const isArmed = (armed: Armed, key: string) => armed.key === key && Date.now() - armed.at < CONFIRM_MS

// first press arms and redraws the button as "press again"; the second press within CONFIRM_MS runs it
async function confirmThen($: any, key: string, run: () => Promise<void>) {
  const armed: Armed = await read($, armedAtom)
  if (!isArmed(armed, key)) {
    await update($, armedAtom, () => ({ key, at: Date.now() }))
    return
  }
  await update($, armedAtom, () => ({ key: '', at: 0 }))
  await run()
}

// github updates the branch server-side; a rebase rewrites it, so a local checkout must pull before pushing again
const runIdOf = (c: Check) => /\/actions\/runs\/(\d+)/.exec(c.url)?.[1] ?? ''

// retries only the failed jobs of the run, which is the cheap fix for a flaky or cancelled job
async function rerunFailed($: any, pr: Pr, c: Check) {
  const run = runIdOf(c)
  if (!run || rerunning) return
  rerunning = true
  try {
    $.ui.toast(`Re-running the failed jobs of ${c.workflow}…`)
    const r = await $.process.run(['gh', 'run', 'rerun', run, '--failed', '-R', pr.repo], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) {
      $.ui.toast(`Couldn't re-run ${c.workflow}: ${(r.stderr || r.stdout || 'gh failed').trim().split('\n')[0]}`, { timeoutMs: 8000 })
      return
    }
    $.ui.toast(`Re-running the failed jobs of ${c.workflow}`, { timeoutMs: 6000 })
    await refresh($, true)
  } finally {
    rerunning = false
  }
}

async function updateBranch($: any, pr: Pr, rebase: boolean) {
  if (updating) return
  updating = true
  try {
    $.ui.toast(rebase ? `Rebasing #${pr.number} on ${pr.base}…` : `Merging ${pr.base} into #${pr.number}…`)
    const r = await $.process.run(
      ['gh', 'pr', 'update-branch', String(pr.number), '-R', pr.repo, ...(rebase ? ['--rebase'] : [])],
      { timeoutMs: 60_000 },
    )
    if (r.exitCode !== 0) {
      $.ui.toast(`Couldn't update #${pr.number}: ${(r.stderr || r.stdout || 'gh failed').trim().split('\n')[0]}`, { timeoutMs: 8000 })
      return
    }
    const local = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    const onBranch = local.exitCode === 0 && local.stdout.trim() === pr.head
    const done = rebase ? `Rebased #${pr.number} on ${pr.base}` : `Merged ${pr.base} into #${pr.number}`
    $.ui.toast(
      onBranch ? `${done}: your checkout is on ${pr.head}, run \`git pull${rebase ? ' --rebase' : ''}\` before pushing again` : done,
      { timeoutMs: 8000 },
    )
    await refresh($, true)
  } finally {
    updating = false
  }
}

async function rebaseWithClaude($: any, pr: Pr) {
  const conflicts = pr.mergeable === 'CONFLICTING'
  const state = [pr.behind ? `${pr.behind} commit${pr.behind === 1 ? '' : 's'} behind \`${pr.base}\`` : '', conflicts ? 'has merge conflicts' : '']
    .filter(Boolean)
    .join(' and ')
  await draftPrompt($, [
    `PR #${pr.number} in ${pr.repo} (${pr.url}) is ${state}.`,
    `Rebase \`${pr.head}\` onto the latest \`origin/${pr.base}\`: fetch, check out the branch, rebase, and resolve any conflicts keeping the intent of both sides.`,
    'Run the tests, then show me what changed and ask before you push with `--force-with-lease`.',
  ].join('\n'))
}

async function loadSteps($: any, pr: Pr, job: Check) {
  const m = /runs\/(\d+)\/job\/(\d+)/.exec(job.url)
  if (!m) return update($, stepsAtom, () => [])
  try {
    const run = await gh($, ['run', 'view', m[1]!, '-R', pr.repo, '--json', 'jobs'])
    const j = run.jobs.find((x: any) => String(x.databaseId) === m[2])
    await update($, stepsAtom, () =>
      (j?.steps ?? []).map((s: any) => ({ name: s.name, status: s.status, conclusion: s.conclusion ?? '' })),
    )
    if (!isFailed(job)) return update($, logAtom, () => [])
    const lines = await fetchFailureLog($, pr, job)
    await update($, logAtom, () => lines)
  } catch (err) {
    await update($, errorAtom, () => String((err as Error).message ?? err))
  }
}

// Follow the agent's `cd` into a different top-level git repo. A pinned
// target (/pr-pulse owner/repo#N) or a non-repo directory leaves the view alone.
async function followCwd($: any, cwd: string) {
  if (target) return
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  if (top.exitCode !== 0) return
  const root = top.stdout.trim()
  if (!root || root === watchedRoot) return
  const here = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner'], { cwd: root })
  if (here.exitCode !== 0) return
  watchedRoot = root
  repoCache = JSON.parse(here.stdout).nameWithOwner
  await update($, viewAtom, () => ({}))
  await update($, selectedAtom, () => 0)
  await refresh($)
}

async function openPanes($: any) {
  await $.ui.open({ id: HISTORY, title: 'PR history' })
  await $.ui.open({ id: REVIEWS, title: 'PR reviews' })
  // opened last and asked for focus, so the PR Pulse tab is the one in front
  await $.ui.open({ id: PANE, title: 'PR Pulse', focus: true })
}

async function closePanes($: any) {
  await $.ui.close({ id: REVIEWS })
  await $.ui.close({ id: HISTORY })
  await $.ui.close({ id: PANE })
}

// panes away, polling and alerts carry on, the AbovePrompt band summarises
async function minimise($: any) {
  await update($, collapsedAtom, () => true)
  await closePanes($)
}

async function expand($: any, number = 0) {
  if (number) {
    await update($, selectedAtom, () => number)
    await update($, viewAtom, () => ({}))
  }
  await update($, collapsedAtom, () => false)
  await openPanes($)
  await refresh($)
}

async function start($: any) {
  running = true
  await update($, watchingAtom, () => true)
  await update($, collapsedAtom, () => false)
  await update($, targetAtom, () => target)
  await update($, repoCacheAtom, () => repoCache)
  await loadTheme($)
  await openPanes($)
  await refresh($)
  if (!timer) timer = $.clock.every(POLL_MS, () => void tick($))
}

// a reload starts the module over; pick the watch back up from session state
async function resume($: any) {
  if (running || !(await read($, watchingAtom))) return
  running = true
  target = await read($, targetAtom)
  repoCache = await read($, repoCacheAtom)
  await loadTheme($)
  // the reload closed the panes; reopen them unless you had minimised to the band
  if (!(await read($, collapsedAtom))) await openPanes($)
  void refresh($, true)
  if (!timer) timer = $.clock.every(POLL_MS, () => void tick($))
}

async function stop($: any) {
  running = false
  await update($, watchingAtom, () => false)
  timer?.cancel()
  timer = undefined
  $.ui.status(undefined)
  await update($, collapsedAtom, () => false)
  await closePanes($)
}

async function tick($: any) {
  if ((await $.clock.now()) < nextPollAt) return
  await refresh($)
}


function paneBar(ui: any, $: any, title: string, repo: string) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text backgroundColor={theme.brandBg} color={theme.onBrand}> ◆ {title} </Text>
        <Text color={theme.muted}>  {repo || '…'}</Text>
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="minimise" label="▁ Minimise" hotkey="m" onPress={() => void minimise($)} />
        <Button key="close" label="✕ Close" hotkey="q" onPress={() => void stop($)} />
      </Box>
    </Box>
  )
}

// the one thing standing between a PR and merging, as a few words for the band
function blocker(p: PrRow) {
  if (p.failing) return `${p.failing} failing`
  if (p.checks === 'running') return 'checks running'
  if (p.isDraft) return 'draft'
  if (p.review === 'CHANGES_REQUESTED') return 'changes requested'
  if (p.review === 'REVIEW_REQUIRED') return 'needs review'
  return 'ready'
}

function band(ui: any, $: any, open: PrRow[], selected: number, queue: number, latest: Alert | undefined) {
  const { Box, Text, Button } = ui
  const t = theme
  const glyph = (p: PrRow) =>
    p.checks === 'failed' ? { g: '✗', c: t.fail } : p.checks === 'running' ? { g: '◐', c: t.run } : p.checks === 'passed' ? { g: '✓', c: t.ok } : { g: '○', c: t.muted }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text backgroundColor={t.brandBg} color={t.onBrand}> ◆ PR </Text>
        {open.length === 0 && <Text color={t.muted}>no open PRs</Text>}
        {open.map(p => {
          const gl = glyph(p)
          const b = blocker(p)
          return (
            <Box key={`chip-${p.number}`} flexDirection="row">
              <Text color={gl.c}>{gl.g} </Text>
              <Button plain key={`chip-open-${p.number}`} dimColor={p.number !== selected} label={`#${p.number}`} onPress={() => void expand($, p.number)} />
              <Text color={b === 'ready' ? t.ok : t.muted}> {b}</Text>
            </Box>
          )
        })}
        {queue > 0 && <Text color={t.accent}>👀 {queue} to review</Text>}
        <Button key="expand" label="⤢ Expand" hotkey="e" onPress={() => void expand($)} />
      </Box>
      {latest && (
        <Text color={latest.tone === 'fail' ? t.fail : latest.tone === 'ok' ? t.ok : t.muted}>
          {'      '}{latest.text} · {new Date(latest.at).toLocaleTimeString().slice(0, 5)}
        </Text>
      )}
    </Box>
  )
}

function heading(ui: any, label: string, count: number, color = theme.accent) {
  const { Box, Text } = ui
  return (
    <Box marginTop={1}>
      <Text color={color}>{`${label.toUpperCase()} · ${count}`}</Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  autoFollow = options.autoFollow !== false
  ciContext = options.ciContext !== false

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!autoFollow || ran.deny !== undefined || ran.isError || !(CREATES_PR.test(e.command) || PUSHES.test(e.command))) return ran
    const result = ran.result as { stdout?: string; stderr?: string; backgroundTaskId?: string } | undefined
    if (!result || result.backgroundTaskId) return ran
    await followFromCommand($, e.command, `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    const notes: string[] = await read($, notesAtom)
    if (!ciContext || !notes.length) return next(e)
    await update($, notesAtom, () => [])
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pulse',
      description: 'PR Pulse: PR status, checks, comments and review queue. Optional arg: owner/repo#123',
    })
    await resume($)
    return next(e)
  })

  on('classic.CwdChanged', async ($, e: any, next) => {
    $.ui.log(`cwd changed to ${e.new_cwd}`, { to: 'debug' })
    await followCwd($, String(e.new_cwd ?? ''))
    return next(e)
  })

  on('command.run', { command: 'pulse' }, async ($, e: any) => {
    const arg = String(e.args ?? '').trim()
    if (running && !arg) {
      if (await read($, collapsedAtom)) {
        await expand($)
        return { text: 'Expanded PR Pulse.' }
      }
      // a reload closes the panes while the watch carries on, so bring them back
      await openPanes($)
      await refresh($, true)
      return { text: `Already watching ${target || repoCache || 'your latest PR'}; refreshed.` }
    }
    const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(arg)
    repoCache = /^[\w.-]+\/[\w.-]+$/.test(arg) ? arg : ''
    target = url ? `${url[1]}#${url[2]}` : /^.+#\d+$/.test(arg) ? arg : ''
    await update($, viewAtom, () => ({}))
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    watchedRoot = top.exitCode === 0 ? top.stdout.trim() : ''
    const text = target ? `Watching ${target}` : repoCache ? `Watching ${repoCache}` : 'Watching your latest PR.'
    await start($)
    return { text }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && running && !(await read($, collapsedAtom))) void stop($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, watchingAtom)) || !(await read($, collapsedAtom))) return next(e)
    const open: PrRow[] = await read($, openAtom)
    const selected: number = await read($, selectedAtom)
    const queue: ReviewRow[] = await read($, reviewsAtom)
    const alerts: Alert[] = await read($, alertsAtom)
    const latest = alerts[0] && Date.now() - alerts[0].at < BAND_ALERT_MS ? alerts[0] : undefined
    return band($.ui.resolve(e), $, open, selected, queue.length, latest)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = theme
    const pr = await read($, prAtom)
    const repo: string = await read($, repoAtom)
    const openPrs: PrRow[] = await read($, openAtom)
    const selected: number = await read($, selectedAtom)
    const error = await read($, errorAtom)
    const loaded: number = await read($, loadedAtom)
    const view: View = await read($, viewAtom)
    const steps: Step[] = await read($, stepsAtom)
    const failedLog: string[] = await read($, logAtom)
    const alerts: Alert[] = await read($, alertsAtom)

    const pick = (n: number) => async () => {
      await update($, selectedAtom, () => n)
      await update($, viewAtom, () => ({}))
      await update($, stepsAtom, () => [])
      void refresh($)
    }
    const go = (v: View) => async () => {
      await update($, viewAtom, () => v)
      await update($, stepsAtom, () => [])
      await update($, logAtom, () => [])
      if (v.comments) await update($, commentsLoadedAtom, () => false)
      if (v.job && pr) await loadSteps($, pr, v.job)
      if (v.comments && pr) await loadComments($, pr)
    }

    const topBar = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text backgroundColor={t.brandBg} color={t.onBrand}> ◆ PR PULSE </Text>
          <Text color={t.muted}>  {repo || '…'}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="↻ Refresh" hotkey="r" onPress={() => void refresh($, true)} />
          <Button key="minimise" label="▁ Minimise" hotkey="m" onPress={() => void minimise($)} />
          <Button key="close" label="✕ Close" hotkey="q" onPress={() => void stop($)} />
        </Box>
      </Box>
    )
    const section = (label: string, count?: number, color = t.accent) => (
      <Box marginTop={1}>
        <Text color={color}>{count === undefined ? label.toUpperCase() : `${label.toUpperCase()} · ${count}`}</Text>
      </Box>
    )
    const errorLine = error ? <Text color={t.fail}>⚠ {error}</Text> : null

    const openSection = (
      <Box flexDirection="column">
        {section('Open PRs', openPrs.length)}
        {openPrs.length === 0 && <Text color={t.muted}>None open.</Text>}
        {openPrs.map(p => {
          const isSel = p.number === selected
          return (
            <Box key={`pr-row-${p.number}`} flexDirection="row">
              <Text color={t.brand}>{isSel ? '▸ ' : '  '}</Text>
              <Button plain key={`pr-${p.number}`} dimColor={!isSel} label={`#${p.number} ${p.title}`} onPress={pick(p.number)} />
              {p.isDraft && <Text color={t.muted}> · draft</Text>}
            </Box>
          )
        })}
      </Box>
    )

    if (!pr) {
      return (
        <Box flexDirection="column">
          {topBar}
          {openSection}
          {errorLine ?? <Text color={t.muted}>Loading PR…</Text>}
        </Box>
      )
    }

    const groups = new Map<string, Check[]>()
    for (const c of pr.checks) groups.set(c.workflow, [...(groups.get(c.workflow) ?? []), c])
    const total = pr.checks.length
    const done = pr.checks.filter(c => !isPending(c)).length
    const count = (cs: Check[]) => {
      const n: Record<Outcome, number> = { failed: 0, running: 0, passed: 0, skipped: 0 }
      for (const c of cs) n[outcome(c)]++
      return n
    }
    const counts = count(pr.checks)

    const bar = (n: Record<Outcome, number>, of: number) => {
      const cells = (k: number) => (of ? Math.round((k / of) * BAR_WIDTH) : 0)
      const order: Outcome[] = ['failed', 'passed', 'skipped', 'running']
      const widths = order.map(o => cells(n[o]))
      const rest = Math.max(0, BAR_WIDTH - widths.reduce((a, b) => a + b, 0))
      return (
        <Text>
          {order.map((o, i) => <Text color={tone(o)}>{'█'.repeat(widths[i]!)}</Text>)}
          <Text color={t.rule}>{'░'.repeat(rest)}</Text>
        </Text>
      )
    }
    const tally = (n: Record<Outcome, number>) => (
      <Text>
        {OUTCOMES.filter(o => n[o]).map(o => (
          <Text color={tone(o)}>{GLYPH[o]} {n[o]} {o}   </Text>
        ))}
      </Text>
    )
    const checkRow = (c: Check, key: string, label: string) => {
      const i = icon(c.status, c.conclusion)
      return (
        <Box key={key} flexDirection="row">
          <Text color={tone(i.tone)}>{i.glyph} </Text>
          <Button plain label={label} onPress={go({ workflow: c.workflow, job: c })} />
        </Box>
      )
    }

    const review = pr.review.toUpperCase()
    const reviewColor = review === 'APPROVED' ? t.ok : review === 'CHANGES_REQUESTED' ? t.fail : t.run
    const reqChecks = pr.required.length ? pr.checks.filter(c => pr.required.includes(c.name)) : pr.checks
    const reqFailed = reqChecks.filter(isFailed).length
    const reqPending = reqChecks.filter(isPending).length
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
    const checkWord = pr.required.length ? 'required check' : 'check'
    // ok: true passes, false blocks, null is waiting or advisory
    const readiness: { ok: boolean | null; label: string }[] = [
      { ok: !pr.isDraft, label: pr.isDraft ? 'draft' : 'ready for review' },
      {
        ok: reqFailed ? false : reqPending ? null : true,
        label: reqFailed ? `${plural(reqFailed, checkWord)} failing` : reqPending ? `${plural(reqPending, checkWord)} running` : `${checkWord}s passed`,
      },
      {
        ok: review === 'APPROVED' || review === 'NONE',
        label: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes requested' : review === 'NONE' ? 'no review required' : 'needs approval',
      },
      { ok: pr.unresolved <= 0, label: pr.unresolved > 0 ? plural(pr.unresolved, 'unresolved thread') : 'threads resolved' },
      { ok: pr.mergeable !== 'CONFLICTING', label: pr.mergeable === 'CONFLICTING' ? 'merge conflicts' : 'no conflicts' },
      // behind is only a blocker when a branch rule demands up-to-date branches, which github reports as BEHIND
      {
        ok: !pr.behind ? true : pr.mergeState === 'BEHIND' ? false : null,
        label: pr.behind ? `${plural(pr.behind, 'commit')} behind ${pr.base}` : `up to date with ${pr.base}`,
      },
    ]
    const waiting = readiness.some(r => r.ok === null && r.label.includes('running'))
    // github can block on rules the checklist cannot see (signed commits, codeowners, deployments)
    if (pr.mergeState === 'BLOCKED' && !waiting && readiness.every(r => r.ok !== false)) {
      readiness.push({ ok: false, label: 'blocked by a branch rule' })
    }
    const blockers = readiness.filter(r => r.ok === false).length
    const isReady = pr.state === 'OPEN' && !blockers && !waiting
    const verdict =
      pr.state === 'MERGED' ? { text: ' ⑂ MERGED ', bg: t.brandBg }
      : pr.state === 'CLOSED' ? { text: ' ⊘ CLOSED ', bg: t.rule }
      : isReady ? { text: ' ✓ READY TO MERGE ', bg: t.ok }
      : blockers ? { text: ` ✗ BLOCKED · ${blockers} `, bg: t.fail }
      : { text: ' ◐ WAITING ON CHECKS ', bg: t.run }
    const readinessLine = (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text backgroundColor={verdict.bg} color="#0F1729">{verdict.text}</Text>
        </Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {readiness.map(r => (
            <Text color={r.ok === true ? t.ok : r.ok === false ? t.fail : t.run}>
              {r.ok === true ? '✓' : r.ok === false ? '✗' : '◐'} {r.label}
            </Text>
          ))}
        </Box>
      </Box>
    )

    // github can only update a branch without conflicts; with them, a local rebase is the way
    const conflicting = pr.mergeable === 'CONFLICTING'
    const armed: Armed = await read($, armedAtom)
    const branchActions = pr.state === 'OPEN' && (pr.behind > 0 || conflicting) ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {!conflicting && (
          <Button
            key="update-merge"
            label={isArmed(armed, `merge-${pr.number}`) ? `Press again to merge ${pr.base} into #${pr.number}` : `⇣ Merge ${pr.base} in`}
            onPress={() => void confirmThen($, `merge-${pr.number}`, () => updateBranch($, pr, false))}
          />
        )}
        {!conflicting && (
          <Button
            key="update-rebase"
            label={isArmed(armed, `rebase-${pr.number}`) ? `Press again to rebase #${pr.number} on ${pr.base}` : `⇣ Rebase on ${pr.base}`}
            onPress={() => void confirmThen($, `rebase-${pr.number}`, () => updateBranch($, pr, true))}
          />
        )}
        <Button key="rebase-claude" label="✦ Rebase with Claude" onPress={() => void rebaseWithClaude($, pr)} />
      </Box>
    ) : null

    const card = (
      <Box flexDirection="column" borderStyle="round" borderColor={t.brand} paddingX={1} marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="open-pr" variant="primary" label="↗ Open PR" hotkey="o" onPress={() => void openUrl($, pr.url)} />
          <Text>{pr.title}</Text>
        </Box>
        <Text>
          <Text color={t.accent}>#{pr.number}</Text>
          <Text color={t.muted}>  ·  </Text>
          <Text color={pr.isDraft ? t.muted : t.ok}>{pr.isDraft ? '○ draft' : `● ${pr.state.toLowerCase()}`}</Text>
          <Text color={t.muted}>  ·  </Text>
          <Text color={reviewColor}>● {REVIEW_LABEL[review] ?? review.toLowerCase().replace(/_/g, ' ')}</Text>
          <Text color={t.muted}>  ·  </Text>
          <Text color={pr.mergeable === 'CONFLICTING' ? t.fail : t.muted}>{pr.mergeable.toLowerCase()}</Text>
        </Text>
        <Box flexDirection="row">
          <Text color={pr.unresolved > 0 ? t.run : t.ok}>{pr.unresolved > 0 ? '💬 ' : '✓ '}</Text>
          <Button
            plain
            key="comments"
            label={`${pr.unresolved > 0 ? `${pr.unresolved} unresolved` : 'no unresolved comments'} · ${pr.threads} thread${pr.threads === 1 ? '' : 's'} · conversation ›`}
            onPress={go({ comments: true })}
          />
        </Box>
        {readinessLine}
        {branchActions}
        <Text color={t.muted}>updated {new Date(loaded).toLocaleTimeString()} · auto-refresh {POLL_MS / 1000}s</Text>
        {errorLine}
      </Box>
    )
    const back = (label: string, v: View) => (
      <Box marginTop={1}>
        <Button plain key={`back-${label}`} label={`← ${label}`} onPress={go(v)} />
      </Box>
    )

    if (view.comments) {
      const { Markdown } = $.ui.resolve(e)
      const threads: Thread[] = await read($, threadsAtom)
      const conversation: Comment[] = await read($, conversationAtom)
      const loadedComments: boolean = await read($, commentsLoadedAtom)
      const open = threads.filter(th => !th.isResolved)
      const resolved = threads.filter(th => th.isResolved)
      const byline = (c: Comment) => (
        <Text>
          <Text color={c.author === me ? t.accent : undefined}>{c.author === me ? 'you' : c.author}</Text>
          {c.state && <Text color={c.state === 'APPROVED' ? t.ok : c.state === 'CHANGES_REQUESTED' ? t.fail : t.muted}> · {c.state.toLowerCase().replace(/_/g, ' ')}</Text>}
          <Text color={t.muted}> · {c.when}</Text>
        </Text>
      )
      const where = (th: Thread) => `${th.path}${th.line ? `:${th.line}` : ''}${th.isOutdated ? ' · outdated' : ''}`
      return (
        <Box flexDirection="column">
          {topBar}
          {card}
          {back('checks', {})}
          {!loadedComments && <Text color={t.muted}>Loading comments…</Text>}
          {loadedComments && (
            <Box flexDirection="column">
              {section('Unresolved threads', open.length, open.length ? t.run : t.accent)}
              {open.length === 0 && <Text color={t.ok}>✓ Nothing waiting on you.</Text>}
              {open.map((th, i) => (
                <Box key={`thread-${i}`} flexDirection="column" borderStyle="round" borderColor={t.run} paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text color={t.accent}>{where(th)}</Text>
                    <Box flexDirection="row" columnGap={1}>
                      <Button key={`thread-fix-${i}`} label="✦ Address with Claude" onPress={() => void addressThread($, pr, th)} />
                      <Button key={`thread-open-${i}`} label="↗ Open" onPress={() => void openUrl($, th.url)} />
                    </Box>
                  </Box>
                  {th.comments.map((c, k) => (
                    <Box key={`thread-${i}-c-${k}`} flexDirection="column" marginTop={k ? 1 : 0}>
                      {byline(c)}
                      <Markdown text={c.body || '_(no text)_'} />
                    </Box>
                  ))}
                </Box>
              ))}
              {section('Conversation', conversation.length)}
              {conversation.length === 0 && <Text color={t.muted}>No general comments.</Text>}
              {conversation.map((c, k) => (
                <Box key={`conv-${k}`} flexDirection="column" borderStyle="round" borderColor={t.rule} paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    {byline(c)}
                    {c.url && <Button key={`conv-open-${k}`} plain label="↗" onPress={() => void openUrl($, c.url)} />}
                  </Box>
                  {c.body && <Markdown text={c.body} />}
                </Box>
              ))}
              {section('Resolved threads', resolved.length, t.muted)}
              {resolved.map((th, i) => (
                <Box key={`resolved-${i}`} flexDirection="row">
                  <Text color={t.ok}>✓ </Text>
                  <Button
                    plain
                    dimColor
                    key={`resolved-open-${i}`}
                    label={`${where(th)} · ${th.comments[0]?.author ?? ''}: ${(th.comments[0]?.body ?? '').split('\n')[0]!.slice(0, 80)}`}
                    onPress={() => void openUrl($, th.url)}
                  />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    if (view.job) {
      const j = view.job
      const ji = icon(j.status, j.conclusion)
      return (
        <Box flexDirection="column">
          {topBar}
          {card}
          {back(view.workflow ?? 'workflows', { workflow: view.workflow })}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text color={tone(ji.tone)}>{ji.glyph} {j.name} · {outcome(j)}</Text>
            {j.url && <Button key="open-job" variant="primary" label="↗ Open job" onPress={() => void openUrl($, j.url)} />}
            {isFailed(j) && <Button key="fix-job" variant="primary" label="✦ Fix with Claude" onPress={() => void fixCheck($, pr, j)} />}
          </Box>
          {section('Steps', steps.length || undefined)}
          {steps.length === 0 && <Text color={t.muted}>Loading steps…</Text>}
          {steps.map(st => {
            const i = icon(st.status, st.conclusion)
            return <Text color={i.tone === 'passed' ? undefined : tone(i.tone)}><Text color={tone(i.tone)}>{i.glyph}</Text> {st.name}</Text>
          })}
          {isFailed(j) && (
            <Box flexDirection="column" borderStyle="round" borderColor={t.fail} paddingX={1} marginTop={1}>
              <Text color={t.fail}>Failure log · last {LOG_LINES} lines</Text>
              {failedLog.length === 0 && <Text color={t.muted}>Loading log…</Text>}
              {failedLog.map(l => <Text color={l.startsWith('✗') ? t.fail : t.muted}>{l}</Text>)}
            </Box>
          )}
        </Box>
      )
    }

    if (view.workflow) {
      const jobs = groups.get(view.workflow) ?? []
      return (
        <Box flexDirection="column">
          {topBar}
          {card}
          {back('all workflows', {})}
          <Box marginTop={1}>
            <Text color={t.accent}>{view.workflow}  </Text>
            {bar(count(jobs), jobs.length)}
          </Box>
          {tally(count(jobs))}
          {OUTCOMES.map(o => {
            const these = jobs.filter(c => outcome(c) === o)
            if (!these.length) return null
            return (
              <Box flexDirection="column">
                {section(o, these.length, tone(o))}
                {these.map(c => checkRow(c, `job-${o}-${c.name}`, `${c.name} ›`))}
              </Box>
            )
          })}
        </Box>
      )
    }

    const failedChecks = pr.checks.filter(isFailed)
    return (
      <Box flexDirection="column">
        {topBar}
        {openSection}
        {card}
        <Box marginTop={1} flexDirection="row" gap={1}>
          <Text color={t.accent}>{pr.checksOn === 'pr' ? 'CHECKS' : 'AFTER MERGE'}</Text>
          {bar(counts, total)}
          <Text color={t.muted}>{pr.checksOn === 'waiting' ? 'waiting for runs on the merge commit' : `${done}/${total}`}</Text>
        </Box>
        {tally(counts)}
        {alerts.length > 0 && (
          <Box flexDirection="column">
            {section('Recent activity', alerts.length)}
            {alerts.slice(0, 5).map((a, i) => (
              <Box key={`alert-${i}`} flexDirection="row">
                <Text color={t.muted}>{new Date(a.at).toLocaleTimeString().slice(0, 5)}  </Text>
                {a.url
                  ? <Button plain key={`alert-open-${i}`} label={a.text} onPress={() => void openUrl($, a.url)} />
                  : <Text color={tone(a.tone === 'info' ? 'skipped' : a.tone === 'ok' ? 'passed' : a.tone === 'fail' ? 'failed' : 'running')}>{a.text}</Text>}
              </Box>
            ))}
          </Box>
        )}
        {failedChecks.length > 0 && (
          <Box flexDirection="column">
            {section('Failed', failedChecks.length, t.fail)}
            {failedChecks.map(c => (
              <Box key={`fail-row-${c.workflow}-${c.name}`} flexDirection="row" columnGap={1}>
                {checkRow(c, `fail-${c.workflow}-${c.name}`, `${c.name} · ${c.workflow} ›`)}
                <Button key={`fix-${c.workflow}-${c.name}`} label="✦ Fix with Claude" onPress={() => void fixCheck($, pr, c)} />
                {runIdOf(c) !== '' && (
                  <Button
                    key={`rerun-${c.workflow}-${c.name}`}
                    label={isArmed(armed, `rerun-${runIdOf(c)}`) ? `Press again to re-run ${c.workflow}` : '↻ Re-run'}
                    onPress={() => void confirmThen($, `rerun-${runIdOf(c)}`, () => rerunFailed($, pr, c))}
                  />
                )}
              </Box>
            ))}
          </Box>
        )}
        {section('Workflows', groups.size)}
        {[...groups.entries()].map(([name, cs]) => {
          const n = count(cs)
          const worst: Outcome = n.failed ? 'failed' : n.running ? 'running' : n.passed ? 'passed' : 'skipped'
          return (
            <Box key={`wf-${name}`} flexDirection="row">
              <Text color={tone(worst)}>{GLYPH[worst]} </Text>
              <Button
                plain
                label={`${name} — ${n.passed} passed${n.failed ? `, ${n.failed} failed` : ''}${n.running ? `, ${n.running} running` : ''} ›`}
                onPress={go({ workflow: name })}
              />
            </Box>
          )
        })}
        {total === 0 && <Text color={t.muted}>No checks reported yet.</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HISTORY }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const t = theme
    const repo: string = await read($, repoAtom)
    const mine: PrRow[] = await read($, historyAtom)
    const all: PrRow[] = await read($, teamAtom)
    const line = (p: PrRow, showAuthor: boolean) => (
      <Box key={`${showAuthor ? 'all' : 'mine'}-${p.number}`} flexDirection="row">
        <Text color={t.brand}>⑂ </Text>
        <Text color={t.muted}>{p.when.slice(5)}  </Text>
        <Button plain key={`${showAuthor ? 'all' : 'mine'}-open-${p.number}`} label={`#${p.number} ${p.title}`} onPress={() => void openUrl($, p.url)} />
        {showAuthor && <Text color={p.author === me ? t.accent : t.muted}> · {p.author === me ? 'you' : p.author}</Text>}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {paneBar(ui, $, 'PR HISTORY', repo)}
        {heading(ui, `Your PRs merged · last ${HISTORY_DAYS} days`, mine.length)}
        {mine.length === 0 && <Text color={t.muted}>None merged.</Text>}
        {mine.map(p => line(p, false))}
        {heading(ui, `All PRs merged · last ${HISTORY_DAYS} days`, all.length)}
        {all.length === 0 && <Text color={t.muted}>None merged.</Text>}
        {all.map(p => line(p, true))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: REVIEWS }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const t = theme
    const repo: string = await read($, repoAtom)
    const reviews: ReviewRow[] = await read($, reviewsAtom)
    const direct = reviews.filter(r => r.direct)
    const team = reviews.filter(r => !r.direct)
    const line = (r: ReviewRow) => (
      <Box key={`review-${r.number}`} flexDirection="row">
        <Text color={r.direct ? t.run : t.brand}>● </Text>
        <Button plain key={`review-open-${r.number}`} label={`#${r.number} ${r.title}`} onPress={() => void openUrl($, r.url)} />
        <Text color={t.muted}> · {r.author}{r.isDraft ? ' · draft' : ''}{!r.direct && r.teams.length ? ` · ${r.teams.join(', ')}` : ''} · {r.when.slice(5)}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {paneBar(ui, $, 'PR REVIEWS', repo)}
        {heading(ui, 'Waiting on you', direct.length, direct.length ? t.run : t.accent)}
        {direct.length === 0 && <Text color={t.muted}>Nothing requested from you directly.</Text>}
        {direct.map(line)}
        {heading(ui, 'Waiting on your team', team.length)}
        {team.length === 0 && <Text color={t.muted}>Nothing requested from your teams.</Text>}
        {team.map(line)}
      </Box>
    )
  })
}
