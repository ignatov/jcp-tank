import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** The signed-in JetBrains Account, as its ID token names it. */
export interface Account {
  readonly subject: string
  readonly issuer: string
  readonly userId?: string
  readonly email?: string
  readonly login?: string
}

/** The workspace that a run is billed to, and the organization that owns it. */
export interface WorkspaceChoice {
  readonly organizationId: string
  readonly workspaceId: string
  readonly organizationName?: string
  readonly workspaceName?: string
}

/** The state of the tank that is not secret. The secrets are in the Keychain, see `secrets.ts`. */
export interface TankConfig {
  readonly account?: Account
  readonly workspace?: WorkspaceChoice
}

export function configDirectory(): string {
  return process.env.JCP_TANK_HOME ?? join(homedir(), ".config", "jcp-tank")
}

export async function readConfig(directory: string = configDirectory()): Promise<TankConfig> {
  try {
    return JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as TankConfig
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    throw e
  }
}

/** Replaces the file in one rename, so a reader never sees half of it. */
export async function writeConfig(config: TankConfig, directory: string = configDirectory()): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = join(directory, "config.json")
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}
