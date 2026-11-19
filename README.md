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
| **Run-bound observations (v0.7.18)** | When OpenRig supplies a run-bound credential (`OPENRIG_RUN_ID` + the activity token), the runner reports the model the agent **accepted** — as `provider/model`, read from the `session/set_config_option` reply's model `currentValue`, not from the value it asked for — and the context ACP reports (`usage_update` `used`/`size`). A reply that names no model reports nothing. The report is an observation-only POST to the same endpoint (`{runId, sequence, occurredAt, observations}`), separate from activity: no `hookEvent`, no `eventFamily`, its own sequence. OpenRig shows these as **runner-reported**, not verified by OpenRig. Without `OPENRIG_RUN_ID` (an unbound install-token launch) nothing is reported. |
| **Native channel (v0.7.19)** | Optional, per seat. When OpenRig supplies a run-bound credential (`OPENRIG_RUN_ID` + the grant token), the runner opens `GET /api/activity/runner-channel`, announces `{type:"hello",version:1,runId,retained,capabilities:{input,wake,cancel}}`, and acknowledges custody of each request before any native effect. An `input` frame becomes **exactly one** `session/prompt`; a `wake` frame waits for the current turn and becomes its own dedicated prompt whose own assistant text is the only answer; a `cancel` frame targets one native invocation and is reported `requested` first, `cancelled` only on dsh's own `stopReason`. It also posts `{type:"turn",...}` opened/closed reports, so Core has the invocation id a named cancel needs. |
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
- **Observations are runner-reported, not verified.** The runner reports the model the agent accepted
  (the reply's `currentValue`; never the declared string, never a model the agent refused, and nothing
  when the reply names no model) and the context counts ACP reports. Verified live: an unadvertised
  declared model produced no config write, a context-only report, and `last observed UNKNOWN (no-data)`.
  OpenRig displays them as "runner-reported" with their sample time; they are not evidence of identity,
  input delivery or cancellation, and OpenRig did not observe them itself.
- A context report carries `usedTokens` and `windowTokens` when both are known, so occupancy is
  legitimate; a bare `usedTokens` stays a reported count (`availability: unknown`). The values are dsh's
  own `usage_update`, not a runner estimate.
- Observations need a run-bound credential (`OPENRIG_RUN_ID`); without one (unbound install token)
  the runner reports nothing. The credential stays in the runner process and is not passed to the agent.
- Reporting is change-only: unchanged facts are not re-sent. Freshness follows the daemon's ten-minute
  policy, so the runner renews known facts with a new sequence and sample time at a turn boundary when
  the last accepted report is older than five minutes — never per chunk. **The user-facing consequence:**
  an idle seat's reported model and context go stale after ten minutes and read unknown until the next
  turn renews them. That is the freshness policy working, not a lost report.
- Refusals: the runner retries `runner_observation_unverified` (409), `activity_grant_pending` (409) and
  `activity_grant_unverified` (409) unchanged, stops for a run on `runner_observation_unavailable`, and
  retires any other refusal without retrying it. Live on a 0.7.18 daemon, a conflicting sequence read
  `409 runner_observation_conflict` and an invalid report `400 invalid_runner_observation`.
- **What an operator actually sees on revocation.** The contract refuses a post at the grant stage
  before the observation branch, so after `rig down` a replayed report returns
  `401 activity_grant_revoked` — not `runner_observation_unavailable`. Nothing is fabricated and no
  event is recorded. Both observation-specific codes (`runner_observation_unverified`,
  `runner_observation_unavailable`) remain implemented for their race paths but were **not observed on
  a real daemon**.
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
- The native channel needs a run-bound credential (`OPENRIG_RUN_ID` + grant). Without one nothing connects, and the
  typed path is the whole interaction.
- The native channel has been exercised against a stand-in Core (contract tests) and **not yet against a real 0.7.19
  daemon**; the wire shapes are taken from the contract and the daemon's own dsh example.
- Stop kills the runner's agent child on hangup; OpenRig does no external compute cleanup.
- Resume uses ACP `session/resume`; a dsh "not resumable" or not-found refusal is reported as
  missing, any other failure is left unconfirmed. A changed declared model is applied on resume.

## Native channel (opt-in, v0.7.19)

Every seat still defaults to `typed`. A seat opts in with
`rig seat set-input-route <seat> --route native --reason "..."`; until then the runner receives no frames and the
typed path below is exactly what runs.

With a run-bound credential the runner opens the run-filtered channel and offers `input`, `wake` and `cancel`. When
Core sends a request the runner:

- validates it (`version`, `runId`, `requestId`, `sequence`, `kind`, payload), refuses anything that does not fit
  **before** any native or typed effect, and never falls back to typing after an uncertain one;
- retains the immutable request and its result for the process lifetime, acknowledges custody, and waits for Core's
  durable acceptance **before** writing the native prompt. HTTP receipts are retried; a native write never is;
- delivers `input` as one prompt, byte for byte — the same guarantee as the typed path, without the pane;
- treats `wake` as a dedicated prompt after the current turn: only that prompt's own assistant text and dsh's own
  terminal outcome become the answer (`{kind:"wake",answer,nativeTurnId,completion}`). Tools, earlier output and
  partial streaming text are never substituted, and an uncorrelated wake reports
  `{completion:"unknown",answer:null,ownershipUnknown:true}` instead of inventing an answer;
- treats `cancel` as a named invocation: it prepares with Core (which withdraws its asks first), rechecks the exact
  target, sends one `session/cancel`, and reports `requested`/`confirmed:false`. It reports `cancelled` only when dsh
  answers `stopReason: "cancelled"`; a target the runner does not hold is `not-this-turn`, and ownership it cannot
  establish is refused as unknown rather than claimed.

A request whose custody was accepted but whose native write could not happen is reported **unavailable** — in the
pane and to Core — never dropped silently: a nudge that dies quietly would look like an idle seat.

The typed path is unchanged and remains the rollback:
`rig seat set-input-route <seat> --route typed --reason "revert to typed input"`.

## Seeing the runner-reported model

Once the daemon has accepted an observation report, OpenRig's model read for the seat has source
`runner_reported`, and `rig ps` shows both the configured value and the last observed one with its
sample time. As observed on a real 0.7.18 daemon:

```text
Model (dev-agent@observe-rig): configured deepseek/deepseek-chat; last observed deepseek/deepseek-chat (runner-reported; sample 2026-11-17T23:29:30.187Z)
Context (…): 1.234% (runner-reported); sample …
```

Those strings are OpenRig's to change; the observed form is recorded here so a reader knows what to
expect. Until a report is accepted the model reads as unknown (`last observed UNKNOWN (no-data)`):
OpenRig never infers it from the configured value.

## Conformance

The checker is OpenRig's official runner conformance check from
[`docs/reference/runner-conformance/`](https://github.com/mvschwarz/openrig/tree/main/docs/reference/runner-conformance)
(the checker shipped with OpenRig 0.7.15, 16 case ids). It substitutes a fake ACP
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
| 10 | Launch wrapper: the runner wraps its native child and scrubs the handoff env | skip (this preset declares no `launch_wrapper`; OpenRig passes no `OPENRIG_LAUNCH_WRAPPER`) |

**13 pass, 0 fail, 1 skip, 2 advisory (both met), 181 checks — exit status 0.** The 0.7.15 checker
has 16 case ids. Case 10 is present and skipped, not passed: this preset does not declare
`launch_wrapper`, so OpenRig passes no `OPENRIG_LAUNCH_WRAPPER` and the checker has nothing to
exercise. dsh-seat does not implement the capability, and a member configured with a wrapper is
refused at preflight (exit 2, no agent started). The exact command and machine-readable results are committed under
`conformance/`.

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
