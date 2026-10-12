import { describe, expect, mock, test as kitTest } from 'claude-code/testing'

// a drawing left mounted redraws after its test ends and trips the kit's leak check; unmount every one
const mounted: { unmount: () => Promise<void> }[] = []

// the plugin's whole reach on the machine: these programs, and only https links opened
const ALLOWED_PROGRAMS = new Set(['gh', 'git', 'uname', 'open', 'xdg-open'])
const violations: string[] = []
const mount = async ($: any, target: any) => {
  const m = await $.ui.mount(target)
  mounted.push(m)
  return m
}
type Body = ($: any, on: any) => Promise<void>
const test = (name: string, a: Body | { options: Record<string, boolean> }, b?: Body) => {
  const [opts, body] = typeof a === 'function' ? [undefined, a] : [a, b!]
  const run = async ($: any, on: any) => {
    violations.length = 0
    on('clock.now', async () => ({ value: Date.now() }) as any)
    try {
      await body($, on)
    } finally {
      for (const m of mounted.splice(0)) await m.unmount().catch(() => undefined)
    }
    expect(violations).toEqual([])
  }
  return opts ? kitTest(name, opts, run) : kitTest(name, run)
}

const REPO = 'acme/widgets'
const row = (number: number, title: string) => ({
  number, title, url: `https://github.com/${REPO}/pull/${number}`, state: 'OPEN', isDraft: true,
  mergedAt: null, closedAt: null, updatedAt: '2026-10-05T18:37:23Z',
})

const job = (name: string, status: string, conclusion: string, id: number) => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion,
  detailsUrl: `https://github.com/${REPO}/actions/runs/1/job/${id}`,
})
const CHECKS = [
  job('lint', 'COMPLETED', 'FAILURE', 2),
  job('validate', 'COMPLETED', 'SUCCESS', 3),
  job('plan', 'IN_PROGRESS', '', 4),
]

const graphqlCalls: string[] = []
const opened: string[] = []
const filled: string[] = []
const toasts: string[] = []
const paneLog: string[] = []
const branchUpdates: string[] = []
let localBranch = 'main'

// what GitHub reports; a test mutates it between refreshes to raise alerts
const world = {
  mergeChecks: null as any[] | null,
  mergedAt: '2026-10-05T10:00:00Z',
  checks: CHECKS as any[],
  latestReviews: [] as { author: { login: string }; state: string }[],
  commentTotal: 1,
  lastCommenter: 'github-actions',
  mergeState: 'BLOCKED',
  prState: 'OPEN',
  queue: [] as any[],
  isDraft: true,
  review: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE',
  required: ['lint'] as string[],
  behind: 2,
  unresolved: 0,
}
const resetWorld = () => {
  world.checks = CHECKS
  world.mergeChecks = null
  world.mergedAt = '2026-10-05T10:00:00Z'
  world.latestReviews = []
  world.commentTotal = 1
  world.lastCommenter = 'github-actions'
  world.mergeState = 'BLOCKED'
  world.prState = 'OPEN'
  world.isDraft = true
  world.review = 'REVIEW_REQUIRED'
  world.mergeable = 'MERGEABLE'
  world.required = ['lint']
  world.behind = 2
  world.unresolved = 0
  world.queue = [
    { ...row(897, 'needs my eyes'), author: { login: 'alice' }, reviewRequests: [{ login: 'me' }] },
    { ...row(895, 'needs team'), author: { login: 'bob' }, reviewRequests: [{ slug: 'acme/team-platform' }, { login: 'other' }] },
  ]
  opened.length = 0
  graphqlCalls.length = 0
  filled.length = 0
  toasts.length = 0
  paneLog.length = 0
  branchUpdates.length = 0
  localBranch = 'main'
}

resetWorld()

const stub = (on: any) => {
  resetWorld()
  on('process.run', async (_$: any, e: any) => ({ value: fakeGh(e.argv) }))
  on('ui.open', async (_$: any, e: any) => {
    paneLog.push(`open ${e.id}${e.focus ? ' (focus)' : ''}`)
    return { value: {} }
  })
  on('ui.close', async (_$: any, e: any) => {
    paneLog.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('clock.every', async () => ({ value: undefined }))
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', async (_$: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true }
  })
}

const ui_props = async (ui: any, key: string) => {
  const walk = (n: any): any =>
    n && typeof n === 'object' ? (n.props?.key === key ? n.props : (n.children ?? []).map(walk).find(Boolean)) : undefined
  return walk(await ui.drawn())
}

const fakeGh = (argv: readonly string[]) => {
  const a = argv.join(' ')
  if (!ALLOWED_PROGRAMS.has(argv[0]!)) violations.push(`ran ${argv[0]}`)
  if ((argv[0] === 'open' || argv[0] === 'xdg-open') && !/^https:\/\//.test(argv[1] ?? '')) violations.push(`opened ${argv[1]}`)
  const ok = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v), stderr: '' })
  if (argv[0] === 'uname') return { exitCode: 0, stdout: 'Darwin\n', stderr: '' }
  if (argv[0] === 'open') { opened.push(argv[1]!); return { exitCode: 0, stdout: '', stderr: '' } }
  if (argv[0] === 'git' && argv.includes('--abbrev-ref')) return { exitCode: 0, stdout: `${localBranch}\n`, stderr: '' }
  if (argv[0] === 'git') return { exitCode: 0, stdout: '/repo\n', stderr: '' }
  if (a.startsWith('gh repo view')) return ok({ nameWithOwner: REPO })
  if (a === 'gh api user') return ok({ login: 'me' })
  if (a.startsWith('gh pr list')) return ok([])
  if (a.startsWith('gh pr view')) return ok({ url: row(899, '').url })
  if (a.startsWith('gh pr update-branch')) {
    branchUpdates.push(a)
    if (world.mergeable === 'CONFLICTING') return { exitCode: 1, stdout: '', stderr: 'merge conflict between base and head\n' }
    world.behind = 0
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  if (a.startsWith('gh api repos/') && a.includes('/compare/')) return ok({ behind_by: world.behind })
  if (a.startsWith('gh api graphql') && (a.includes('mergeStateStatus') || a.includes('open:search(query:$q'))) {
    graphqlCalls.push(a)
    const withRollup = (checks: any[]) => ({
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks.map(c => ({
        ...c, checkSuite: { workflowRun: { workflow: { name: c.workflowName } } }, isRequired: world.required.includes(c.name),
      })) } } } }] },
    })
    const listed = (r: any, extra: object) => ({ ...r, author: { login: 'me' }, ...extra })
    const detail = () => ({
      mergedAt: world.mergedAt,
      mergeCommit: world.prState === 'MERGED' ? { statusCheckRollup: world.mergeChecks ? { contexts: { nodes: world.mergeChecks.map(c => ({ ...c, checkSuite: { workflowRun: { workflow: { name: c.workflowName } } } })) } } : null } : null,
      title: 'test 2', url: row(899, '').url, state: world.prState, isDraft: world.isDraft, reviewDecision: world.review, mergeable: world.mergeable,
      mergeStateStatus: world.mergeState, baseRefName: 'main', headRefName: 'feature/widget-sizes',
      latestReviews: { nodes: world.latestReviews },
      ...withRollup(world.checks),
      reviewThreads: { nodes: Array.from({ length: world.unresolved }, () => ({ isResolved: false, comments: { totalCount: 1, nodes: [] } })) },
      comments: { totalCount: world.commentTotal, nodes: [{ author: { login: world.lastCommenter }, createdAt: '2026-10-05T19:00:00Z' }] },
    })
    const data: any = {}
    if (a.includes('pullRequest(number:$num)')) data.repository = { pullRequest: detail() }
    if (a.includes('merged:search')) {
      data.merged = { nodes: [
        { ...row(890, 'mine merged'), state: 'MERGED', author: { login: 'me' }, mergedAt: '2026-10-04T10:00:00Z' },
        { ...row(891, 'theirs merged'), state: 'MERGED', author: { login: 'someone' }, mergedAt: '2026-10-05T10:00:00Z' },
      ] }
    }
    if (a.includes('queue:search')) {
      data.queue = { nodes: world.queue.map((r: any) => ({
        ...r,
        reviewRequests: { nodes: r.reviewRequests.map((q: any) => ({
          requestedReviewer: q.login ? { __typename: 'User', login: q.login } : { __typename: 'Team', slug: q.slug, name: q.slug },
        })) },
      })) }
    }
    if (a.includes('open:search(query:$q')) {
      data.open = { nodes: [
        listed(row(899, 'test 2'), { reviewDecision: 'REVIEW_REQUIRED', ...withRollup([CHECKS[0], CHECKS[1]]) }),
        listed(row(898, 'test 1'), { isDraft: false, reviewDecision: 'APPROVED', ...withRollup([CHECKS[1]]) }),
      ] }
    }
    return ok({ data })
  }
  if (a.includes('--log-failed')) {
    return { exitCode: 0, stdout: 'lint\tRun tflint\t2026-10-05T18:35:40.1Z Error: unknown attribute "foo"\n', stderr: '' }
  }
  if (a.startsWith('gh run view')) {
    return ok({ jobs: [{ databaseId: 2, steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Run tflint', status: 'completed', conclusion: 'failure' },
    ] }] })
  }
  if (a.startsWith('gh api graphql') && a.includes('comments(last')) {
    const c = (login: string, body: string) => ({ author: { login }, body, createdAt: '2026-10-05T18:40:00Z', url: `https://github.com/${REPO}/pull/899#c` })
    return ok({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [
        { isResolved: false, isOutdated: false, path: 'main.tf', line: 12, comments: { nodes: [c('reviewer', 'Use a variable here'), c('me', 'Done')] } },
        { isResolved: true, isOutdated: true, path: 'vars.tf', line: 3, comments: { nodes: [c('reviewer', 'Typo in description')] } },
      ] },
      comments: { nodes: [c('github-actions', '## Wrong format of the pull request title!')] },
      reviews: { nodes: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-10-05T18:41:00Z', url: '' }] },
    } } } })
  }
  if (a.startsWith('gh api graphql')) return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })
  return { exitCode: 1, stdout: '', stderr: `unexpected: ${a}` }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`lists every open PR (${surface})`, async ($, on) => {
    on('process.run', async (_$, e) => ({ value: fakeGh(e.argv) }) as any)
    const closed: string[] = []
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.close', async (_$, e) => {
      closed.push(e.id)
      return { value: undefined } as any
    })
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    on('clock.every', async () => ({ value: undefined }) as any)

    const res = await $.command.run({ command: 'pulse', args: '' } as any)
    expect(res?.text).toBe('Watching your latest PR.')

    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /#898/ })).toBeDefined()
    expect(await ui.find({ text: /#899/ })).toBeDefined()

    const again = await $.command.run({ command: 'pulse', args: '' } as any)
    expect(again?.text).toMatch(/^Already watching/)

    expect((await ui.find({ key: 'close' }))?.text).toBe('✕ Close')
    await ui.press({ key: 'close' })
    expect(closed).toEqual(['pr-pulse-reviews', 'pr-pulse-history', 'pr-pulse'])
    const reopened = await $.command.run({ command: 'pulse', args: '' } as any)
    expect(reopened?.text).toBe('Watching your latest PR.')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`drills into a failed check (${surface})`, async ($, on) => {
    on('process.run', async (_$, e) => ({ value: fakeGh(e.argv) }) as any)
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.close', async () => ({ value: undefined }) as any)
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    on('clock.every', async () => ({ value: undefined }) as any)

    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ text: '1 failed' })).toBeDefined()
    expect(await ui.find({ text: '1 passed' })).toBeDefined()
    expect(await ui.find({ text: '1 running' })).toBeDefined()

    await ui.press({ key: 'lint · CI ›' })
    expect(await ui.find({ text: /lint · failed/ })).toBeDefined()
    expect(await ui.find({ text: 'Run tflint' })).toBeDefined()
    expect(await ui.find({ text: 'Error: unknown attribute "foo"' })).toBeDefined()

    await ui.press({ key: 'back-CI' })
    expect(await ui.find({ text: 'FAILED · 1' })).toBeDefined()
    expect(await ui.find({ text: 'PASSED · 1' })).toBeDefined()
    expect(await ui.find({ text: 'RUNNING · 1' })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`history splits my merges from everyone's (${surface})`, async ($, on) => {
    on('process.run', async (_$, e) => ({ value: fakeGh(e.argv) }) as any)
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    on('clock.every', async () => ({ value: undefined }) as any)

    await $.command.run({ command: 'pulse', args: '' } as any)
    const pane = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'refresh' })
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse-history' })

    expect(await ui.find({ text: /YOUR PRS MERGED .* · 1$/ })).toBeDefined()
    expect(await ui.find({ text: /ALL PRS MERGED .* · 2$/ })).toBeDefined()
    expect(await ui.find({ text: /#891 theirs merged/ })).toBeDefined()
    expect(await ui.find({ text: /· someone/ })).toBeDefined()
    expect(await ui.find({ text: /· you/ })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`reviews split direct requests from team ones (${surface})`, async ($, on) => {
    on('process.run', async (_$, e) => ({ value: fakeGh(e.argv) }) as any)
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    on('clock.every', async () => ({ value: undefined }) as any)

    await $.command.run({ command: 'pulse', args: '' } as any)
    const pane = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'refresh' })
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse-reviews' })

    expect(await ui.find({ text: /WAITING ON YOU · 1/ })).toBeDefined()
    expect(await ui.find({ text: /WAITING ON YOUR TEAM · 1/ })).toBeDefined()
    expect(await ui.find({ text: /#897 needs my eyes/ })).toBeDefined()
    expect(await ui.find({ text: /team-platform/ })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`buttons open the PR in the browser (${surface})`, async ($, on) => {
    on('process.run', async (_$, e) => ({ value: fakeGh(e.argv) }) as any)
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    on('ui.toast', async () => ({ value: undefined }) as any)
    on('clock.every', async () => ({ value: undefined }) as any)
    opened.length = 0

    await $.command.run({ command: 'pulse', args: '' } as any)
    const pane = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'refresh' })
    expect((await ui_props(pane, 'open-pr'))?.variant).toBe('primary')
    await pane.press({ key: 'open-pr' })
    expect(opened).toEqual(['https://github.com/acme/widgets/pull/899'])

    const reviews = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse-reviews' })
    await reviews.press({ key: 'review-open-897' })
    expect(opened[1]).toBe('https://github.com/acme/widgets/pull/897')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`drills into review comments (${surface})`, async ($, on) => {
    on('process.run', async (_$, e) => ({ value: fakeGh(e.argv) }) as any)
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    on('clock.every', async () => ({ value: undefined }) as any)

    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'comments' })

    expect(await ui.find({ text: 'UNRESOLVED THREADS · 1' })).toBeDefined()
    expect(await ui.find({ text: 'main.tf:12' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: 'Use a variable here' })).toBeDefined()
    expect(await ui.find({ text: 'CONVERSATION · 2' })).toBeDefined()
    expect(await ui.find({ text: /changes requested/ })).toBeDefined()
    expect(await ui.find({ text: 'RESOLVED THREADS · 1' })).toBeDefined()
    expect(await ui.find({ text: /vars\.tf:3 · outdated · reviewer: Typo/ })).toBeDefined()

    await ui.press({ key: 'back-checks' })
    expect(await ui.find({ text: 'CHECKS' })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows why the PR cannot merge yet (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /✗ BLOCKED · 3/ })).toBeDefined()
    expect(await ui.find({ text: '✗ draft' })).toBeDefined()
    expect(await ui.find({ text: '✗ 1 required check failing' })).toBeDefined()
    expect(await ui.find({ text: '✗ needs approval' })).toBeDefined()
    expect(await ui.find({ text: '◐ 2 commits behind main' })).toBeDefined()
  })

  test(`alerts when checks, reviews and comments change (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    expect(toasts.filter(x => !x.startsWith('Draft'))).toEqual([])

    world.checks = [CHECKS[0], CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    world.latestReviews = [{ author: { login: 'alice' }, state: 'APPROVED' }]
    world.commentTotal = 3
    world.lastCommenter = 'alice'
    await ui.press({ key: 'refresh' })

    expect(toasts).toContain('✗ plan failed on #899')
    expect(toasts).toContain('✅ #899 approved by alice')
    expect(toasts).toContain('💬 2 new comments on #899 from alice')
    expect(await ui.find({ text: 'RECENT ACTIVITY · 3' })).toBeDefined()
  })

  test(`drafts a fix prompt for a failed check (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'fix-CI-lint' })
    expect(filled).toHaveLength(1)
    expect(filled[0]).toContain('The "lint" check (CI) failed on PR #899')
    expect(filled[0]).toContain('Error: unknown attribute "foo"')
    expect(toasts).toContain('Draft added to your prompt: review it, then press Enter')
  })

  test(`drafts a prompt to address a review thread (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'comments' })
    await ui.press({ key: 'thread-fix-0' })
    expect(filled[0]).toContain('`main.tf:12`')
    expect(filled[0]).toContain('> **reviewer**: Use a variable here')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`updates a stale branch on github (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'update-rebase' })
    expect(branchUpdates).toEqual([])
    expect((await ui_props(ui, 'update-rebase'))?.label).toBe('Press again to rebase #899 on main')
    await ui.press({ key: 'update-rebase' })
    expect(branchUpdates).toEqual([`gh pr update-branch 899 -R ${REPO} --rebase`])
    expect(toasts).toContain('Rebased #899 on main')
    expect(await ui.find({ text: '✓ up to date with main' })).toBeDefined()
    expect(await ui.find({ text: '✦ Rebase with Claude' })).toBeUndefined()
  })

  test(`merges the base in without rebasing (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'update-merge' })
    await ui.press({ key: 'update-merge' })
    expect(branchUpdates).toEqual([`gh pr update-branch 899 -R ${REPO}`])
    expect(toasts).toContain('Merged main into #899')
  })

  test(`one press only arms; pressing the other button re-arms instead of running (${surface})`, async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'update-merge' })
    await ui.press({ key: 'update-rebase' })
    expect(branchUpdates).toEqual([])
    expect((await ui_props(ui, 'update-merge'))?.label).toBe('⇣ Merge main in')
    expect((await ui_props(ui, 'update-rebase'))?.label).toBe('Press again to rebase #899 on main')
  })

  test(`tells you to pull when your checkout is on the updated branch (${surface})`, async ($, on) => {
    stub(on)
    localBranch = 'feature/widget-sizes'
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'update-rebase' })
    await ui.press({ key: 'update-rebase' })
    expect(toasts).toContain('Rebased #899 on main: your checkout is on feature/widget-sizes, run `git pull --rebase` before pushing again')
  })

  test(`conflicts leave only the rebase with Claude (${surface})`, async ($, on) => {
    stub(on)
    world.mergeable = 'CONFLICTING'
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    expect(await ui_props(ui, 'update-rebase')).toBeUndefined()
    expect(await ui_props(ui, 'update-merge')).toBeUndefined()
    await ui.press({ key: 'rebase-claude' })
    expect(branchUpdates).toEqual([])
    expect(filled[0]).toContain('is 2 commits behind `main` and has merge conflicts')
    expect(filled[0]).toContain('Rebase `feature/widget-sizes` onto the latest `origin/main`')
    expect(filled[0]).toContain('ask before you push with `--force-with-lease`')
  })

  test(`an up-to-date branch shows no branch actions (${surface})`, async ($, on) => {
    stub(on)
    world.behind = 0
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    expect(await ui_props(ui, 'rebase-claude')).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a re-run that passes supersedes the old failure (${surface})`, async ($, on) => {
    stub(on)
    world.checks = [
      { ...CHECKS[0], startedAt: '2026-10-05T18:47:30Z' },
      { ...CHECKS[0], conclusion: 'SUCCESS', startedAt: '2026-10-05T19:35:53Z' },
      { ...CHECKS[1], startedAt: '2026-10-05T18:47:31Z' },
    ]
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /FAILED · / })).toBeUndefined()
    expect(await ui.find({ text: '✓ 2 passed   ' })).toBeDefined()
    expect(await ui.find({ text: '✓ required checks passed' })).toBeDefined()
  })
}

describe('change alerts', () => {
  // first poll records, every later poll compares; `poll` is one refresh as the 15s timer would run it
  const watch = async ($: any) => {
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    const poll = async () => {
      toasts.length = 0
      await ui.press({ key: 'refresh' })
      return [...toasts]
    }
    await poll()
    return { ui, poll }
  }

  test('the first poll after starting stays quiet', async ($, on) => {
    stub(on)
    await watch($)
    expect(toasts).toEqual([])
  })

  test('a check that keeps failing alerts once', async ($, on) => {
    stub(on)
    const { poll } = await watch($)
    world.checks = [CHECKS[0], CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    expect(await poll()).toEqual(['✗ plan failed on #899'])
    expect(await poll()).toEqual([])
  })

  test('all checks finishing green', async ($, on) => {
    stub(on)
    world.checks = [CHECKS[1], CHECKS[2]]
    const { poll } = await watch($)
    world.checks = [CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'SUCCESS' }]
    expect(await poll()).toEqual(['✓ All checks passed on #899'])
  })

  test('reviews: changes requested and plain comments', async ($, on) => {
    stub(on)
    const { poll } = await watch($)
    world.latestReviews = [{ author: { login: 'alice' }, state: 'CHANGES_REQUESTED' }, { author: { login: 'bob' }, state: 'COMMENTED' }]
    expect(await poll()).toEqual(['✋ alice requested changes on #899', '💬 bob reviewed #899'])
    world.latestReviews = [{ author: { login: 'alice' }, state: 'APPROVED' }, { author: { login: 'bob' }, state: 'COMMENTED' }]
    expect(await poll()).toEqual(['✅ #899 approved by alice'])
  })

  test('your own reviews and comments stay quiet', async ($, on) => {
    stub(on)
    const { poll } = await watch($)
    world.latestReviews = [{ author: { login: 'me' }, state: 'COMMENTED' }]
    world.commentTotal = 2
    world.lastCommenter = 'me'
    expect(await poll()).toEqual([])
  })

  test('ready to merge, then merged', async ($, on) => {
    stub(on)
    const { poll } = await watch($)
    world.mergeState = 'CLEAN'
    expect(await poll()).toEqual(['● #899 is ready to merge'])
    world.prState = 'MERGED'
    expect(await poll()).toEqual(['⑂ #899 merged'])
  })

  test('a merge to the base leaves the branch behind, then conflicting', async ($, on) => {
    stub(on)
    world.behind = 0
    const { poll } = await watch($)
    world.behind = 3
    expect(await poll()).toEqual(['⇣ #899 is 3 commits behind main'])
    expect(await poll()).toEqual([])
    world.mergeable = 'CONFLICTING'
    expect(await poll()).toEqual(['✗ #899 has merge conflicts with main'])
  })

  test('closed without merging', async ($, on) => {
    stub(on)
    const { poll } = await watch($)
    world.prState = 'CLOSED'
    expect(await poll()).toEqual(['⊘ #899 closed'])
  })

  test('a queued re-run does not resurrect an old failure', async ($, on) => {
    stub(on)
    world.checks = [
      { ...CHECKS[0], startedAt: '2026-10-05T18:47:30Z' },
      { ...CHECKS[0], conclusion: 'SUCCESS', startedAt: '2026-10-05T19:35:53Z' },
    ]
    const { poll } = await watch($)
    world.checks = [
      { ...CHECKS[0], startedAt: '2026-10-05T18:47:30Z' },
      { ...CHECKS[0], status: 'QUEUED', conclusion: '', startedAt: '0001-01-01T00:00:00Z' },
    ]
    expect(await poll()).toEqual([])
    world.checks = [
      { ...CHECKS[0], startedAt: '2026-10-05T18:47:30Z' },
      { ...CHECKS[0], conclusion: 'SUCCESS', startedAt: '2026-10-05T20:55:00Z' },
    ]
    expect(await poll()).toEqual(['✓ All checks passed on #899'])
  })

  test('runs cancelled before they start are not a pass', async ($, on) => {
    stub(on)
    world.checks = [{ ...CHECKS[1], status: 'QUEUED', conclusion: '' }, { ...CHECKS[2], status: 'QUEUED', conclusion: '' }]
    const { ui, poll } = await watch($)
    world.checks = [{ ...CHECKS[1], conclusion: 'CANCELLED' }, { ...CHECKS[2], status: 'COMPLETED', conclusion: 'CANCELLED' }]
    expect(await poll()).toEqual(['⊘ validate cancelled on #899', '⊘ plan cancelled on #899'])
    expect(await ui.find({ text: /FAILED · 2/ })).toBeDefined()
  })

  test('a new PR in your review queue', async ($, on) => {
    stub(on)
    const { ui, poll } = await watch($)
    world.queue = [...world.queue, { ...row(900, 'fresh one'), author: { login: 'carol' }, reviewRequests: [{ login: 'me' }] }]
    expect(await poll()).toEqual(['👀 Review requested from you: #900 fresh one (carol)'])
    expect(await ui.find({ text: /RECENT ACTIVITY · 1/ })).toBeDefined()
    expect(await ui.find({ key: 'alert-open-0' })).toBeDefined()
  })
})

describe('collapsed band', () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } as any

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`minimise swaps the panes for a one-line summary (${surface})`, async ($, on) => {
      stub(on)
      await $.command.run({ command: 'pulse', args: '' } as any)
      const pane = await mount($, { plugin: 'pr-pulse', surface, component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
      await pane.press({ key: 'refresh' })
      paneLog.length = 0
      await pane.press({ key: 'minimise' })
      expect(paneLog).toEqual(['close pr-pulse-reviews', 'close pr-pulse-history', 'close pr-pulse'])

      const band = await mount($, { plugin: 'pr-pulse', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.find({ text: '#899' })).toBeDefined()
      expect(await band.find({ text: ' 1 failing' })).toBeDefined()
      expect(await band.find({ text: '#898' })).toBeDefined()
      expect(await band.find({ text: ' ready' })).toBeDefined()
      expect(await band.find({ text: /👀 2 to review/ })).toBeDefined()

      paneLog.length = 0
      await band.press({ key: 'chip-open-898' })
      expect(paneLog).toEqual(['open pr-pulse-history', 'open pr-pulse-reviews', 'open pr-pulse (focus)'])
      expect(await pane.find({ text: /▸ / })).toBeDefined()
    })
  }

  test('the band stays out of the way unless collapsed', async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    let threw = false
    try {
      await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('/pulse while already watching brings closed panes back', async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    paneLog.length = 0
    const res = await $.command.run({ command: 'pulse', args: '' } as any)
    expect(res?.text).toMatch(/^Already watching/)
    expect(paneLog).toEqual(['open pr-pulse-history', 'open pr-pulse-reviews', 'open pr-pulse (focus)'])
  })

  test('/pulse while collapsed expands', async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'minimise' })
    const res = await $.command.run({ command: 'pulse', args: '' } as any)
    expect(res?.text).toBe('Expanded PR Pulse.')
  })

  test('alerts keep coming while collapsed and show on the band', async ($, on) => {
    stub(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'minimise' })
    const band = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    world.checks = [CHECKS[0], CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    toasts.length = 0
    await band.press({ key: 'expand' })
    await pane.press({ key: 'minimise' })
    await pane.press({ key: 'refresh' }).catch(() => undefined)
    expect(toasts).toContain('✗ plan failed on #899')
  })
})

describe('merge readiness', () => {
  const card = async ($: any) => {
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    return ui
  }
  const allGreen = () => {
    world.checks = [CHECKS[1], { ...CHECKS[0], conclusion: 'SUCCESS' }]
    world.isDraft = false
    world.review = 'APPROVED'
    world.behind = 0
    world.mergeState = 'CLEAN'
  }

  test('everything green reads ready to merge', async ($, on) => {
    stub(on)
    allGreen()
    const ui = await card($)
    expect(await ui.find({ text: ' ✓ READY TO MERGE ' })).toBeDefined()
    for (const label of ['✓ ready for review', '✓ required checks passed', '✓ approved', '✓ threads resolved', '✓ no conflicts', '✓ up to date with main']) {
      expect(await ui.find({ text: label })).toBeDefined()
    }
  })

  test('only a required check still running reads waiting on checks', async ($, on) => {
    stub(on)
    allGreen()
    world.mergeState = 'BLOCKED'
    world.checks = [CHECKS[1], { ...CHECKS[0], status: 'IN_PROGRESS', conclusion: '' }]
    const ui = await card($)
    expect(await ui.find({ text: ' ◐ WAITING ON CHECKS ' })).toBeDefined()
    expect(await ui.find({ text: '◐ 1 required check running' })).toBeDefined()
  })

  test('a failing non-required check does not block', async ($, on) => {
    stub(on)
    allGreen()
    world.mergeState = 'UNSTABLE'
    world.checks = [{ ...CHECKS[0], conclusion: 'SUCCESS' }, { ...CHECKS[1], conclusion: 'FAILURE' }]
    const ui = await card($)
    expect(await ui.find({ text: ' ✓ READY TO MERGE ' })).toBeDefined()
  })

  test('with no required checks configured, every check counts', async ($, on) => {
    stub(on)
    allGreen()
    world.mergeState = 'UNSTABLE'
    world.required = []
    world.checks = [{ ...CHECKS[0], conclusion: 'SUCCESS' }, { ...CHECKS[1], conclusion: 'FAILURE' }]
    const ui = await card($)
    expect(await ui.find({ text: '✗ 1 check failing' })).toBeDefined()
    expect(await ui.find({ text: ' ✗ BLOCKED · 1 ' })).toBeDefined()
  })

  test('changes requested, conflicts and an open thread each block', async ($, on) => {
    stub(on)
    allGreen()
    world.mergeState = 'DIRTY'
    world.review = 'CHANGES_REQUESTED'
    world.mergeable = 'CONFLICTING'
    world.unresolved = 1
    const ui = await card($)
    expect(await ui.find({ text: ' ✗ BLOCKED · 3 ' })).toBeDefined()
    expect(await ui.find({ text: '✗ changes requested' })).toBeDefined()
    expect(await ui.find({ text: '✗ merge conflicts' })).toBeDefined()
    expect(await ui.find({ text: '✗ 1 unresolved thread' })).toBeDefined()
  })

  test('being behind main warns without blocking', async ($, on) => {
    stub(on)
    allGreen()
    world.behind = 3
    const ui = await card($)
    expect(await ui.find({ text: '◐ 3 commits behind main' })).toBeDefined()
    expect(await ui.find({ text: ' ✓ READY TO MERGE ' })).toBeDefined()
  })

  test('behind main blocks when a branch rule requires up-to-date branches', async ($, on) => {
    stub(on)
    allGreen()
    world.behind = 3
    world.mergeState = 'BEHIND'
    const ui = await card($)
    expect(await ui.find({ text: '✗ 3 commits behind main' })).toBeDefined()
    expect(await ui.find({ text: ' ✗ BLOCKED · 1 ' })).toBeDefined()
  })

  test('github blocking for a reason the checklist cannot see is not called ready', async ($, on) => {
    stub(on)
    allGreen()
    world.mergeState = 'BLOCKED'
    const ui = await card($)
    expect(await ui.find({ text: ' ✗ BLOCKED · 1 ' })).toBeDefined()
    expect(await ui.find({ text: '✗ blocked by a branch rule' })).toBeDefined()
  })

  test('the review state reads naturally', async ($, on) => {
    stub(on)
    const ui = await card($)
    expect(await ui.find({ text: '● review required' })).toBeDefined()
  })

  test('a repo with no review rule needs no approval', async ($, on) => {
    stub(on)
    allGreen()
    world.review = ''
    const ui = await card($)
    expect(await ui.find({ text: '✓ no review required' })).toBeDefined()
  })

  test('merged and closed PRs say so instead of a checklist verdict', async ($, on) => {
    stub(on)
    world.prState = 'MERGED'
    let ui = await card($)
    expect(await ui.find({ text: ' ⑂ MERGED ' })).toBeDefined()
    world.prState = 'CLOSED'
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: ' ⊘ CLOSED ' })).toBeDefined()
  })

  test('today\'s #899: draft and needs approval', async ($, on) => {
    stub(on)
    world.checks = [{ ...CHECKS[0], conclusion: 'SUCCESS' }]
    world.behind = 0
    const ui = await card($)
    expect(await ui.find({ text: ' ✗ BLOCKED · 2 ' })).toBeDefined()
    expect(await ui.find({ text: '✗ draft' })).toBeDefined()
    expect(await ui.find({ text: '✗ needs approval' })).toBeDefined()
  })
})

describe('after merge', () => {
  const card = async ($: any) => {
    await $.command.run({ command: 'pulse', args: '' } as any)
    const ui = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await ui.press({ key: 'refresh' })
    return ui
  }
  const apply = (conclusion: string) => job('apply', 'COMPLETED', conclusion, 9)

  test('a merged PR shows the runs on its merge commit', async ($, on) => {
    stub(on)
    world.prState = 'MERGED'
    world.mergeChecks = [apply('FAILURE')]
    const ui = await card($)
    expect(await ui.find({ text: 'AFTER MERGE' })).toBeDefined()
    expect(await ui.find({ text: '1 failed' })).toBeDefined()
    expect(await ui.find({ text: 'apply · CI ›' })).toBeDefined()
  })

  test('says it is waiting while the merge commit has no runs yet', async ($, on) => {
    stub(on)
    world.prState = 'MERGED'
    world.mergedAt = new Date().toISOString()
    const ui = await card($)
    expect(await ui.find({ text: 'waiting for runs on the merge commit' })).toBeDefined()
  })

  test('falls back to the PR checks when the repo runs nothing after merge', async ($, on) => {
    stub(on)
    world.prState = 'MERGED'
    const ui = await card($)
    expect(await ui.find({ text: 'CHECKS' })).toBeDefined()
    expect(await ui.find({ text: '1 failed' })).toBeDefined()
  })
})

test('the capability guard catches a program outside the allowlist', async () => {
  fakeGh(['curl', 'https://example.com'])
  fakeGh(['open', 'file:///etc/passwd'])
  expect(violations).toEqual(['ran curl', 'opened file:///etc/passwd'])
  violations.length = 0
})

describe('CI-aware agent', () => {
  // the engine beneath the plugin: what Claude's Bash call returned, and the prompt as it reached the model
  const agent = (on: any, stdout = '') => {
    const seen: { context?: readonly string[] }[] = []
    on('tool.call', async (_$: any, e: any) =>
      e.command.startsWith('false')
        ? { result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }
        : { result: { stdout, stderr: '', interrupted: false } },
    )
    on('prompt.submit', async (_$: any, e: any) => {
      seen.push({ context: e.context })
      return { text: e.text, context: e.context }
    })
    return seen
  }
  const claudeRuns = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })

  test('follows the PR Claude opens, starting as the band', async ($, on) => {
    stub(on)
    agent(on, 'https://github.com/acme/widgets/pull/898\n')
    await claudeRuns($, 'gh pr create --fill')
    expect(toasts).toContain('PR Pulse is following #898, which Claude just opened')
    const band = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } })
    expect(await band.find({ text: '#898' })).toBeDefined()
  })

  test('follows the PR for the branch Claude pushes', async ($, on) => {
    stub(on)
    agent(on, '')
    await claudeRuns($, 'git push -u origin HEAD')
    expect(toasts).toContain('PR Pulse is following #899, which Claude just pushed to')
  })

  test('ignores failed commands and unrelated ones', async ($, on) => {
    stub(on)
    agent(on, 'https://github.com/acme/widgets/pull/898\n')
    await claudeRuns($, 'false && gh pr create')
    await claudeRuns($, 'echo https://github.com/acme/widgets/pull/898')
    expect(toasts).toEqual([])
  })

  test('a CI failure on a followed PR reaches Claude once, with the log', async ($, on) => {
    stub(on)
    const seen = agent(on, 'https://github.com/acme/widgets/pull/899\n')
    await claudeRuns($, 'gh pr create --fill')
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    world.checks = [CHECKS[0], CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    await pane.press({ key: 'refresh' })
    expect(toasts).toContain('✦ Will tell Claude at your next prompt: plan failed on #899')

    await $.prompt.submit({ text: 'what next?' })
    await $.prompt.submit({ text: 'and now?' })
    const note = (seen[0]!.context ?? []).join('\n')
    expect(note).toContain('the "plan" check (CI) failed on PR #899')
    expect(note).toContain('Error: unknown attribute "foo"')
    expect(seen[1]!.context ?? []).toEqual([])
  })

  test('says when a followed PR is green again', async ($, on) => {
    stub(on)
    const seen = agent(on, 'https://github.com/acme/widgets/pull/899\n')
    world.checks = [{ ...CHECKS[1] }, { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    await claudeRuns($, 'gh pr create --fill')
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    world.checks = [{ ...CHECKS[1] }, { ...CHECKS[2], status: 'COMPLETED', conclusion: 'SUCCESS' }]
    await pane.press({ key: 'refresh' })
    await $.prompt.submit({ text: 'status?' })
    expect((seen[0]!.context ?? []).join('\n')).toContain('CI is green again on PR #899')
  })

  test('PRs Claude did not touch never reach its context', async ($, on) => {
    stub(on)
    const seen = agent(on)
    await $.command.run({ command: 'pulse', args: '' } as any)
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'refresh' })
    world.checks = [CHECKS[0], CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    await pane.press({ key: 'refresh' })
    await $.prompt.submit({ text: 'hi' })
    expect(seen[0]!.context ?? []).toEqual([])
  })

  test('ciContext off keeps Claude out of it', { options: { ciContext: false } }, async ($, on) => {
    stub(on)
    const seen = agent(on, 'https://github.com/acme/widgets/pull/899\n')
    await claudeRuns($, 'gh pr create --fill')
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    world.checks = [CHECKS[0], CHECKS[1], { ...CHECKS[2], status: 'COMPLETED', conclusion: 'FAILURE' }]
    await pane.press({ key: 'refresh' })
    await $.prompt.submit({ text: 'hi' })
    expect(seen[0]!.context ?? []).toEqual([])
  })

  test('autoFollow off ignores what Claude runs', { options: { autoFollow: false } }, async ($, on) => {
    stub(on)
    agent(on, 'https://github.com/acme/widgets/pull/898\n')
    await claudeRuns($, 'gh pr create --fill')
    expect(toasts).toEqual([])
  })
})

describe('adaptive polling', () => {
  // own clock: the shared wrapper stubs clock.now, and a second hook for it would not load
  const listCalls = (calls: string[]) => calls.filter(a => a.startsWith('gh api graphql') && a.includes('open:search(query:$q')).length
  const watch = async ($: any, on: any, rate?: { limited: boolean }) => {
    const calls: string[] = []
    const clock = mock.clock(on)
    on('process.run', async (_$: any, e: any) => {
      calls.push(e.argv.join(' '))
      if (rate?.limited && e.argv[0] === 'gh' && e.argv[1] === 'api' && e.argv[2] === 'graphql') return { value: { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' } }
      return { value: fakeGh(e.argv) }
    })
    on('ui.open', async () => ({ value: {} }) as any)
    on('ui.close', async () => ({ value: undefined }) as any)
    on('ui.status', async () => ({ value: undefined }) as any)
    on('ui.log', async () => ({ value: undefined }) as any)
    await $.command.run({ command: 'pulse', args: '' } as any)
    return { calls, clock }
  }

  kitTest('polls every 15s while checks run, then slows to 60s once they finish', async ($, on) => {
    resetWorld()
    const { calls, clock } = await watch($, on)
    const first = listCalls(calls)
    const spawned = calls.length
    await clock.advance(15_000)
    expect(listCalls(calls)).toBe(first + 1)
    expect(calls.length).toBe(spawned + 1)

    world.checks = CHECKS.map(c => ({ ...c, status: 'COMPLETED', conclusion: 'SUCCESS' }))
    await clock.advance(15_000)
    const settled = listCalls(calls)
    await clock.advance(45_000)
    expect(listCalls(calls)).toBe(settled)
    await clock.advance(15_000)
    expect(listCalls(calls)).toBe(settled + 1)
  })

  kitTest('a forced refresh needs one GraphQL request and the behind-count, nothing else', async ($, on) => {
    resetWorld()
    const { calls } = await watch($, on)
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    const before = calls.length
    await pane.press({ key: 'refresh' })
    const made = calls.slice(before).map(c => (c.startsWith('gh api graphql') ? 'graphql' : c.split(' ').slice(0, 3).join(' ')))
    expect(made).toEqual(['graphql', 'gh api repos/acme/widgets/compare/main...feature%2Fwidget-sizes'])
  })

  kitTest('stretches idle polling to 120s while minimised to the band', async ($, on) => {
    resetWorld()
    world.checks = CHECKS.map(c => ({ ...c, status: 'COMPLETED', conclusion: 'SUCCESS' }))
    const { calls, clock } = await watch($, on)
    const pane = await mount($, { plugin: 'pr-pulse', surface: 'terminal', component: 'Pane', props: {} as any, requestId: 'pr-pulse' })
    await pane.press({ key: 'minimise' })
    await clock.advance(60_000)
    const settled = listCalls(calls)
    await clock.advance(105_000)
    expect(listCalls(calls)).toBe(settled)
    await clock.advance(15_000)
    expect(listCalls(calls)).toBe(settled + 1)
  })

  kitTest('backs off after a rate-limit error and recovers on success', async ($, on) => {
    resetWorld()
    const rate = { limited: true }
    const { calls, clock } = await watch($, on, rate)
    const first = listCalls(calls)
    await clock.advance(30_000)
    expect(listCalls(calls)).toBe(first)

    rate.limited = false
    await clock.advance(30_000)
    expect(listCalls(calls)).toBe(first + 1)
  })
})
