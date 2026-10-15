# OpenRig + "dsh" (DeepSeek Harness): support, roadmap, and the bring-your-own-harness story

Research date: 2026‑10‑15. OpenRig latest release at time of writing: **0.6.10** (released 2026‑10‑12).
Method: `web_search` + `web_fetch` of openrig.dev, the GitHub API (issues/PRs/discussions/releases), and a
shallow clone of `mvschwarz/openrig@main` (`fd097bfd`, 2026‑10‑15) grepped for the relevant terms.
All fetched content is treated as data.

---

## Headline answers

| Question | Answer |
| --- | --- |
| Is **dsh** supported? | **No.** No mention anywhere on openrig.dev, in the repo, in issues/PRs/discussions, or on the web. |
| Is **dsh** planned or requested? | **No evidence.** Zero occurrences of `dsh`, `DeepSeek`, or `DeepSeek Harness` in any public OpenRig source or tracker. |
| Does OpenRig have a public "bring your own harness" extension story? | **Not shipped.** A provider-neutral harness **plugin/protocol** is an open design discussion ([Discussion #43](https://github.com/mvschwarz/openrig/discussions/43)); the maintainer says the "plug-in point for agent apps is now planned for OpenRig 0.7.0" (comment, 2026‑10‑08). Today a new runtime requires core code changes. |
| Can a RigBundle ship a runtime adapter? | **No.** Bundles can carry specs, skills, plugins, workflow specs, context packs, agent images and a project — and can only *select* among built-in runtimes. No runtime-adapter kind exists. |

---

## 1. Supported runtimes/harnesses on openrig.dev

**FOUND EVIDENCE.**

The canonical published list is in the FAQ, which answers "What coding agents are supported, and can I mix them?"
under the anchor `#runtimes` ([openrig.dev/docs/faq](https://openrig.dev/docs/faq)):

> **Claude Code, Codex, Pi and Oh My Pi, in any mix within one rig**: each seat names its harness, and every agent
> messages the others and works the same queue. A Claude owner with a Codex checker is a common pairing, since
> different models catch different mistakes. Each seat can also have its own model and reasoning effort. See
> [Mixed-harness teams](/features/mixed-harness) …

The Taxonomy spec, in its definition of "Agent Harness (Harness Runtime)", states the same set
([openrig.dev/specs/taxonomy](https://openrig.dev/specs/taxonomy)):

> Canonical examples: Claude Code, Codex CLI, Devin. **OpenRig launches Claude Code, Codex, Pi and Oh My Pi (OMP)
> as agent runtimes**; a RigSpec member can also be a plain terminal process or a test stub.

The RigSpec reference gives the machine-checkable enumeration
([openrig.dev/specs/rigspec](https://openrig.dev/specs/rigspec), `runtime` field row; identical in the raw
[`/specs/rigspec.md`](https://openrig.dev/specs/rigspec.md) and in
[docs/reference/rig-spec.md](https://github.com/mvschwarz/openrig/blob/v0.6.10/docs/reference/rig-spec.md)):

> `runtime` | string | yes | — | Agent runtime. **Current supported values: `claude-code`, `codex`, `pi`, `omp`,
> `terminal`, `stub`.** `stub` is a deterministic test harness, not an agent …

The repo's own architecture map confirms six `RuntimeAdapter` implementations
([ARCHITECTURE.md](https://github.com/mvschwarz/openrig/blob/main/ARCHITECTURE.md)):

> | Runtime adapters | 6 (`claude-code`, `codex`, `pi`, `omp`, `terminal`, `stub`); the command counts 5 because
> `OmpRuntimeAdapter` extends `PiRuntimeAdapter` | …

**Notable asymmetry (found evidence, not speculation):** Pi and OMP are seat runtimes, but they are *not* offered
as setup/kernel providers. [Getting started](https://openrig.dev/docs/getting-started) asks only *"Which working
account do you want this team to use: Claude Code, Codex, or both?"* and documents
`rig setup --providers claude` / `codex` / `both`. The kernel boot tracker reasons only about Claude Code + Codex
(`packages/daemon/src/domain/kernel-boot-tracker.ts`: `"auth_blocked" // Both Claude Code + Codex unauthenticated;
cannot pick a variant`). The repo `README.md` headline is still: *"Claude Code and Codex in the same rig, managed
as one system."*

**NOT FOUND / ABSENT on the pages you listed:**

- `/docs/configuration` — no harness/runtime support list; it covers config keys and explicitly separates
  permissions. There is a `runtime.readiness_timeout_seconds` key documented in the getting-started troubleshooting
  table (`rig config set runtime.readiness_timeout_seconds <1-600>`), but no runtime enumeration.
- `/docs/lifecycle` — mentions `--runtime` on `rig grow` (`--runtime` defaults to claude-code) but lists no supported set.
- `/docs/faq` — besides the `#runtimes` answer above, the "harness framework" answer is about *content/methodology*
  (GSD, G‑Stack, Super Powers), not harness runtimes: *"Build your own harness framework, or use an existing one."*
  This is a different axis from "add a runtime" and should not be conflated with it.
- `https://www.openrig.dev/...` redirects cross-origin to `https://openrig.dev/...`; both resolve to the same content.
- The published `/docs` overview notes the generated config/MCP/TUI tables were *"last checked against OpenRig 0.6.6"*
  while repo-rendered pages follow 0.6.10.

---

## 2. Any mention of dsh / DeepSeek / custom runtime / BYO agent?

**FOUND EVIDENCE (there is an active BYO-harness conversation — but it is generic, not dsh-specific):**

- **[Discussion #43 — "feat: add provider-neutral harness plugins"](https://github.com/mvschwarz/openrig/discussions/43)**
  (moved from [issue #23](https://github.com/mvschwarz/openrig/issues/23), which is **closed** with the label
  `discussion`). 20 comments; open. This is the central thread. The proposal asks that a contributor
  *"be able to add a coding harness by installing a versioned OpenRig harness plugin and manifest, without modifying
  OpenRig daemon, CLI, UI, TUI, or core schema source."* It documents the existing seam and the leak:
  *"`packages/daemon/src/domain/runtime-adapter.ts` defines a five-method `RuntimeAdapter` contract … This is a useful
  foundation, but it is an in-process TypeScript interface and does not cover all provider-specific behaviour,"* and
  *"Adding a new coding harness currently requires more than adding one adapter. A contributor must find and update
  provider-specific allowlists, unions, routes, process detectors, resource projection code, resume and fork logic,
  activity handling, authentication checks, package handling, and UI surfaces."*
- Maintainer reply on #23 (2026‑09‑25), closing the issue in favour of the discussion:
  > "Where we stand today, honestly: the five-method `RuntimeAdapter` seam you found is real and it's where the three
  > adapter PRs in flight (#19/#32 Muse and OpenCode, #35 Oh My Pi) plug in. You're right that runtime knowledge leaks
  > past it into preflight, workflow harness lists, packages, images and identity matching … **What we are not going to
  > do yet is commit to a plugin protocol** before those adapters have taught us what the manifest actually needs to
  > declare … Treat this as a priority we're taking seriously, not a polite deferral."
- Maintainer in Discussion #43 (2026‑10‑08), the closest thing to a public commitment:
  > "@z4cc, @phamhung075, @MTG‑Thomas, @KevinUnk and @zai184: **the plug-in point for agent apps is now planned for
  > OpenRig 0.7.0.** Each app plugs in, stays yours to maintain, and **shows as a community app OpenRig hasn't tested.**
  > Two questions to help with the first port: (1) Would you like your app to be the first one ported onto it once a
  > **draft contract is posted here**? … (2) For your app, which of these can it report without reading the screen:
  > busy, idle, waiting for a person's approval, and the session id?"
- Earlier maintainer survey in #43 (2026‑09‑25) — the design basis: *"Of the six we surveyed, none had solved 'add a
  terminal harness with zero changes to core' yet,"* and *"A capability field is real only if a core branch reads it
  and a test pins the consumer."*
- Community runtime requests / in-flight adapters, all generic:
  OpenCode ([#517](https://github.com/mvschwarz/openrig/issues/517), field report [#227](https://github.com/mvschwarz/openrig/issues/227)),
  Cursor CLI ([#352](https://github.com/mvschwarz/openrig/issues/352) / PR [#353](https://github.com/mvschwarz/openrig/pull/353)),
  Grok CLI ([#522](https://github.com/mvschwarz/openrig/issues/522)),
  Google Antigravity `agy` (PR [#348](https://github.com/mvschwarz/openrig/pull/348)),
  Devin ([Discussion #44](https://github.com/mvschwarz/openrig/discussions/44)),
  IBM Bob Shell ([#659](https://github.com/mvschwarz/openrig/issues/659)),
  `jcode` ([#629](https://github.com/mvschwarz/openrig/issues/629)),
  Trae CLI (PR [#1321](https://github.com/mvschwarz/openrig/pull/1321), opened 2026‑10‑15, **open/unmerged**).
- A RigBundle-level "plugin" exists but is unrelated to runtimes (see §5).

**NOT FOUND / ABSENT:**

- `dsh` — **zero** results in [GitHub issue/PR search](https://github.com/mvschwarz/openrig/issues?q=dsh) (API
  `total_count: 0`), zero in a clone grep of `main` (word-boundary `\bdsh\b` matches only the `.git` pack and a
  binary GIF).
- `deepseek` — **2** API hits, **neither about a harness runtime**:
  [PR #1046](https://github.com/mvschwarz/openrig/pull/1046) (native Windows lifecycle; incidental keyword hit) and
  [issue #29](https://github.com/mvschwarz/openrig/issues/29) (Pi activity hooks omit `generation`).
  The only `deepseek` string in the codebase is a provider key mapping inside the *Pi* runtime:
  `packages/daemon/src/adapters/pi-runner-protocol.ts:133: deepseek: "DEEPSEEK_API_KEY"`.
- `DeepSeek Harness` / `deepseek-harness` — zero hits in the repo and in OpenRig issue/PR search. Note: the
  `deepseek-ai/deepseek-harness` repo and `JunkaiWang-TheoPhy/deepseek-harness` exist, but **no page links them to
  OpenRig**. A generic web search surfaced a *different* project's bug ("dsh-runtime drops assistant text…",
  [nexu-io/open-design#8085](https://github.com/nexu-io/open-design/issues/8085)) — unrelated to OpenRig, and
  **not evidence about OpenRig**.
- "third-party harness", "custom runtime", "bring your own agent", "new runtime", "add a runtime",
  "runtime adapter" as *documented public API* — no matches in any user-facing doc. (Searches in the GitHub tracker
  return only the community requests listed above.)
- No OpenRig issue, PR, or discussion asks for DeepSeek Harness specifically. The nearest analogues are the other
  CLI harnesses listed above.

---

## 3. How does a new runtime get added? (repo-documented process)

**FOUND EVIDENCE — yes, documented, but as an in-repo contribution procedure, not a user extension point.**

[ARCHITECTURE.md](https://github.com/mvschwarz/openrig/blob/main/ARCHITECTURE.md), section **"A runtime adapter"**:

> 1. Implement `RuntimeAdapter` from `packages/daemon/src/domain/runtime-adapter.ts`: `runtime`, `listInstalled`,
>    `project`, `deliverStartup`, `launchHarness` and `checkReady`. The smallest implementation is
>    `packages/daemon/src/adapters/terminal-adapter.ts`; the scripted test double is `stub-runtime-adapter.ts`.
> 2. Register it in `packages/daemon/src/startup.ts`. The adapter maps are keyed by runtime name: `adapters:` (for the
>    pod instantiator) and `runtimeAdapters:`. The context monitor has its own map for the runtimes it samples.
> 3. Accept the runtime name in rig spec validation: `SUPPORTED_RUNTIMES` in
>    `packages/daemon/src/domain/rigspec-preflight.ts`. Other runtime lists, such as `RuntimeHint` in
>    `domain/discovery-types.ts` and `LEGACY_KNOWN_RUNTIMES` in `domain/rigspec-schema.ts`, may need it too; search
>    for an existing runtime name such as `"pi"` to find them.
> 4. Launch, projection and readiness are arteries. Read [docs/as-built/arteries.md](docs/as-built/arteries.md) first.

Confirmed in code (`main`): `const SUPPORTED_RUNTIMES = new Set(["claude-code", "codex", "pi", "omp", "terminal", "stub"]);`
(`packages/daemon/src/domain/rigspec-preflight.ts:150`), with preflight errors
`` `${pod.id}.${member.id}: unsupported runtime "${member.runtime}"` ``.

Also found: *"Do not edit `CHANGELOG.md`… Do not bump versions"* and, for integrations,
[CONTRIBUTING.md](https://github.com/mvschwarz/openrig/blob/main/CONTRIBUTING.md):

> **Integrations with other tools or projects.** Open an issue or an Ideas Discussion and wait for a maintainer's yes
> on scope before you build it; an issue on its own isn't a yes. **Often the best home for an integration is your own
> repository, and we're happy to link to it.**

**Scale of a real adapter PR (found evidence, illustrative):** [PR #1321](https://github.com/mvschwarz/openrig/pull/1321)
"feat(daemon): add Trae CLI runtime support" (open, unmerged, 2026‑10‑15) touches **18 files**: new
`traecli-runtime-adapter.ts` (+817) and `traecli-resume.ts` (+167), plus `startup.ts`, `rigspec-preflight.ts`,
`runtime-verifier.ts`, `restore-orchestrator.ts`, `native-resume-probe.ts`, `resume-token-validation.ts`,
`provider-types.ts`, `yolo-mode.ts`, `docs/reference/rig-spec.md`, UI `runtime-brand.ts` / `RuntimeMark.tsx`, and tests.
That matches the #43 proposal's claim that a new harness is not a one-file change.

**NOT FOUND / ABSENT:** no `docs/` page, guide, or `rig` command documents adding a runtime for end users. There is
no loader, registry file, env var, or directory a user can drop an adapter into.

---

## 4. Changelog / what's-new / ROADMAP on generic runtime work

**FOUND EVIDENCE.**

- **0.6.10 is the latest release** — confirmed both ways: [`/releases`](https://github.com/mvschwarz/openrig/releases)
  shows `v0.6.10` published **2026‑10‑12T07:01:52Z**, and `package.json` on `main` is `0.6.10`
  ([whats-new](https://openrig.dev/whats-new): *"OpenRig 0.6.10 — 12 October 2026"*).
- **0.6.10 contains no generic/pluggable-runtime work.** Its only harness-related item is provider *selection*:
  > **"Tell setup which agent harnesses you use, and it installs and checks only those. A harness you skip no longer
  > shows up as a failure."** … `rig setup --providers claude` (or `codex`, `both`, or a comma list) installs and
  > checks only the harnesses you chose. One you didn't choose reads `skipped`, never failed. … [#1065]
  > — [whats-new §0.6.10 › Setup & platform](https://openrig.dev/whats-new)
  A grep of the CHANGELOG's `## [0.6.10]` section for `runtime`, `adapter`, `harness` and `plugin` found **no**
  runtime-adapter or plugin-protocol entry (only this `--providers` note and an unrelated plugin-version bump).
- **ROADMAP.md has a dedicated "Agents and runtimes" section** ([ROADMAP.md](https://github.com/mvschwarz/openrig/blob/main/ROADMAP.md)):
  > ## Agents and runtimes
  > - **Codex seats that can reach the local daemon by default** (#275), with an easy opt-out.
  > - **Custom Codex providers such as Bedrock** (#194) …
  > - **Operator recovery for Pi and Oh My Pi seats** (#41).
  > - **New agent types:** OpenCode (#87, #227, #517), the Cursor CLI (#352), the Grok CLI (#522) and Devin (#44)
  >   are **planned on a shared adapter**. Design discussion: #43. **Adapter pull requests are welcome once that
  >   adapter lands.**
  The same file prefaces: *"These are things we'd welcome help with… This isn't a schedule or a promise: we release
  often, and an item ships when a good change for it lands."*
- The repo is already using `0.7.0` slice identifiers in source comments/tests (e.g. `OPR.0.7.0.15`), consistent with
  0.7.0 being the in-progress development line — but **no 0.7.0 release or tag exists yet**, and no merged code
  implements a runtime plugin protocol.

**NOT FOUND / ABSENT:** no ROADMAP item, changelog entry, release note, or merged PR names dsh, DeepSeek, or any
generic external-harness loader. The "shared adapter" is **planned, not landed** (ROADMAP: *"Adapter pull requests
are welcome once that adapter lands"*), and the maintainer's 0.7.0 plug-in point is announced in a discussion comment
with a **draft contract still to be posted**.

---

## 5. RigBundle: can a bundle ship a runtime adapter?

**Answer: No — a bundle can only carry content and *select* among built-in runtimes.**

**FOUND EVIDENCE.** [RigBundle Reference](https://openrig.dev/specs/rigbundle) (source
`docs/reference/rig-bundle.md`, *"Last validated against code: 2026‑10‑07, at the 0.6.6 cut"*) defines the archive as:

> A `.rigbundle` is a self-contained distributable archive that packages a rig spec, all referenced agent specs,
> their resources (skills, guidance, startup files), culture file, documentation, and an integrity manifest into a
> single file.

Declared, routable kinds in the manifest are enumerated as **`skills`, `plugins`, `workflow_specs`, `context_packs`,
`agent_images`** (+ `project`), and the archive layout is `bundle.yaml`, `rig.yaml`, `CULTURE.md`, `SETUP.md`,
`agents/…`, `context-packs/…`, `project/…`, `skills/…`. **There is no runtime/adapter/harness kind.**

Runtime handling in bundles is *selection only*, and the allowed set is declared by the bundle author, not shipped
by it:

> `--preset <name>` … Build one of the configurations the bundle declares in `configurations.yaml` beside `rig.yaml` …
> `--seat <pod.member=runtime>` … Use this runtime for one seat, **within what `configurations.yaml` allows**.
> Repeatable; applied after `--preset`. **An undeclared choice is refused with the allowed set, and nothing is built.**

The `configuration` manifest field example confirms the values are existing runtime IDs:
`configuration: { id: "dev.lead=claude-code,dev.researcher=codex" }`.

**What a bundle's `plugins` are (found evidence — this is the likely source of confusion):** they are *agent*
plugins in Claude Code / Codex plugin format, projected into a seat's runtime, not runtime adapters. See
[AgentSpec](https://openrig.dev/specs/agentspec):

> `plugins` | `id`, `source`, `plugin_type`* | Local plugin directories; selected with `uses.plugins`. `source.kind`
> must be `local`. **`plugin_type` is `claude`, `codex` or `auto` (default)**: Claude projects a plugin to
> `<cwd>/.claude/plugins/<id>` when it is `claude`, or `auto` with a `.claude-plugin/plugin.json`; Codex projects to
> `<cwd>/.codex/plugins/<id>` …

Confirmed in code: `PluginRuntime = "claude" | "codex"` (`packages/daemon/src/domain/plugin-discovery-service.ts:36`),
manifests only `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, and
`plugin_type: must be "claude" | "codex" | "auto"` (`agent-manifest.ts`). The FAQ makes the same distinction:

> OpenRig does have its own packaging mechanism called a plugin, managed with `rig plugin`: a way to bundle an
> extension so it can be discovered and used inside a rig. That is a component you can use within OpenRig. It is not
> what OpenRig itself is. — [FAQ](https://openrig.dev/docs/faq)

**NOT FOUND / ABSENT:** no bundle manifest field, `bundles.ts` route, or install path that registers, loads, or
executes a runtime adapter; no `runtime` kind among the declared bundle contents; no documentation statement that a
third party can ship a runtime via a bundle.

---

## Bottom line for a "dsh in OpenRig" effort

1. **dsh is not mentioned, supported, planned, or requested anywhere in OpenRig's public surface** as of 2026‑10‑15.
   `deepseek` appears in OpenRig only as a *provider API-key name attached to the Pi runtime*.
2. **Nothing can be done today by configuration or by a bundle** — `runtime: dsh` would fail preflight with
   `unsupported runtime "dsh"`.
3. The only two paths that exist per the sources are: (a) **write an in-repo adapter** following ARCHITECTURE.md
   "A runtime adapter" and get it merged (the process every other harness used, including the still-open Trae CLI PR),
   or (b) **wait for the planned 0.7.0 plug-in point** announced in Discussion #43, for which the draft contract has
   not yet been posted. Beyond that, CONTRIBUTING.md says an integration's best home is often the contributor's own
   repository.
4. Any statement about *intent* to support dsh would be speculation — no source says anything about it either way.
