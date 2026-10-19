#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// dsh-seat — Phase 1 seat runner: hosts a DeepSeek Harness agent (ACP profile)
// inside the seat's tmux pane so OpenRig can adopt and drive it.
//
// Why this exists: OpenRig seats are tmux-first — `rig send` types into the pane
// and `rig capture` reads it — while dsh is protocol-first (no first-party TUI;
// its interactive surface is a browser, `headless` is one-shot, and `acp`/`sdk`
// speak JSON-RPC on stdio). This runner is the bridge, and it deliberately
// follows OpenRig's pi-runner shape so Phase 2 (a first-class `dsh` runtime
// adapter) can lift it unchanged:
//
//   pane stdin (rig send / human typing) ──▶ ACP session/prompt   (one prompt per
//                                            Enter, pastes kept whole; queued, one
//                                            prompt may be in flight at a time)
//   ACP session/update                   ──▶ human-readable pane mirror
//   ACP session/request_permission       ──▶ answered from the seat's posture
//   turn boundaries                      ──▶ POST /api/activity/hooks
//   lifecycle truth                      ──▶ <stateRoot>/<session>/runner-state.json
//   each turn's usage (dsh session log)  ──▶ <stateRoot>/<session>/turns.jsonl, stamped
//                                            with the harness fingerprint that ran it
//
// Honest failure: a dead dsh child prints EXIT/ERROR and records `exited` in the
// sidecar — never a silently frozen pane (pi-runner.ts:9-13, Rule 15).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { AcpClient } from "./acp.mjs";
import { attachPaneInput } from "./input.mjs";
import {
  normalizePosture,
  permissionDecision,
  permissionModeForPosture,
  describePermission,
  describeDecision,
} from "./permissions.mjs";
import { ActivityPoster, readActivityEndpoint, defaultOpenRigHome } from "./activity.mjs";
import { dshChildEnv, telemetryChosen, uploadsLeftOn } from "./privacy.mjs";
import { CLAIM_HINT, resolveSeatIdentity } from "./identity.mjs";
import { HarnessFingerprinter, defaultAgentsHome, diffHarness } from "./fingerprint.mjs";
import { SessionLogTail, TAKE_WAITS_MS, TURN_RECORD_SCHEMA, turnUsageFields } from "./usage.mjs";
import { appendJsonl, seatFile, sidecarPath, writeJsonAtomic, writeSidecar } from "./state.mjs";

export const RUNNER_READY_MARKER = "[dsh-runner] READY";
export const RUNNER_EXIT_MARKER = "[dsh-runner] EXITED";
export const RUNNER_ERROR_MARKER = "[dsh-runner] ERROR";

const VERSION = "0.1.0";
const DEFAULT_PROFILE = "acp";

/** A delay that never holds the process open on its own. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (n) => n.toLocaleString("en-US");

// ── Pane output ─────────────────────────────────────────────────────────────
// ACP streams deltas, so the writer tracks whether the pane is mid-line before
// emitting any framed line. This keeps the transcript readable and keeps the
// markers on their own lines for anything that greps the pane.

export class PaneWriter {
  #out;
  #styled;
  #midLine = false;

  constructor(out = process.stdout, { styled = Boolean(out.isTTY) } = {}) {
    this.#out = out;
    this.#styled = styled;
  }

  /** Raw streamed text (assistant output) — no added newline. */
  text(chunk) {
    if (!chunk) return;
    this.#out.write(chunk);
    this.#midLine = !chunk.endsWith("\n");
  }

  /** Streamed reasoning, visually secondary to the answer. */
  thought(chunk) {
    if (!chunk) return;
    if (!this.#midLine) {
      this.#out.write(this.#styled ? "\x1b[2m· " : "· ");
    }
    this.#out.write(chunk);
    this.#midLine = !chunk.endsWith("\n");
    if (this.#styled && !this.#midLine) this.#out.write("\x1b[0m");
  }

  /** Echoed pane input (raw mode turns the terminal's own echo off). */
  input(chunk) {
    if (!chunk) return;
    this.#out.write(chunk);
    this.#midLine = !chunk.endsWith("\n");
  }

  /** A framed line of our own (markers, tool summaries, errors). */
  line(text = "") {
    if (this.#midLine) {
      this.#out.write("\n");
      this.#midLine = false;
    }
    this.#out.write(`${text}\n`);
  }
}

// ── Arguments ───────────────────────────────────────────────────────────────

export function parseArgs(argv, env = process.env) {
  const args = {
    sessionName: null,
    cwd: process.cwd(),
    dshHome: env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : path.join(os.homedir(), ".dsh"),
    dshCommand: "dsh",
    profile: DEFAULT_PROFILE,
    stateRoot: path.join(defaultOpenRigHome(env), "state", "dsh"),
    sessionsRoot: null,
    launchId: null,
    posture: "floor",
    session: null,
    model: null,
    effort: null,
    mcpServersFile: null,
    runtimeLabel: "dsh",
    nodeId: null,
    generation: null,
    activity: true,
    resumeFallbackFresh: false,
    requestTimeoutMs: 0,
    verbose: false,
    help: false,
  };

  const takesValue = new Set([
    "--session-name",
    "--cwd",
    "--dsh-home",
    "--dsh-command",
    "--profile",
    "--state-root",
    "--sessions-root",
    "--launch-id",
    "--posture",
    "--session",
    "--model",
    "--effort",
    "--mcp-servers",
    "--runtime-label",
    "--node-id",
    "--generation",
    "--request-timeout",
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    let flag = token;
    let inline = null;
    if (token.startsWith("--") && token.includes("=")) {
      const at = token.indexOf("=");
      flag = token.slice(0, at);
      inline = token.slice(at + 1);
    }
    const readValue = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[i];
    };

    if (takesValue.has(flag)) {
      const value = readValue();
      switch (flag) {
        case "--session-name": args.sessionName = value; break;
        case "--cwd": args.cwd = value; break;
        case "--dsh-home": args.dshHome = value; break;
        case "--dsh-command": args.dshCommand = value; break;
        case "--profile": args.profile = value; break;
        case "--state-root": args.stateRoot = value; break;
        case "--sessions-root": args.sessionsRoot = value; break;
        case "--launch-id": args.launchId = value; break;
        case "--posture": args.posture = value; break;
        case "--session": args.session = value; break;
        case "--model": args.model = value; break;
        case "--effort": args.effort = value; break;
        case "--mcp-servers": args.mcpServersFile = value; break;
        case "--runtime-label": args.runtimeLabel = value; break;
        case "--node-id": args.nodeId = value; break;
        case "--generation": args.generation = value; break;
        case "--request-timeout": {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative number`);
          args.requestTimeoutMs = parsed;
          break;
        }
        default: throw new Error(`unhandled flag ${flag}`);
      }
      continue;
    }

    switch (flag) {
      case "--no-activity": args.activity = false; break;
      case "--resume-fallback-fresh": args.resumeFallbackFresh = true; break;
      case "--verbose": args.verbose = true; break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown argument "${token}"`);
    }
  }

  args.cwd = path.resolve(args.cwd);
  args.dshHome = path.resolve(args.dshHome);
  args.stateRoot = path.resolve(args.stateRoot);
  args.sessionsRoot = path.resolve(args.sessionsRoot ?? path.join(args.dshHome, "sessions"));
  if (!args.sessionName) args.sessionName = `${path.basename(args.cwd)}-dsh`;
  if (!args.launchId) args.launchId = randomUUID();
  args.posture = normalizePosture(args.posture);
  return args;
}

const USAGE = `dsh-seat — host a DeepSeek Harness agent in a tmux pane as an OpenRig seat

Usage: node src/dsh-seat.mjs --session-name <seat@rig> [options]

Options:
  --session-name <name>   seat identity, usually <member>@<rig> (default: <cwd-basename>-dsh)
  --cwd <dir>             session workspace; dsh requires an absolute path (default: $PWD)
  --dsh-home <dir>        DSH_HOME for this seat (default: $DSH_HOME, else ~/.dsh)
  --dsh-command <cmd>     dsh executable (default: dsh)
  --profile <name>        dsh profile to boot (default: acp)
  --state-root <dir>      sidecar and turn-record root (default: $OPENRIG_HOME/state/dsh)
  --sessions-root <dir>   dsh session-log root, read for turn usage (default: <dsh-home>/sessions)
  --launch-id <id>        launch-attempt id stamped into the sidecar (default: random)
  --posture <p>           floor | auto | full_bypass (default: floor)
  --session <id>          resume this dsh session instead of creating a new one
  --model <value>         set the ACP "model" config option after session setup
  --effort <value>        set the ACP "reasoning_effort" config option
  --mcp-servers <file>    JSON file holding the ACP mcpServers array
  --runtime-label <l>     runtime label for activity posts (default: dsh)
  --node-id <id>          OpenRig node id for activity posts
  --generation <uuid>     occupant generation for activity posts
  --no-activity           do not POST activity to the OpenRig daemon
  --resume-fallback-fresh fall back to a fresh session when resume fails
  --request-timeout <ms>  ACP request timeout (default: 0 = wait indefinitely)
  --verbose               print ignored protocol traffic
  -h, --help              this help

Local pane commands: /help /session /usage /cancel /quit
`;

/** One pane line for a recorded turn's usage. */
function describeUsage(fields) {
  const { usage, tools } = fields;
  const parts = [
    `${fields.llmCalls} model call${fields.llmCalls === 1 ? "" : "s"}`,
    `in ${count(usage.inputTokens)}`,
    `cache read ${count(usage.cacheReadTokens)}`,
  ];
  if (usage.cacheWriteTokens) parts.push(`cache write ${count(usage.cacheWriteTokens)}`);
  parts.push(`out ${count(usage.outputTokens)}`);
  if (tools.calls) parts.push(`${tools.calls} tool call${tools.calls === 1 ? "" : "s"}${tools.errors ? ` (${tools.errors} failed)` : ""}`);
  const models = Object.keys(fields.byModel);
  if (models.length) parts.push(models.join(", "));
  return `${parts.join(" · ")}${fields.usageSource === "session-log" ? "" : ` · partial: ${fields.usageNote}`}`;
}

// ── The seat ────────────────────────────────────────────────────────────────

/**
 * Run one seat until the agent or the pane dies. Exported so tests can drive it
 * with an injected ACP command and I/O.
 *
 * @returns {Promise<{code: number, sessionId: string|null}>}
 */
export async function runSeat(options) {
  const {
    args,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    env = process.env,
    clientFactory = (opts) => new AcpClient(opts),
    activityFactory = (opts) => new ActivityPoster(opts),
    identityResolver = null,
    now = () => new Date().toISOString(),
  } = options;

  const writer = new PaneWriter(output);
  const sidecar = sidecarPath({ stateRoot: args.stateRoot, sessionName: args.sessionName });
  const posture = normalizePosture(args.posture);
  const permissionMode = permissionModeForPosture(posture);

  let sessionId = args.session ?? null;
  let shuttingDown = false;
  let exitReason = null;
  let exitCode = 0;
  let exitAnnounced = false;
  let ready = false;
  let lastUsagePercent = null;
  let lastContext = null;
  let agentGone = false;

  const mcpServersText = args.mcpServersFile ? fs.readFileSync(args.mcpServersFile, "utf8") : null;
  const mcpServers = mcpServersText === null ? [] : JSON.parse(mcpServersText);

  // The OpenRig seat this pane is: given on the command line, or learned after
  // adoption (see refreshIdentity below).
  let identity = { nodeId: args.nodeId ?? null, generation: args.generation ?? null };

  // The harness each turn runs with (src/fingerprint.mjs), and where turns are
  // recorded with their usage (src/usage.mjs).
  const fingerprinter = new HarnessFingerprinter({
    cwd: args.cwd,
    dshHome: args.dshHome,
    agentsHome: defaultAgentsHome(env),
    profile: args.profile,
  });
  let harness = null;
  let agentInfo = null;
  let logTail = null;
  const turnsFile = seatFile(args, "turns.jsonl");

  // Each write replaces the whole sidecar, so `exited` is carried forward
  // rather than dropped by a mid-run write that does not mention it.
  let lastExited = null;
  const writeState = (patch = {}) => {
    if ("exited" in patch) lastExited = patch.exited;
    writeSidecar(sidecar, {
      ready,
      launchId: args.launchId,
      sessionName: args.sessionName,
      cwd: args.cwd,
      posture,
      permissionMode,
      sessionId,
      nodeId: identity.nodeId,
      generation: identity.generation,
      harnessFingerprint: harness?.fingerprint ?? null,
      runnerPid: process.pid,
      updatedAt: now(),
      exited: lastExited,
      ...patch,
    });
  };

  // The daemon's activity endpoint: read now and, while missing, again whenever
  // the seat looks up its identity — a seat can start before the daemon has
  // ever run, and adoption's claim hint is proof that it runs now.
  let endpoint = args.activity ? readActivityEndpoint(defaultOpenRigHome(env)) : null;
  const activity = activityFactory({
    sessionName: args.sessionName,
    nodeId: identity.nodeId,
    generation: identity.generation,
    runtime: args.runtimeLabel,
    endpoint,
    onError: (err) => {
      if (args.verbose) errorOutput.write(`[dsh-seat] activity post failed: ${err.message}\n`);
    },
  });

  const findEndpoint = () => {
    if (endpoint || !args.activity) return;
    endpoint = readActivityEndpoint(defaultOpenRigHome(env));
    if (!endpoint) return;
    activity.setEndpoint?.(endpoint);
    writer.line(`[dsh-seat] activity reporting on: found the OpenRig endpoint ${endpoint.baseUrl}`);
    if (ready && sessionId) activity.sessionIdentity({ sessionId });
  };

  // An explicit --generation wins outright; otherwise ask the daemon whose
  // activity endpoint we post to — for the generation of the given --node-id,
  // or for both.
  const lookup = { nodeId: args.nodeId ?? null };
  const resolveIdentity = args.generation
    ? null
    : identityResolver
      ? () => identityResolver(lookup)
      : () =>
          endpoint
            ? resolveSeatIdentity({ baseUrl: endpoint.baseUrl, sessionName: args.sessionName, nodeId: lookup.nodeId })
            : { ok: false, reason: "no OpenRig activity endpoint yet" };
  let identityInFlight = null;
  let identityAskedAt = 0;

  /**
   * Ask the daemon which node and occupant generation this pane is bound to,
   * retrying after each delay until the generation is known. Never blocks the
   * seat: callers fire and forget, and a failure only leaves activity untrusted.
   */
  const refreshIdentity = (reason, retryDelays = []) => {
    findEndpoint();
    if (!resolveIdentity || identityInFlight) return identityInFlight;
    identityAskedAt = Date.now();
    identityInFlight = (async () => {
      for (const delay of [0, ...retryDelays]) {
        if (shuttingDown) return;
        if (delay) await sleep(delay);
        let found;
        try {
          found = await resolveIdentity();
        } catch (err) {
          found = { ok: false, reason: err.message };
        }
        if (shuttingDown) return;
        if (!found?.ok) continue;
        // A generation belongs to its node: never pair another node's with --node-id.
        if (args.nodeId && found.nodeId !== args.nodeId) continue;
        const next = { nodeId: found.nodeId, generation: found.generation ?? null };
        if (next.nodeId !== identity.nodeId || next.generation !== identity.generation) {
          identity = next;
          activity.setIdentity?.(identity);
          writeState({});
          writer.line(
            `[dsh-seat] OpenRig seat: node ${identity.nodeId} · ${identity.generation ? `generation ${identity.generation}` : "generation not yet recorded"} (${reason})`,
          );
        }
        if (identity.generation) return;
      }
    })().finally(() => {
      identityInFlight = null;
    });
    return identityInFlight;
  };

  /**
   * Hash the harness as it stands; when it changed, keep a manifest of it and
   * say so in the pane. Runs at READY and before every turn, so each turn
   * record names the harness that ran it.
   */
  const refreshHarness = () => {
    let next;
    try {
      next = fingerprinter.compute({
        runner: VERSION,
        agent: agentInfo?.name ? `${agentInfo.name}@${agentInfo.version ?? "unknown"}` : null,
        profile: args.profile,
        posture,
        mcpServers: mcpServersText === null ? null : sha256(mcpServersText),
      });
    } catch (err) {
      if (args.verbose) writer.line(`[dsh-seat] harness fingerprint failed: ${err.message}`);
      return;
    }
    if (next.fingerprint === harness?.fingerprint) return;
    const previous = harness;
    harness = next;
    try {
      writeJsonAtomic(seatFile(args, path.join("harness", `${next.fingerprint}.json`)), { ...next, computedAt: now() });
    } catch {
      /* the fingerprint stands without its manifest */
    }
    writeState({});
    const short = (h) => h.fingerprint.slice(0, 12);
    if (!previous) {
      const files = `${next.files.length} file${next.files.length === 1 ? "" : "s"}${next.truncated ? ", truncated" : ""}`;
      writer.line(`[dsh-seat] harness ${short(next)} (${files})`);
      return;
    }
    const diff = diffHarness(previous, next);
    const counts = [["+", diff.added], ["~", diff.changed], ["-", diff.removed]]
      .filter(([, labels]) => labels.length)
      .map(([sign, labels]) => `${sign}${labels.length}`);
    const what = [counts.length ? `${counts.join(" ")} files` : "", diff.settings.length ? `settings: ${diff.settings.join(", ")}` : ""]
      .filter(Boolean)
      .join(" · ");
    writer.line(`[dsh-seat] harness changed ${short(previous)} → ${short(next)} (${what})`);
  };

  writeState({ ready: false, exited: null });

  writer.line(`[dsh-seat] ${args.sessionName} · cwd ${args.cwd} · profile ${args.profile}`);
  writer.line(`[dsh-seat] DSH_HOME ${args.dshHome} · posture ${posture} · DSH_PERMISSION_MODE ${permissionMode}`);
  writer.line(`[dsh-seat] launch ${args.launchId}${activity.enabled ? "" : " · activity reporting off"}`);

  if (!args.activity) writer.line("[dsh-seat] activity reporting disabled by flag");
  else if (!activity.enabled) {
    writer.line("[dsh-seat] activity reporting off for now: no OpenRig activity endpoint yet (looked for again at adoption)");
  }

  writer.line(
    telemetryChosen(env)
      ? "[dsh-seat] dsh telemetry: operator setting kept"
      : "[dsh-seat] dsh telemetry off (DSH_TELEMETRY_DISABLED=1)",
  );
  const uploads = uploadsLeftOn({ dshHome: args.dshHome, profile: args.profile });
  if (uploads.length) {
    writer.line(
      `[dsh-seat] note: official DeepSeek API requests from this seat also carry ${uploads.map((u) => u.label).join(" and ")}; ` +
        `enabled: false on ${uploads.map((u) => u.id).join(" and ")} in ${path.join(args.dshHome, "cordis.patch.yml")} ` +
        `turns ${uploads.length === 1 ? "it" : "them"} off (scripts/make-seat-home.sh writes that for a new home)`,
    );
  }

  const client = clientFactory({
    command: args.dshCommand,
    args: ["--profile", args.profile],
    cwd: args.cwd,
    env: dshChildEnv(env, {
      dshHome: args.dshHome,
      permissionMode,
      sessionName: args.sessionName,
      openrigUrl: endpoint?.baseUrl ?? null,
    }),
    requestTimeoutMs: args.requestTimeoutMs,
  });

  // ── turn records ──────────────────────────────────────────────────────────

  const launchTotals = { turns: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let usageGapNoted = false;

  /**
   * Append one turn's record to turns.jsonl: what ran it (harness, model, seat
   * identity), how it ended, and the tokens it used per the dsh session log.
   * Never throws; waits at most TAKE_WAITS_MS for the log to catch up.
   */
  async function recordTurn(turn) {
    const endedAt = now();
    const durationMs = Date.now() - turn.startedMs;
    let taken = { rows: [], settled: false, error: "no session log reader" };
    // A dead or departing agent writes no more; anything else gets the full
    // wait, a failed prompt included — its turn may still be ending.
    const waits = shuttingDown || agentGone ? [0] : TAKE_WAITS_MS;
    try {
      if (logTail) taken = await logTail.takeTurn({ waits });
    } catch (err) {
      taken = { rows: [], settled: false, error: err.message };
    }
    const fields = turnUsageFields(taken);
    try {
      appendJsonl(turnsFile, {
        schema: TURN_RECORD_SCHEMA,
        sessionName: args.sessionName,
        launchId: args.launchId,
        sessionId,
        turn: turn.number,
        startedAt: turn.startedAt,
        endedAt,
        durationMs,
        stopReason: turn.stopReason,
        error: turn.error,
        nodeId: identity.nodeId,
        generation: identity.generation,
        harnessFingerprint: turn.harness,
        posture,
        model: args.model,
        effort: args.effort,
        promptBytes: Buffer.byteLength(turn.text),
        promptSha256: sha256(turn.text),
        context: lastContext,
        ...fields,
      });
    } catch (err) {
      writer.line(`[dsh-seat] could not write the turn record: ${err.message}`);
    }
    if (!fields.usage) {
      if (!usageGapNoted) writer.line(`[usage] unavailable: ${fields.usageNote}`);
      usageGapNoted = true;
      return;
    }
    launchTotals.turns += 1;
    for (const key of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]) launchTotals[key] += fields.usage[key];
    writer.line(`[usage] ${describeUsage(fields)}`);
  }

  const queue = [];
  let inFlight = false;
  let turnDone = null; // the current turn, through its record
  let turnNumber = 0;

  const pump = () => {
    // The next prompt waits for the last turn's record, so the session-log
    // rows of one turn are never read as another's.
    if (turnDone || shuttingDown || agentGone || queue.length === 0) return;
    const text = queue.shift();
    inFlight = true;
    refreshHarness();
    const turn = {
      number: ++turnNumber,
      text,
      startedAt: now(),
      startedMs: Date.now(),
      harness: harness?.fingerprint ?? null,
      stopReason: null,
      error: null,
    };
    // Still no generation? Ask again now and then, so a seat adopted without a
    // claim hint reaching it still becomes trusted.
    if (!identity.generation && Date.now() - identityAskedAt > 60_000) void refreshIdentity("turn");
    activity.turnStart();
    turnDone = client
      .prompt({ sessionId, text })
      .then((result) => {
        turn.stopReason = result?.stopReason ?? "unknown";
        writer.line(`── turn end (${turn.stopReason}) ──`);
      })
      .catch((err) => {
        turn.error = err.message;
        if (!shuttingDown) writer.line(`${RUNNER_ERROR_MARKER} prompt failed: ${err.message}`);
      })
      .then(() => {
        inFlight = false;
        activity.turnEnd();
        return recordTurn(turn);
      })
      .finally(() => {
        turnDone = null;
        pump();
      });
  };

  const enqueue = (text) => {
    if (agentGone) {
      writer.line("[dsh-seat] the agent has exited; this prompt was not sent");
      return;
    }
    queue.push(text);
    if (inFlight || queue.length > 1) writer.line(`[queued: ${queue.length}${inFlight ? " · 1 running" : ""}]`);
    pump();
  };

  const localCommand = (line) => {
    const [verb] = line.slice(1).split(/\s+/);
    switch (verb) {
      case "help":
        writer.line("local: /help /session /usage /cancel /quit — anything else is sent to the agent");
        return true;
      case "session":
        writer.line(`[dsh-seat] session ${sessionId ?? "(none)"} · cwd ${args.cwd}`);
        return true;
      case "usage": {
        const context = lastUsagePercent === null ? "context: not reported yet" : `context ${lastUsagePercent}% used`;
        const spent = launchTotals.turns
          ? ` · this launch: ${launchTotals.turns} turn${launchTotals.turns === 1 ? "" : "s"}, in ${count(launchTotals.inputTokens)}, cache read ${count(launchTotals.cacheReadTokens)}, out ${count(launchTotals.outputTokens)}`
          : "";
        writer.line(`[dsh-seat] ${context}${spent} · records ${turnsFile}`);
        return true;
      }
      case "cancel":
        if (sessionId) {
          client.cancel({ sessionId });
          writer.line("[dsh-seat] cancel requested");
        }
        return true;
      case "quit":
      case "exit":
        writer.line("[dsh-seat] closing");
        void shutdown("user-quit");
        return true;
      default:
        return false;
    }
  };

  // ── protocol events ───────────────────────────────────────────────────────

  client.on("stderr", ({ line }) => {
    // dsh keeps stdout for protocol frames; its diagnostics are worth seeing,
    // but must not be mistaken for agent output.
    if (line.trim()) writer.line(`[dsh] ${line}`);
  });

  client.on("stdout", ({ line }) => {
    writer.line(`[dsh-seat] unexpected agent stdout: ${line.slice(0, 200)}`);
  });

  client.on("notification", ({ method, params }) => {
    if (method !== "session/update") {
      if (args.verbose) writer.line(`[dsh-seat] notification ${method}`);
      return;
    }
    if (params.sessionId && params.sessionId !== sessionId) return;
    const update = params.update ?? {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") writer.text(update.content.text);
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text") writer.thought(update.content.text);
        break;
      case "tool_call":
        writer.line(`[tool] ${update.title ?? update.kind ?? update.toolCallId ?? "call"}${update.status ? ` — ${update.status}` : ""}`);
        break;
      case "tool_call_update": {
        const label = update.title ?? update.toolCallId ?? "call";
        if (update.status) writer.line(`[tool] ${label} — ${update.status}`);
        break;
      }
      case "usage_update": {
        if (typeof update.used === "number" && typeof update.size === "number" && update.size > 0) {
          const percent = Math.floor((update.used / update.size) * 100);
          lastContext = { used: update.used, size: update.size };
          if (percent !== lastUsagePercent) {
            lastUsagePercent = percent;
            writer.line(`[context] ${percent}% (${update.used}/${update.size})`);
          }
        }
        break;
      }
      case "session_info_update":
        if (update.title) writer.line(`[session] ${update.title}`);
        break;
      case "config_option_update":
        if (args.verbose) writer.line(`[dsh-seat] config ${JSON.stringify(update).slice(0, 160)}`);
        break;
      default:
        if (args.verbose) writer.line(`[dsh-seat] update ${update.sessionUpdate}`);
        break;
    }
  });

  client.on("request", ({ method, params, respond }) => {
    if (method !== "session/request_permission") {
      respond.error(-32601, `dsh-seat does not implement ${method}`);
      writer.line(`[dsh-seat] refused unimplemented agent request ${method}`);
      return;
    }
    const decision = permissionDecision(params.options, posture);
    respond(decision);
    writer.line(`[permission] ${describePermission(params)} → ${describeDecision(decision, params.options)} (posture ${posture})`);
  });

  const exited = new Promise((resolve) => {
    client.on("exit", ({ code, signal }) => {
      agentGone = true;
      if (queue.length) {
        writer.line(`[dsh-seat] ${queue.length} queued prompt${queue.length === 1 ? "" : "s"} dropped: the agent has exited`);
        queue.length = 0;
      }
      // A child that exits because WE are shutting it down is not an agent
      // failure: keep the real reason (user-quit / signal-* / stdin-closed) so
      // the sidecar records why the seat ended rather than an incidental exit.
      if (!shuttingDown) {
        exitReason = `agent-exit code=${code} signal=${signal}`;
        exitCode = code === 0 ? 0 : 1;
      }
      resolve();
    });
  });

  // ── shutdown ──────────────────────────────────────────────────────────────

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    exitReason = reason;
    writer.line(`[dsh-seat] shutting down (${reason})`);
    if (sessionId) {
      try {
        await client.closeSession({ sessionId });
      } catch {
        /* agent may already be gone */
      }
    }
    await client.dispose();
  }

  // runSeat waits for this before returning, or the CLI's exit could beat the
  // marker and the sidecar write and leave a dead seat recorded as ready.
  let signalled = null;
  const onSignal = (signal) => {
    if (signalled) return;
    exitAnnounced = true;
    signalled = shutdown(`signal-${signal}`)
      .then(() => (turnDone ? Promise.race([turnDone, sleep(5000)]) : null))
      .then(() => {
        writer.line(`${RUNNER_EXIT_MARKER} (${signal})`);
        writeState({ ready: false, exited: { reason: `signal-${signal}` } });
        process.exitCode = 0;
        resolveDone();
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  // ── start ─────────────────────────────────────────────────────────────────

  try {
    client.start?.();
    const initialized = await client.initialize({ clientInfo: { name: "dsh-seat", version: VERSION } });
    agentInfo = initialized?.agentInfo ?? null;

    if (args.session) {
      try {
        const resumed = await client.resumeSession({ sessionId: args.session, cwd: args.cwd, mcpServers });
        sessionId = resumed?.sessionId ?? args.session;
        writer.line(`[dsh-seat] resumed session ${sessionId}`);
      } catch (err) {
        if (!args.resumeFallbackFresh) throw err;
        writer.line(`${RUNNER_ERROR_MARKER} resume failed (${err.message}); starting a fresh session`);
        const created = await client.newSession({ cwd: args.cwd, mcpServers });
        sessionId = created.sessionId;
      }
    } else {
      const created = await client.newSession({ cwd: args.cwd, mcpServers });
      sessionId = created.sessionId;
      writer.line(`[dsh-seat] session ${sessionId}`);
    }

    if (args.model) await client.setConfigOption({ sessionId, configId: "model", value: args.model });
    if (args.effort) await client.setConfigOption({ sessionId, configId: "reasoning_effort", value: args.effort });

    // Turn usage is read from the session log; what it held before this
    // launch (a resumed session's history) is not this launch's work.
    logTail = new SessionLogTail({ sessionsRoot: args.sessionsRoot, sessionId });
    const logGap = logTail.skipExisting();
    refreshHarness();
    writer.line(`[dsh-seat] turn records → ${turnsFile}${logGap ? ` · usage: ${logGap}` : ""}`);

    ready = true;
    writeState({ ready: true, exited: null });
    activity.sessionIdentity({ sessionId });
    writer.line(RUNNER_READY_MARKER);
    writer.line("[dsh-seat] type a line + Enter to prompt · /help for local commands");
    // A runner restarted after adoption is already bound; a new pane is not yet.
    void refreshIdentity("ready");
  } catch (err) {
    writer.line(`${RUNNER_ERROR_MARKER} setup failed: ${err.message}`);
    writeState({ ready: false, exited: { reason: "setup-failed", error: err.message } });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await client.dispose();
    return { code: 1, sessionId };
  }

  const paneInput = attachPaneInput({
    input,
    output,
    echo: (text) => writer.input(text),
    onSubmit: (text, { pasted = false } = {}) => {
      if (shuttingDown) return;
      // Only a typed line can be a local command; anything pasted — every
      // `rig send` — goes to the agent, even when it starts with "/".
      if (!pasted && text.startsWith("/") && !text.includes("\n") && localCommand(text.trim())) return;
      // Adoption has just bound this pane: learn the node and generation it got.
      if (CLAIM_HINT.test(text)) void refreshIdentity("adopted", [500, 1500, 4000]);
      enqueue(text);
    },
    onInterrupt: () => {
      if (inFlight && sessionId) {
        client.cancel({ sessionId });
        writer.line("[dsh-seat] cancel requested (Ctrl-C)");
      } else {
        writer.line("[dsh-seat] Ctrl-C: no turn is running · /quit closes the seat");
      }
    },
    onReject: (maxBytes) => {
      writer.line(`[dsh-seat] input rejected: larger than ${maxBytes} bytes — send a smaller message`);
    },
    // A seat whose pane input is gone has no way to receive work: end honestly
    // rather than sit frozen holding a session open.
    onClose: () => {
      if (!shuttingDown) void shutdown("stdin-closed").then(resolveDone);
    },
  });

  await Promise.race([exited, done]);
  // A turn cut short by the exit still gets its record.
  if (turnDone) await Promise.race([turnDone, sleep(5000)]);
  if (signalled) await signalled;

  if (!exitAnnounced && exitReason) {
    const marker = exitReason.startsWith("agent-exit") && exitCode !== 0 ? RUNNER_ERROR_MARKER : RUNNER_EXIT_MARKER;
    writer.line(`${marker} (${exitReason})`);
    writeState({ ready: false, exited: { reason: exitReason, code: exitCode } });
  }

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  paneInput.detach();
  return { code: exitCode, sessionId };
}

// ── CLI entry (self-invocation guard, as pi-runner.ts:1005-1018 does) ───────

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${RUNNER_ERROR_MARKER} ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const { code } = await runSeat({ args });
  process.exit(code ?? 0);
}
