import type { Plugin } from "@opencode-ai/plugin"
import { exec } from "node:child_process"
import { basename } from "node:path"

const execWithTimeout = (cmd: string, timeoutMs = 500): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err)
      resolve((stdout ?? "").trim())
    })
  })

const getFrontmostPid = async (): Promise<number | null> => {
  try {
    const result = await execWithTimeout(
      `osascript -e 'tell application "System Events" to get unix id of first application process whose frontmost is true'`,
    )
    const pid = parseInt(result, 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

const getAncestorPids = async (startPid: number): Promise<Set<number>> => {
  const ancestors = new Set<number>()
  try {
    const result = await execWithTimeout(`ps -eo pid=,ppid=`, 1000)
    const parentMap = new Map<number, number>()
    for (const line of result.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts.length === 2)
        parentMap.set(parseInt(parts[0], 10), parseInt(parts[1], 10))
    }
    let pid = startPid
    while (pid > 1) {
      ancestors.add(pid)
      const ppid = parentMap.get(pid)
      if (ppid === undefined || ppid === pid) break
      pid = ppid
    }
  } catch { }
  return ancestors
}

const getMultiplexerWindowLabel = async (): Promise<string | null> => {
  if (process.env.TMUX) {
    const pane = process.env.TMUX_PANE
    if (!pane) return null
    try {
      return (await execWithTimeout(
        `tmux display-message -t ${pane} -p '#{session_name}-#{window_index}'`,
      )) || null
    } catch {
      return null
    }
  }
  if (process.env.STY) {
    const windowId = process.env.WINDOW
    if (!windowId) return null
    const name = process.env.STY.split(".").slice(1).join(".")
    return name ? `${name}-${windowId}` : null
  }
  return null
}

const getTmuxClientPid = async (): Promise<number | null> => {
  try {
    const target = process.env.TMUX_PANE ? `-t ${process.env.TMUX_PANE} ` : ""
    const result = await execWithTimeout(
      `tmux display-message ${target}-p '#{client_pid}'`,
    )
    const pid = parseInt(result, 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

const isTmuxPaneActive = async (): Promise<boolean> => {
  const pane = process.env.TMUX_PANE
  if (!pane) return true
  try {
    const result = await execWithTimeout(
      `tmux display-message -t ${pane} -p '#{session_attached} #{window_active} #{pane_active}'`,
    )
    const parts = result.split(" ")
    return parts[0] === "1" && parts[1] === "1" && parts[2] === "1"
  } catch {
    return true
  }
}

const getScreenClientPid = async (): Promise<number | null> => {
  const sty = process.env.STY
  if (!sty) return null
  try {
    const screenServerPid = parseInt(sty.split(".")[0], 10)
    if (!Number.isFinite(screenServerPid)) return null
    const result = await execWithTimeout(
      `ps -eo pid=,ppid=,command= | grep '[s]creen'`,
      1000,
    )
    for (const line of result.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) continue
      const pid = parseInt(match[1], 10)
      const ppid = parseInt(match[2], 10)
      if (pid === screenServerPid || ppid === screenServerPid) continue
      if (match[3].includes("screen") && match[3].includes(sty)) return pid
    }
    return null
  } catch {
    return null
  }
}

const isScreenWindowActive = async (): Promise<boolean> => {
  const sty = process.env.STY
  if (!sty) return true
  const windowId = process.env.WINDOW
  if (!windowId) return true
  try {
    const result = await execWithTimeout(`screen -S ${sty} -Q number`, 1000)
    const match = result.match(/^(\d+)/)
    return match ? match[1] === windowId : true
  } catch {
    return true
  }
}

const isTerminalFocused = async (): Promise<boolean> => {
  try {
    const frontPid = await getFrontmostPid()
    if (frontPid === null) return false

    let startPid: number
    let extraCheck: (() => Promise<boolean>) | null = null

    if (process.env.TMUX) {
      const clientPid = await getTmuxClientPid()
      if (clientPid === null) return false
      startPid = clientPid
      extraCheck = isTmuxPaneActive
    } else if (process.env.STY) {
      const clientPid = await getScreenClientPid()
      if (clientPid === null) return false
      startPid = clientPid
      extraCheck = isScreenWindowActive
    } else {
      startPid = process.pid
    }

    const ancestors = await getAncestorPids(startPid)
    if (!ancestors.has(frontPid)) return false
    return extraCheck ? extraCheck() : true
  } catch {
    return false
  }
}

const notifyDebounce = new Map<string, number>()

const sendNotification = async (title: string, message: string): Promise<void> => {
  const key = `${title}:${message}`
  const now = Date.now()
  if ((notifyDebounce.get(key) ?? 0) > now - 1000) return
  notifyDebounce.set(key, now)

  const esc = (s: string) => s.replace(/"/g, '\\"')
  try {
    await execWithTimeout(
      `osascript -e 'display notification "${esc(message)}" with title "${esc(title)}"'`,
      3000,
    )
  } catch { }
}

const playSound = (): Promise<void> =>
  new Promise((resolve) => {
    exec(`afplay /System/Library/Sounds/Blow.aiff`, { timeout: 5000 }, () => resolve())
  })

const notify = async (message: string, projectName: string): Promise<void> => {
  if (await isTerminalFocused()) return

  const windowLabel = await getMultiplexerWindowLabel()
  const title = `OpenCode - ${windowLabel ?? projectName}`

  await Promise.allSettled([
    sendNotification(title, message),
    playSound(),
  ])
}

export const NotifierPlugin: Plugin = async ({ directory }) => {
  if (process.env.OPENCODE_CLIENT && process.env.OPENCODE_CLIENT !== "cli") return {}

  const projectName = basename(directory)
  const childSessions = new Set<string>()
  const sessionBusyTimes = new Map<string, number>()
  const sessionIdleSeqs = new Map<string, number>()
  const pendingIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const sessionNotifiedEvents = new Map<string, Set<string>>()

  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [id, time] of sessionBusyTimes) {
      if (time < cutoff) {
        sessionBusyTimes.delete(id)
        sessionIdleSeqs.delete(id)
        sessionNotifiedEvents.delete(id)
        childSessions.delete(id)
      }
    }
  }, 5 * 60 * 1000)
  cleanupInterval.unref?.()

  const dedup = (message: string, sessionId?: string): boolean => {
    if (!sessionId) return false
    const notified = sessionNotifiedEvents.get(sessionId)
    if (notified?.has(message)) return true
    if (!notified) sessionNotifiedEvents.set(sessionId, new Set([message]))
    else notified.add(message)
    return false
  }

  const cancelPendingIdle = (sessionId: string) => {
    const timer = pendingIdleTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      pendingIdleTimers.delete(sessionId)
    }
    sessionIdleSeqs.set(sessionId, (sessionIdleSeqs.get(sessionId) ?? 0) + 1)
  }

  const scheduleSessionIdle = (sessionId: string) => {
    cancelPendingIdle(sessionId)
    const seq = sessionIdleSeqs.get(sessionId) ?? 0

    const timer = setTimeout(async () => {
      pendingIdleTimers.delete(sessionId)
      if ((sessionIdleSeqs.get(sessionId) ?? 0) !== seq) return
      if (childSessions.has(sessionId)) return
      await notify("Session has finished", projectName)
    }, 350)

    timer.unref?.()
    pendingIdleTimers.set(sessionId, timer)
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const info = (event.properties as any).info
          if (info?.parentID) childSessions.add(info.id)
          break
        }
        case "permission.replied": {
          const sid = (event.properties as any).sessionID ?? ""
          if (!dedup("permission", sid)) await notify("Session needs permission", projectName)
          break
        }
        case "session.idle": {
          scheduleSessionIdle(event.properties.sessionID)
          break
        }
        case "session.status": {
          const { sessionID, status } = event.properties
          if (status.type === "busy") {
            sessionBusyTimes.set(sessionID, Date.now())
            cancelPendingIdle(sessionID)
            sessionNotifiedEvents.delete(sessionID)
          }
          break
        }
        case "session.error": {
          const { sessionID, error } = event.properties as any
          cancelPendingIdle(sessionID ?? "")
          if (error?.name !== "MessageAbortedError") await notify("Session encountered an error", projectName)
          break
        }

      }
    },
    "permission.ask": async (input, _output) => {
      const sid = (input as any).sessionID ?? ""
      if (!dedup("permission", sid)) await notify("Session needs permission", projectName)
    },
    "tool.execute.before": async (input, _output) => {
      if (input.tool === "question" && !dedup("question", input.sessionID))
        await notify("Session has a question", projectName)
    },
  }
}

export default NotifierPlugin
