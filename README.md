# dsh-seat — a DeepSeek Harness runner preset for OpenRig

A small, dependency-free runner that hosts a **DeepSeek Harness (`dsh`)** agent in an OpenRig
seat's tmux pane. `bin/dsh-seat` implements OpenRig's **runner contract** (the draft current
through 0.7.9) and passes its official conformance check; `preset/dsh.yaml` is the preset to
declare it.

**Permissions changed in 0.7.8: the default is now permit, not refuse.** When a person can be
asked, OpenRig routes the request to them; when nobody can be asked (no registered person,
unreachable daemon, an older OpenRig that answers 404), the runner permits with the agent's own
`allow_once` option (else `allow_always`). The old refuse-and-hold posture is opt-in with
`--deny`. See [Permissions](#permissions-and-the-078-default).

This is an independent project, not affiliated with or supported by OpenRig or DeepSeek. It
talks to `dsh` over its published `acp` profile (ACP v1, newline-delimited JSON-RPC on stdio) and
to OpenRig over the documented runner environment and `POST /api/activity/hooks`. Licensed
Apache-2.0.

## What it does

| Contract area | This runner |
|---|---|
| **Identity** | Writes the launch record to `OPENRIG_LAUNCH_RESULT` after `session/new` (or a successful resume), with `format: 1`, the attempt, the preset name, the agent's `nativeRef`, and a `producer` naming the runner, dsh and ACP versions (`dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1`). A failed handshake writes no conversation. |
| **Activity** | `UserPromptSubmit/accepted`; working posts from real ACP activity — `PreToolUse/<tool kind>` on every `tool_call` (unthrottled), `active/agent_message` on a message or thought chunk (at most one per 10 s per turn); a **working beat** `active/liveness` every 5 s with `livenessSeconds: 15` while a prompt is outstanding and the child is alive; `active/permission_resolved` with the `askId` after a person's answer or a permit; `Notification/permission_prompt` only when refusing-and-holding; `Notification/runtime_error`; the turn's `Stop/<stopReason>` and a 60 s `Stop/idle_heartbeat`, both with `livenessSeconds: 60`; `Stop/dsh_exited` on agent exit. Every post made for a turn carries its `turnId`; one sequence rises across the process. The beat stops on the turn's Stop, a permission ask, attention, exit and shutdown, and never runs while a person is asked. |
| **Input** | Raw mode + bracketed paste. One submitted block — newlines included — becomes exactly one `session/prompt`, byte for byte. A block sent mid-turn queues for the next turn. |
| **Control** | A block that is exactly `/abort`, or Ctrl-C outside a paste, sends ACP `session/cancel`. `Stop/cancelled` is posted only when the agent itself returns `stopReason: "cancelled"`. |
| **Permissions** | Submits the live request to `POST /api/activity/permission-requests` (the contract's body: session/occupant/conversation/turn, the agent's unchanged `requestId`, tool call and options). If a person is asked, OpenRig records `permission_prompt` and the runner reads the ask (`GET …/<askId>?waitSeconds=25`) until the turn ends, delivering the chosen option once, or `cancelled` for refused/withdrawn/stale. Concurrent asks are tracked independently: no working beat while any is pending, each is delivered once, and all open asks are withdrawn on cancel/end/exit. `permitted` (at submit or read) delivers that option; no one can be asked (404, unreachable, unlisted status, or a refusal the table marks permit) gives the agent its `allow_once`, else `allow_always`. Only `denied_by_seat`/`options_unsupported`/`--deny`/no-allow-option refuse and hold: title in the pane, `Notification/permission_prompt`, attention until the next accepted prompt. Withdraws an open ask on cancel/end/exit with `turn_cancelled`/`turn_ended`/`exited`. Unknown agent requests get JSON-RPC `-32601`. |
| **Resume** | With `OPENRIG_RESUME_REF`, calls ACP `session/resume` (falling back to `session/load` only for other ACP agents that advertise it). Never calls `session/new` on a resume. dsh 0.2.1-rc.2 advertises `sessionCapabilities.resume` and no `loadSession`; `session/load` returns `-32601`. dsh's "not resumable"/not-found refusal is recorded as `error: "missing"`; any other failure is left unconfirmed. The pane states `resuming <ref> (asked by OpenRig)` or `new conversation (OpenRig passed no resume ref)`. `--require-resume` / `DSH_SEAT_REQUIRE_RESUME=1` refuses a launch with no resume ref before spawning dsh: no conversation is created, and the record carries `error: "resume_required"`. |
| **First input / model** | `OPENRIG_FIRST_INPUT` bytes become the first prompt. `OPENRIG_MODEL` is matched against dsh's advertised `model` option: `provider/model` (provider exact or a substring such as `deepseek` for `deepseek-official`, model id unique), a unique bare model id, or an exact opaque selector. The mapped value is applied with `session/set_config_option` on fresh launches **and on resumes** (from the resume's `configOptions`). A value that cannot be mapped is reported in the pane with what dsh advertised and dsh's own default remains; a raw value is never sent. |
| **Agent environment** | The child gets the baseline shell, OpenRig's identity/routing variables (`OPENRIG_SESSION_NAME`, `OPENRIG_NODE_ID`, `OPENRIG_RUNTIME`, `OPENRIG_OCCUPANT_GENERATION`, `OPENRIG_HOME/URL/HOST/PORT`), the seat's own `DSH_HOME`, dsh's telemetry choice (`DSH_TELEMETRY_DISABLED=1` unless the operator set one), and the declared provider's key when set. It does not inherit the activity hook token or the runner-only launch/attempt/resume variables. |

## Install

Requirements: Node 22+, `dsh` with the `acp` profile installed and on `PATH`, OpenRig 0.7.6+ (the
runner contract; answered permissions from 0.7.8, the working beat from 0.7.9), and tmux. On an
older daemon the beat is harmless — that daemon already maps `active` to running — and the
permission routes answer 404, which takes the permit path.

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

### Permissions and the 0.7.8 default

`session/request_permission` is no longer refused by default. The runner submits it to the
answered-path route. A person (the default person, the seat's chosen person) gets the ask and
OpenRig records needs-input; the runner reads their answer and delivers the chosen option once.
When nobody can be asked, the runner permits with the agent's own `allow_once` (else
`allow_always`) — including an OpenRig without the route (404), an unreachable daemon, and a
status/code the contract doesn't list.

This is a **security-relevant behaviour change**: a request that used to stop for a human can now
be permitted automatically when OpenRig cannot route it. Set `--deny` in the preset command
(`command: dsh-seat --deny`) or use `rig seat set-permissions-to <seat> --deny --reason "…"` for
the old refuse-and-hold posture. Unknown agent requests remain `-32601`.

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

- **The default is permit.** When nobody can be asked — no registered person, several and no
  default, an unreachable daemon, an OpenRig older than 0.7.8 that answers 404 — the agent gets
  its own `allow_once` (else `allow_always`). Set `--deny` for the old refusal posture.
- With `--deny`, `denied_by_seat` or `options_unsupported`, the request is refused at once, the
  tool title is shown, `Notification/permission_prompt` is posted, and attention is held until
  the next accepted prompt or `rig seat clear-attention`.
- An ask that reaches a person stays pending and visible until the agent's turn ends; it is never
  timed out into a grant. The runner reads at most 25 s per read (re-reading until the turn ends);
  a read that gets no answer within its 30 s client bound is treated as "nobody can be asked" and
  permits, rather than holding the turn.
- Concurrent permission requests are tracked independently: no working beat while any is pending,
  each option is delivered once, and every open ask is withdrawn (`turn_cancelled`, `turn_ended`,
  `exited`) when the turn ends.
- A person's own words (`said`, 0.7.9) are queued to the agent as an ordinary prompt after the
  turn, behind anything already waiting; they are never the permission answer.
- A prompt whose whole text is `/abort` cannot be sent; Ctrl-C inside a paste also aborts.
- Without a TTY the runner reads input line by line; the channel is not binary-safe.
- Fork is unsupported.
- Guidance, skills and startup files are not placed by OpenRig for community harnesses and are
  not projected by this runner.
- The declared model is matched by `provider/model` (provider exact or a substring, unique model
  id), a unique bare id, or an exact opaque selector, and applied on fresh launches and resumes.
  A value that cannot be mapped is reported in the pane with dsh's advertised choices; dsh's own
  default remains.
- The agent child gets the baseline shell, OpenRig identity/routing variables, its own `DSH_HOME`,
  dsh's telemetry choice, and the declared provider's key. `DSH_TELEMETRY_DISABLED=1` is set
  unless the operator chose a telemetry setting; the activity hook token and runner-only launch
  variables never cross.
- A per-seat `DSH_HOME` is provisioned when `DSH_HOME` is unset; an explicit `DSH_HOME=$HOME/.dsh`
  (the operator's home) is refused. The generated home disables dsh's session-log and
  plugin-inventory uploads via `cordis.patch.yml`.
- Reopening uses `session/resume`; tested with dsh 0.2.1-rc.2, which advertises
  `sessionCapabilities.resume` and no `loadSession` (`session/load` returns `-32601`). The
  `session/load` fallback is for other ACP agents only.
- Activity reports real ACP events: accepted, tool calls, message chunks, the working beat,
  permission resolution/refusal, the turn's end and the agent's exit. Message/thought chunks are
  throttled to one `active` post per 10 s per turn; the working beat is `active/liveness` every
  5 s (`livenessSeconds: 15`) while a prompt is outstanding and the child is alive. Idle liveness
  is a `Stop` at turn end plus a `Stop/idle_heartbeat` every 60 s, both with `livenessSeconds: 60`.
- On a 0.7.6/0.7.7 daemon the working beat is harmless: that daemon already maps `active` to
  running (it is not an unknown event), and the permission routes answer 404, which takes the
  permit path. A real 0.7.7 daemon was not available to run here.
- Carrying a `turnId` does not make OpenRig reject a stale event; that is daemon-side work on
  OpenRig #43.
- Stop kills the runner's agent child on hangup; OpenRig does no external compute cleanup.
- Resume uses ACP `session/resume`; a dsh "not resumable" or not-found refusal is reported as
  missing, any other failure is left unconfirmed. A changed declared model is applied on resume.

## Conformance

The checker is OpenRig's official runner conformance check from
[`docs/reference/runner-conformance/`](https://github.com/mvschwarz/openrig/tree/main/docs/reference/runner-conformance)
(upstream/main at `2b929b3d7`; it changed in #2368 and #2375 after 0.7.7). It substitutes a fake ACP
agent for dsh and drives the runner in a private tmux server:

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
| 3b | Working beat: names the open turn, keeps order, comes often enough, stops at Stop and while a person is asked; `permission_resolved` before the next beat; permit-at-submit keeps beating | pass |
| 4 | Default permit when nobody can be asked (404/unreachable); refuse-and-hold only on `denied_by_seat` or no allow option | pass |
| 4b | Answered permissions: submit, read ≤25 s, deliver the answer/permit once, refuse/cancel/withdraw per the table, no ask for permit-at-submit | pass |
| 4c | The person's words (`said`) are queued as a prompt (advisory) | met (advisory; not counted) |
| 5 | Every post carries `OPENRIG_OCCUPANT_GENERATION` | pass |
| 6 | Resume the same conversation; honest missing; no new conversation | pass |
| 7 | Agent dies mid-turn → `Stop/dsh_exited`, never idle | pass |
| 7b | Failed prompt → `Notification/runtime_error`, not a permission request | pass |
| 7c | Closing the pane ends the agent (advisory, proposed section 9) | met (advisory; not counted) |
| 8 | Unknown agent request → `-32601`, then prompts still work | pass |
| 9 | `OPENRIG_FIRST_INPUT` exact bytes as the first prompt | pass |

**13 pass, 0 fail, 0 skip, 2 advisory (both met) — exit status 0.** The updated checker added
cases 3b, 4b and 4c and reworked case 4. The eleven original case IDs remain and pass under the
updated checker; case 4 was reworked for the 0.7.8 permit default, and the old checker's case 4
fails by design because it asserts refuse-by-default. The exact command and machine-readable
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
