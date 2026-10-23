import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

// The ladvin plugin's MCP server, in tool-name spelling (mcp__plugin_ladvin_ladvin__*).
const SERVER = 'plugin_ladvin_ladvin'
const PANE = 'ladvin'
const POLL_MS = 10_000

// Change the tag when Snapshot's fields change: it declines what an earlier version stored.
const snap = atom({ plugin: 'ladvin', key: 'snap' } as const, null, { shape: 'snap-2' })
const problem = atom({ plugin: 'ladvin', key: 'problem' } as const, null)
const isBandHidden = atom({ plugin: 'ladvin', key: 'isBandHidden' } as const, false)
// ~/.ssh/config hosts not added to ladvin yet: one press adds them.
const sshHosts = atom({ plugin: 'ladvin', key: 'sshHosts' } as const, [])

function parseSshHosts(config: string): string[] {
  const names = config
    .split(/\r?\n/)
    .map(l => l.match(/^\s*Host\s+(.+)$/i)?.[1] ?? '')
    .flatMap(l => l.split(/\s+/))
    .filter(n => n && !/[*?!]/.test(n))
  return [...new Set(names)]
}

// Best effort: no config, no home, or no access just means no add buttons.
async function readSshHosts($: EngineInterface): Promise<string[]> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!home) return []
    const config = await $.fs.read(`${home}/.ssh/config`)
    return parseSshHosts(typeof config === 'string' ? config : '')
  } catch {
    return []
  }
}

async function addHost($: EngineInterface, alias: string): Promise<void> {
  $.ui.toast(`Adding ${alias}: checking claude and tmux, installing the daemon (up to a minute)…`)
  await runAndToast($, 'ladvin_add_host', { alias })
}

// Module state starts over on a reload; the atoms above outlive it.
let prev: Snapshot | null = null
let ticker: { cancel(): void } | null = null
let hasAutoOpened = false

type Task = Snapshot['tasks'][number]
type Burn = Snapshot['burn'][number]

const isLive = (t: Task) => t.state === 'running' || t.state === 'idle'
const shortAccount = (label: string) => label.replace(/@.*$/, '@')
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

function duration(ms?: number): string {
  if (ms === undefined) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

function clockOf(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ▰▰▰▱▱▱▱▱▱▱ 30%
function bar(pct: number): string {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)))
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

// The team's goal as written for agents is long; the panel shows its first clause.
function title(goal: string): string {
  const first = goal.split(/[.:\n]/)[0]?.trim() ?? goal
  return first.length > 48 ? `${first.slice(0, 47)}…` : first
}

async function callLadvin($: EngineInterface, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await $.mcp.call(SERVER, tool, args)
  const text = r.content.map(c => ('text' in c ? c.text : '')).join('\n')
  if (r.isError) throw new Error(text || `${tool} failed`)
  return text
}

// Toasts for what changed since the last poll: finished agents, new teammate messages, budgets crossed.
function announce($: EngineInterface, next: Snapshot): void {
  if (prev) {
    for (const t of next.tasks) {
      const before = prev.tasks.find(x => x.taskId === t.taskId)
      if (before && isLive(before) && !isLive(t))
        $.ui.toast(`ladvin: ${t.role ?? t.taskId}@${t.host} ${t.state}${t.failReason ? ` — ${t.failReason}` : ''}`)
    }
    const sameTeam = prev.team?.teamId === next.team?.teamId
    const fresh = (next.team?.unread ?? 0) - (sameTeam ? (prev.team?.unread ?? 0) : 0)
    const last = next.team?.recent.at(-1)
    if (fresh > 0 && last) $.ui.toast(`${last.role}: ${last.text.slice(0, 90)}`)
    for (const b of next.burn) {
      const was = prev.burn.find(x => x.label === b.label)
      if (b.over.length && !was?.over.length) $.ui.toast(`ladvin: ${b.label} over budget (${b.over.join(', ')})`)
    }
  }
  prev = next
}

// Status line only while something is happening; quiet otherwise.
function statusText(s: Snapshot): string | undefined {
  const running = s.tasks.filter(t => t.state === 'running').length
  const idle = s.tasks.filter(t => t.state === 'idle').length
  const unread = s.team?.unread ?? 0
  if (!running && !idle && !unread) return undefined
  const parts = [running && `${running} running`, idle && `${idle} idle`, unread && `${unread} new`].filter(Boolean)
  const top = s.burn.find(b => b.fiveHourPct !== undefined)
  return `ladvin ${parts.join(' · ')}${top ? ` · 5h ${top.fiveHourPct}%` : ''}`
}

async function poll($: EngineInterface): Promise<void> {
  try {
    const s = JSON.parse(await callLadvin($, 'ladvin_snapshot')) as Snapshot
    announce($, s)
    const known = new Set(s.hosts.map(h => h.alias))
    const candidates = (await readSshHosts($)).filter(a => !known.has(a))
    await update($, sshHosts, () => candidates)
    await update($, snap, () => s)
    await update($, problem, () => null)
    $.ui.status(statusText(s))
    // Open the panel by itself once, when there is something to watch.
    if (!hasAutoOpened && (s.tasks.some(isLive) || s.team)) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: 'ladvin' })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await update($, problem, () =>
      /ladvin_snapshot|not found|unknown tool/i.test(msg) ? 'ladvin is out of date: /plugin update ladvin' : msg,
    )
  }
}

async function runAndToast($: EngineInterface, tool: string, args: Record<string, unknown> = {}): Promise<void> {
  try {
    const text = await callLadvin($, tool, args)
    $.ui.toast(text.split('\n')[0] ?? tool)
  } catch (err) {
    $.ui.toast(err instanceof Error ? err.message : String(err))
  }
  await poll($)
}

function startPolling($: EngineInterface): void {
  ticker?.cancel()
  ticker = $.clock.every(POLL_MS, () => void poll($))
  void poll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ladvin', description: 'Open the ladvin panel: hosts, remote agents, team chat, burn' })
    startPolling($)
    return next(e)
  })

  on('command.run', { command: 'ladvin' }, async $ => {
    await poll($)
    const opened = await $.ui.open({ id: PANE, title: 'ladvin' })
    return { text: opened.isPlaced ? 'ladvin panel opened.' : 'ladvin panel will show when the terminal is wide enough.' }
  })

  // After any ladvin tool call the state has likely changed: refresh now instead of waiting for the tick.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // never let the panel get in the way of a tool call
    if (e.tool.startsWith('mcp__plugin_ladvin_ladvin__') && !e.tool.endsWith('ladvin_snapshot')) void poll($).catch(() => {})
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || !s || (await read($, isBandHidden))) return next(e)
    const unread = s.team?.unread ?? 0
    const running = s.tasks.filter(t => t.state === 'running').length
    const over = s.burn.filter(b => b.over.length)
    if (!running && !unread && !over.length) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const last = s.team?.recent.at(-1)
    return (
      <Box gap={1}>
        <Text color="claude">◆ ladvin</Text>
        {running > 0 && <Text>{running} running</Text>}
        {unread > 0 && last && (
          <Text color="suggestion">
            {last.role}: {last.text.slice(0, 60)}
            {last.text.length > 60 ? '…' : ''}
          </Text>
        )}
        {over.length > 0 && <Text color="warning">over budget: {over.map(b => shortAccount(b.label)).join(', ')}</Text>}
        <Button key="open" label="Panel" plain onPress={() => void $.ui.open({ id: PANE, title: 'ladvin' })} />
        <Button key="hide" label="Hide" plain dimColor onPress={() => void update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    const issue = await read($, problem)
    const addable = await read($, sshHosts)
    const rows = e.viewport?.rows ?? 30

    if (!s)
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{issue ?? 'Connecting to ladvin…'}</Text>
        </Box>
      )

    const teamTasks = new Set(s.team?.members.map(m => m.taskId) ?? [])
    const delegates = s.tasks.filter(t => !teamTasks.has(t.taskId)).sort((a, b) => Number(isLive(b)) - Number(isLive(a)))
    const members = s.tasks.filter(t => teamTasks.has(t.taskId))
    const measured = s.burn.filter(b => b.fiveHourPct !== undefined || b.sevenDayPct !== undefined)
    const chat = s.team?.chat ?? s.team?.recent.map(m => ({ at: m.at, from: m.role, text: m.text })) ?? []
    const chatRoom = Math.max(3, rows - 14 - Math.min(delegates.length, 4) * 2 - s.hosts.length)

    const stateColor = (t: Task) => (t.state === 'running' ? 'claude' : t.state === 'idle' ? 'suggestion' : t.state === 'done' ? 'success' : 'error')
    const stateMark = (t: Task) => (t.state === 'running' ? '▶' : t.state === 'idle' ? '◌' : t.state === 'done' ? '✓' : '✗')

    const burnLine = (b: Burn) => (
      <Box key={`burn-${b.label}`} gap={1}>
        <Text>{shortAccount(b.label)}</Text>
        {b.fiveHourPct !== undefined && (
          <Text color={b.fiveHourPct >= 80 ? 'warning' : 'success'}>
            5h {bar(b.fiveHourPct)} {b.fiveHourPct}%
          </Text>
        )}
        {b.sevenDayPct !== undefined && <Text dimColor>7d {b.sevenDayPct}%</Text>}
        {b.over.length > 0 && <Text color="warning">⚠ {b.over.join(', ')}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {/* servers from ~/.ssh/config, one press to add */}
        {addable.length > 0 && (
          <Box gap={1} flexWrap="wrap">
            <Text dimColor>Add a server:</Text>
            {addable.slice(0, 8).map(alias => (
              <Button key={`add-${alias}`} label={`+ ${alias}`} onPress={() => void addHost($, alias)} />
            ))}
          </Box>
        )}

        {/* hosts: one line each */}
        <Box flexDirection="column">
          {s.hosts.length === 0 && <Text dimColor>No servers yet — press one above, or ask Claude to add a host.</Text>}
          {s.hosts.map(host => {
            const live = s.tasks.filter(t => t.host === host.alias && isLive(t)).length
            return (
              <Box key={`host-${host.alias}`} gap={1}>
                <Text color={host.reachable ? 'success' : 'inactive'}>{host.reachable ? '●' : '○'}</Text>
                <Text weight="bold">{host.alias}</Text>
                <Text dimColor>{host.account ?? (host.reachable ? '' : 'not connected yet')}</Text>
                {live > 0 && <Text color="claude">{live} active</Text>}
              </Box>
            )
          })}
        </Box>

        {/* team chat */}
        {s.team && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text weight="bold">Chat</Text>
              <Text dimColor>{title(s.team.goal)}</Text>
            </Box>
            <Box gap={1}>
              {members.map(t => (
                <Text key={`member-${t.taskId}`} color={stateColor(t)}>
                  {stateMark(t)} {t.role}
                </Text>
              ))}
              {members.some(isLive) && <Button key="watch-team" label="Watch" onPress={() => void runAndToast($, 'ladvin_attach', { task_id: members.find(isLive)!.taskId })} />}
              <Button key="end-team" label="End" onPress={() => void runAndToast($, 'ladvin_team_end')} />
            </Box>
            {chat.length === 0 && <Text dimColor>Waiting for the first message…</Text>}
            {chat.slice(-chatRoom).map((m, i) => (
              <Box key={`chat-${i}`} gap={1} marginTop={1}>
                <Text dimColor>{clockOf(m.at)}</Text>
                <Box flexDirection="column" flexShrink={1}>
                  <Text color={m.from === 'you' ? 'claude' : 'suggestion'} weight="bold">
                    {m.from === 'you' ? 'you' : m.from}
                  </Text>
                  <Text>{m.text.length > 600 ? `${m.text.slice(0, 599)}…` : m.text}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {/* delegated tasks */}
        {delegates.length > 0 && (
          <Box flexDirection="column">
            <Text weight="bold">Tasks</Text>
            {delegates.slice(0, 6).map(t => (
              <Box key={`task-${t.taskId}`} flexDirection="column">
                <Box gap={1}>
                  <Text color={stateColor(t)}>{stateMark(t)}</Text>
                  <Text>{t.host}</Text>
                  <Text dimColor>
                    {t.taskId} · {t.preset} · {duration(t.elapsedMs)} · {tokens(t.tokensIn + t.tokensOut)} tok
                  </Text>
                  {isLive(t) && <Button key={`watch-${t.taskId}`} label="Watch" onPress={() => void runAndToast($, 'ladvin_attach', { task_id: t.taskId })} />}
                  {isLive(t) && <Button key={`stop-${t.taskId}`} label="Stop" onPress={() => void runAndToast($, 'ladvin_cancel', { task_id: t.taskId })} />}
                </Box>
                {(t.failReason || t.lastActivity) && <Text dimColor>  {(t.failReason ?? t.lastActivity ?? '').slice(0, 90)}</Text>}
              </Box>
            ))}
          </Box>
        )}

        {/* burn: only what was measured */}
        {measured.length > 0 ? (
          <Box flexDirection="column">
            <Text weight="bold">Quota</Text>
            {measured.map(burnLine)}
          </Box>
        ) : null}

        <Box gap={1}>
          <Button key="refresh" label="Refresh" plain dimColor onPress={() => void poll($)} />
          <Button key="burn" label={measured.length ? 'Re-measure quota' : 'Measure quota'} plain dimColor onPress={() => void runAndToast($, 'ladvin_burn')} />
          {s.tasks.some(isLive) && <Button key="stop" label="Stop all" plain dimColor onPress={() => void runAndToast($, 'ladvin_stop_all')} />}
          <Text dimColor>· {clockOf(s.at)}</Text>
          {issue && <Text color="warning">{issue}</Text>}
        </Box>
      </Box>
    )
  })
}
