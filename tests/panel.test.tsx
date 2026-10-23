import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'

const PANE = {
  plugin: 'ladvin',
  component: 'Pane',
  requestId: 'ladvin',
  props: { title: 'ladvin', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = { plugin: 'ladvin', component: 'AbovePrompt', props: { hasSurvey: false } } as const

const SNAP: Snapshot = {
  at: '2026-10-23T10:00:00.000Z',
  hosts: [{ alias: 'kata28', account: 'me@example.com', reachable: true }],
  tasks: [
    { taskId: 't_00000001', host: 'kata28', state: 'running', kind: 'delegate', preset: 'worker', elapsedMs: 75_000, tokensIn: 1200, tokensOut: 300, lastActivity: 'Bash(iostat -x 1 3)' },
    { taskId: 't_00000002', host: 'kata28', state: 'idle', kind: 'team', preset: 'observer', role: 'db-watch', tokensIn: 0, tokensOut: 0 },
  ],
  team: {
    teamId: 'team_1',
    goal: 'find the bottleneck',
    members: [{ role: 'db-watch', host: 'kata28', taskId: 't_00000002' }],
    tasks: [{ id: 'k1', title: 'watch pool', status: 'doing' }],
    unread: 2,
    recent: [{ at: '2026-10-23T10:00:00.000Z', role: 'db-watch', host: 'kata28', text: 'pool exhausted at 14:03Z' }],
    chat: [
      { at: '2026-10-23T10:00:00.000Z', from: 'db-watch', text: 'pool exhausted at 14:03Z' },
      { at: '2026-10-23T10:00:05.000Z', from: 'you', text: 'which query holds the locks?' },
    ],
  },
  burn: [{ label: 'me@example.com', hosts: ['kata28'], fiveHourPct: 42, sevenDayPct: 9, running: 2, over: [] }],
}

function engine(on: any, answer: () => unknown) {
  on('command.register', () => ({ value: { command: 'ladvin' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', () => ({ value: answer() }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
}

const ok = (s: Snapshot) => () => ({ content: [{ type: 'text', text: JSON.stringify(s) }], isError: false })

test('the pane shows hosts, the team chat both ways, tasks and quota', async ($, on) => {
  engine(on, ok(SNAP))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ladvin', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /me@example.com/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pool exhausted at 14:03Z/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /which query holds the locks?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /◌ db-watch/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /t_00000001 · worker · 1m · 1.5k tok/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h ▰▰▰▰▱▱▱▱▱▱ 42%/ })).toBeDefined()
    for (const key of ['watch-t_00000001', 'stop-t_00000001', 'watch-team', 'end-team', 'stop'])
      expect(await ui.find({ key })).toBeDefined()
    await ui.unmount()
  }
})

test('the band appears only when agents run or messages wait', async ($, on) => {
  engine(on, ok(SNAP))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ladvin', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /db-watch: pool exhausted/ })).toBeDefined()
  await ui.unmount()
})

test('an older ladvin without the snapshot tool gets a clear hint', async ($, on) => {
  engine(on, () => ({ content: [{ type: 'text', text: 'Tool ladvin_snapshot not found' }], isError: true }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ladvin', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /plugin update ladvin/ })).toBeDefined()
  await ui.unmount()
})

test('servers from ~/.ssh/config that are not added yet get an add button', async ($, on) => {
  engine(on, ok(SNAP))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', () => ({ value: 'Host kata28\n  HostName 10.0.0.28\nHost kata54 gpu-box\nHost *\n  ServerAliveInterval 30\nHost *.internal\n' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ladvin', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'add-kata54' })).toBeDefined()
  expect(await ui.find({ key: 'add-gpu-box' })).toBeDefined()
  expect(await ui.find({ key: 'add-kata28' })).toBeUndefined() // already a ladvin host
  await ui.unmount()
})
