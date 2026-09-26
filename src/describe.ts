import { isRecord, type SessionUpdate } from "./acp"
import type { ConnectTiming } from "./ws"

export function describeTiming(timing: ConnectTiming): string {
  const steps = [
    timing.tcpMs === undefined ? undefined : `tcp ${timing.tcpMs} ms`,
    timing.tlsMs === undefined ? undefined : `tls ${timing.tlsMs} ms`,
    `upgrade ${timing.upgradeMs} ms`,
  ]
  return steps.filter((step) => step !== undefined).join(", ")
}

/** The facts of an `initialize` result that decide whether Air can use the agent. */
export function describeInitialize(result: Readonly<Record<string, unknown>>): string[] {
  const info = isRecord(result.agentInfo) ? result.agentInfo : {}
  const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {}
  const air = isRecord(result._meta) && isRecord(result._meta.jetbrains) && isRecord(result._meta.jetbrains.air) ? result._meta.jetbrains.air : {}
  const methods = Array.isArray(result.authMethods) ? result.authMethods : []
  return [
    `agent       ${String(info.name ?? "?")} ${String(info.version ?? "")} ${info.title === undefined ? "" : `"${String(info.title)}"`}`.trimEnd(),
    `protocol    ${String(result.protocolVersion)}`,
    `capability  ${Object.keys(capabilities).join(", ") || "none"}; loadSession=${String(capabilities.loadSession)}`,
    `session     ${isRecord(capabilities.sessionCapabilities) ? Object.keys(capabilities.sessionCapabilities).join(", ") || "none" : "none"}`,
    `air meta    ${Array.isArray(air.capabilities) ? air.capabilities.join(", ") : "none"}`,
    `auth        ${methods.map((method) => (isRecord(method) ? String(method.id) : "?")).join(", ") || "none"}`,
  ]
}

/** Why Air would refuse the agent (`verifyAgentInfo`), or `undefined` when it accepts it. */
export function airIncompatibility(result: Readonly<Record<string, unknown>>): string | undefined {
  const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {}
  if (result.protocolVersion !== 1) {
    return `protocolVersion is ${String(result.protocolVersion)}, not 1`
  }
  return capabilities.loadSession === true ? undefined : "the agent does not advertise loadSession"
}

/** One line per config option and one line per value that the spawner offers. */
export function describeConfigOptions(options: unknown, maxValues: number = 15): string[] {
  if (!Array.isArray(options) || options.length === 0) {
    return ["  (no config options)"]
  }
  const lines: string[] = []
  for (const option of options) {
    if (!isRecord(option)) {
      continue
    }
    const category = option.category === undefined ? "" : `, category ${String(option.category)}`
    const name = option.name === undefined ? "" : ` "${String(option.name)}"`
    lines.push(`  ${String(option.id)}${name} [${String(option.type ?? "select")}${category}] = ${JSON.stringify(option.currentValue)}`)
    const values = flattenValues(option.options)
    for (const value of values.slice(0, maxValues)) {
      lines.push(`      ${value}`)
    }
    if (values.length > maxValues) {
      lines.push(`      ... and ${values.length - maxValues} more`)
    }
  }
  return lines
}

export function describeUpdate(update: SessionUpdate): string {
  const kind = String(update.update.sessionUpdate ?? "?")
  const content = update.update.content
  const text = isRecord(content) && typeof content.text === "string" ? `: ${JSON.stringify(truncate(content.text, 200))}` : ""
  const meta = update.meta === undefined ? "" : ` _meta{${Object.keys(update.meta).join(",")}}`
  return `${kind}${text}${meta}`
}

function flattenValues(options: unknown, group: string = ""): string[] {
  if (!Array.isArray(options)) {
    return []
  }
  return options.flatMap((entry): string[] => {
    if (!isRecord(entry)) {
      return []
    }
    if (Array.isArray(entry.options)) {
      return flattenValues(entry.options, `${String(entry.name ?? entry.group ?? "")} / `)
    }
    const name = entry.name !== undefined && entry.name !== entry.value ? ` "${String(entry.name)}"` : ""
    return [`${group}${String(entry.value)}${name}`]
  })
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}
