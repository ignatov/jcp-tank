/** The status, the body, and the duration of one HTTP call. */
export interface HttpOutcome {
  readonly status: number
  readonly body: string
  readonly ms: number
}

/** The HTTP API of the agent spawner, with the same Bearer token as the ACP connection (`AirCloudSpawner.kt`). */
export class SpawnerHttp {
  constructor(private readonly baseUrl: string, private readonly token: () => Promise<string>) {}

  /** Deletes a draft. Air calls this only for a draft whose first prompt never started. */
  deleteSession(sessionId: string): Promise<HttpOutcome> {
    return this.call("DELETE", `/sessions/${encodeURIComponent(sessionId)}`)
  }

  /** One page of the sessions that the user owns or shares with others. */
  sessions(offset: number, limit: number): Promise<HttpOutcome> {
    return this.call("GET", `/sessions?offset=${offset}&limit=${limit}`)
  }

  session(sessionId: string): Promise<HttpOutcome> {
    return this.call("GET", `/sessions/${encodeURIComponent(sessionId)}`)
  }

  sessionStatus(sessionId: string): Promise<HttpOutcome> {
    return this.call("GET", `/sessions/${encodeURIComponent(sessionId)}/status`)
  }

  /** "Terminate and archive a session", as the generated API describes it. Air never calls it. */
  archiveSession(sessionId: string): Promise<HttpOutcome> {
    return this.call("PUT", `/sessions/${encodeURIComponent(sessionId)}/archive`)
  }

  private async call(method: string, path: string): Promise<HttpOutcome> {
    const started = performance.now()
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.text()
    return { status: response.status, body, ms: Math.round(performance.now() - started) }
  }
}
