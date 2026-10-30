// SPDX-License-Identifier: Apache-2.0
// Focused tests for bin/dsh-seat: the model resolver, the child-env scrub, and
// the launch-record/resume paths (drive the real entry with a fake ACP agent).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveModelChoice } from "../src/model.mjs";
import { buildAgentEnv } from "../src/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "dsh-seat");
const fake = join(here, "contract-fake-agent.mjs");
const MODEL_OPTIONS = [{
  id: "model", name: "Model", type: "select",
  currentValue: "[\"deepseek-official\",\"deepseek-v4-flash\"]",
  options: [{
    group: "deepseek-official", name: "DeepSeek",
    options: [
      { value: "[\"deepseek-official\",\"deepseek-v4-flash\"]", name: "deepseek-v4-flash" },
      { value: "[\"deepseek-official\",\"deepseek-v4-pro\"]", name: "DeepSeek-V4-Pro" },
    ],
  }],
}];

test("model resolver: exact provider/model, bare unique id, official provider, unmappable", () => {
  assert.deepEqual(resolveModelChoice(MODEL_OPTIONS, "deepseek/deepseek-v4-flash"),
    { ok: true, value: "[\"deepseek-official\",\"deepseek-v4-flash\"]", label: "deepseek-v4-flash" });
  assert.deepEqual(resolveModelChoice(MODEL_OPTIONS, "deepseek-v4-flash"),
    { ok: true, value: "[\"deepseek-official\",\"deepseek-v4-flash\"]", label: "deepseek-v4-flash" });
  assert.deepEqual(resolveModelChoice(MODEL_OPTIONS, "deepseek-official/deepseek-v4-pro"),
    { ok: true, value: "[\"deepseek-official\",\"deepseek-v4-pro\"]", label: "DeepSeek-V4-Pro" });
  const missing = resolveModelChoice(MODEL_OPTIONS, "acme/nope");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not available; advertised: deepseek-v4-flash, DeepSeek-V4-Pro/);
  // A bare model id ambiguous across providers is reported, not guessed.
  const ambiguous = [{ id: "model", options: [
    { value: "[\"p1\",\"same\"]", name: "same-p1" }, { value: "[\"p2\",\"same\"]", name: "same-p2" },
  ] }];
  assert.equal(resolveModelChoice(ambiguous, "same").ok, false);
});

test("agent env: baseline + DSH_HOME + only the declared provider key", () => {
  const source = {
    PATH: "/bin", HOME: "/home/x", DSH_HOME: "/state/dsh", DEEPSEEK_API_KEY: "sk-test",
    OPENRIG_ACTIVITY_HOOK_TOKEN: "hook-secret", OPENRIG_LAUNCH_RESULT: "/tmp/record", SOMETHING: "no",
  };
  const env = buildAgentEnv(source, { model: "deepseek/deepseek-v4-flash" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.DSH_HOME, "/state/dsh");
  assert.equal(env.DEEPSEEK_API_KEY, "sk-test");
  assert.equal(env.OPENRIG_ACTIVITY_HOOK_TOKEN, undefined);
  assert.equal(env.OPENRIG_LAUNCH_RESULT, undefined);
  assert.equal(env.SOMETHING, undefined);
  const noProvider = buildAgentEnv(source, { model: "deepseek-v4-flash" });
  assert.equal(noProvider.DEEPSEEK_API_KEY, undefined);
});

function start(t, { mode = "fresh", model = null, resume = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-seat-contract-"));
  const log = join(dir, "agent.jsonl");
  const envLog = join(dir, "agent-env.json");
  const record = join(dir, "launch", "record.json");
  const child = spawn(process.execPath, [bin, "--agent-command", `${process.execPath} ${fake} --log ${log} --env-log ${envLog} --mode ${mode}`], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(dir, "dsh-home"),
      OPENRIG_LAUNCH_RESULT: record, OPENRIG_LAUNCH_ATTEMPT: "attempt-1",
      OPENRIG_SESSION_NAME: "test@rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "dsh",
      OPENRIG_OCCUPANT_GENERATION: "gen-1", OPENRIG_ACTIVITY_HOOK_TOKEN: "hook-secret",
      ...(model ? { OPENRIG_MODEL: model } : {}), ...(resume ? { OPENRIG_RESUME_REF: resume } : {}),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stdout += chunk; });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { child, dir, log, envLog, record, stdout: () => stdout };
}

async function waitFor(read, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const json = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
const lines = (path) => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

test("fresh launch: record after session/new and the declared model applied", async (t) => {
  const run = start(t, { model: "deepseek/deepseek-v4-flash" });
  const record = await waitFor(() => json(run.record));
  assert.ok(record, `no record; pane: ${run.stdout()}`);
  assert.deepEqual(record, {
    format: 1, attempt: "attempt-1", harness: "dsh", nativeRef: "fake-new",
    producer: "dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1",
  });
  const config = await waitFor(() => lines(run.log).find((m) => m.method === "session/set_config_option"));
  assert.equal(config.params.configId, "model");
  assert.equal(config.params.value, "[\"deepseek-official\",\"deepseek-v4-flash\"]");
  const agentEnv = json(run.envLog);
  assert.equal(agentEnv.OPENRIG_ACTIVITY_HOOK_TOKEN, undefined);
  assert.equal(agentEnv.OPENRIG_LAUNCH_RESULT, undefined);
  assert.equal(agentEnv.DSH_HOME, join(run.dir, "dsh-home"));
});

test("unadvertised model is reported, not silently ignored, and no raw value is sent", async (t) => {
  const run = start(t, { model: "acme/nope" });
  await waitFor(() => json(run.record));
  const reported = await waitFor(() => run.stdout().includes("declared model acme/nope not applied"));
  assert.ok(reported, `no warning; pane: ${run.stdout()}`);
  assert.match(run.stdout(), /advertised: deepseek-v4-flash, DeepSeek-V4-Pro/);
  assert.equal(lines(run.log).some((m) => m.method === "session/set_config_option"), false);
});

test("resume: same ref recorded, no session/new, and a changed model applied from resume configOptions", async (t) => {
  const run = start(t, { mode: "resume", resume: "fake-old", model: "deepseek-v4-pro" });
  const record = await waitFor(() => json(run.record));
  assert.deepEqual(record, {
    format: 1, attempt: "attempt-1", harness: "dsh", nativeRef: "fake-old",
    producer: "dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1",
  });
  assert.equal(lines(run.log).some((m) => m.method === "session/new"), false);
  const config = await waitFor(() => lines(run.log).find((m) => m.method === "session/set_config_option"));
  assert.equal(config.params.value, "[\"deepseek-official\",\"deepseek-v4-pro\"]");
});

test("resume missing: records error missing and starts no conversation", async (t) => {
  const run = start(t, { mode: "missing", resume: "fake-gone" });
  const record = await waitFor(() => json(run.record));
  assert.deepEqual(record, {
    format: 1, attempt: "attempt-1", harness: "dsh", error: "missing",
    producer: "dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1",
  });
  assert.equal(lines(run.log).some((m) => m.method === "session/new"), false);
});
