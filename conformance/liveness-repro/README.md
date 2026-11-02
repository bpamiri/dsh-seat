# Liveness reproduction (sanitized)

A small, dependency-free reproduction of the **activity posts** a dsh-seat runner
sends during one long, silent turn, on two builds:

| Capture | Build | Result |
|---|---|---|
| `timeline-a.json` | `f029719cc0e2a8e79196edd041e4d7ea7adb9ab8` (pre-beat) | `UserPromptSubmit/accepted` at 0 s, then no working post until `Stop/end_turn` at 60 s. |
| `timeline-b.json` | `454aab3c64e71c1e5e185d45d21e92cb60b36e62` (working beat; PR #9 at capture time) | accepted, `active/liveness` every ~5 s with `livenessSeconds: 15` from 5 s to 55 s, `active/agent_message` at 60.003 s, `Stop/end_turn` at 60.004 s. |

The current PR branch head is a docs/tests-only descendant of `454aab3c`; the
runner itself is unchanged from that capture build. The timestamps are from qa's
capture runs on 2026-11-02 (macOS, one 60 s fake turn).

## What this does — and does not — show

This artifact observes **the posts the runner sent**, not OpenRig's computed
activity state. The human's [Discussion #43 comment](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19299837)
reports the observed working→unknown transition on a real long turn (working
evidence expired after 15 s while the task was still running); that observation
is the human's, **not something this repro measured**.

This host denies tmux pane forks, so no daemon-side activity state was observed
here. The reproduction supplies the post timeline and a runnable harness; the
#43 comment supplies the observed state transition.

It uses a fake ACP agent and a local `127.0.0.1` activity endpoint. No dsh, no
model, no credentials, no network. It also does not exercise permissions.

## Run it

Requirements: Node 22+. Nothing else.

```sh
# From a checkout of this repository (for the beat build), and a checkout of
# f029719cc for the pre-beat build:
node conformance/liveness-repro/run-capture.mjs \
  a /path/to/pre-beat/dsh-seat/bin/dsh-seat /tmp/liveness-out \
  conformance/liveness-repro/fake-agent.mjs

node conformance/liveness-repro/run-capture.mjs \
  b /path/to/current/dsh-seat/bin/dsh-seat /tmp/liveness-out \
  conformance/liveness-repro/fake-agent.mjs
```

Environment:

- `FAKE_AGENT_SILENCE_MS` — how long the fake turn stays silent (default 60000).
- `CAPTURE_BUILD` — label written into the generated timeline.

The harness starts the runner in a throwaway workspace with a local activity
endpoint and a fake ACP agent, sends one prompt through `OPENRIG_FIRST_INPUT`,
records every activity post with wall-clock timestamps, and writes
`capture-<a|b>-posts.jsonl`, `capture-<a|b>-timeline.json`, the agent log and the
runner's stdout/stderr. The generated meta includes absolute paths from the host
that ran it; sanitize those before sharing.

## Files

- `fake-agent.mjs` — silent ACP agent (initialize / session/new / one prompt),
  no model or credentials.
- `run-capture.mjs` — local activity endpoint + runner driver.
- `timeline-a.json`, `timeline-b.json` — the captured post timelines above.
- `liveness-pre.preset.yaml.example` / `liveness-beat.preset.yaml.example` —
  example presets whose command is the matching `run-seat-*.sh.example`.
- `run-seat-pre.sh.example` / `run-seat-beat.sh.example` — launcher examples
  (replace `<PATH_TO_…>` placeholders).
- `rig-pre.yaml.example` / `rig-beat.yaml.example`, `agent.yaml.example` —
  minimal rig/AgentSpec examples for a manual run.

No private paths, prompts, seat names or credentials are included; the example
files use placeholders.
