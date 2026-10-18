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
pane stdin (rig send / human typing) ──▶ ACP session/prompt   (one per Enter, pastes kept whole;
                                                              queued, one in flight)
ACP session/update                   ──▶ human-readable pane mirror
ACP session/request_permission       ──▶ answered from the seat's posture
turn boundaries                      ──▶ POST /api/activity/hooks (stamped with node + generation)
lifecycle truth                      ──▶ <stateRoot>/<session>/runner-state.json
each turn's usage (dsh session log)  ──▶ <stateRoot>/<session>/turns.jsonl, with the harness
                                         fingerprint that ran it
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
| Unit/integration suite (`npm test`) | ✅ 25/25 at the time |

What has changed since that run — multi-line input framing, privacy defaults, seat identity lookup, and
turn records with a harness fingerprint — is covered by the suite (now 81 tests) and was checked
against the dsh (`687f282e`) and OpenRig source it relies on, but has **not yet been run against a live
dsh or daemon**.

## Requirements

- **Node 22 or 24** (dsh's own requirement).
- **`dsh` on `PATH`**, with at least the `acp` profile available.
- A **writable `DSH_HOME`**. dsh rewrites `$DSH_HOME/profiles/<name>/cordis.yml` on every boot, so a
  read-only home fails with `EPERM` before the agent starts.
- Credentials reachable from that home (`$DSH_HOME/.credentials.yaml` or provider env vars).
- For turn usage from a **zstd-compressed** session log (dsh's default), Node 22.15 or later. Homes
  built by `make-seat-home.sh` keep plain logs, which any Node reads.

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

The script also writes the seat's own `cordis.patch.yml` (an existing one is left alone): dsh's
session-log upload to DeepSeek is turned off (see **Privacy defaults**), and a fresh sessions root keeps
plain JSONL logs so the runner can read per-turn token usage without zstd.

[`examples/adopt/start-seat.sh`](examples/adopt/start-seat.sh) does this for you: with no explicit
`dsh-home` argument it assembles a home **per seat**, beside that seat's runner state, at
`$OPENRIG_HOME/state/dsh/<member>@<rig>/home`, from `${DSH_HOME:-~/.dsh}` on first use — and
**refuses** to start if you point it at your live `~/.dsh`. One home per seat matters twice over: dsh's
storage has no cross-process locking, and a seat's home holds its harness (skills, `AGENTS.md`,
patches), which is what a seat tunes.

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
| `--node-id` / `--generation` | OpenRig seat identity, when you know it; otherwise it is learned after adoption |
| `--state-root <dir>` | sidecar and turn-record root (default `$OPENRIG_HOME/state/dsh`) |
| `--sessions-root <dir>` | dsh session-log root, read for turn usage (default `<dsh-home>/sessions`) |
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

### Input: one message per Enter, pastes kept whole

`rig send` pastes the whole enveloped message with tmux's bracketed paste, then presses Enter. The runner
switches bracketed paste on in its pane and frames input itself: everything between the paste markers is
one message, line breaks included, and Enter submits it — so a multi-line `rig send` reaches the agent
as **one** prompt, not one prompt per line. Ctrl-C clears a half-typed line; on an empty line it cancels
the running turn.
Only a single typed line can be a local `/command`; a pasted message that starts with `/` goes to the
agent. A message over 1 MiB is refused whole rather than cut.

### Privacy defaults

dsh ships two upload paths that are on unless a deployment turns them off: `session-log-deepseek`
attaches the session log to every official DeepSeek API request, and `session-telemetry-otel` releases
the session to DeepSeek's collector on explicit feedback. The runner starts dsh with
`DSH_TELEMETRY_DISABLED=1` unless you have set `DSH_TELEMETRY_DISABLED` or `DSH_TELEMETRY_MODE`
yourself. The session-log upload is config rather than environment, so `make-seat-home.sh` turns it off
in the seat home's patch, and a seat whose home leaves it on says so in the pane at startup.

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
delivers to the agent as its first prompt, and takes as its cue to learn its node and generation (see
**Seat identity**).

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
   `window-sampling`, not by the hooks (`decidedBy: "window-sampling"`). *Since addressed in the
   runner:* it now learns its node and generation from the daemon after adoption (see **Seat
   identity**); an adapter can still pass `--node-id` and `--generation`.

## Honest limitations of Phase 1

- **No projection or startup delivery.** OpenRig will not write `AGENTS.md` or install skills for this
  seat; do it by hand (dsh reads `$DSH_HOME/AGENTS.md`, `~/.agents/AGENTS.md`, then the project chain,
  and discovers skills in `<project>/.dsh/skills`, `<project>/.agents/skills`, `$DSH_HOME/skills`,
  `~/.agents/skills` — hot-watched).
- **No daemon-side resume.** `rig down` / snapshot / restore treat the seat as adopted/unmanaged;
  OpenRig will not restart it. Resume is manual: restart the runner with `--session <id>` from
  `runner-state.json`.
- **Activity reporting is best-effort.** Turn hooks are trusted once the runner has learned the seat's
  generation, but the session-identity post only sticks once the node's declared runtime matches; the
  seat is declared `stub`, so expect `409` for that post. Failures never disturb the seat.
- **One prompt in flight.** ACP allows one prompt per session, so extra lines are queued (the pane
  shows `[queued: n]`). Mid-turn steering is not available; `/cancel` aborts the turn.
- **Minimal line editing.** Typed input supports backspace and Ctrl-C; arrow keys, history and cursor
  movement are ignored. Pastes and `rig send` are unaffected.
- **Turn usage covers the session's own model calls.** Subagents write child sessions of their own,
  which are not read yet. A turn whose closing log rows arrive after the runner's ~2 s wait is recorded
  as `session-log-partial`; its late rows count toward the next record, which names them in
  `lateDshTurns` and is marked partial too, so totals across records stay whole.
- **`turns.jsonl` is never rotated.** It grows by one line per turn; archive it like any log.
- **No identity primitive in dsh.** The pane name is the seat identity; dsh itself has no `--name`.

## Activity reporting (how it wires up)

`{baseUrl, token}` is read from `$OPENRIG_HOME/activity-endpoint.json` (default `~/.openrig`), and the
runner POSTs to `/api/activity/hooks` with the `x-openrig-activity-token` header, using the same body
shape OpenRig's Pi runner posts: `UserPromptSubmit` on turn start, `Stop` on turn end, and an
`eventFamily: "session_identity"` post at READY carrying the dsh session id. All posts are
fire-and-forget: a daemon outage never reaches the seat loop.

### Seat identity

The daemon trusts a turn hook only when it carries the occupant generation, and a pane started by hand
and then adopted cannot know its node or generation at launch. So the runner asks the daemon it already
posts to: `GET /api/whoami?sessionName=<seat>` for the node, then
`GET /api/telemetry/v1/nodes/<node>/tenures` for the newest generation. It asks at READY (a restarted
runner may already be bound), when OpenRig's adoption claim hint arrives (retrying for a few seconds),
and, while no generation is known, before a turn at most once a minute. Once known, activity posts, the
sidecar and the turn records carry `nodeId` and `generation`, and the pane prints
`OpenRig seat: node … · generation …`. A `--generation` on the command line wins and turns the lookup
off; a `--node-id` alone still lets the runner learn that node's generation.

## Turn records and the harness fingerprint

After every turn the runner appends one JSON line to `<state-root>/<member>@<rig>/turns.jsonl`
(schema `dsh-seat/turn/v1`):

| Field | Meaning |
|---|---|
| `sessionName`, `launchId`, `sessionId`, `turn` | which seat, launch and dsh session; `turn` counts this launch's prompts |
| `startedAt`, `endedAt`, `durationMs`, `stopReason`, `error` | how the turn went |
| `nodeId`, `generation` | the OpenRig seat, once known |
| `harnessFingerprint`, `posture`, `model`, `effort` | what ran it |
| `promptBytes`, `promptSha256` | the prompt's size and hash — never its text |
| `usage` | `inputTokens` (uncached), `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens` (part of output), `totalTokens`, `calls` |
| `byModel` | the same, per `provider/model` route |
| `llmCalls`, `steps`, `tools`, `endReasons`, `dshTurns`, `contextWindow`, `context` | model calls, steps, tool calls with failures by tool, how dsh's turns ended and their numbers, the context window and how full it was |
| `usageSource`, `usageNote` | `session-log`; `session-log-partial`, with the reason; or `unavailable` (`usage` is null) |
| `lateDshTurns` | dsh turns whose late rows this record carries because an earlier record was taken before they ended |

ACP reports no token usage — only how full the context window is — so the numbers come from dsh's own
session log, where every model call is recorded with the provider's counts. The runner finds the log
under `<dsh-home>/sessions` (`--sessions-root` overrides), skips what it held before this launch, and
after each turn reads the rows that turn appended. dsh writes its log in batches up to 200 ms behind
the events, so the runner waits briefly (at most about 2 s) until a whole turn is in the log, and sends
the next queued prompt only after the record is written. The pane shows one line per turn
(`[usage] 3 model calls · in 1,204 · cache read 41,600 · out 512 · 2 tool calls · deepseek/…`) and
`/usage` shows this launch's totals.

To price a turn, bill `inputTokens` at the cache-miss rate, `cacheReadTokens` at the cache-hit rate
(and `cacheWriteTokens` where a provider charges for them), and `outputTokens` at the output rate.
Per-model totals across every seat on the machine:

```bash
jq -s '[.[] | select(.byModel) | .byModel | to_entries[]] | group_by(.key)
  | map({model: .[0].key, calls: (map(.value.calls) | add),
         input: (map(.value.inputTokens) | add), cacheRead: (map(.value.cacheReadTokens) | add),
         cacheWrite: (map(.value.cacheWriteTokens) | add), output: (map(.value.outputTokens) | add)})' \
  "${OPENRIG_HOME:-$HOME/.openrig}"/state/dsh/*/turns.jsonl
```

The **harness fingerprint** is a sha256 over what shapes the agent apart from the model and the prompt:
the files dsh reads — `$DSH_HOME/AGENTS.md`, `<agents-home>/AGENTS.md`, the `AGENTS.md` / `CLAUDE.md`
(and `.local.md`) chain from the project root down to the cwd, the four skill roots
(`<project>/.dsh/skills`, `<project>/.agents/skills`, `$DSH_HOME/skills`, `<agents-home>/skills`) and
the home and profile `cordis.patch.yml` — plus posture, profile, dsh version and MCP server config.
Files are named by role rather than path, so seats with the same harness share a fingerprint. Model and
effort are left out on purpose, so one harness can be compared across models. It is recomputed before
every turn; a change is printed in the pane (`harness changed 40107c65a5a2 → 098028e9d9d8 (+1 files)`),
the sidecar carries the current one, and each distinct fingerprint's manifest — file labels, sizes and
sha256s, never content — is kept at `<state-root>/<seat>/harness/<fingerprint>.json`, so any two can be
diffed. Secrets (`.env`, credentials) are never read.

Together they are the measurement half of a self-improvement loop: change a seat's harness, then keep
the change if turns under the new fingerprint use fewer tokens or fail fewer tool calls. Outcome signals
(queue closures, reviews) live in OpenRig and join on `nodeId`, `generation` and time. Per-harness totals:

```bash
jq -s 'map(select(.usage)) | group_by(.harnessFingerprint)
  | map({harness: .[0].harnessFingerprint[0:12], turns: length,
         input: (map(.usage.inputTokens) | add), cacheRead: (map(.usage.cacheReadTokens) | add),
         output: (map(.usage.outputTokens) | add), toolErrors: (map(.tools.errors) | add)})' \
  "${OPENRIG_HOME:-$HOME/.openrig}"/state/dsh/*/turns.jsonl
```

## Tests

```bash
npm test                                        # 81 tests: no model, no network, no dsh required
./scripts/make-seat-home.sh                     # once, for the live paths below
npm run probe                                   # live ACP handshake (initialize/new/close, real dsh)
PROBE_PROMPT="reply with one word" npm run probe # live model turn — spends a few tokens
```

The suite drives the runner against `test/fake-acp-agent.mjs`, a scriptable ACP server (permission
requests, resume failure, mid-turn death, non-JSON stdout, usage updates, held and cancelled turns, and
a dsh-shaped session log in plain or zstd form, with closing rows that land late). The live path is covered by
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


