/** Where the tank keeps its secrets: the refresh token and the cached spawner token. */
export interface SecretStore {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<boolean>
}

/** The Keychain service of every tank secret. */
export const SECRET_SERVICE = "jcp-tank"

/**
 * The OS credential store through `Bun.secrets`. On macOS it is the login Keychain. A secret never goes
 * through a file or a command line.
 */
export function osSecretStore(service: string = SECRET_SERVICE): SecretStore {
  return {
    get: (name) => Bun.secrets.get({ service, name }),
    set: (name, value) => Bun.secrets.set({ service, name, value }),
    delete: (name) => Bun.secrets.delete({ service, name }),
  }
}

/** A store in memory, for tests. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>()

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value)
  }

  async delete(name: string): Promise<boolean> {
    return this.values.delete(name)
  }
}
