import { describe, expect, test as kitTest } from 'claude-code/testing'

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
const test = (name: string, body: ($: any, on: any) => Promise<void>) =>
  kitTest(name, async ($, on) => {
    violations.length = 0
    try {
      await body($, on)
    } finally {
      for (const m of mounted.splice(0)) await m.unmount().catch(() => undefined)
    }
    expect(violations).toEqual([])
  })

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

const opened: string[] = []
const filled: string[] = []
const toasts: string[] = []
const paneLog: string[] = []

// what GitHub reports; a test mutates it between refreshes to raise alerts
const world = {
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
  filled.length = 0
  toasts.length = 0
  paneLog.length = 0
}

resetWorld()

const stub = (on: any) => {
  resetWorld()
  on('process.run', async (_$: any, e: any) => ({ value: fakeGh(e.argv) }))
  on('ui.open', async (_$: any, e: any) => {
    paneLog.push(`open ${e.id}`)
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
  if (argv[0] === 'git') return { exitCode: 0, stdout: '/repo\n', stderr: '' }
  if (a.startsWith('gh repo view')) return ok({ nameWithOwner: REPO })
  if (a.includes('review-requested:@me')) return ok(world.queue)
  if (a.startsWith('gh pr list') && a.includes('--state open')) {
    return ok([
      { ...row(899, 'test 2'), reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [CHECKS[0], CHECKS[1]] },
      { ...row(898, 'test 1'), isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [CHECKS[1]] },
    ])
  }
  if (a.startsWith('gh pr list') && a.includes('--state merged')) {
    return ok([
      { ...row(890, 'mine merged'), state: 'MERGED', author: { login: 'me' }, mergedAt: '2026-10-04T10:00:00Z' },
      { ...row(891, 'theirs merged'), state: 'MERGED', author: { login: 'someone' }, mergedAt: '2026-10-05T10:00:00Z' },
    ])
  }
  if (a === 'gh api user') return ok({ login: 'me' })
  if (a.startsWith('gh pr list')) return ok([])
  if (a.startsWith('gh pr view')) {
    return ok({
      title: 'test 2', url: row(899, '').url, state: world.prState, isDraft: world.isDraft, reviewDecision: world.review, mergeable: world.mergeable,
      mergeStateStatus: world.mergeState, baseRefName: 'main', headRefName: 'trivial/pr-pulse-test-2',
      latestReviews: world.latestReviews, statusCheckRollup: world.checks,
    })
  }
  if (a.startsWith('gh pr checks')) return { exitCode: 1, stdout: JSON.stringify(world.required.map(name => ({ name }))), stderr: '' }
  if (a.startsWith('gh api repos/') && a.includes('/compare/')) return ok({ behind_by: world.behind })
  if (a.startsWith('gh api graphql') && a.includes('totalCount')) {
    return ok({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: Array.from({ length: world.unresolved }, () => ({ isResolved: false, comments: { totalCount: 1, nodes: [] } })) },
      comments: { totalCount: world.commentTotal, nodes: [{ author: { login: world.lastCommenter }, createdAt: '2026-10-05T19:00:00Z' }] },
    } } } })
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
      expect(paneLog).toEqual(['open pr-pulse', 'open pr-pulse-history', 'open pr-pulse-reviews'])
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

  test('/pr-pulse while collapsed expands', async ($, on) => {
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

test('the capability guard catches a program outside the allowlist', async () => {
  fakeGh(['curl', 'https://example.com'])
  fakeGh(['open', 'file:///etc/passwd'])
  expect(violations).toEqual(['ran curl', 'opened file:///etc/passwd'])
  violations.length = 0
})
