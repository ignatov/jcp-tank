# jcp-tank

Load tests for JCP cloud environments. The tool is an ACP client of the JCP agent spawner, the service that
Air uses for cloud runs (`plugins/air/backend/acp/src/cloud/` in the IntelliJ monorepo).

## Setup

```sh
bun install
./jcp-tank login   # signs in to JetBrains Account in the browser
```

## Commands

| Command | What it does | Cost |
|---|---|---|
| `whoami` | Shows the account, the workspace, and the spawner token claims | free |
| `probe` | Connects to the spawner and sends `initialize` | free |
| `draft` | Creates a draft session, shows its config options, and deletes it | free |
| `launch` | Launches one cloud environment and waits for the marker in the answer | one environment |
| `batch -n <count>` | Launches sessions in parallel: a cold turn, a warm turn, then archive | one environment per session |
| `report [--batch <id>]` | Percentiles per phase, outcomes, and error classes | free |
| `status --batch <id>` | The status of every session of a batch | free |
| `chat` | Starts a session and lets you talk to its agent | one environment |
| `chat --session <id>` | Attaches to a session and shows its history | free for an archived session |
| `sessions` | Lists the sessions of the workspace | free |
| `status <id>` | Shows the state of a session and its Air Web link | free |
| `archive <id>` | Ends a session and keeps its history | free |

`launch` asks the agent to repeat a unique marker. The marker in the answer proves that the environment
works. The default mode is `read-only`, so the agent pushes no branch to the repository. Use `--mode agent`
to let the agent edit files.

`batch` opens one WebSocket per session, because the spawner serves one session per connection. The cold
turn asks for a marker. The warm turn asks the agent to run `git rev-parse HEAD`, and the answer must hold
the commit that the spawner cloned. The tank allows that command once. Each session adds one line to
`runs/launches.jsonl`, and `report` computes the statistics from these lines.

In `chat`, the first message starts the environment. Ctrl-C cancels the turn. `/quit` leaves the session
running, so you can attach to it again. `/archive` ends it. A suspended session wakes up when you attach.

## Where the data is

- The macOS Keychain, service `jcp-tank`: `jba-refresh:prod` holds the refresh token, and
  `spawner-token:prod:<workspace>` caches the spawner token.
- `~/.config/jcp-tank/config.json`: the account and the workspace. Nothing in it is secret.
- `runs/*.jsonl`: every frame of every run, with each `jcpToken` masked.
- `runs/launches.jsonl`: one result line per launch.
