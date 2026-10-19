# h2cv (herdr sends to claude verifiably)

Hand Claude Code a job that is bigger than one session — or one you want done while you are away — and let it start the extra Claude Code sessions it needs, with each instruction verified as delivered.

<a href="https://github.com/sakamossan/h2cv-demo"><img src="https://github.com/sakamossan/h2cv-demo/releases/download/demo-assets/demo.gif" alt="A Claude Code session starting three Claude Code sessions with h2cv" /></a>

## What it's for

- **Run work while you are away.** A timer starts a claude session at 09:00 with a skill to run, and the result is waiting in its pane when you sit down.
- **Split a job across sessions.** One session plans and starts reviewers or implementers in parallel panes, instead of doing everything in one context.
- **Assign roles.** A long-lived session hands follow-up work to a fresh session with a clean context, instead of carrying everything forever.

All of these need one claude session (or a script) to start another claude session and type into it. h2cv is the one command that does that and tells you, in JSON, whether it worked.

It runs on top of [herdr](https://herdr.dev), a terminal workspace manager for AI coding agents: herdr owns the tabs and panes the sessions live in, and `herdr server` is its headless server.

## Try it in 60 seconds

You need `herdr` and `claude` on `PATH`, a running `herdr server`, and a directory you have opened claude in before (a new directory shows the workspace-trust dialog, and h2cv stops with `untrusted-workspace` rather than answer it for you).

```bash
npm install -g h2cv
h2cv launch --cwd ~/your-project --prompt 'Say hello in one sentence, then stop.'
```

A new tab named after the directory appears in herdr, claude starts in it, and the prompt is typed and submitted. A few seconds later the command prints one JSON document with `ok: true`, the `pane` the session lives in, and the generated `agentName`. Switch to that tab and claude has already answered. Close the tab when you are done; h2cv leaves it open on purpose.

The more common way to use it is to hand it to an agent and let it read its own manual. `h2cv --help` is a machine-readable command catalog and `h2cv explain` is the mechanics; both are written to be consumed by an LLM and relayed to you.

```bash
claude -p '
  Using the `npx h2cv` command,
  start another Claude Code session with --remote-control.
  Read `npx h2cv --help` first.'
```

## Why this needs a tool

herdr ships a skill file for AI agents, and asking claude to "type this into the other pane" looks like it should be enough. In practice the instruction arrives on the fourth attempt, or twice, and the agent spends your tokens and your waiting time on pane ids and screen dumps instead of the work. You end up checking on it because nothing seems to be happening. Two examples of what goes wrong in the Claude input box:

- **The completion menu eats your Enter.** A prompt that starts with `/review` opens the completion menu, and the Enter that should submit it only closes the menu. The body sits in the box, and sending the whole message again creates a duplicate.
- **An "empty" box is not blank.** Claude Code fills an empty input box with a dim placeholder hint, so a reader that waits for the box to clear can misread the hint as typed text and wait forever.

No single retry or sleep fixes these; each one needs its own check of the screen.

<a href="https://imgflip.com/i/ayqhq9"><img src="https://i.imgflip.com/ayqhq9.jpg" alt="Just use if statements." /></a>

h2cv runs those checks deterministically and reports the state it observed. `h2cv explain failure-modes` lists every failure mode it defends against, its mitigation, and the documentation topic for it. claude and herdr change often, and h2cv is the compatibility layer that absorbs those changes.

## Requirements

- Node.js 20 or newer (no runtime dependencies)
- `herdr` and `claude` on `PATH`
  - both are executed as external commands, never bundled or redistributed
- A running herdr server (`herdr server`), kept resident by whatever means you prefer
  - h2cv only probes for liveness and fails with `server-down` when it is absent; it never starts the server for you. See `h2cv explain launch-sequence` for why the line is drawn there

Tested with claude 2.1.303 / herdr 0.9.3 (agent detection manifest 2026.10.11.1).

## Install

```bash
npm install -g h2cv
```

## Commands

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

Everything after `--` is passed straight through to `claude`, and nothing is added to it. The session name `claude` sees (`-n`) and remote control are yours to pass; `--agent-name` only names the herdr agent and the tab. Omit `--prompt` to start the session.

`--agent-name` is optional. herdr needs a name to start an agent at all, so omitting it derives one from the pane (`h2cv-w<N>-p<M>`) and labels the tab with the basename of `--cwd`; the name that was used comes back as `agentName` in the success JSON either way.

Pass `--pane <paneId>` in place of `--cwd` to start the session in a pane you created yourself. The startup sequence is otherwise identical — the pane is still probed for shell readiness before anything is typed into it — but the tab is yours to create and to close.

### `send` — deliver text to an existing pane and verify the submit

```bash
h2cv send --pane "$HERDR_PANE_ID" 'run the tests and report failures'
h2cv send --agent-name my-agent 'run the tests and report failures'
```

The destination is exactly one of `--pane <paneId>` or `--agent-name <name>`. `--pane` is the handle to carry around: a canonical pane id (`w<N>:p<M>`, where each number is base32 over `123456789ABCDEFGHJKMNPQRSTVWXYZ0`, so anything past the ninth pane reads like `w1:p2K`) whose value stays valid across waits and retries, and inside a session `$HERDR_PANE_ID` already holds it. `--agent-name` is folded into a pane id by a single `agent get` before anything is typed — the name itself is not a handle, because its binding is released the moment claude exits, so a name that resolves to nothing fails as `agent-vanished` rather than typing anywhere.

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

### `explain` — how each layer behaves

`h2cv explain` tells your AI agent how each layer actually behaves — the startup pipeline, the input-ready stages, the send protocol, the output contract, and the failure modes it exists to defend against. Each topic carries the stage table it covers, generated from the same registry the implementation reports `stage` and `trace` from.

```bash
h2cv explain                 # topic list
h2cv explain failure-modes   # what goes wrong, and where each defense lives
h2cv explain send-protocol   # a topic
h2cv explain send-unverified # or an error code you just received
```

## Examples

### Start a skill session on a schedule

`launch` is one command that starts a session, delivers the first prompt, and exits — so anything that can run a command can start a skill session, with no agent in the loop. A systemd user service and the timer that fires it:

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

`launch` never closes the tab it created, so the session is still sitting in its pane — with the skill run behind it — when you get to the machine. The unit's own exit status is the startup verdict: the launch JSON goes to the journal, and a startup that could not be verified fails the unit rather than leaving a silent pane.

### Have a running session start another one and run a skill

An agent that has read `h2cv --help` can open a pane, start a session in it, and hand that session a skill to run, all from one prompt.

```bash
claude -p '
  Using the `npx h2cv` command,
  launch another Claude Code session in a new pane
  and have it run the `/review` skill.'
```

## Documentation

`h2cv --help` is the machine-readable catalog of every command, including the two this page does not cover: `wait-input-ready` (wait until a pane can take input, without sending anything; it takes the same `--pane` / `--agent-name` pair as `send`) and `self-send` (a send whose target is the caller's own pane). `h2cv explain` without arguments lists the topics.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit over src and bin
npm run build     # emit dist/
```

`smoke.test.ts` drives the real `claude` and `herdr` binaries, so it is skipped unless `EXTERNAL` is set in the environment.

## License

MIT
