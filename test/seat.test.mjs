// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runSeat, parseArgs, RUNNER_READY_MARKER, RUNNER_ERROR_MARKER } from "../src/dsh-seat.mjs";
import { sidecarPath, readSidecar } from "../src/state.mjs";
import { fakeAgentFactory, recordingActivity, captureStream, openInput, waitFor } from "./helpers.mjs";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-test-"));
  return { dir, stateRoot: path.join(dir, "state"), home: path.join(dir, "dsh-home") };
}

/** Start a seat against the fake agent and return handles. */
function startSeat({ argv = [], agentEnv = {}, posture = "floor", env = {}, onClientOptions = () => {} } = {}) {
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
    // Keep the runner away from the real ~/.openrig activity endpoint.
    env: { OPENRIG_HOME: path.join(dir, "openrig-home"), ...env },
    clientFactory: (opts) => {
      onClientOptions(opts);
      return fakeAgentFactory(agentEnv)(opts);
    },
    activityFactory: () => activity,
  });
  return { args, input, output, activity, done, dir, stateRoot, home };
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
