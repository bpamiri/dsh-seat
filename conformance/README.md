# Runner conformance evidence

This directory records the result of OpenRig's official runner conformance check against
`bin/dsh-seat`.

## Checker

From OpenRig `upstream/main` at `ff604d943` (the draft harness/runner contract and checker
published with 0.7.6):

- `docs/reference/runner-conformance/check-runner.mjs`
- `docs/reference/runner-conformance/fake-acp-agent.mjs`

The checker was not copied into this repository; run it from that tree (or an installed OpenRig).

## Command

```sh
node check-runner.mjs \
  --runner '/absolute/path/to/dsh-seat/bin/dsh-seat --agent-command {agent}' \
  --name dsh --resume --first-input --json
```

The `runner` field in `openrig-runner-conformance.json` therefore shows the machine-specific
absolute path used for this run (`/tmp/dsh-seat-existing/bin/dsh-seat ...`). Everything else is the
checker's verbatim output.

Environment: macOS, Node v26.0.0, tmux 3.7c. The fake agent stands in for dsh, so no model,
credentials or network are involved.

## Result

`CHECK_EXIT=0`

| Case | Result |
|---|---|
| 1 handshake | pass |
| 1b failed handshake | pass |
| 2 input, queue, cancel | pass |
| 3 activity | pass |
| 4 permissions | pass |
| 5 generation | pass |
| 6 resume | pass |
| 7 death mid-turn | pass |
| 7b prompt error | pass |
| 7c shutdown (advisory, proposed section 9) | met — never counted |
| 8 unknown request | pass |
| 9 first input | pass |

Summary: **11 pass, 0 fail, 0 skip, 1 advisory (met)**.

## Real dsh check (outside the checker)

Against `dsh 0.2.1-rc.2`, `acp` profile, no model turn:

- the shipped runner reopened an existing, closed conversation through `session/resume` and wrote
  `{"format":1,"attempt":"attempt-real-1","harness":"dsh","nativeRef":"d10a03a2-9829-408f-a590-0147f6a37b09","producer":"dsh-seat 0.2.0; ACP 1"}`;
- for an unknown id, dsh answered `-32602 Invalid params: session is not resumable: <id>` and the
  runner wrote `{"format":1,"attempt":"attempt-real-1","harness":"dsh","error":"missing","producer":"dsh-seat 0.2.0; ACP 1"}`.

A live session is refused with `session is already active: <id>`, which this runner does not
report as missing. No paid model turn was run; section 10's real seat journey is still the useful
real-agent check.

## What this does not prove

- How OpenRig reads the posts (working/idle/needs input/unknown after exit) — that is OpenRig's side.
- Real dsh turn behaviour, permissions, model/provider wiring, pty paste/truncation, or a stored
  credential login.
- The model handoff: the checker cannot see the wire, and OpenRig shows the effective model as
  unknown.
