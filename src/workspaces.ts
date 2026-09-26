import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { decodeXmlEntities } from "./jba-config"
import { jwtClaims } from "./jwt"

/** A workspace that the account can bill a run to. */
export interface WorkspaceOption {
  readonly organizationId: string
  readonly organizationName?: string
  readonly workspaceId: string
  readonly workspaceName?: string
}

/** A workspace that an IDE selected in `Settings | Air | AI Access`, keyed by the JetBrains Account user. */
export interface IdeSelection {
  readonly ide: string
  readonly userId: string
  readonly organizationId: string
  readonly workspaceId: string
}

/** The workspaces of every organization in the orgs-user-info JWT: `orgMemberships[].workspaces[]`. */
export function workspaceOptions(orgsUserInfoJwt: string): WorkspaceOption[] {
  const memberships = jwtClaims(orgsUserInfoJwt).orgMemberships
  if (!Array.isArray(memberships)) {
    return []
  }
  const options: WorkspaceOption[] = []
  for (const membership of memberships) {
    const org = asRecord(membership)
    const organizationId = asString(org?.orgId)
    if (org === undefined || organizationId === undefined) {
      continue
    }
    const organizationName = asString(org.orgName) ?? asString(org.name)
    for (const entry of Array.isArray(org.workspaces) ? org.workspaces : []) {
      const workspace = asRecord(entry)
      const workspaceId = asString(workspace?.id)
      if (workspaceId !== undefined) {
        options.push({ organizationId, organizationName, workspaceId, workspaceName: asString(workspace?.name) })
      }
    }
  }
  return options
}

/**
 * The selections that IntelliJ IDEA installations saved in `options/other.xml`, the newest version first.
 * The file holds the `AirJcpWorkspaceSelection` component, a JSON document keyed by the user id.
 */
export async function ideSelections(jetbrainsDirectory: string = join(homedir(), "Library", "Application Support", "JetBrains")): Promise<IdeSelection[]> {
  let entries: string[]
  try {
    entries = await readdir(jetbrainsDirectory)
  }
  catch {
    return []
  }
  const selections: IdeSelection[] = []
  for (const ide of entries.filter((name) => /^IntelliJIdea\d{4}\.\d+$/.test(name)).sort().reverse()) {
    let xml: string
    try {
      xml = await readFile(join(jetbrainsDirectory, ide, "options", "other.xml"), "utf8")
    }
    catch {
      continue
    }
    const component = /<component name="AirJcpWorkspaceSelection">([\s\S]*?)<\/component>/.exec(xml)?.[1]
    if (component === undefined) {
      continue
    }
    const document = asRecord(JSON.parse(decodeXmlEntities(component)))
    for (const [userId, value] of Object.entries(asRecord(document?.selections) ?? {})) {
      const selection = asRecord(value)
      const organizationId = asString(selection?.organizationId)
      const workspaceId = asString(selection?.workspaceId)
      if (organizationId !== undefined && workspaceId !== undefined) {
        selections.push({ ide, userId, organizationId, workspaceId })
      }
    }
  }
  return selections
}

export type WorkspaceResolution =
  | { readonly kind: "chosen", readonly workspace: WorkspaceOption, readonly source: string }
  | { readonly kind: "ambiguous", readonly options: readonly WorkspaceOption[] }
  | { readonly kind: "none" }

/**
 * Picks the workspace to bill: the requested one, else the selection of the IDE, else the only one.
 * A requested id that the account does not have is an error, not a fallback.
 */
export function resolveWorkspace(
  options: readonly WorkspaceOption[],
  requested: string | undefined,
  selections: readonly IdeSelection[],
  userId: string | undefined,
): WorkspaceResolution {
  if (requested !== undefined) {
    const workspace = options.find((option) => option.workspaceId === requested)
    if (workspace === undefined) {
      throw new Error(`The account has no workspace ${requested}. It has: ${options.map((o) => o.workspaceId).join(", ") || "none"}`)
    }
    return { kind: "chosen", workspace, source: "--workspace" }
  }
  const ranked = [...selections.filter((s) => s.userId === userId), ...selections.filter((s) => s.userId !== userId)]
  for (const selection of ranked) {
    const workspace = options.find((option) => option.workspaceId === selection.workspaceId)
    if (workspace !== undefined) {
      return { kind: "chosen", workspace, source: `${selection.ide} (Settings | Air | AI Access)` }
    }
  }
  const [only, ...rest] = options
  if (only === undefined) {
    return { kind: "none" }
  }
  return rest.length === 0 ? { kind: "chosen", workspace: only, source: "the only workspace" } : { kind: "ambiguous", options }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
