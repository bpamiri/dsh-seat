// SPDX-License-Identifier: Apache-2.0
// Focused tests for bin/dsh-seat: the model resolver, the child-env scrub, and
// the launch-record/resume paths (drive the real entry with a fake ACP agent).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { resolveModelChoice } from "../src/model.mjs";
import { buildAgentEnv, providerKeyForModel } from "../src/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "dsh-seat");
const fake = join(here, "contract-fake-agent.mjs");

// The activity reporter is unit-tested in-process with fake timers and an
// injected post sink (no port, no sleeping). Importing the runner must not read
// the seat's live endpoint, so neutralize the ambient connection env first.
const savedOpenrigEnv = {};
for (const key of ["OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_HOST", "OPENRIG_HOME", "OPENRIG_ACTIVITY_HOOK_TOKEN"]) {
  savedOpenrigEnv[key] = process.env[key];
  delete process.env[key];
}
const { createActivityReporter, isEntrypoint } = await import(pathToFileURL(bin).href);
for (const [key, value] of Object.entries(savedOpenrigEnv)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
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

test("agent env: identity/routing + telemetry off + DSH_HOME + provider key, never the hook token", () => {
  const source = {
    PATH: "/bin", HOME: "/home/x", DEEPSEEK_API_KEY: "sk-test",
    OPENRIG_URL: "http://127.0.0.1:9", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_NODE_ID: "node-1",
    OPENRIG_RUNTIME: "dsh", OPENRIG_OCCUPANT_GENERATION: "gen-1", OPENRIG_HOME: "/openrig",
    OPENRIG_ACTIVITY_HOOK_TOKEN: "hook-secret", OPENRIG_LAUNCH_RESULT: "/tmp/record", SOMETHING: "no",
  };
  const env = buildAgentEnv(source, { model: "deepseek-official/deepseek-v4-flash", dshHome: "/seat/home" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.DSH_HOME, "/seat/home");
  assert.equal(env.DEEPSEEK_API_KEY, "sk-test");
  assert.equal(env.OPENRIG_SESSION_NAME, "seat@rig");
  assert.equal(env.OPENRIG_URL, "http://127.0.0.1:9");
  assert.equal(env.OPENRIG_NODE_ID, "node-1");
  assert.equal(env.OPENRIG_RUNTIME, "dsh");
  assert.equal(env.OPENRIG_OCCUPANT_GENERATION, "gen-1");
  assert.equal(env.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(env.OPENRIG_ACTIVITY_HOOK_TOKEN, undefined);
  assert.equal(env.OPENRIG_LAUNCH_RESULT, undefined);
  assert.equal(env.SOMETHING, undefined);
  // Bare ids and the deepseek-official provider both select the DeepSeek key.
  assert.equal(providerKeyForModel("deepseek-v4-flash"), "DEEPSEEK_API_KEY");
  assert.equal(providerKeyForModel("deepseek-official/deepseek-v4-pro"), "DEEPSEEK_API_KEY");
  assert.equal(buildAgentEnv(source, { model: "deepseek-v4-flash", dshHome: "/h" }).DEEPSEEK_API_KEY, "sk-test");
  // An operator telemetry choice is forwarded, not overridden.
  const chosen = buildAgentEnv({ ...source, DSH_TELEMETRY_MODE: "OFF" }, { model: null, dshHome: "/h" });
  assert.equal(chosen.DSH_TELEMETRY_DISABLED, undefined);
  assert.equal(chosen.DSH_TELEMETRY_MODE, "OFF");
});

function start(t, {
  mode = "fresh", model = null, resume = null, extraEnv = {}, dshHome = "explicit", home = process.env.HOME,
  openrigHome = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-seat-contract-"));
  const log = join(dir, "agent.jsonl");
  const envLog = join(dir, "agent-env.json");
  const record = join(dir, "launch", "record.json");
  const resolvedDshHome = dshHome === "explicit" ? join(dir, "dsh-home") : dshHome;
  const child = spawn(process.execPath, [bin, "--agent-command", `${process.execPath} ${fake} --log ${log} --env-log ${envLog} --mode ${mode}`], {
    env: {
      PATH: process.env.PATH, HOME: home,
      ...(resolvedDshHome ? { DSH_HOME: resolvedDshHome } : {}),
      ...(openrigHome ? { OPENRIG_HOME: openrigHome } : {}),
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
  assert.equal(agentEnv.OPENRIG_SESSION_NAME, "test@rig");
  assert.equal(agentEnv.OPENRIG_NODE_ID, "node-1");
  assert.equal(agentEnv.OPENRIG_RUNTIME, "dsh");
  assert.equal(agentEnv.OPENRIG_OCCUPANT_GENERATION, "gen-1");
  assert.equal(agentEnv.DSH_TELEMETRY_DISABLED, "1");
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

test("unset DSH_HOME provisions a per-seat home and does not write the operator's ~/.dsh", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-seat-home-"));
  const operator = join(home, ".dsh");
  mkdirSync(join(operator, "profiles", "acp"), { recursive: true });
  writeFileSync(join(operator, "profiles", "acp", "cordis.yml"), "profile\n");
  writeFileSync(join(operator, "marker"), "untouched\n");
  const openrigHome = join(home, "openrig");
  const run = start(t, { dshHome: null, home, openrigHome });
  const record = await waitFor(() => json(run.record));
  assert.ok(record, `no record; pane: ${run.stdout()}`);
  const agentEnv = json(run.envLog);
  assert.match(agentEnv.DSH_HOME, new RegExp(`^${openrigHome}/state/dsh/.+/dsh-home$`));
  assert.equal(agentEnv.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(agentEnv.OPENRIG_ACTIVITY_HOOK_TOKEN, undefined);
  assert.equal(readFileSync(join(operator, "marker"), "utf8"), "untouched\n");
  for (const leaked of ["sessions", "storages", ".anonymous-user-id"]) {
    assert.equal(existsSync(join(operator, leaked)), false, `operator home gained ${leaked}`);
  }
  assert.equal(readFileSync(join(agentEnv.DSH_HOME, "profiles", "acp", "cordis.yml"), "utf8"), "profile\n");
  assert.match(readFileSync(join(agentEnv.DSH_HOME, "cordis.patch.yml"), "utf8"), /session-log-deepseek[\s\S]*enabled: false/);
  t.after(() => rmSync(home, { recursive: true, force: true }));
});

test("refuses the operator's own DSH_HOME before spawning the agent", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-seat-operator-"));
  const operator = join(home, ".dsh");
  mkdirSync(operator, { recursive: true });
  const run = start(t, { dshHome: operator, home });
  await waitFor(() => run.child.exitCode !== null);
  assert.equal(run.child.exitCode, 1);
  assert.match(run.stdout(), /refusing DSH_HOME/);
  assert.equal(existsSync(run.record), false);
  assert.equal(existsSync(run.envLog), false);
  t.after(() => rmSync(home, { recursive: true, force: true }));
});

// ── activity: turnId, working posts, throttle, idle heartbeat ───────────────
// Fake timers (node:test mock.timers) drive the 10 s throttle and the 60 s beat
// with no sleeping; the post sink is the injected array, so no port is opened.
const MOCK_APIS = ["setInterval", "setTimeout", "Date"];
const kinds = (posts) => posts.map((post) => `${post.hookEvent}/${post.subtype}`);

function activityFixture({ pending = () => false, enabled = () => true } = {}) {
  const posts = [];
  const reporter = createActivityReporter({
    post: (hookEvent, subtype, extra = {}) => { posts.push({ hookEvent, subtype, ...extra }); },
    hasPendingPost: pending,
    enabled,
  });
  return { posts, reporter };
}

test("activity: turnId is on accepted, tool, message, permission and stop posts", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  const { posts, reporter } = activityFixture();
  reporter.beginTurn("7");
  assert.deepEqual(kinds(posts), ["UserPromptSubmit/accepted"]);
  assert.equal(posts[0].turnId, "7");
  assert.equal(reporter.toolCall("read"), true);
  t.mock.timers.tick(10_000);
  assert.equal(reporter.messageChunk(), true);
  reporter.endTurn("end_turn");
  assert.deepEqual(kinds(posts), [
    "UserPromptSubmit/accepted", "PreToolUse/read", "active/agent_message", "Stop/end_turn",
  ]);
  for (const post of posts) assert.equal(post.turnId, "7");
  assert.equal(posts.at(-1).livenessSeconds, 60);
  // The permission post belongs to its turn too.
  reporter.beginTurn("8");
  reporter.permission();
  assert.deepEqual(kinds(posts).slice(-2), ["UserPromptSubmit/accepted", "Notification/permission_prompt"]);
  assert.equal(posts.at(-1).turnId, "8");
});

test("activity: every tool call posts unthrottled; only message chunks are throttled to one per 10 s", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  const { posts, reporter } = activityFixture();
  reporter.beginTurn("1");
  assert.equal(reporter.messageChunk(), true, "the first chunk posts");
  assert.equal(reporter.toolCall("read"), true, "a tool call posts even inside the chunk window");
  assert.equal(reporter.messageChunk(), false, "a chunk in the same instant is throttled");
  assert.equal(reporter.toolCall("execute"), true, "every further tool call still posts");
  t.mock.timers.tick(9_999);
  assert.equal(reporter.messageChunk(), false, "tool calls neither consume nor reset the chunk window");
  t.mock.timers.tick(1);
  assert.equal(reporter.messageChunk(), true, "the chunk window has passed");
  assert.deepEqual(kinds(posts), [
    "UserPromptSubmit/accepted", "active/agent_message", "PreToolUse/read",
    "PreToolUse/execute", "active/agent_message",
  ]);
});

test("activity: no working post while attention is held or after the turn ended", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  const { posts, reporter } = activityFixture();
  reporter.beginTurn("1");
  reporter.permission();
  t.mock.timers.tick(60_000);
  assert.equal(reporter.toolCall("read"), false);
  assert.equal(reporter.messageChunk(), false);
  assert.deepEqual(kinds(posts), ["UserPromptSubmit/accepted", "Notification/permission_prompt"]);
  reporter.endTurn("cancelled");
  assert.equal(posts.some((post) => post.hookEvent === "Stop"), false, "no idle Stop while attention is held");
  assert.equal(reporter.messageChunk(), false, "the turn is gone");
});

test("activity: a chunk after shutdown or agent exit posts nothing, even with the turn open", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  // shutdown()/agentExited() leave the turn open, so the dead guard is the only
  // reason these chunks are suppressed; without it, the first chunk of a turn
  // (the 10 s window is still open) would post and this would fail.
  const shutdownRun = activityFixture();
  shutdownRun.reporter.beginTurn("1");
  assert.ok(shutdownRun.reporter.turn, "the turn is still open when shutdown begins");
  shutdownRun.reporter.shutdown();
  assert.equal(shutdownRun.reporter.messageChunk(), false, "no chunk post after shutdown");
  assert.deepEqual(kinds(shutdownRun.posts), ["UserPromptSubmit/accepted"], "nothing else was posted");

  const exitRun = activityFixture();
  exitRun.reporter.beginTurn("2");
  exitRun.reporter.agentExited();
  assert.equal(exitRun.reporter.messageChunk(), false, "no chunk post after agent exit");
  assert.deepEqual(kinds(exitRun.posts), ["UserPromptSubmit/accepted"]);
});

test("activity: idle beats run only while idle, and stop on accept, attention and exit", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  const { posts, reporter } = activityFixture();
  reporter.idle();
  assert.equal(reporter.beatArmed, true);
  t.mock.timers.tick(60_000);
  assert.deepEqual(kinds(posts), ["Stop/idle_heartbeat"]);
  assert.equal(posts[0].livenessSeconds, 60);
  // A new accepted prompt stops the beat; ticks during the turn post nothing.
  reporter.beginTurn("1");
  assert.equal(reporter.beatArmed, false);
  t.mock.timers.tick(120_000);
  assert.deepEqual(kinds(posts), ["Stop/idle_heartbeat", "UserPromptSubmit/accepted"]);
  // After the turn settles the beat restarts on the next idle call.
  reporter.endTurn("end_turn");
  reporter.idle();
  assert.equal(reporter.beatArmed, true);
  t.mock.timers.tick(60_000);
  assert.deepEqual(kinds(posts).slice(-2), ["Stop/end_turn", "Stop/idle_heartbeat"]);
  // Attention stops it, and the held turn posts no idle Stop.
  reporter.beginTurn("2");
  reporter.permission();
  assert.equal(reporter.beatArmed, false);
  reporter.endTurn("end_turn");
  reporter.idle();
  t.mock.timers.tick(60_000);
  assert.equal(posts.filter((post) => post.subtype === "idle_heartbeat").length, 2);
  // An agent exit retires the beat for good.
  reporter.beginTurn("3");
  reporter.endTurn("end_turn");
  reporter.idle();
  reporter.agentExited();
  assert.equal(reporter.beatArmed, false);
  t.mock.timers.tick(120_000);
  assert.equal(posts.filter((post) => post.subtype === "idle_heartbeat").length, 2);
});

test("activity: a pending post makes a beat skip instead of queueing behind it", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  let pending = true;
  const { posts, reporter } = activityFixture({ pending: () => pending });
  reporter.idle();
  t.mock.timers.tick(60_000);
  assert.deepEqual(posts, [], "the skipped beat posts nothing");
  pending = false;
  t.mock.timers.tick(60_000);
  assert.deepEqual(kinds(posts), ["Stop/idle_heartbeat"], "the next beat posts once");
});

test("activity: the heartbeat timer is unref'd and cleared on shutdown", () => {
  const { reporter } = activityFixture();
  reporter.idle();
  assert.equal(reporter.beatArmed, true);
  assert.equal(reporter.beatHandle.hasRef(), false, "the beat must not keep the process alive");
  reporter.shutdown();
  assert.equal(reporter.beatArmed, false);
});

test("activity: a cancel-requested turn posts no idle until the prompt settles", (t) => {
  t.mock.timers.enable({ apis: MOCK_APIS });
  const { posts, reporter } = activityFixture();
  const turn = reporter.beginTurn("1");
  turn.cancelSent = true;
  t.mock.timers.tick(120_000);
  assert.deepEqual(kinds(posts), ["UserPromptSubmit/accepted"], "cancel request alone posts nothing");
  reporter.endTurn("cancelled");
  assert.deepEqual(kinds(posts), ["UserPromptSubmit/accepted", "Stop/cancelled"], "the agent's stop reason ends it");
  assert.equal(posts.at(-1).livenessSeconds, 60);
  reporter.idle();
  t.mock.timers.tick(60_000);
  assert.equal(posts.at(-1).subtype, "idle_heartbeat");
});

test("activity: the real runner posts accepted/tool/message/stop with one turnId", async (t) => {
  // The only test in this file that opens a listening port: a loopback stand-in
  // for the activity endpoint captures the runner's real post sequence.
  const posted = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { posted.push(JSON.parse(body)); } catch { /* a malformed post is asserted by absence */ }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const firstDir = mkdtempSync(join(tmpdir(), "dsh-seat-first-"));
  const first = join(firstDir, "first.txt");
  writeFileSync(first, "hello\n");
  t.after(() => rmSync(firstDir, { recursive: true, force: true }));
  const run = start(t, {
    mode: "activity",
    extraEnv: { OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_FIRST_INPUT: first },
  });
  const stop = await waitFor(() => posted.find((post) => post.hookEvent === "Stop" && post.subtype === "end_turn"));
  assert.ok(stop, `no Stop post; pane: ${run.stdout()}`);
  assert.deepEqual(posted.map((post) => `${post.hookEvent}/${post.subtype}`),
    ["UserPromptSubmit/accepted", "active/agent_message", "PreToolUse/read", "Stop/end_turn"],
    "a burst of two chunks is throttled to one active post");
  assert.deepEqual(posted.map((post) => post.sequence), [1, 2, 3, 4], "posts keep their order");
  for (const post of posted) {
    assert.equal(post.turnId, "1");
    assert.equal(post.sessionName, "test@rig");
    assert.equal(post.nodeId, "node-1");
    assert.equal(post.generation, "gen-1");
    assert.equal(post.runtime, "dsh");
  }
  assert.equal(stop.livenessSeconds, 60);
});

test("entrypoint guard: a symlinked invocation is started directly; an import is not", (t) => {
  // npm link installs bin/dsh-seat as a symlink on PATH (and macOS /tmp is an
  // alias of /private/tmp). argv[1] is then the invoked path while
  // import.meta.url is the real one, so the guard must compare realpaths or the
  // runner would import and exit silently.
  const dir = mkdtempSync(join(tmpdir(), "dsh-seat-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "dsh-seat");
  symlinkSync(bin, link);
  const moduleUrl = pathToFileURL(bin).href;
  assert.equal(isEntrypoint(link, moduleUrl), true, "a symlinked path must run main");
  assert.equal(isEntrypoint(bin, moduleUrl), true, "the real path is the entrypoint");
  assert.equal(isEntrypoint(process.argv[1], moduleUrl), false, "importing the module must not run main");
  assert.equal(isEntrypoint(undefined, moduleUrl), false);
  assert.equal(isEntrypoint(join(dir, "missing"), moduleUrl), false, "a missing path is not the entrypoint");
});
