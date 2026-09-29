# h2cv (herdr sends to claude verifiably)

A command-line tool that lets Claude Code start Claude Code sessions and give them instructions.

It uses herdr and handles known Claude input-box failure modes with deterministic checks.

<a href="https://imgflip.com/i/ayqhq9"><img src="https://i.imgflip.com/ayqhq9.jpg" alt="Just use if statements." /></a>

## Why

herdr ships a skill file for AI agents, but a skill file alone does not reliably let one claude give instructions to another claude. A message may succeed only after several attempts, consuming context with pane ids and screen dumps. The Claude input box has several states that require explicit handling:

### The completion menu eats your Enter

Claude Code A sends the `/review` skill to Claude Code B with `pane run`, but B may not start working. The Enter key may open the completion menu for the leading `/` instead of submitting the prompt, leaving the body in the input box. Recovery requires checking this state; sending the whole message again can create a duplicate.

### `idle` lies for about a second

Immediately after startup, herdr reports the agent as `idle` while the TUI is still initializing. An immediate `agent send` is discarded. The `idle` status does not guarantee that the input box is ready, so status and input readiness require separate checks.

### "It didn't arrive" has three different endings

Delivery can fail in three ways: no text arrives, the body arrives without a submit, or the submit is delayed. Treating a delayed submit as no delivery can execute the same instruction twice. Retry safety therefore depends on classifying the observed state.

### An "empty" box is not blank either

Claude Code fills an empty input box with a dim placeholder hint. A reader can misclassify that placeholder as entered text and wait indefinitely for the box to become empty.

### A first-run dialog takes the prompt instead

Starting a claude session in a new directory can open a blocking MCP approval or workspace-trust dialog. Text sent after the input box is drawn can go to the dialog instead of the prompt.

### And pressing Enter to get past it can end the session

Pressing Enter accepts the permissive default in MCP dialogs. In the workspace-trust dialog, however, the default is `No, exit`, which terminates claude. h2cv detects that dialog, does not send a key, and returns `untrusted-workspace` while leaving the session running. Workspace trust requires user approval.

<details>
<summary>The rest of the list</summary>

- You send a message to a pane, the box has not repainted yet, and the agent — seeing nothing there — sends it a second time
- Scrollback still holds frames that scrolled away seconds ago, so reading "recent output" verifies the past: the dialog, the prompt line, or the status label you are looking for may already be gone
- Emptying the input box means sending Ctrl+C. Send it exactly once and the box clears as intended; send it twice and the session is over — which is why h2cv never sends it, and reports a box it cannot use instead
- While claude is connecting to Remote Control the agent looks like it is waiting for messages, but everything actually sent during that window is thrown away
- Terminals wrap multibyte characters in cells, so a read-back cannot simply be compared against the string that was sent

</details>

h2cv handles each case with deterministic checks and reports the observed state. `h2cv explain failure-modes` lists each failure mode, its mitigation, and the corresponding documentation topic.

### And the list keeps growing

claude and herdr change frequently, and upstream releases can introduce new failure modes. Some cases remain unresolved: a send retry can misclassify an accepted submit as undelivered and create duplicates.

h2cv provides a compatibility layer while herdr and Claude Code continue to change.

## Requirements

- Node.js 20 or newer (no runtime dependencies)
- `herdr` and `claude` on `PATH`
  - both are executed as external commands, never bundled or redistributed
- A running herdr server (`herdr server`), kept resident by whatever means you prefer
  - h2cv only probes for liveness and fails with `server-down` when it is absent; it never starts the server for you. See `h2cv explain launch-sequence` for why the line is drawn there

Tested with claude 2.1.284 / herdr 0.9.0 (agent detection manifest 2026.09.11.1).

## Install

```bash
npm install -g h2cv
```

## Quick start

Hand it to an agent and let it read its own manual. `h2cv --help` is a machine-readable command catalog and `h2cv explain` is the mechanics; both are written to be consumed by an LLM and relayed to you.

```bash
claude -p '
  Using the `npx h2cv` command,
  start another Claude Code session with --remote-control.
  Read `npx h2cv --help` first.'
```

### `launch` — start a session and deliver the first prompt

```bash
h2cv launch \
  --cwd /home/you/project \
  --agent-name my-agent \
  --prompt '/summarize README.md' \
  -- \
    --model claude-sonnet-5 \
    --remote-control my-agent \
    -n my-agent
```

Everything after `--` is passed straight through to `claude`, and nothing is added to it. The
session name `claude` sees (`-n`) and remote control are yours to pass; `--agent-name` only names
the herdr agent and the tab. Omit `--prompt` to start the session.

`--agent-name` is optional. herdr needs a name to start an agent at all, so omitting it derives one
from the pane (`h2cv-w<N>-p<M>`) and labels the tab with the basename of `--cwd`; the name that was
used comes back as `agentName` in the success JSON either way.

Pass `--pane <paneId>` in place of `--cwd` to start the session in a pane you created yourself. The startup sequence is otherwise identical — the pane is still probed for shell readiness before anything is typed into it — but the tab is yours to create and to close.

### `send` — deliver text to an existing pane and verify the submit

```bash
h2cv send --pane "$HERDR_PANE_ID" 'run the tests and report failures'
h2cv send --agent-name my-agent 'run the tests and report failures'
```

The destination is exactly one of `--pane <paneId>` or `--agent-name <name>`, and `wait-input-ready`
takes the same pair. `--pane` is the handle to carry around: a canonical pane id (`w<N>:p<M>`, where
each number is base32 over `123456789ABCDEFGHJKMNPQRSTVWXYZ0`, so anything past the ninth pane reads
like `w1:p2K`) whose value stays valid across waits and retries, and inside a session
`$HERDR_PANE_ID` already holds it.
`--agent-name` is folded into a pane id by a single `agent get` before anything is typed — the name
itself is not a handle, because its binding is released the moment claude exits, so a name that
resolves to nothing fails as `agent-vanished` rather than typing anywhere.

Slash commands go through the same command. Anything that starts a turn is verified by waiting for the session to start working; commands that never start one (`/clear`, `/rename`, `/exit`, `/quit`) are verified by watching the input box clear instead. The caller does not have to know which is which — `send` picks the check from the text, and says which one it used.

```json
{
  "ok": true,
  "target": "w1:p58",
  "attempts": 1,
  "evidence": "herdr-agent-working",
  "trace": [
    { "attempt": 1, "stage": "alive", "ms": 41, "result": "ok" },
    { "attempt": 1, "stage": "box", "ms": 38, "result": "ok" },
    { "attempt": 1, "stage": "type", "ms": 94, "result": "ok" },
    { "attempt": 1, "stage": "enter", "ms": 199, "result": "ok" }
  ]
}
```

Every step of the run is a named stage, and `trace` records how long each one took and how it ended. `evidence` says what actually proved the submit landed.

When the submit cannot be verified, the same command returns `ok: false` with `error: "send-unverified"`, the `stage` it stopped in, and the terminal snapshot (`verify`, `sendVerdict`, `lastAgentStatus`, `boxBody`, `paneTail`, `detection`) that tells the caller whether re-firing is safe.

Every failure object carries a `hint` pointing at the topic that explains it. An agent that reads the hint can work out what to do next on its own.

```json
{
  "ok": false,
  "error": "send-unverified",
  "stage": "enter",
  "verify": "herdr-agent-working",
  "sendVerdict": "submitted-late",
  "hint": "h2cv explain send-protocol"
}
```

## Examples

### Have a running session start another one and run a skill

The prompt above starts a session and stops there. An agent that has read `h2cv --help` can go one
step further in the same prompt: open a pane, start a session in it, and hand that session a skill
to run.

```bash
claude -p '
  Using the `npx h2cv` command,
  launch another Claude Code session in a new pane
  and have it run the `/review` skill.'
```

### Start a skill session on a schedule

`launch` is one command that starts a session, delivers the first prompt, and exits — so anything
that can run a command can start a skill session, with no agent in the loop. A systemd user service
and the timer that fires it:

```ini
# ~/.config/systemd/user/standup-morning.service
# If you keep the herdr server in a unit of your own, point Requires=/After= at it here.

[Service]
Type=oneshot
ExecStart=/usr/bin/env h2cv launch \
  --cwd /home/you/project \
  --agent-name morning-session \
  --prompt '/standup Take stock of what happened last night.' \
  -- \
    --model claude-sonnet-5 \
    --remote-control morning-session \
    -n morning-session
```

```ini
# ~/.config/systemd/user/standup-morning.timer
[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now standup-morning.timer
```

`launch` never closes the tab it created, so the session is still sitting in its pane — with the
skill run behind it — when you get to the machine. The unit's own exit status is the startup
verdict: the launch JSON goes to the journal, and a startup that could not be verified fails the
unit rather than leaving a silent pane.

## Documentation

`h2cv explain` tells your AI agent how each layer actually behaves — the startup pipeline, the input-ready stages, the send protocol, the output contract, and the failure modes it exists to defend against. Each topic carries the stage table it covers, generated from the same registry the implementation reports `stage` and `trace` from.

```bash
h2cv explain                 # topic list
h2cv explain failure-modes   # what goes wrong, and where each defense lives
h2cv explain send-protocol   # a topic
h2cv explain send-unverified # or an error code you just received
h2cv --help                  # machine-readable command catalog
```

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit over src and bin
npm run build     # emit dist/
```

`smoke.test.ts` drives the real `claude` and `herdr` binaries, so it is skipped unless `EXTERNAL` is
set in the environment.

## License

MIT
