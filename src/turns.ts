import type { TurnSpec } from "./launch"

/** The first prompt. It launches the environment, and the marker in the answer proves that the agent runs. */
export const COLD_TURN: TurnSpec = {
  name: "cold",
  prompt: (marker) => `How are you? Answer in one short sentence, and include the marker ${marker} in the answer. Do not use any tools.`,
}

/** The second prompt, on a warm environment. */
export const WARM_TURNS: Readonly<Record<string, TurnSpec>> = {
  /** Proves that the agent runs commands in the clone: the answer must hold the commit that the spawner cloned. */
  git: {
    name: "warm",
    prompt: (marker) => `Run \`git rev-parse HEAD\` in the repository. Reply with its output and the marker ${marker}.`,
    check: (answer, facts) => facts.revision === undefined || answer.includes(facts.revision.slice(0, 7))
      ? undefined
      : `The answer has no commit ${facts.revision.slice(0, 12)}`,
  },
  /** Proves that the clone is there, without a command. Reading needs no permission in the read-only mode. */
  readme: {
    name: "warm",
    prompt: (marker) => `Read the first line of README.md in the repository. Reply with that line and the marker ${marker}.`,
  },
  /** Measures the model alone on a warm environment. */
  marker: {
    name: "warm",
    prompt: (marker) => `Reply with the marker ${marker} and nothing else.`,
  },
}
