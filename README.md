# dsh-seat — a DeepSeek Harness runner preset for OpenRig

A small, dependency-free runner that hosts a **DeepSeek Harness (`dsh`)** agent in an OpenRig
seat's tmux pane. `bin/dsh-seat` implements OpenRig's **runner contract** (the draft published
with 0.7.6) and passes its official conformance check; `preset/dsh.yaml` is the preset to
declare it.

This is an independent project, not affiliated with or supported by OpenRig or DeepSeek. It
talks to `dsh` over its published `acp` profile (ACP v1, newline-delimited JSON-RPC on stdio) and
to OpenRig over the documented runner environment and `POST /api/activity/hooks`. Licensed
Apache-2.0.

## What it does

| Contract area | This runner |
|---|---|
| **Identity** | Writes the launch record to `OPENRIG_LAUNCH_RESULT` after `session/new` (or a successful resume), with `format: 1`, the attempt, the preset name, the agent's `nativeRef`, and a `producer` naming the runner, dsh and ACP versions (`dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1`). A failed handshake writes no conversation. |
| **Activity** | `UserPromptSubmit/accepted`; working posts from real ACP activity — `PreToolUse/<tool kind>` on every `tool_call` (unthrottled), `active/agent_message` on a message or thought chunk (at most one per 10 s per turn); `Notification/permission_prompt`; `Notification/runtime_error`; the turn's `Stop/<stopReason>` and a 60 s `Stop/idle_heartbeat`, both with `livenessSeconds: 60`; `Stop/dsh_exited` on agent exit. Every post made for a turn carries its `turnId`. Posts are queued in order and never block the agent. |
| **Input** | Raw mode + bracketed paste. One submitted block — newlines included — becomes exactly one `session/prompt`, byte for byte. A block sent mid-turn queues for the next turn. |
| **Control** | A block that is exactly `/abort`, or Ctrl-C outside a paste, sends ACP `session/cancel`. `Stop/cancelled` is posted only when the agent itself returns `stopReason: "cancelled"`. |
| **Permissions** | Every `session/request_permission` is refused at once with `{"outcome":{"outcome":"cancelled"}}`, the requested tool title is shown in the pane, `Notification/permission_prompt` is posted, and the attention is held until the next accepted prompt. Unknown agent requests get JSON-RPC `-32601`. |
| **Resume** | With `OPENRIG_RESUME_REF`, calls ACP `session/resume` (falling back to `session/load` only for other ACP agents that advertise it). Never calls `session/new` on a resume. dsh 0.2.1-rc.2 advertises `sessionCapabilities.resume` and no `loadSession`; `session/load` returns `-32601`. dsh's "not resumable"/not-found refusal is recorded as `error: "missing"`; any other failure is left unconfirmed. The pane states `resuming <ref> (asked by OpenRig)` or `new conversation (OpenRig passed no resume ref)`. `--require-resume` / `DSH_SEAT_REQUIRE_RESUME=1` refuses a launch with no resume ref before spawning dsh: no conversation is created, and the record carries `error: "resume_required"`. |
| **First input / model** | `OPENRIG_FIRST_INPUT` bytes become the first prompt. `OPENRIG_MODEL` is matched against dsh's advertised `model` option: `provider/model` (provider exact or a substring such as `deepseek` for `deepseek-official`, model id unique), a unique bare model id, or an exact opaque selector. The mapped value is applied with `session/set_config_option` on fresh launches **and on resumes** (from the resume's `configOptions`). A value that cannot be mapped is reported in the pane with what dsh advertised and dsh's own default remains; a raw value is never sent. |
| **Agent environment** | The child gets the baseline shell, OpenRig's identity/routing variables (`OPENRIG_SESSION_NAME`, `OPENRIG_NODE_ID`, `OPENRIG_RUNTIME`, `OPENRIG_OCCUPANT_GENERATION`, `OPENRIG_HOME/URL/HOST/PORT`), the seat's own `DSH_HOME`, dsh's telemetry choice (`DSH_TELEMETRY_DISABLED=1` unless the operator set one), and the declared provider's key when set. It does not inherit the activity hook token or the runner-only launch/attempt/resume variables. |

## Install

Requirements: Node 22+, `dsh` with the `acp` profile installed and on `PATH`, OpenRig 0.7.6+ (the
runner contract), and tmux.

```sh
git clone https://github.com/bpamiri/dsh-seat.git
cd dsh-seat
npm link                 # puts `dsh-seat` on PATH (no runtime dependencies)
mkdir -p "${OPENRIG_HOME:-$HOME/.openrig}/community-harnesses"
cp preset/dsh.yaml "${OPENRIG_HOME:-$HOME/.openrig}/community-harnesses/dsh.yaml"
```

The preset's command is `dsh-seat`; it starts `dsh --profile acp` unless you pass
`--agent-command` (for example `dsh-seat --agent-command 'dsh --profile acp'`).

### DSH_HOME

A seat needs its own writable `DSH_HOME`: dsh rewrites the profile on every boot and writes
`sessions`, `storages` and `.anonymous-user-id` into the home. With `DSH_HOME` unset, the runner
provisions `$OPENRIG_HOME/state/dsh/<session>/dsh-home` (or `~/.openrig/...`), copying the operator's
`~/.dsh/profiles/acp` when it exists and linking the shared `profiles/node_modules`; it writes a
`cordis.patch.yml` that turns off dsh's session-log and plugin-package-inventory uploads. It never
copies or links `.credentials.yaml`. If `DSH_HOME` is explicitly the operator's `~/.dsh`, the runner
refuses to start; point it at a per-seat writable home instead.

### The preset

```yaml
format: 1
name: dsh
command: dsh-seat
maintainer: bpamiri
runner: true
launch_result: true
first_input: true
passes_model: true
resume: true
limits: ...   # see preset/dsh.yaml
```

## Limits

- Permission requests are refused at once (first version); a job that needs an edit or command
  approved cannot finish. Attention clears on the next accepted prompt or with
  `rig seat clear-attention <session> --reason "…"`.
- A prompt whose whole text is `/abort` cannot be sent; Ctrl-C inside a paste also aborts.
- Without a TTY the runner reads input line by line; the channel is not binary-safe.
- Fork is unsupported.
- Guidance, skills and startup files are not placed by OpenRig for community harnesses and are
  not projected by this runner.
- The declared model is matched by `provider/model` (provider exact or a substring, unique model
  id), a unique bare id, or an exact opaque selector, and applied on fresh launches and resumes. A value that cannot be mapped is reported
  in the pane with dsh's advertised choices; dsh's own default remains.
- The agent child gets the baseline shell, OpenRig identity/routing variables, its own `DSH_HOME`,
  dsh's telemetry choice, and the declared provider's key. `DSH_TELEMETRY_DISABLED=1` is set unless
  the operator chose a telemetry setting; the activity hook token and runner-only launch variables
  never cross.
- A per-seat `DSH_HOME` is provisioned when `DSH_HOME` is unset; an explicit `DSH_HOME=$HOME/.dsh`
  (the operator's home) is refused. The generated home disables dsh's session-log and plugin-inventory
  uploads via `cordis.patch.yml`.
- Reopening uses `session/resume`; tested with dsh 0.2.1-rc.2, which advertises
  `sessionCapabilities.resume` and no `loadSession` (`session/load` returns `-32601`). The
  `session/load` fallback is for other ACP agents only.
- Activity reports real ACP events: an accepted prompt, permission notices, tool calls, message
  chunks, the turn's end and the agent's exit. Every tool call posts `PreToolUse` (unthrottled);
  message and thought chunks are throttled to at most one `active` post per 10 s per turn. Every
  post for a turn carries its `turnId`.
- A long silent step — a tool call or thinking with no output — still reads unknown after 15 s;
  event-driven posts cannot cover silence.
- Idle liveness is a `Stop` at turn end plus a `Stop/idle_heartbeat` every 60 s, both with
  `livenessSeconds: 60`. The heartbeat runs only while no turn is open, no attention is held, the
  agent is alive and the runner is not shutting down; it stops on a new accepted prompt, on
  attention, on child exit and on shutdown.
- Carrying a `turnId` does not make OpenRig reject a stale event; that is the daemon-side work on
  OpenRig #43.
- Stop kills the runner's agent child on hangup; OpenRig does no external compute cleanup.
- Resume uses ACP `session/resume`; a dsh "not resumable" or not-found refusal is reported as
  missing, any other failure is left unconfirmed. A changed declared model is applied on resume.

## Conformance

The checker is OpenRig's official runner conformance check from
[`docs/reference/runner-conformance/`](https://github.com/mvschwarz/openrig/tree/main/docs/reference/runner-conformance)
(upstream/main at `ff604d943`, published with 0.7.6). It substitutes a fake ACP agent for dsh and
drives the runner in a private tmux server:

```sh
node check-runner.mjs \
  --runner '/absolute/path/to/dsh-seat/bin/dsh-seat --agent-command {agent}' \
  --name dsh --resume --first-input --json
```

Result (the conformance JSON is in
[`conformance/openrig-runner-conformance.json`](conformance/openrig-runner-conformance.json)):

| Case | Contract | Result |
|---|---|---|
| 1 | Handshake: record only after the conversation is open | pass |
| 1b | Failed initialize / session/new: no record, no accepted/idle post | pass |
| 2 | One block = one prompt; queued mid-turn; `/abort` and Ctrl-C; cancelled only on the agent's stop reason | pass |
| 3 | Activity: accepted with `turnId`, then `Stop/end_turn`; all fields, token, identity, rising sequence | pass |
| 4 | Permission refused at once, shown, held as needs input; no idle Stop while held | pass |
| 5 | Every post carries `OPENRIG_OCCUPANT_GENERATION` | pass |
| 6 | Resume the same conversation; honest missing; no new conversation | pass |
| 7 | Agent dies mid-turn → `Stop/dsh_exited`, never idle | pass |
| 7b | Failed prompt → `Notification/runtime_error`, not a permission request | pass |
| 7c | Closing the pane ends the agent (advisory, proposed section 9) | met (advisory; not counted) |
| 8 | Unknown agent request → `-32601`, then prompts still work | pass |
| 9 | `OPENRIG_FIRST_INPUT` exact bytes as the first prompt | pass |

**11 pass, 0 fail, 0 skip, 1 advisory (met) — exit status 0.** The exact command and machine-readable
results are committed under `conformance/`.

### Real dsh check

Against `dsh 0.2.1-rc.2` (`acp` profile), without a model turn: `initialize` succeeds; `session/new`
opens a conversation; after `session/close`, `session/resume` with the same id reopens it; an unknown
id is refused with `-32602 Invalid params: session is not resumable: <id>` and a live one with
`session is already active: <id>`. The model resolver was also exercised live against dsh's
advertised choices: bare `deepseek-v4-flash`, `deepseek/deepseek-v4-flash` and
`deepseek-official/deepseek-v4-flash` all resolve to dsh's opaque selector; an unadvertised value is
reported and not sent; and a different declared model applied after a reopen is visible in the
`set_config_option` reply's `currentValue` (dsh does not persist the selection across close+resume;
the runner re-applies the declared model on every resume). No paid model turn was run, and no
attempt was made to verify a turn's answer. The section 10 journey — a real seat, one multi-line message, working → idle, a
refused permission, `/abort`, and a real resume — is still the useful real-agent check.

## What the conformance check cannot prove

- The fake agent stands in for dsh, so dsh's own timing, model/provider behaviour and permission
  prompts are not exercised.
- How OpenRig reads these posts (working / idle / needs input / unknown after exit) is OpenRig's
  side and its own tests.
- The model handoff has no wire the checker can see; this runner maps the declared model onto
  dsh's advertised selector (including on resumes), but the effective model is shown as unknown by
  OpenRig.
- Real pty paste/truncation, a paid model turn, and a stored-credential login are not covered.

## Prior adopt-path runner

`src/dsh-seat.mjs` (installed as `dsh-seat-adopt`) is the earlier runner that lets OpenRig adopt a
dsh pane before the runner contract existed. It remains for that use; `bin/dsh-seat` is the
contract runner this repository is now about. Development notes are under `docs/`.
