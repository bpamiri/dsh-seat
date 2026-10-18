// SPDX-License-Identifier: Apache-2.0
// The runner as OpenRig starts it: its own process, signalled from outside.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSidecar, seatFile, sidecarPath } from "../src/state.mjs";
import { FAKE_AGENT, waitFor } from "./helpers.mjs";

const RUNNER = fileURLToPath(new URL("../src/dsh-seat.mjs", import.meta.url));

/** Run the CLI against the fake agent, standing in for `dsh --profile acp`. */
function startCli({ agentEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-cli-"));
  const fakeDsh = path.join(dir, "fake-dsh");
  fs.writeFileSync(fakeDsh, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}"\n`, { mode: 0o755 });
  const stateRoot = path.join(dir, "state");
  const child = spawn(
    process.execPath,
    [RUNNER, "--session-name", "s@r", "--cwd", dir, "--state-root", stateRoot, "--dsh-home", path.join(dir, "home"), "--dsh-command", fakeDsh],
    {
      env: { ...process.env, OPENRIG_HOME: path.join(dir, "openrig-home"), DSH_AGENTS_HOME: path.join(dir, "agents-home"), ...agentEnv },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const cli = { child, stateRoot, out: "" };
  child.stdout.on("data", (chunk) => (cli.out += chunk));
  child.stderr.on("data", (chunk) => (cli.out += chunk));
  cli.exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return cli;
}

test("SIGTERM on an idle seat leaves an honest sidecar and the EXITED marker", async () => {
  const cli = startCli();
  await waitFor(() => cli.out.includes("[dsh-runner] READY"), { label: "READY" });
  cli.child.kill("SIGTERM");
  const { code } = await cli.exited;

  assert.equal(code, 0);
  const state = readSidecar(sidecarPath({ stateRoot: cli.stateRoot, sessionName: "s@r" }));
  assert.equal(state.ready, false);
  assert.deepEqual(state.exited, { reason: "signal-SIGTERM" });
  assert.match(cli.out, /\[dsh-runner\] EXITED \(SIGTERM\)/);
});

test("SIGTERM mid-turn records the turn first, and EXITED is the pane's last line", async () => {
  const cli = startCli({ agentEnv: { FAKE_ACP_HOLD_MS: "10000", FAKE_ACP_CHUNKS: "working" } });
  await waitFor(() => cli.out.includes("[dsh-runner] READY"), { label: "READY" });
  cli.child.stdin.write("long job\n");
  await waitFor(() => cli.out.includes("working"), { label: "turn in flight" });
  cli.child.kill("SIGTERM");
  await cli.exited;

  const records = fs
    .readFileSync(seatFile({ stateRoot: cli.stateRoot, sessionName: "s@r" }, "turns.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(records.length, 1);
  assert.equal(cli.out.trim().split("\n").at(-1), "[dsh-runner] EXITED (SIGTERM)");
  const state = readSidecar(sidecarPath({ stateRoot: cli.stateRoot, sessionName: "s@r" }));
  assert.deepEqual(state.exited, { reason: "signal-SIGTERM" });
});
