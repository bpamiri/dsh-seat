# Runner conformance evidence

This directory records the result of OpenRig's official runner conformance check against
`bin/dsh-seat`.

## Checker

From the checker shipped with OpenRig 0.7.15 (16 case ids). The run recorded here was made in a
`node:22-alpine` container with tmux. A run on this macOS host is not a runner result and is not
committed: this host denies tmux pane forks, so it failed at startup — exit 1, 15 fail / 1 skip over
the 16 case ids, every case reporting `tmux couldn't start the runner: create window failed: fork
failed: Operation not permitted`.

- `docs/reference/runner-conformance/check-runner.mjs`
- `docs/reference/runner-conformance/fake-acp-agent.mjs`

The checker was not copied into this repository; run it from that tree (or an installed OpenRig).

## Command

```sh
node check-runner.mjs \
  --runner '/absolute/path/to/dsh-seat/bin/dsh-seat --agent-command {agent}' \
  --name dsh --resume --first-input --json
```

The `runner` field in `openrig-runner-conformance.json` shows the path the run used
(`/runner/bin/dsh-seat ...`, the container's checkout). Everything else is the checker's verbatim
output: the file is the checker's `--json` result copied in unmodified, so regenerating it is a
copy of a fresh run's output, not a hand edit.

On 0.7.15 a person's answer is two steps: the answer is recorded and the ask stays pending, and the
receiving agent or operator then decides with `rig seat decide-permission <ask> --option <id>`.
The environment and DSH_HOME checks below predate the 0.7.15 run and still hold; the checker's fake
agent stands in for dsh in every case here.

Environment of the recorded result: the `node:22-alpine` container with tmux (the macOS host
attempt above produced no runner result). The fake agent stands in for dsh, so no model,
credentials or network are involved.

## Result

`CHECK_EXIT=0`

| Case | Result |
|---|---|
| 1 handshake | pass |
| 1b failed handshake | pass |
| 2 input, queue, cancel | pass |
| 3 activity | pass |
| 3b working beat (§4, 0.7.9) | pass |
| 4 default permit / refuse-and-hold (§7, 0.7.8) | pass |
| 4b answered permissions (§7, 0.7.8) | pass |
| 4c person's words queued (advisory) | met — never counted |
| 5 generation | pass |
| 6 resume | pass |
| 7 death mid-turn | pass |
| 7b prompt error | pass |
| 7c shutdown (advisory, proposed section 9) | met — never counted |
| 8 unknown request | pass |
| 9 first input | pass |
| 10 launch wrapper | skip — this preset declares no `launch_wrapper`, so OpenRig passes no `OPENRIG_LAUNCH_WRAPPER` |

Summary: **13 pass, 0 fail, 1 skip, 2 advisory (both met)**, exit 0, 16 case ids, 181 checks.
Case 10 is present and skipped, not dropped and not passed: dsh-seat does not implement the optional
`launch_wrapper` capability and correctly does not declare it; a member configured with a wrapper is
refused at preflight with exit 2 and no agent started.

The updated checker added cases 3b, 4b and 4c and reworked case 4. The eleven original case IDs
remain and pass under the updated checker; case 4 was reworked for the 0.7.8 permit default, and
the old checker's case 4 fails by design because it asserts refuse-by-default. The checker's fake
agent stands in for dsh and scripts the ask/permit routes; a real person answering, and a real
0.7.8/0.7.9 daemon, were not available here.

A sanitized liveness reproduction (pre-beat vs working-beat post timelines and a local harness) lives in
[`liveness-repro/`](liveness-repro/README.md).

## Real dsh check (outside the checker)

Against `dsh 0.2.1-rc.2`, `acp` profile, no model turn:

- the shipped runner reopened an existing, closed conversation through `session/resume` and wrote
  `{"format":1,"attempt":"attempt-real-1","harness":"dsh","nativeRef":"d10a03a2-9829-408f-a590-0147f6a37b09","producer":"dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1"}`;
- for an unknown id, dsh answered `-32602 Invalid params: session is not resumable: <id>` and the
  runner wrote `{"format":1,"attempt":"attempt-real-1","harness":"dsh","error":"missing","producer":"dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1"}`.

A live session is refused with `session is already active: <id>`, which this runner does not
report as missing; dsh advertises `sessionCapabilities.resume` and no `loadSession`, and
`session/load` answers `-32601`.

The environment and DSH_HOME were checked live (real dsh, no model turn): the agent child received
the baseline shell, OpenRig identity/routing (`OPENRIG_URL`, `OPENRIG_SESSION_NAME`, `OPENRIG_NODE_ID`,
`OPENRIG_RUNTIME`, `OPENRIG_OCCUPANT_GENERATION`, `OPENRIG_HOME`, `OPENRIG_HOST`, `OPENRIG_PORT`),
`DSH_HOME`, `DSH_TELEMETRY_DISABLED=1`, and the declared provider key; it did **not** receive
`OPENRIG_ACTIVITY_HOOK_TOKEN` or `OPENRIG_LAUNCH_RESULT`. With `DSH_HOME` unset the runner provisioned
`$OPENRIG_HOME/state/dsh/<session>/dsh-home`; a clean simulated operator `~/.dsh` was byte-for-byte
unchanged (no `sessions`, `storages` or `.anonymous-user-id`). An explicit
`DSH_HOME=$HOME/.dsh` exited 1 before spawning the agent. (`PWD`, `SHLVL`, `_` and
`__CF_USER_TEXT_ENCODING` in the proxy's key list are added by the shell that launches the agent
command, not by the runner's allowlist.)

The model handoff was also exercised live against dsh's advertised choices, through a stdio proxy
that records the ACP wire (no model turn): bare `deepseek-v4-pro`, `deepseek/deepseek-v4-pro` and
`deepseek-official/deepseek-v4-pro` all sent the advertised opaque selector
`["deepseek-official","deepseek-v4-pro"]` and dsh accepted it (its reply's `currentValue` changed);
`acme/nope` produced the pane warning with the advertised list and sent no value; and a resume with
`OPENRIG_MODEL=deepseek/deepseek-v4-pro` reopened the requested session and then sent the same
selector. No paid model turn was run; section 10's real seat journey is still the useful real-agent
check.

## What this does not prove

- How OpenRig reads the posts (working/idle/needs input/unknown after exit) — that is OpenRig's side.
- Real dsh turn behaviour, permissions, model/provider wiring, pty paste/truncation, or a stored
  credential login.
- A real person answering (the checker scripts the ask/read routes), or a real 0.7.8/0.7.9 daemon.
- How a 0.7.6/0.7.7 daemon treats the beat event: only the 404-permit path is exercised here; the
  beat event is not available to test against that daemon.
- The model handoff: the checker cannot see the wire, and OpenRig shows the effective model as
  unknown.
