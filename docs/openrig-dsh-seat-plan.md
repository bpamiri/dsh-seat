# Adding DSH seats to an OpenRig rig — recommendation

Scope: how to get `dsh` (DeepSeek Harness, `@deepseek-ai/dsh` 0.2.0-rc.2) seats into a rig on
OpenRig 0.6.7 (installed) / 0.6.10 (latest release).

Evidence base: read-only inspection of the installed OpenRig CLI
(the installed `@openrig/cli` package), the OpenRig source clone
(an OpenRig source clone, v0.6.6, upstream `mvschwarz/openrig`), the installed dsh
package (`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/*`), and public OpenRig docs / GitHub
(Discussion #43, ROADMAP.md, openrig.dev). Companion raw research: `openrig-dsh-harness-research.md`.
Line references are `file:line` in the source clone unless stated otherwise.

---

## 1. The recommendation

**Build one piece of your own code — a small ACP-backed "seat runner" that lives in the tmux pane —
adopt it into rigs now with zero OpenRig changes, then upstream the same runner plus a
`dsh-runtime-adapter.ts` as a first-class `dsh` runtime.**

Rationale, in one line: **dsh is protocol-first, OpenRig seats are tmux-first, and the runner is the
only bridge between them.**

- OpenRig assumes a seat is a tmux pane it can *type into* (`rig send` → `tmux send-keys`) and *read
  from* (`rig capture`), hosting a harness whose UI a human can attach to.
- dsh has **no first-party terminal UI** (`dsh tui` → `Error: dsh: profile "tui" does not exist`;
  shipped profile templates are `acp`, `web`, `headless`, `sdk`, `sdk-minimal` —
  `dsh-app-boot/lib/index.js:529-535`). Its interactive surface is the **Web GUI**; its programmable
  surfaces are `headless` (one-shot), and `acp` / `sdk` (stdio JSON-RPC).
- So dsh cannot be "a pane you type prompts into" on its own. A ~300-line runner that owns an ACP
  connection and turns pane stdin into `session/prompt` calls makes it exactly that — and OpenRig
  already has a proven precedent for this shape (the Pi runner,
  `packages/daemon/src/adapters/pi-runner.ts`).

Do **not** try to make dsh impersonate Claude Code or Pi. Both are whole-protocol integrations
(`claude --resume` + `CLAUDE.md` projection + pane probing; Pi's typed JSONL RPC,
`pi-runner.ts` spawns and speaks *Pi's* dialect). A shim means emulating someone else's protocol
*and* translating dsh's — strictly more work than the real thing.

---

## 2. Why the obvious paths don't work (verified)

| Path | Verdict | Evidence |
|---|---|---|
| `rig grow <rig> --runtime dsh` | **Rejected before launch** | `SUPPORTED_RUNTIMES = new Set(["claude-code","codex","pi","omp","terminal","stub"])`, `packages/daemon/src/domain/rigspec-preflight.ts:147`, enforced at `:302` and `:383` → `unsupported runtime "dsh"`. Preflight runs on every materialize/add/expand path. |
| Config key / env var | **No mechanism** | The entire runtime config namespace is two keys: `runtime.codex.hooks_enabled`, `runtime.readiness_timeout_seconds` (`domain/user-settings/settings-store.ts:149-150`). Unknown keys throw. No `OPENRIG_*_RUNNER`/`*_BINARY` var exists; `OPENRIG_RUNTIME` is output-only identity. |
| Plugin | **Cannot** | Plugins are Claude/Codex plugin *spec folders* (`PluginRuntime = "claude"\|"codex"`, `domain/plugin-discovery-service.ts:36`); they project skills/hooks/MCP into a seat, and cannot register an adapter or a launch command. |
| RigBundle | **Cannot** | Bundle kinds are `skills, plugins, workflow_specs, context_packs, agent_images` — no runtime/adapter kind. Runtimes are *select-only* within what the bundle already declares. |
| `stub` as a generic command seat | **No** | The stub runner executes a closed script grammar from `<cwd>/.openrig/stub/script.json`; steps are only `say` / `emit{compaction,slow_output,mid_turn_death,restore}` (`adapters/stub-script.ts:16-29`). There is no exec step and no `--command` flag (`adapters/stub-runner.ts:39-53`). |
| `rig adopt` a hand-run dsh pane, alone | **Insufficient** | The mechanics work (see §4 Phase 1) but a bare dsh gives the pane nothing to type at: `headless` exits after one task; `acp`/`sdk` stdin is the JSON-RPC channel (typing corrupts it); `web` is a browser app. A runner (or a third-party TUI plugin) is required regardless. |
| Wait for the 0.7.0 plug-in point | **Right long-term, not a plan** | Maintainer, 2026-10-08, [Discussion #43](https://github.com/mvschwarz/openrig/discussions/43): *"the plug-in point for agent apps is now planned for OpenRig 0.7.0… once a draft contract is posted."* No draft posted, 0.7.0 unreleased, no tag. |

No public request for dsh/DeepSeek Harness exists in OpenRig (GitHub issue/PR search for `dsh` and
`DeepSeek Harness` returns zero). The only `deepseek` string in the repo is a provider API key on the
**Pi** runtime (`adapters/pi-runner-protocol.ts:133`).

---

## 3. The design: what a `dsh` runtime looks like

### 3.1 Why ACP, not headless

| dsh surface | Fit as a seat |
|---|---|
| `dsh --profile headless --json --session-id <id> "<task>"` | Works, cheapest. One process per prompt; NDJSON events (`session`, `status{turn_start,step_start,step_end,turn_end}`, `thinking`, `text`, `tool_call`, `tool_result`, `final`, `error`); exit 0 iff `turn/end` reason is `completed`; id captured from the first `session` line. Costs: no mid-turn steering, no cancel, ~1 process per turn. Resume is fenced (below). |
| `dsh --profile acp` | **The right base.** Standard ACP v1 over stdio: `initialize`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/cancel`, `session/set_config_option`, `session/prompt`, `session/update`, `session/request_permission` ("a permission prompt with one-shot allow/reject choices; your client can answer automatically"). Persistent agent, multiple prompts, resume, cancel, per-session MCP. The ACP SDK is already on this machine (`@agentclientprotocol/sdk`, with a client example). |
| `dsh --profile sdk` | Minimal JSON-RPC (`initialize`/`session/prompt`/`shutdown`; notifications `session.event`, `session.status running\|idle`). **No cancel, no close, and no resume**: the server only calls `agents.create()`, and persistence refuses an id whose log exists (`refusing to materialize "<id>": a log already exists on disk`). |
| `dsh web` | Local HTTP server + browser. Accepts no prompt from the command line. Not a seat surface. |

### 3.2 Mapping the five-method `RuntimeAdapter` contract

Contract: `packages/daemon/src/domain/runtime-adapter.ts:139-173` (`runtime`, `listInstalled`,
`project`, `deliverStartup`, `launchHarness`, `checkReady`).

| Adapter method | dsh mechanism |
|---|---|
| `runtime` | `"dsh"`. |
| `project` | Write `AGENTS.md` in the seat cwd (dsh reads user-global `$DSH_HOME/AGENTS.md` then the broad→specific project chain, `AGENTS.md`/`CLAUDE.md`/`*.local.md`, 64 KiB cap); drop skills into `<cwd>/.dsh/skills/<name>/SKILL.md` (hot-watched — no restart); emit a per-seat `--patch` overlay for `dsh-mcp-client` rows (`mcp__<server>__<tool>`) and persona. |
| `deliverStartup` | Over ACP as `session/prompt` after `session/new`, and/or as pre-written files above (file-drop is dsh's strongest area and needs no protocol). |
| `launchHarness` | Type `node dsh-runner.js --session-name <seat@rig> --cwd <cwd> [--session <dsh-id>] [--posture <p>]` into the pane. The runner spawns `dsh --profile acp` as a child (stdio JSON-RPC), does `initialize`, then `session/new` or `session/resume`, prints `[dsh-runner] READY`, and writes the launch-scoped sidecar `<stateRoot>/<session>/runner-state.json` carrying `{ready, launchId, sessionId, exited?}`. Posture → `DSH_PERMISSION_MODE=read-only\|workspace-write\|danger-full-access`. |
| `checkReady` | Launch-scoped sidecar poll (`launchId` match) + `READY` marker, mirroring `pi-runtime-adapter.ts:379-417`. No pane heuristics. |
| resume token | The dsh session id (`session-<uuid>`), `resumeType: "dsh_session_id"`. **ACP is the only resume path worth building on.** |
| activity / liveness | `session/update` + turn boundaries → `POST /api/activity/hooks` with `{sessionName,nodeId,generation,runtime,hookEvent,…}` (exactly what `pi-runner.ts:571-581` does). |
| permissions | `session/request_permission` answered by posture: `full_bypass` → allow; otherwise decline escalation and let `DSH_PERMISSION_MODE` do the work. |

### 3.3 dsh fences to design around

- **No identity concept.** No `--name`/`--label`. OpenRig owns naming (`<member>@<rig>`); `DSH_SESSION_ID`
  and the session title are the only handles.
- **Session ids cannot be pre-assigned** — always `session-<uuid>`, and default `headless` prints no id at
  all; only `--json` reveals it in the opening `session` event.
- **Resume is surface-specific.** `headless --session-id` refuses a session that records an agent preset
  (`dsh-headless/lib/index.js:223`) and requires an exactly matching cwd; Web-created sessions carry a
  preset, so headless cannot adopt them. SDK cannot resume at all.
- **One writer per session** (`flock` on `session.lock`) — a seat and any sidecar cannot share a conversation.
- **Session logs are zstd by default** — an external tailer needs zstd or a separate `DSH_HOME` root with
  `compression: none`.
- **`$DSH_HOME` must be writable**: dsh rewrites `$DSH_HOME/profiles/<name>/cordis.yml` on every boot.
- **Config is per-`$DSH_HOME`**, so per-seat isolation means a per-seat `--patch` or a per-seat home.
- `never` approval policy means *deny escalation*, not auto-approve; `ask` with no answerer fails closed.

---

## 4. Phased plan

### Phase 0 — decision hygiene (30 minutes)
1. Open an issue / Ideas Discussion proposing a `dsh` runtime, and offer to be the first port in
   [Discussion #43](https://github.com/mvschwarz/openrig/discussions/43). `CONTRIBUTING.md` requires a
   maintainer yes-on-scope before you build; the maintainer explicitly asked who wants to be first ported.
2. Pin the dsh version (0.2.0-rc.2 vs the 0.2.1-alpha line) and record it in the runner.

### Phase 1 — a working dsh seat today, no OpenRig changes (1–2 days) — **DONE**
Built as `dsh-seat/` — now at `~/GitHub/bpamiri/dsh-seat/` (see its `README.md`): a dependency-free ACP-backed runner plus a fake-ACP
test suite. Verified live against dsh 0.2.0-rc.2: pane boot, real prompt via `tmux send-keys`,
sidecar, clean shutdown, and resume across a process restart with context continuity. Adopted into a
throwaway rig and driven with `rig send` / `rig capture`, with the agent writing a file on disk.
Two gaps the live adoption exposed (both Phase 2 work) are recorded in that README's
"Field notes from the first live adoption": discovery fingerprints a dsh pane as `unknown`, and
activity hooks arrive without an occupant generation so the daemon falls back to window sampling.

Then seat it with the adoption flow (verified: `rig adopt` calls
`/api/rigs/import/materialize`, which "create[s] rig topology **without launching**"
(`packages/daemon/src/routes/rigspec.ts:175`), then binds live panes):

```bash
# 1. hand-start dsh in the canonical session name for the member
tmux new-session -d -s dev1-dsh@my-rig -c /path/to/repo \
  "node ~/bin/dsh-seat --cwd /path/to/repo --posture workspace-write"

# 2. declare the topology (member runtime must be one of the six — see the caveat below)
#    spec.yaml: pods[].members[] with id: dev1-dsh, agent_ref: local:agents/dev1-dsh, profile: default
rig discover                                   # dsh pane fingerprint = runtimeHint "unknown" (expected)
rig adopt spec.yaml --bind dev1-dsh=dev1-dsh@my-rig
```

What you get immediately: the seat appears in `rig ps`, `rig send`/`rig capture` work, it owns queue
items, tmux transcript capture starts, and the claim hint
(`--- OpenRig: You have been adopted into rig "X" as <member>. Run: rig whoami --json ---`,
`domain/claim-service.ts:196`) is typed into your runner and becomes the seat's first prompt.

**Honest limitations of Phase 1:** no topology projection or startup-file delivery, no activity
telemetry, no resume/restore orchestration (`rig down`/snapshot treat it as unmanaged/adopted), OpenRig
cannot restart it, and the node's **runtime label must be a lie** — `dsh` is refused by preflight, so
declare `stub` and accept that any path that tries to relaunch the seat will do the wrong thing.

### Phase 2 — upstream it as a first-class `dsh` runtime (~12–20 files, ~1,500–3,000 lines incl. tests)
Precedents: the Pi landing (~4 new files, ~1,200 source + ~1,300 test lines); OMP touched 25 source files
because it *reused* the Pi runner; the open Trae CLI PR #1321 touches 18 files.

Irreducible core:
1. `packages/daemon/src/adapters/dsh-runtime-adapter.ts` — the five methods.
2. `packages/daemon/src/adapters/dsh-runner.ts` + `dsh-runner-protocol.ts` — the ACP bridge and its
   sidecar/marker/argv contract (dsh is not a Pi dialect, so `pi-runner.ts` cannot be reused).
3. Register in **both** maps: `startup.ts:964` (`adapters:`) and `startup.ts:1234` (`runtimeAdapters:`).
4. `SUPPORTED_RUNTIMES` — `domain/rigspec-preflight.ts:147`.
5. Runner entry-path constant next to `startup.ts:623` / `:781`.
6. Tests mirroring `pi-*` / `omp-*`; the shared gates that go red: `rigspec-preflight.test.ts`,
   `startup-wiring-pins.test.ts:76`, `resume-token-validation.test.ts`, `native-resume-probe.test.ts`.

For a production (resumable) seat, additionally: `resumeTypeForRuntime`
(`domain/resume-token-validation.ts:46-51`), a resume adapter wired like `adapters/pi-resume.ts`
(`restore-orchestrator.ts:141-146`, `:1541-1571`), the native resume probe
(`domain/native-resume-probe.ts:35-48`), an availability verifier
(`rigspec-preflight.ts:10-15`, `:404-406`), and `LEGACY_KNOWN_RUNTIMES` (`rigspec-schema.ts:1186`) if
you need flat-node rigspecs. Native permission selection needs a migration: the CHECK constraint is
`runtime IN ('codex','claude-code')` (`db/migrations/088_node_permission_selections.ts:9`).

Graceful today, widen later: activity taxonomy (unknown runtimes already fall back to
`TMUX_GENERIC_RUNG_INVENTORY`, `domain/activity-taxonomy.ts:193-196`), skill/plugin/agent-image/package
runtime unions, and the UI's `RuntimeBrandId` (`packages/ui/src/lib/runtime-brand.ts:1`) — a `dsh` seat
renders as "Unknown" until widened. The TUI needs nothing.

### Phase 3 — move to the plug-in form
When the 0.7.0 agent-app plug-in contract is posted, port the adapter to it so you are not carrying a
fork. Keep the runner as-is; that is the reusable asset.

---

## 5. Risks / what would change the recommendation

- **dsh's ACP surface is young** (0.2.0-rc.2, with a 0.2.1-alpha line shipping weekly). Pin the version;
  write the runner against ACP v1 rather than dsh internals.
- **A third-party dsh TUI plugin could remove Phase 1's runner work** (a community `tui` profile exists,
  e.g. via discussion #3715) — but it is unverified, and it would still leave Phase 2 unchanged.
- **If OpenRig's 0.7.0 shared adapter lands first**, a dsh adapter may be a much smaller delta than
  Phase 2's estimate. Phase 0 is the cheapest hedge: ask.
- **Unverified by execution:** dsh could not be run in this session (the file sandbox denies writes to
  `$DSH_HOME`, which dsh requires on every boot), so all dsh flag surfaces above are read from the
  installed compiled source, not from live `--help`. The end-to-end `headless --json --session-id`
  resume cycle and a live ACP handshake remain to be proven on this machine.

## 6. What I would do first

Phase 1's runner, because it is the load-bearing artifact for every other option: it produces a working
dsh seat this week, it is exactly the code Phase 2 upstreams, and it is the artifact that makes a Phase 0
proposal credible ("here is a running dsh seat; here is the adapter contract it satisfies").
