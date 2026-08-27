# h2cv (herdr sends to claude verifiably)

A command-line tool that lets Claude Code start Claude Code sessions and give them instructions.

It drives herdr underneath, and closes, in deterministic code, the problems you are bound to hit when you work the claude input box through it.

<a href="https://imgflip.com/i/ayqhq9"><img src="https://i.imgflip.com/ayqhq9.jpg" alt="Just use if statements." /></a>

## Why

herdr ships a skill file for AI agents, but a skill file on its own will not let one claude give instructions to another claude. Your agent may well get a message delivered on the fourth attempt — by which point its context is packed with pane ids and screen dumps, and it has lost the thread of whatever it was working on in the first place. The claude input box is a more complicated place than it looks. A short list of what is waiting there:

### The completion menu eats your Enter

Claude Code A sends the `/review` skill to Claude Code B with `pane run`. B does not necessarily start working. A wonders why nothing is happening and goes back to look at the pane — again, and again. The Enter never reached the prompt: the completion menu opened on the leading `/` and swallowed it, and the body is still sitting in the input box. Getting out of this takes a procedure rather than a retry, and the obvious move — send the whole thing again — is the wrong one.

### `idle` lies for about a second

Right after startup, herdr reports the agent as `idle`. Trust that, fire `agent send` immediately, and the instruction vanishes without ever running: the TUI is still initializing, and everything typed into that window is discarded. The status is not so much wrong as answering a different question than the one you asked, which is why "check the status, then send" is itself the trap.

### "It didn't arrive" has three different endings

Nothing arrived, the body arrived without a submit, or the submit landed late. The agent believes it is looking at one condition and re-fires. Read the third as the first and the same instruction runs twice. Whether a retry is safe is not a yes/no question; it is a classification problem.

### An "empty" box is not blank either

Claude Code fills the empty input box with a dim placeholder hint. So whatever reads that box back finds text inside a box that is empty, and what follows is not a double-send — it is silence: the sender is waiting for the box to look empty before it types, and the box never looks empty. (Still with me?)

### A first-run dialog takes the prompt instead

Start a claude session in a directory it has not seen before and a blocking dialog comes up — MCP approval, workspace trust. Wait for the input box to be drawn and then start typing, and everything you type goes into the dialog.

<details>
<summary>The rest of the list</summary>

- You send a message to a pane, the box has not repainted yet, and the agent — seeing nothing there — sends it a second time
- Scrollback still holds frames that scrolled away seconds ago, so reading "recent output" verifies the past: the dialog, the prompt line, or the status label you are looking for may already be gone
- Emptying the input box means sending Ctrl+C. Send it exactly once and the box clears as intended; send it twice and the session is over — which is why h2cv never sends it, and reports a box it cannot use instead
- While claude is connecting to Remote Control the agent looks like it is waiting for messages, but everything actually sent during that window is thrown away
- Terminals wrap multibyte characters in cells, so a read-back cannot simply be compared against the string that was sent

</details>

h2cv closes each of these in code — deterministic checks, not inference — and reports what it saw. The full index, with the defense for each one and the topic that documents it, is `h2cv explain failure-modes`.

### And the list keeps growing

claude and herdr are both moving targets, and every upstream release is a chance for a new one of these to appear. Not all of them are closed today either: a send retry can still misread an accepted submit as undelivered and stack duplicates.

herdr and Claude Code are each still evolving, and one day these gaps and frictions should be gone for good. Until that day, a tool built for them is the easier way to live with them.

## Requirements

- Node.js 20 or newer (no runtime dependencies)
- `herdr` and `claude` on `PATH`
  - both are executed as external commands, never bundled or redistributed
- A running herdr server (`herdr server`), kept resident by whatever means you prefer
  - h2cv only probes for liveness and fails with `server-down` when it is absent; it never starts the server for you. See `h2cv explain launch-sequence` for why the line is drawn there

Tested with claude 2.1.246 / herdr 0.8.2 (agent detection manifest 2026.08.21.1).

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
