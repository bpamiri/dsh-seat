// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runSeat, parseArgs, RUNNER_READY_MARKER, RUNNER_ERROR_MARKER } from "../src/dsh-seat.mjs";
import { sidecarPath, readSidecar, seatFile } from "../src/state.mjs";
import { fakeAgentFactory, recordingActivity, captureStream, openInput, waitFor } from "./helpers.mjs";

// Seats a test leaves running (an assertion failed before its /quit) are
// closed here, so the failure is reported instead of the test file hanging.
const running = new Set();
test.afterEach(async () => {
  for (const seat of running) {
    seat.input.end();
    await Promise.race([seat.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  running.clear();
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-test-"));
  return { dir, stateRoot: path.join(dir, "state"), home: path.join(dir, "dsh-home") };
}

/** Start a seat against the fake agent and return handles. */
function startSeat({
  argv = [],
  agentEnv = {},
  posture = "floor",
  env = {},
  onClientOptions = () => {},
  identityResolver = null,
} = {}) {
  const { dir, stateRoot, home } = workspace();
  const args = parseArgs(
    [
      "--session-name",
      "dev1-dsh@test-rig",
      "--cwd",
      dir,
      "--state-root",
      stateRoot,
      "--dsh-home",
      home,
      "--posture",
      posture,
      ...argv,
    ],
    {},
  );
  const input = openInput();
  const output = captureStream();
  const activity = recordingActivity();
  const done = runSeat({
    args,
    input,
    output,
    errorOutput: output,
    // Keep the runner away from the real ~/.openrig activity endpoint and ~/.agents skills.
    env: { OPENRIG_HOME: path.join(dir, "openrig-home"), DSH_AGENTS_HOME: path.join(dir, "agents-home"), ...env },
    clientFactory: (opts) => {
      onClientOptions(opts);
      return fakeAgentFactory(agentEnv)(opts);
    },
    activityFactory: () => activity,
    identityResolver,
  });
  const seat = { args, input, output, activity, done, dir, stateRoot, home };
  running.add(seat);
  return seat;
}

/** The seat's turn records so far. */
function turnRecords(seat) {
  try {
    return fs
      .readFileSync(seatFile({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }, "turns.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("parseArgs applies seat defaults and rejects nonsense", () => {
  const args = parseArgs(["--cwd", "/tmp", "--session-name", "a@b"], {});
  assert.equal(args.sessionName, "a@b");
  assert.equal(args.cwd, "/tmp");
  assert.equal(args.profile, "acp");
  assert.equal(args.posture, "floor");
  assert.ok(args.launchId, "a launch id is minted");
  assert.ok(args.stateRoot.endsWith(path.join("state", "dsh")));

  assert.throws(() => parseArgs(["--nope"], {}), /unknown argument/);
  assert.throws(() => parseArgs(["--cwd"], {}), /requires a value/);
  assert.throws(() => parseArgs(["--request-timeout", "soon"], {}), /non-negative number/);
  assert.throws(() => parseArgs(["--posture", "reckless"], {}), /unknown posture/);
});

test("a seat becomes READY, carries a prompt to the agent, and mirrors the answer", async () => {
  const seat = startSeat({ agentEnv: { FAKE_ACP_CHUNKS: "po|ng" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY marker" });

  seat.input.write("what is up\n");
  await waitFor(() => seat.output.text().includes("── turn end (end_turn) ──"), { label: "turn end" });

  const text = seat.output.text();
  assert.match(text, /pong/);
  assert.match(text, /\[dsh-seat\] session session-fake-1/);

  // Sidecar is the daemon's authoritative liveness + resume surface.
  const state = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(state.ready, true);
  assert.equal(state.sessionId, "session-fake-1");
  assert.equal(state.launchId, seat.args.launchId);
  assert.equal(state.permissionMode, "workspace-write");

  // Activity: identity once, then a turn boundary pair.
  assert.deepEqual(seat.activity.kinds(), ["identity", "turnStart", "turnEnd"]);

  seat.input.write("/quit\n");
  const result = await seat.done;
  assert.equal(result.sessionId, "session-fake-1");
  assert.match(seat.output.text(), /\[dsh-runner\] EXITED \(user-quit\)/);

  const finalState = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(finalState.ready, false);
  assert.equal(finalState.exited.reason, "user-quit");
});

test("the seat's posture answers escalations, and the answer reaches the agent", async () => {
  const seat = startSeat({ posture: "floor", agentEnv: { FAKE_ACP_ASK_PERMISSION: "1", FAKE_ACP_CHUNKS: "ok" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("do something risky\n");
  await waitFor(() => seat.output.text().includes("── turn end (end_turn) ──"), { label: "turn end" });

  const text = seat.output.text();
  assert.match(text, /\[permission\] Run a dangerous command → reject_once \(Reject\) \(posture floor\)/);
  assert.match(text, /\|permission=reject-once/);

  seat.input.write("/quit\n");
  await seat.done;
});

test("full_bypass answers with a standing allow", async () => {
  const seat = startSeat({ posture: "full_bypass", agentEnv: { FAKE_ACP_ASK_PERMISSION: "1", FAKE_ACP_CHUNKS: "ok" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("do something risky\n");
  await waitFor(() => seat.output.text().includes("|permission=allow-always"), { label: "permission answer" });

  const state = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(state.permissionMode, "danger-full-access");

  seat.input.write("/quit\n");
  await seat.done;
});

test("prompts arriving mid-turn are queued, not dropped", async () => {
  const seat = startSeat({ agentEnv: { FAKE_ACP_CHUNKS: "slow" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("first\n");
  seat.input.write("second\n");
  seat.input.write("third\n");

  await waitFor(() => (seat.output.text().match(/── turn end \(end_turn\) ──/g) ?? []).length === 3, {
    label: "three turns",
  });
  assert.match(seat.output.text(), /\[queued: 1/);

  seat.input.write("/quit\n");
  await seat.done;
});

test("a dead agent is reported honestly and never leaves a frozen pane", async () => {
  const seat = startSeat({ agentEnv: { FAKE_ACP_EXIT_ON_PROMPT: "1" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("this will kill the agent\n");
  const result = await seat.done;

  assert.equal(result.code, 1);
  assert.match(seat.output.text(), new RegExp(RUNNER_ERROR_MARKER.replace(/[[\]]/g, "\\$&")));

  const state = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(state.ready, false);
  assert.match(state.exited.reason, /agent-exit/);
});

test("resume failure is a loud failure unless fresh fallback is asked for", async () => {
  const failing = startSeat({ argv: ["--session", "session-gone"], agentEnv: { FAKE_ACP_RESUME_FAILS: "1" } });
  const failedResult = await failing.done;
  assert.equal(failedResult.code, 1);
  assert.match(failing.output.text(), new RegExp(RUNNER_ERROR_MARKER.replace(/[[\]]/g, "\\$&")));
  assert.match(failing.output.text(), /resume refused by fake agent/);

  const falling = startSeat({
    argv: ["--session", "session-gone", "--resume-fallback-fresh"],
    agentEnv: { FAKE_ACP_RESUME_FAILS: "1" },
  });
  await waitFor(() => falling.output.text().includes(RUNNER_READY_MARKER), { label: "READY after fallback" });
  assert.match(falling.output.text(), /starting a fresh session/);

  falling.input.write("/quit\n");
  await falling.done;
});

test("context usage and local commands are surfaced to the operator", async () => {
  const seat = startSeat({ agentEnv: { FAKE_ACP_CHUNKS: "x", FAKE_ACP_USAGE: "1", FAKE_ACP_THOUGHT: "1" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("go\n");
  await waitFor(() => seat.output.text().includes("[context] 25%"), { label: "usage line" });

  seat.input.write("/session\n");
  await waitFor(() => seat.output.text().includes("[dsh-seat] session session-fake-1"), { label: "/session" });

  seat.input.write("/help\n");
  await waitFor(() => seat.output.text().includes("local: /help /session /usage /cancel /quit"), { label: "/help" });
  assert.match(seat.output.text(), /considering…/);

  seat.input.write("/quit\n");
  await seat.done;
});

test("a multi-line rig send reaches the agent as one prompt, not one per line", async () => {
  const capture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-capture-")), "prompts.jsonl");
  const seat = startSeat({ agentEnv: { FAKE_ACP_CHUNKS: "got it", FAKE_ACP_CAPTURE: capture } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  // OpenRig pastes the enveloped message whole (paste-buffer -r -p), then Enter.
  const envelope = "From: orch-lead@test-rig\nTo: dev1-dsh@test-rig\n\nImplement X.\nThen run the tests.";
  seat.input.write(`\x1b[200~${envelope}\x1b[201~\r`);
  await waitFor(() => seat.output.text().includes("── turn end (end_turn) ──"), { label: "turn end" });

  const prompts = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(prompts, [[envelope]]);
  assert.equal((seat.output.text().match(/── turn end/g) ?? []).length, 1);

  seat.input.write("/quit\n");
  await seat.done;
});

test("Ctrl-C cancels the turn in flight, and is harmless when idle", async () => {
  const seat = startSeat({ agentEnv: { FAKE_ACP_CHUNKS: "working", FAKE_ACP_HOLD_MS: "10000" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("\x03");
  await waitFor(() => seat.output.text().includes("Ctrl-C: no turn is running"), { label: "idle Ctrl-C" });

  seat.input.write("long job\n");
  await waitFor(() => seat.output.text().includes("working"), { label: "turn in flight" });
  seat.input.write("\x03");
  await waitFor(() => seat.output.text().includes("── turn end (cancelled) ──"), { label: "cancelled turn" });
  assert.match(seat.output.text(), /cancel requested \(Ctrl-C\)/);

  seat.input.write("/quit\n");
  await seat.done;
});

test("the dsh child runs with telemetry off, and the pane flags a home that still uploads session logs", async () => {
  let childEnv = null;
  const seat = startSeat({ onClientOptions: (opts) => (childEnv = opts.env) });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  assert.equal(childEnv.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(childEnv.DSH_HOME, seat.home);
  assert.equal(childEnv.DSH_PERMISSION_MODE, "workspace-write");
  assert.match(seat.output.text(), /dsh telemetry off \(DSH_TELEMETRY_DISABLED=1\)/);
  assert.match(seat.output.text(), /leaves dsh's session-log upload on/);

  seat.input.write("/quit\n");
  await seat.done;
});

test("an operator's telemetry choice is kept, and a patched home gets no upload note", async () => {
  let childEnv = null;
  const { home } = workspace();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "cordis.patch.yml"), "- id: session-log-deepseek\n  config:\n    enabled: false\n");
  const seat = startSeat({
    argv: ["--dsh-home", home],
    env: { DSH_TELEMETRY_MODE: "FEEDBACK_ONLY" },
    onClientOptions: (opts) => (childEnv = opts.env),
  });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  assert.equal(childEnv.DSH_TELEMETRY_DISABLED, undefined);
  assert.equal(childEnv.DSH_TELEMETRY_MODE, "FEEDBACK_ONLY");
  assert.match(seat.output.text(), /dsh telemetry: operator setting kept/);
  assert.doesNotMatch(seat.output.text(), /session-log upload on/);

  seat.input.write("/quit\n");
  await seat.done;
});

test("after adoption, the seat learns its node and generation and stamps activity with them", async () => {
  let adopted = false;
  let asked = 0;
  const seat = startSeat({
    agentEnv: { FAKE_ACP_CHUNKS: "ran rig whoami" },
    identityResolver: async () => {
      asked += 1;
      return adopted ? { ok: true, nodeId: "node-1", generation: "gen-1" } : { ok: false, reason: "not-adopted" };
    },
  });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });
  await waitFor(() => asked === 1, { label: "lookup at READY" });
  assert.deepEqual(seat.activity.identities, [], "an unbound pane stays unstamped");

  // `rig adopt` binds the pane, then types its claim hint (sendText + Enter).
  adopted = true;
  seat.input.write('\x1b[200~--- OpenRig: You have been adopted into rig "test-rig" as scratch.dev1-dsh. Run: rig whoami --json ---\x1b[201~\r');
  await waitFor(() => seat.output.text().includes("OpenRig seat: node node-1 · generation gen-1 (adopted)"), {
    label: "identity line",
  });
  await waitFor(() => seat.output.text().includes("── turn end (end_turn) ──"), { label: "claim hint turn" });

  assert.deepEqual(seat.activity.identities, [{ nodeId: "node-1", generation: "gen-1" }]);
  const lastPost = seat.activity.posts.at(-1);
  assert.equal(lastPost.kind, "turnEnd");
  assert.equal(lastPost.generation, "gen-1");

  const state = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(state.nodeId, "node-1");
  assert.equal(state.generation, "gen-1");
  assert.equal(state.exited, null, "a mid-run sidecar write keeps the exited field");

  seat.input.write("/quit\n");
  await seat.done;
});

test("an identity given on the command line is used as given and never looked up", async () => {
  let asked = 0;
  const seat = startSeat({
    argv: ["--node-id", "node-x", "--generation", "gen-x"],
    identityResolver: async () => {
      asked += 1;
      return { ok: true, nodeId: "other", generation: "other" };
    },
  });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });
  seat.input.write('--- OpenRig: You have been adopted into rig "r" as p.m. Run: rig whoami --json ---\n');
  await waitFor(() => seat.output.text().includes("── turn end (end_turn) ──"), { label: "turn end" });

  assert.equal(asked, 0);
  const state = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(state.nodeId, "node-x");
  assert.equal(state.generation, "gen-x");

  seat.input.write("/quit\n");
  await seat.done;
});

test("each turn is recorded with its usage from the dsh session log, the seat identity, and the harness that ran it", async () => {
  const seat = startSeat({
    argv: ["--node-id", "node-7", "--generation", "gen-7", "--model", "deepseek-v4-flash", "--effort", "high"],
    agentEnv: { FAKE_ACP_SESSION_LOG: "1", FAKE_ACP_LOG_TOOL_ERROR: "1", FAKE_ACP_USAGE: "1", FAKE_ACP_CHUNKS: "done" },
  });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });
  assert.match(seat.output.text(), /\[dsh-seat\] harness [0-9a-f]{12} \(0 files\)/);
  assert.doesNotMatch(seat.output.text(), /usage: no session log/);

  seat.input.write("first job\n");
  await waitFor(() => turnRecords(seat).length === 1, { label: "first record" });
  seat.input.write("second job\n");
  await waitFor(() => turnRecords(seat).length === 2, { label: "second record" });

  const [first, second] = turnRecords(seat);
  const state = readSidecar(sidecarPath({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }));
  assert.equal(first.schema, "dsh-seat/turn/v1");
  assert.equal(first.sessionName, "dev1-dsh@test-rig");
  assert.equal(first.launchId, seat.args.launchId);
  assert.equal(first.sessionId, "session-fake-1");
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 2);
  assert.equal(first.stopReason, "end_turn");
  assert.equal(first.error, null);
  assert.equal(first.nodeId, "node-7");
  assert.equal(first.generation, "gen-7");
  assert.equal(first.posture, "floor");
  assert.equal(first.model, "deepseek-v4-flash");
  assert.equal(first.effort, "high");
  assert.equal(first.promptBytes, Buffer.byteLength("first job"));
  assert.equal(first.promptSha256, createHash("sha256").update("first job").digest("hex"));
  assert.equal(JSON.stringify(first).includes("first job"), false, "the prompt itself is not recorded");
  assert.deepEqual(first.context, { used: 250, size: 1000 });
  assert.ok(first.durationMs >= 0);

  assert.equal(first.usageSource, "session-log");
  assert.equal(first.usageNote, null);
  assert.deepEqual(first.dshTurns, [1]);
  assert.deepEqual(second.dshTurns, [2]);
  assert.deepEqual(first.endReasons, ["completed"]);
  assert.equal(first.llmCalls, 1);
  assert.deepEqual(first.usage, {
    calls: 1,
    inputTokens: 1200,
    cacheReadTokens: 4000,
    cacheWriteTokens: 0,
    outputTokens: 80,
    reasoningTokens: 20,
    totalTokens: 5280,
  });
  assert.deepEqual(Object.keys(first.byModel), ["deepseek/deepseek-v4-flash"]);
  assert.equal(first.contextWindow, 1000000);
  assert.deepEqual(first.tools, { calls: 1, errors: 1, byName: { bash: { calls: 1, errors: 1 } } });

  // The fingerprint in the record is the sidecar's, and its manifest is kept.
  assert.match(first.harnessFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.harnessFingerprint, state.harnessFingerprint);
  const manifest = JSON.parse(
    fs.readFileSync(seatFile({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }, `harness/${first.harnessFingerprint}.json`), "utf8"),
  );
  assert.equal(manifest.fingerprint, first.harnessFingerprint);
  assert.equal(manifest.settings.agent, "fake-acp@0.0.0");
  assert.equal(manifest.settings.posture, "floor");

  assert.match(
    seat.output.text(),
    /\[usage\] 1 model call · in 1,200 · cache read 4,000 · out 80 · 1 tool call \(1 failed\) · deepseek\/deepseek-v4-flash/,
  );
  seat.input.write("/usage\n");
  await waitFor(() => seat.output.text().includes("this launch: 2 turns, in 2,400, cache read 8,000, out 160"), {
    label: "/usage totals",
  });

  seat.input.write("/quit\n");
  await seat.done;
});

test("rows that land after the answer, in zstd frames, still make a whole record, and the next prompt waits for it", async () => {
  // Turn 1's closing row lands 400ms after its answer; turn 2's at once. Were
  // the second prompt sent before turn 1's record, both turns would close
  // inside turn 1's wait and be counted as one.
  const seat = startSeat({
    agentEnv: { FAKE_ACP_SESSION_LOG: "1", FAKE_ACP_LOG_ZSTD: "1", FAKE_ACP_LOG_LATE_END_MS: "400,0", FAKE_ACP_CHUNKS: "ok" },
  });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });

  seat.input.write("first\n");
  await waitFor(() => seat.output.text().includes("── turn end (end_turn) ──"), { label: "first answer" });
  seat.input.write("second\n");
  await waitFor(() => turnRecords(seat).length === 2, { label: "two records", timeoutMs: 10_000 });

  const [first, second] = turnRecords(seat);
  for (const [record, turn] of [[first, 1], [second, 2]]) {
    assert.equal(record.usageSource, "session-log", JSON.stringify(record));
    assert.deepEqual(record.dshTurns, [turn]);
    assert.deepEqual(record.endReasons, ["completed"]);
    assert.equal(record.usage.inputTokens, 1200);
  }

  seat.input.write("/quit\n");
  await seat.done;
});

test("a resumed session's earlier turns are not counted as this launch's", async () => {
  const { home } = workspace();
  const logFile = path.join(home, "sessions", "--fake-project--", "session-old", "session.v4.jsonl");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const history = [
    { type: "session", version: 4, id: "session-old", createdAt: 1, cwd: "/work", isSeeded: false, delegationDepth: 0 },
    { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1, message: { source: { provider: "deepseek", model: "deepseek-v4-pro" } }, usage: { inputTokens: 999999, outputTokens: 999999 }, stream: [] },
    },
    { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  fs.writeFileSync(logFile, history.map((row) => `${JSON.stringify(row)}\n`).join(""));

  const seat = startSeat({ argv: ["--dsh-home", home, "--session", "session-old"], agentEnv: { FAKE_ACP_SESSION_LOG: "1" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });
  seat.input.write("carry on\n");
  await waitFor(() => turnRecords(seat).length === 1, { label: "record" });

  const [record] = turnRecords(seat);
  assert.equal(record.sessionId, "session-old");
  assert.deepEqual(record.dshTurns, [2]);
  assert.equal(record.usage.inputTokens, 1200);
  assert.deepEqual(Object.keys(record.byModel), ["deepseek/deepseek-v4-flash"]);

  seat.input.write("/quit\n");
  await seat.done;
});

test("a skill added between turns changes the fingerprint, and each record names the harness that ran it", async () => {
  const seat = startSeat({ agentEnv: { FAKE_ACP_CHUNKS: "ok" } });
  await waitFor(() => seat.output.text().includes(RUNNER_READY_MARKER), { label: "READY" });
  assert.match(seat.output.text(), /turn records → .*turns\.jsonl · usage: no session log for session-fake-1/);

  seat.input.write("before\n");
  await waitFor(() => turnRecords(seat).length === 1, { label: "first record" });
  const skill = path.join(seat.dir, ".dsh", "skills", "triage", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: triage\n---\nSort failures before fixing them.\n");
  seat.input.write("after\n");
  await waitFor(() => turnRecords(seat).length === 2, { label: "second record" });

  const [before, after] = turnRecords(seat);
  assert.notEqual(before.harnessFingerprint, after.harnessFingerprint);
  assert.match(
    seat.output.text(),
    new RegExp(`harness changed ${before.harnessFingerprint.slice(0, 12)} → ${after.harnessFingerprint.slice(0, 12)} \\(\\+1 files\\)`),
  );
  const manifests = fs.readdirSync(seatFile({ stateRoot: seat.stateRoot, sessionName: seat.args.sessionName }, "harness")).sort();
  assert.deepEqual(manifests, [`${before.harnessFingerprint}.json`, `${after.harnessFingerprint}.json`].sort());

  // No session log: the records say so, and the pane says it once.
  assert.equal(before.usageSource, "unavailable");
  assert.equal(before.usage, null);
  assert.match(before.usageNote, /no session log/);
  assert.equal((seat.output.text().match(/\[usage\] unavailable/g) ?? []).length, 1);

  seat.input.write("/quit\n");
  await seat.done;
});
