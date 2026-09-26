import type { FileSink } from "bun"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

/** The frame logs of every run, and `launches.jsonl` with one result line per run. */
export const RUNS_DIRECTORY = join(import.meta.dir, "..", "runs")

/** Replaces every `jcpToken` value, so a log never holds a credential. */
export function maskSecrets(text: string): string {
  return text.replace(/("jcpToken"\s*:\s*")[^"]*"/g, "$1***\"")
}

/** A JSONL log of one run: every frame and event, with the milliseconds since the start of the run. */
export class RunLog {
  private constructor(readonly path: string, private readonly sink: FileSink, private readonly started: number) {}

  static async create(name: string, directory: string = RUNS_DIRECTORY): Promise<RunLog> {
    await mkdir(directory, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const path = join(directory, `${stamp}-${name}.jsonl`)
    return new RunLog(path, Bun.file(path).writer(), performance.now())
  }

  elapsed(): number {
    return Math.round(performance.now() - this.started)
  }

  frame(direction: "in" | "out", text: string): void {
    const masked = maskSecrets(text)
    let frame: unknown = masked
    try {
      frame = JSON.parse(masked)
    }
    catch {
      // Keep the text as it is.
    }
    this.write({ t: this.elapsed(), dir: direction, frame })
  }

  event(name: string, data: Readonly<Record<string, unknown>> = {}): void {
    this.write({ t: this.elapsed(), event: name, ...data })
  }

  async close(): Promise<void> {
    await this.sink.end()
  }

  private write(record: Readonly<Record<string, unknown>>): void {
    this.sink.write(`${JSON.stringify(record)}\n`)
    void this.sink.flush()
  }
}
