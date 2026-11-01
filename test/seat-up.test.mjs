// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SEAT_UP = fileURLToPath(new URL("../scripts/seat-up.sh", import.meta.url));
const NODE_MAJOR = process.versions.node.split(".")[0];
const SEAT = "dev1-dsh@test-rig";

/** A self-contained seat: OpenRig home, seat state, a fake dsh and JDK, a temp root. */
function fixture({ seatEnv = {}, runnerState = { sessionId: "sess-1", ready: false } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seat-up-test-")));
  const openrigHome = path.join(dir, "openrig");
  const seatDir = path.join(openrigHome, "state", "dsh", SEAT);
  fs.mkdirSync(path.join(seatDir, "home", "profiles"), { recursive: true });
  if (runnerState) fs.writeFileSync(path.join(seatDir, "runner-state.json"), JSON.stringify(runnerState));

  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const dsh = path.join(bin, "dsh");
  fs.writeFileSync(dsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const jdk = path.join(dir, "jdk21");
  fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
  fs.writeFileSync(path.join(jdk, "bin", "java"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const settings = {
    NODE: process.execPath,
    NODE_MAJOR,
    DSH_COMMAND: dsh,
    TMP_ROOT: path.join(dir, "tmp-root"),
    SOURCE_HOME: path.join(dir, "operator-dsh"),
    ...seatEnv,
  };
  fs.writeFileSync(
    path.join(seatDir, "seat.env"),
    Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
  );
  return { dir, openrigHome, seatDir, jdk, settings };
}

function seatUp(fx, { env = {}, args = [] } = {}) {
  const result = spawnSync("sh", [SEAT_UP, ...args], {
    cwd: fx.dir,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: fx.dir,
      OPENRIG_HOME: fx.openrigHome,
      OPENRIG_SESSION_NAME: SEAT,
      DSH_SEAT_DRY_RUN: "1",
      ...env,
    },
  });
  const lines = result.stdout.split("\n");
  const argv = lines.filter((line) => line.startsWith("ARG ")).map((line) => line.slice(4));
  const passed = Object.fromEntries(
    lines.filter((line) => line.startsWith("PASS ")).map((line) => line.slice(5).split(/=(.*)/s).slice(0, 2)),
  );
  const value = (key) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  return { ...result, argv, passed, value, flag };
}

test("seat-up resumes the seat's session on the pinned Node, with a scrubbed environment and an initial prompt", () => {
  const fx = fixture({ seatEnv: { JAVA_HOME: "", ENV_LUCLI_HOME: "{seat_tmp}/lucli-home" } });
  fs.appendFileSync(path.join(fx.seatDir, "seat.env"), `JAVA_HOME=${fx.jdk}\n`);
  const run = seatUp(fx, { env: { OPENRIG_NODE_ID: "node-7", OPENRIG_OCCUPANT_GENERATION: "gen-3" } });
  assert.equal(run.status, 0, run.stderr);

  const seatTmp = path.join(fx.dir, "tmp-root", SEAT);
  assert.equal(run.value("NODE"), process.execPath);
  assert.ok(run.value("PATH").startsWith(`${fx.jdk}/bin:${path.dirname(process.execPath)}:`), "JDK, then the pinned Node, lead PATH");
  assert.equal(run.value("TMPDIR"), seatTmp);
  assert.equal(run.passed.LUCLI_HOME, `${seatTmp}/lucli-home`);
  assert.equal(run.passed.JAVA_HOME, fx.jdk);

  assert.equal(run.argv[0], fileURLToPath(new URL("../src/dsh-seat.mjs", import.meta.url)));
  assert.equal(run.flag("--session-name"), SEAT);
  assert.equal(run.flag("--session"), "sess-1");
  assert.equal(run.flag("--dsh-home"), path.join(fx.seatDir, "home"));
  assert.equal(run.flag("--state-root"), path.join(fx.openrigHome, "state", "dsh"));
  assert.equal(run.flag("--posture"), "floor");
  assert.equal(run.flag("--runtime-label"), "dsh");
  assert.equal(run.flag("--node-id"), "node-7");
  assert.equal(run.flag("--generation"), "gen-3");
  assert.ok(run.argv.includes("--scrub-env"));
  assert.deepEqual(
    run.argv.flatMap((arg, i) => (arg === "--pass-env" ? [run.argv[i + 1]] : [])).sort(),
    ["JAVA_HOME", "LUCLI_HOME"],
  );
  assert.match(run.flag("--initial-prompt"), /rig whoami --json/);

  // The seat's temp directories are private.
  for (const dir of [path.join(fx.dir, "tmp-root"), seatTmp]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
});

test("no saved session means a fresh one, and the initial prompt can be turned off", () => {
  const fx = fixture({ runnerState: null, seatEnv: { INITIAL_PROMPT: "off" } });
  const run = seatUp(fx);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.flag("--session"), undefined);
  assert.equal(run.flag("--initial-prompt"), undefined);
});

test("a malformed session id in runner-state.json is not passed on", () => {
  const fx = fixture({ runnerState: { sessionId: "x; rm -rf /" } });
  const run = seatUp(fx);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.flag("--session"), undefined);
});

test("the environment overrides seat.env, and the seat name can come from the argument", () => {
  const fx = fixture({ seatEnv: { MODEL: "from-file" } });
  const run = seatUp(fx, { env: { OPENRIG_SESSION_NAME: "", DSH_SEAT_MODEL: "deepseek/from-env" }, args: [SEAT] });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.flag("--session-name"), SEAT);
  assert.equal(run.flag("--model"), "deepseek/from-env");
});

test("a managed launch is floor-only: auto is refused from seat.env and from the environment", () => {
  for (const run of [
    seatUp(fixture({ seatEnv: { POSTURE: "auto" } })),
    seatUp(fixture(), { env: { DSH_SEAT_POSTURE: "auto" } }),
  ]) {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /POSTURE 'auto' is not allowed here: a managed launch is floor-only/);
    assert.match(run.stderr, /--posture auto as a deliberate choice/);
    assert.equal(run.argv.length, 0, "nothing would have run");
  }
  const floor = seatUp(fixture({ seatEnv: { POSTURE: "floor" } }));
  assert.equal(floor.status, 0, floor.stderr);
  assert.equal(floor.flag("--posture"), "floor");
});

test("seat-up refuses what would make the seat unsafe or wrong", () => {
  const refusals = [
    [{ POSTURE: "full_bypass" }, /POSTURE 'full_bypass' is not allowed here: a managed launch is floor-only/],
    [{ NODE_MAJOR: "99" }, /pinned to Node 99/],
    [{ NODE: "node" }, /NODE must be an absolute path/],
    [{ JAVA_HOME: "/nonexistent-jdk" }, /has no bin\/java/],
    [{ TMP_ROOT: "relative/tmp" }, /TMP_ROOT must be an absolute path/],
  ];
  for (const [seatEnv, message] of refusals) {
    const run = seatUp(fixture({ seatEnv }));
    assert.notEqual(run.status, 0, JSON.stringify(seatEnv));
    assert.match(run.stderr, message);
  }

  const shared = fixture();
  const live = seatUp(shared, { env: { DSH_SEAT_DSH_HOME: shared.settings.SOURCE_HOME } });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /is your live dsh home/);

  const unnamed = seatUp(fixture(), { env: { OPENRIG_SESSION_NAME: "" } });
  assert.notEqual(unnamed.status, 0);
  assert.match(unnamed.stderr, /no seat name/);
});

test("a symlinked seat temp directory is refused, not followed", () => {
  const fx = fixture();
  const root = fx.settings.TMP_ROOT;
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(path.join(fx.dir, "elsewhere"));
  fs.symlinkSync(path.join(fx.dir, "elsewhere"), path.join(root, SEAT));
  const run = seatUp(fx);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /is a symlink/);
});

// ── An honest --fresh: follow what the launch asked for ─────────────────────
test("OPENRIG_RESUME_REF resumes exactly that ref and ignores runner-state.json", () => {
  const fx = fixture({ runnerState: { sessionId: "sess-saved" } });
  const run = seatUp(fx, { env: { OPENRIG_RESUME_REF: "sess-asked" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.flag("--session"), "sess-asked");
  assert.equal(run.value("RESUME_SOURCE"), "openrig-resume");
  assert.match(run.value("RESUME_DECISION"), /resuming sess-asked \(asked by OpenRig\)/);
});

test("a real OpenRig resume (LAUNCH_ATTEMPT + RESUME_REF) resumes the requested ref, not the saved one", () => {
  // Guards the rule order: a resume ref must beat the new-conversation signal.
  // A community-harness resume sets both OPENRIG_LAUNCH_ATTEMPT and
  // OPENRIG_RESUME_REF, and runner-state.json may hold a different id.
  const fx = fixture({ runnerState: { sessionId: "sess-saved" } });
  const run = seatUp(fx, { env: { OPENRIG_LAUNCH_ATTEMPT: "attempt-9", OPENRIG_RESUME_REF: "sess-asked" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.flag("--session"), "sess-asked");
  assert.equal(run.value("RESUME_SOURCE"), "openrig-resume");
});

test("an OpenRig new-conversation signal starts fresh, without runner-state.json", () => {
  for (const env of [{ OPENRIG_LAUNCH_ATTEMPT: "attempt-9" }, { OPENRIG_CONVERSATION: "conversation-9" }]) {
    const fx = fixture({ runnerState: { sessionId: "sess-saved" } });
    const run = seatUp(fx, { env });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.flag("--session"), undefined, JSON.stringify(env));
    assert.equal(run.value("RESUME_SOURCE"), "openrig-fresh");
    assert.match(run.value("RESUME_DECISION"), /OpenRig asked for a new conversation/);
  }
});

test("--fresh works before and after the seat name, and DSH_SEAT_FRESH=1 works too", () => {
  for (const run of [
    seatUp(fixture({ runnerState: { sessionId: "sess-saved" } }), { env: { OPENRIG_SESSION_NAME: "" }, args: ["--fresh", SEAT] }),
    seatUp(fixture({ runnerState: { sessionId: "sess-saved" } }), { env: { OPENRIG_SESSION_NAME: "" }, args: [SEAT, "--fresh"] }),
    seatUp(fixture({ runnerState: { sessionId: "sess-saved" } }), { env: { DSH_SEAT_FRESH: "1" } }),
  ]) {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.flag("--session"), undefined);
    assert.equal(run.flag("--session-name"), SEAT);
    assert.equal(run.value("RESUME_SOURCE"), "asked-fresh");
    assert.match(run.value("RESUME_DECISION"), /fresh \(asked with --fresh\)/);
  }
});

test("--fresh plus OPENRIG_RESUME_REF is refused, naming both", () => {
  const run = seatUp(fixture(), { env: { OPENRIG_RESUME_REF: "sess-asked" }, args: ["--fresh"] });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--fresh/);
  assert.match(run.stderr, /OPENRIG_RESUME_REF=sess-asked/);
  assert.equal(run.argv.length, 0, "nothing would have run");
});

test("an invalid OPENRIG_RESUME_REF is refused, never falling back to runner-state.json", () => {
  const fx = fixture({ runnerState: { sessionId: "sess-saved" } });
  const run = seatUp(fx, { env: { OPENRIG_RESUME_REF: "bad; rm -rf /" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not a valid session id/);
  assert.equal(run.argv.length, 0);
});

test("an unknown --flag is refused with usage, not ignored", () => {
  const run = seatUp(fixture(), { args: ["--bogus"] });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unknown option '--bogus'/);
  assert.match(run.stderr, /usage: seat-up\.sh/);
});

test("with no launch signal the saved runner-state.json still resumes; a fresh run leaves it byte-identical", () => {
  const fx = fixture({ runnerState: { sessionId: "sess-saved", ready: true } });
  const statePath = path.join(fx.seatDir, "runner-state.json");
  const before = fs.readFileSync(statePath);

  const plain = seatUp(fx);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.flag("--session"), "sess-saved");
  assert.equal(plain.value("RESUME_SOURCE"), "runner-state");
  assert.match(plain.value("RESUME_DECISION"), /from runner-state\.json/);

  const fresh = seatUp(fx, { env: { DSH_SEAT_FRESH: "1" } });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.flag("--session"), undefined);
  assert.deepEqual(fs.readFileSync(statePath), before, "a fresh start never rewrites runner-state.json");
});
