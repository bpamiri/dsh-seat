# dsh-seat — a DeepSeek Harness seat for OpenRig

A small, dependency-free runner that hosts a **DeepSeek Harness (`dsh`)** agent inside a tmux pane
so OpenRig can adopt it as a seat. **No OpenRig changes required** — it works today, on a released
OpenRig, through the adopt path.

It is an independent project, not affiliated with or supported by OpenRig or DeepSeek. It talks to
`dsh` over its published command line and the Agent Client Protocol, and to OpenRig over its
published CLI and HTTP API; it contains no code from either. Licensed Apache-2.0.

## Where this sits

OpenRig does not accept `dsh` as a runtime, and (as of 0.6.x) there is no supported way to add one
without editing OpenRig's own TypeScript. So this repo does the one thing that needs no such edit: it
puts a runner in the seat's pane and lets `rig adopt` bind the pane, exactly as it would bind any
other tmux session. The "one lie you have to tell" section below is the price of that, and it is a
real cost, not a footnote.

The upstream path is OpenRig's **0.7.0 agent-app plug-in point**, where an app and its runner stay
maintained by their contributor. The maintainer reviewed a proposal for `dsh`
([mvschwarz/openrig#1327](https://github.com/mvschwarz/openrig/issues/1327)) and asked for the plug-in
route rather than an in-tree adapter, with `dsh` welcome as a candidate against the draft contract
once it exists. This runner is meant to be the implementation behind that plug-in when the contract
lands — which is why it is deliberately shaped like OpenRig's own `pi-runner`
(`packages/daemon/src/adapters/pi-runner.ts`): the runner is the durable asset, and the integration
layer around it is the part that will be rewritten.

No contract draft has been posted and no 0.7.0 release exists as of this writing, so nothing here is
built against an assumed API.

## Why a runner is needed

OpenRig seats are **tmux-first**: `rig send` types into the pane, `rig capture` reads it, a human
attaches to it. `dsh` is **protocol-first**: it has no first-party terminal UI (`dsh tui` errors), its
interactive surface is a browser (`dsh web`), `headless` is one-shot, and `acp` / `sdk` speak JSON-RPC
on stdio. So a bare `dsh` in a pane gives OpenRig nothing to type at. This runner is the bridge.

```
pane stdin (rig send / human typing) ──▶ ACP session/prompt   (queued, one in flight)
ACP session/update                   ──▶ human-readable pane mirror
ACP session/request_permission       ──▶ answered from the seat's posture
turn boundaries                      ──▶ POST /api/activity/hooks
lifecycle truth                      ──▶ <stateRoot>/<session>/runner-state.json
```

## Status: verified live, not just unit-tested

Against real `dsh 0.2.0-rc.2` (`acp` profile, Node 24.11):

| Check | Result |
|---|---|
| ACP handshake + `session/new` + real prompt | ✅ `initialize` → `session/new` → `session/prompt` → `"pong"` |
| Seat boots in a tmux pane, prints `[dsh-runner] READY` | ✅ |
| Prompt typed the way `rig send` does it (`tmux send-keys … Enter`) | ✅ streamed thought + answer, `── turn end (end_turn) ──` |
| Sidecar written with `launchId` + `sessionId` | ✅ |
| Clean `/quit` | ✅ `EXITED (user-quit)`, `ready:false`, reason recorded |
| **Resume across a process restart** | ✅ `resumed session 51ec1ace-…`, and the agent still recalled its earlier answer |
| OpenRig activity endpoint auth + routing | ✅ accepted the token, honest `404 session_not_found` for an unadopted name |
| Unit/integration suite (`npm test`) | ✅ 25/25 |

## Requirements

- **Node 22 or 24** (dsh's own requirement).
- **`dsh` on `PATH`**, with at least the `acp` profile available.
- A **writable `DSH_HOME`**. dsh rewrites `$DSH_HOME/profiles/<name>/cordis.yml` on every boot, so a
  read-only home fails with `EPERM` before the agent starts.
- Credentials reachable from that home (`$DSH_HOME/.credentials.yaml` or provider env vars).

### Build a seat home

Do **not** point a seat at your own `~/.dsh`: every boot rewrites that profile tree, which your own dsh
sessions are using. Build a private, writable home instead — bundles and credentials are symlinked, so
nothing is copied or duplicated:

```bash
./scripts/make-seat-home.sh                  # -> <repo>/.seat-home (profile: acp)
./scripts/make-seat-home.sh /tmp/seat1 ~/.dsh
DSH_SEAT_PROFILE=acp ./scripts/make-seat-home.sh
```

`.seat-home/` is gitignored, so the credential symlink never lands in version control.

[`examples/adopt/start-seat.sh`](examples/adopt/start-seat.sh) does this for you: with no explicit
`dsh-home` argument it assembles `$OPENRIG_HOME/state/dsh/seat-home` from `${DSH_HOME:-~/.dsh}` on
first use, and **refuses** to start if you point it at your live `~/.dsh`.

## Quick start (standalone pane)

```bash
node src/dsh-seat.mjs \
  --session-name dev1-dsh@my-rig \
  --cwd /path/to/repo \
  --dsh-home /path/to/seat-dsh-home     # writable; per-seat isolation recommended
```

Then type a line and press Enter. Local commands: `/help /session /usage /cancel /quit`.

Useful flags:

| Flag | Meaning |
|---|---|
| `--session <id>` | resume that dsh session instead of creating one |
| `--resume-fallback-fresh` | allow a fresh session when resume fails (default: fail loudly) |
| `--posture floor\|auto\|full_bypass` | OpenRig's posture vocabulary (default `floor`) |
| `--model <id>` / `--effort <id>` | set the `model` / `reasoning_effort` ACP config options |
| `--mcp-servers <file>` | JSON file holding the ACP `mcpServers` array for `session/new` |
| `--runtime-label <l>` | runtime label used in activity posts (default `dsh`) |
| `--node-id` / `--generation` | OpenRig seat identity for activity posts |
| `--state-root <dir>` | sidecar root (default `$OPENRIG_HOME/state/dsh`) |
| `--no-activity` | do not POST activity to the daemon |
| `--verbose` | print ignored protocol traffic |

**Posture → dsh permission mode** (dsh bundles sandbox + approval, and `DSH_PERMISSION_MODE` is the
only launch-time selector):

| Posture | `DSH_PERMISSION_MODE` | Escalation requests (`session/request_permission`) |
|---|---|---|
| `floor` | `workspace-write` | refused with the agent's own reject option |
| `auto` | `workspace-write` | allowed once |
| `full_bypass` | `danger-full-access` | allowed, preferring a standing allow |

A posture with no matching option answers `cancelled` rather than leaving the agent waiting on a human
who is not there.

## Using it as an OpenRig seat (adopt)

`rig adopt` materializes topology **without launching** (`POST /api/rigs/import/materialize` — "create
rig topology without launching") and then binds live panes to members. So the flow is: start the pane
yourself, then adopt it.

```bash
cd examples/adopt
# 1. start the seat under the canonical session name <member>@<rig>
./start-seat.sh /path/to/repo

# 2. adopt it. NOTE: the logical id is pod-qualified — <pod>.<member>, not <member>.
rig discover --json                       # find the discovery id for dev1-dsh@dsh-scratch
rig adopt rig.yaml --bind scratch.dev1-dsh=dev1-dsh@dsh-scratch
```

If `rig adopt` reports `Logical ID 'dev1-dsh' does not exist in rig`, that is the pod qualification:
list the real ids with `curl -s http://127.0.0.1:7433/api/rigs/<rigId>/nodes`, or bind afterwards
without re-materializing:

```bash
rig bind <discoveredId> --rig <rigId> --node scratch.dev1-dsh
```

What you get: the seat appears in `rig ps`, `rig send` / `rig capture` work, it can own queue items,
tmux transcript capture starts, and OpenRig types its claim hint into the pane — which this runner
delivers to the agent as its first prompt.

### The one lie you have to tell

`dsh` is **not** an accepted `runtime` value: `SUPPORTED_RUNTIMES` is
`{claude-code, codex, pi, omp, terminal, stub}` and preflight rejects anything else with
`unsupported runtime "dsh"`. The example spec therefore declares `runtime: stub`. Nothing in the adopt
path launches the stub harness (materialize does not launch), so the label is inert for an adopted
seat — but it is wrong, and anything that tries to *relaunch* this node will do the wrong thing.

## Field notes from the first live adoption

A dsh seat was adopted into a throwaway rig (`dsh-scratch`) on 2026-10-15 and driven through the real
CLI. It works as a seat: the claim hint became the agent's first prompt (it loaded the OpenRig skill and
ran `rig whoami`), `rig send` delivered a task, the agent wrote `SEAT.md` on disk, `rig capture` read
the transcript, and the daemon reported `nodeKind: agent`, `sessionStatus: running`,
`occupantLifecycle: active`.

Two gaps that only a live adoption exposes, both Phase 2 work:

1. **Discovery fingerprints the pane as `unknown`.** `activeCommand` is `node` and nothing in the pane
   matches Claude/Codex patterns, so `rig discover` cannot name the runtime and `--draft` would exclude
   the seat. Phase 2 should add a `dsh` `RuntimeHint` with a READY-marker rule, exactly as OMP does
   (`domain/session-fingerprinter.ts:29,143` matches `[omp-runner] READY`).
2. **Activity hooks land but are not trusted.** The daemon accepted the posts and then warned:
   *"a recent hook exists … but carried NO occupant generation"* — so the seat's state was decided by
   `window-sampling`, not by the hooks (`decidedBy: "window-sampling"`). Phase 2's adapter must pass
   `--node-id` and `--generation` so the runner can stamp them and activity becomes the deciding rung.

## Honest limitations of Phase 1

- **No projection or startup delivery.** OpenRig will not write `AGENTS.md` or install skills for this
  seat; do it by hand (dsh reads `$DSH_HOME/AGENTS.md` then the project chain, and discovers skills in
  `<project>/.dsh/skills`, `<project>/.agents/skills`, `$DSH_HOME/skills` — hot-watched).
- **No daemon-side resume.** `rig down` / snapshot / restore treat the seat as adopted/unmanaged;
  OpenRig will not restart it. Resume is manual: restart the runner with `--session <id>` from
  `runner-state.json`.
- **Activity reporting is best-effort and, today, mostly rejected.** Posts authenticate and route, but
  the session-identity post only sticks once the node's declared runtime matches; the seat is declared
  `stub`, so expect `404`/`409` answers. Failures never disturb the seat.
- **One prompt in flight.** ACP allows one prompt per session, so extra lines are queued (the pane
  shows `[queued: n]`). Mid-turn steering is not available; `/cancel` aborts the turn.
- **Line-based input.** Input is read line by line, which matches what `tmux send-keys` + Enter
  produces. Multi-line bracketed paste is Phase 2 work.
- **No identity primitive in dsh.** The pane name is the seat identity; dsh itself has no `--name`.

## Activity reporting (how it wires up)

`{baseUrl, token}` is read from `$OPENRIG_HOME/activity-endpoint.json` (default `~/.openrig`), and the
runner POSTs to `/api/activity/hooks` with the `x-openrig-activity-token` header, using the same body
shape OpenRig's Pi runner posts: `UserPromptSubmit` on turn start, `Stop` on turn end, and an
`eventFamily: "session_identity"` post at READY carrying the dsh session id. All posts are
fire-and-forget: a daemon outage never reaches the seat loop.

## Tests

```bash
npm test                                        # 25 tests: no model, no network, no dsh required
./scripts/make-seat-home.sh                     # once, for the live paths below
npm run probe                                   # live ACP handshake (initialize/new/close, real dsh)
PROBE_PROMPT="reply with one word" npm run probe # live model turn — spends a few tokens
```

The suite drives the runner against `test/fake-acp-agent.mjs`, a scriptable ACP server (permission
requests, resume failure, mid-turn death, non-JSON stdout, usage updates). The live path is covered by
`probes/probe-acp.mjs` (override its home with `PROBE_DSH_HOME`) and by the manual tmux walkthrough
above.

## In-tree integration: built, verified, and not submitted

An in-tree `dsh` runtime was built and verified against real `dsh 0.2.0-rc.2` — the five-method
`RuntimeAdapter`, a TypeScript port of this runner, a resume adapter, registration in both adapter
maps, `SUPPORTED_RUNTIMES` + a `dsh --version` verifier, a `dsh_session_id` resume type, and a `dsh`
discovery hint. It lives outside this repository, on a local branch of an OpenRig checkout, and it is
**not expected to be submitted**: the maintainer asked for the plug-in route instead
([#1327](https://github.com/mvschwarz/openrig/issues/1327)).

It is worth keeping for two reasons. It proves the protocol behaviour in this repo holds under
OpenRig's real launch, resume, projection and readiness paths. And it is a concrete inventory of the
core seams a new runtime still has to edit — the evidence the 0.7.0 contract is meant to eliminate.

The work that survives is this runner: the adapter around it is the part that will be replaced.


