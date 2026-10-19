// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { dshChildEnv, telemetryChosen, sessionLogVerdict, sessionLogUploadDisabled, uploadRowVerdict, uploadsLeftOn } from "../src/privacy.mjs";

const MAKE_SEAT_HOME = fileURLToPath(new URL("../scripts/make-seat-home.sh", import.meta.url));

test("the dsh child gets telemetry off unless the operator chose a setting", () => {
  const env = dshChildEnv({ PATH: "/bin" }, { dshHome: "/seat/home", permissionMode: "workspace-write" });
  assert.equal(env.DSH_HOME, "/seat/home");
  assert.equal(env.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(env.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(env.PATH, "/bin");

  const chosen = dshChildEnv({ DSH_TELEMETRY_MODE: "FEEDBACK_ONLY" }, { dshHome: "/h", permissionMode: "workspace-write" });
  assert.equal(chosen.DSH_TELEMETRY_DISABLED, undefined);
  assert.equal(chosen.DSH_TELEMETRY_MODE, "FEEDBACK_ONLY");

  assert.equal(telemetryChosen({ DSH_TELEMETRY_DISABLED: "yes" }), true);
  assert.equal(telemetryChosen({ DSH_TELEMETRY_DISABLED: "  " }), false);
  assert.equal(telemetryChosen({}), false);
});

test("the dsh child is named for the agent's own rig calls", () => {
  const env = dshChildEnv({ PATH: "/bin" }, {
    dshHome: "/h", permissionMode: "workspace-write",
    sessionName: "dev1-dsh@wheels-dsh", openrigUrl: "http://127.0.0.1:7433",
  });
  assert.equal(env.OPENRIG_SESSION_NAME, "dev1-dsh@wheels-dsh");
  assert.equal(env.OPENRIG_URL, "http://127.0.0.1:7433");

  // The seat's own name always wins over one inherited from the parent shell.
  const inherited = dshChildEnv({ OPENRIG_SESSION_NAME: "someone-else@rig" }, {
    dshHome: "/h", permissionMode: "workspace-write", sessionName: "dev1-dsh@wheels-dsh",
  });
  assert.equal(inherited.OPENRIG_SESSION_NAME, "dev1-dsh@wheels-dsh");

  // An operator-set OPENRIG_URL is kept; no endpoint known means no URL is invented.
  const keptUrl = dshChildEnv({ OPENRIG_URL: "http://10.0.0.5:7433" }, {
    dshHome: "/h", permissionMode: "workspace-write", sessionName: "s@r", openrigUrl: "http://127.0.0.1:7433",
  });
  assert.equal(keptUrl.OPENRIG_URL, "http://10.0.0.5:7433");
  const noUrl = dshChildEnv({}, { dshHome: "/h", permissionMode: "workspace-write", sessionName: "s@r" });
  assert.equal(noUrl.OPENRIG_URL, undefined);

  // Without a session name (direct library use), nothing OpenRig is added.
  const bare = dshChildEnv({}, { dshHome: "/h", permissionMode: "workspace-write" });
  assert.equal(bare.OPENRIG_SESSION_NAME, undefined);
});

test("sessionLogVerdict reads the session-log row of a patch", () => {
  assert.equal(sessionLogVerdict("- id: session-log-deepseek\n  config:\n    enabled: false\n"), true);
  assert.equal(sessionLogVerdict("- id: 'session-log-deepseek'\n  disabled: true\n"), true);
  assert.equal(sessionLogVerdict("- id: session-log-deepseek\n  config:\n    enabled: true\n"), false);
  assert.equal(
    sessionLogVerdict("- id: session-log-deepseek\n  config:\n    maxBytes: 100\n- id: other\n  config:\n    enabled: false\n"),
    false,
    "an `enabled: false` on a later row does not count",
  );
  assert.equal(sessionLogVerdict("- id: other\n  config: {}\n"), null);
});

test("only the row's own switch counts, not an enabled: false nested deeper in its config", () => {
  const nested = "- id: session-log-deepseek\n  config:\n    enabled: true\n    redact:\n      enabled: false\n";
  assert.equal(sessionLogVerdict(nested), false);
  const nestedOnly = "- id: session-log-deepseek\n  config:\n    redact:\n      enabled: false\n";
  assert.equal(sessionLogVerdict(nestedOnly), false);
  const disabledInConfig = "- id: session-log-deepseek\n  config:\n    redact:\n      level: 1\n    enabled: false\n";
  assert.equal(sessionLogVerdict(disabledInConfig), true);
});

test("each upload row is read on its own, and a home lists the uploads it leaves on", () => {
  const both = "- id: session-log-deepseek\n  config:\n    enabled: false\n- id: plugin-package-inventory-deepseek\n  config:\n    enabled: false\n";
  assert.equal(uploadRowVerdict(both, "plugin-package-inventory-deepseek"), true);
  assert.equal(uploadRowVerdict(both, "session-log-deepseek"), true);
  assert.equal(uploadRowVerdict("- id: session-log-deepseek\n  config:\n    enabled: false\n", "plugin-package-inventory-deepseek"), null);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-uploads-"));
  const ids = () => uploadsLeftOn({ dshHome: home, profile: "acp" }).map((upload) => upload.id);
  assert.deepEqual(ids(), ["session-log-deepseek", "plugin-package-inventory-deepseek"], "dsh's defaults: both on");
  fs.writeFileSync(path.join(home, "cordis.patch.yml"), "- id: session-log-deepseek\n  config:\n    enabled: false\n");
  assert.deepEqual(ids(), ["plugin-package-inventory-deepseek"]);
  fs.mkdirSync(path.join(home, "profiles", "acp"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "acp", "cordis.patch.yml"), "- id: plugin-package-inventory-deepseek\n  disabled: true\n");
  assert.deepEqual(ids(), [], "a row the home patch does not mention falls to the profile patch");
});

test("the home-level patch outranks the profile patch", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-privacy-"));
  assert.equal(sessionLogUploadDisabled({ dshHome: home, profile: "acp" }), false, "no patch: dsh's default is on");

  fs.mkdirSync(path.join(home, "profiles", "acp"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "acp", "cordis.patch.yml"), "- id: session-log-deepseek\n  config:\n    enabled: false\n");
  assert.equal(sessionLogUploadDisabled({ dshHome: home, profile: "acp" }), true);

  fs.writeFileSync(path.join(home, "cordis.patch.yml"), "- id: session-log-deepseek\n  config:\n    enabled: true\n");
  assert.equal(sessionLogUploadDisabled({ dshHome: home, profile: "acp" }), false);
});

function fakeSourceHome() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-source-"));
  fs.mkdirSync(path.join(source, "profiles", "acp"), { recursive: true });
  fs.writeFileSync(path.join(source, "profiles", "acp", "package.json"), "{}\n");
  fs.mkdirSync(path.join(source, "profiles", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(source, ".credentials.yaml"), "secret: not-copied\n");
  return source;
}

test("make-seat-home writes a seat patch: uploads off, plain JSONL on a fresh root", () => {
  const source = fakeSourceHome();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-target-")), "seat's home");
  execFileSync("sh", [MAKE_SEAT_HOME, target, source], { encoding: "utf8" });

  const patch = fs.readFileSync(path.join(target, "cordis.patch.yml"), "utf8");
  assert.equal(sessionLogVerdict(patch), true);
  assert.equal(uploadRowVerdict(patch, "plugin-package-inventory-deepseek"), true);
  assert.deepEqual(uploadsLeftOn({ dshHome: target, profile: "acp" }), []);
  assert.equal(fs.lstatSync(path.join(target, "profiles", "node_modules")).isSymbolicLink(), true, "the bundle tree stays a symlink");
  assert.match(patch, /- id: session-persistence-jsonl\n {2}config:\n {4}root: '.*seat''s home\/sessions'\n {4}compression: none/);
  assert.equal(sessionLogUploadDisabled({ dshHome: target, profile: "acp" }), true);
  assert.equal(fs.lstatSync(path.join(target, ".credentials.yaml")).isSymbolicLink(), true, "credentials stay a symlink");

  // A second run leaves the operator's file alone.
  fs.writeFileSync(path.join(target, "cordis.patch.yml"), "# mine\n");
  const rerun = execFileSync("sh", [MAKE_SEAT_HOME, target, source], { encoding: "utf8" });
  assert.match(rerun, /seat patch already present/);
  assert.equal(fs.readFileSync(path.join(target, "cordis.patch.yml"), "utf8"), "# mine\n");
});

test("make-seat-home links no bundle tree when the source home has none (dsh 0.2.1 and later)", () => {
  const source = fakeSourceHome();
  fs.rmSync(path.join(source, "profiles", "node_modules"), { recursive: true });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-target-"));
  const output = execFileSync("sh", [MAKE_SEAT_HOME, path.join(target, "home"), source], { encoding: "utf8" });
  assert.equal(fs.existsSync(path.join(target, "home", "profiles", "node_modules")), false);
  assert.throws(() => fs.lstatSync(path.join(target, "home", "profiles", "node_modules")), /ENOENT/, "not even a dangling link");
  assert.doesNotMatch(output, /node_modules/);
});

test("make-seat-home writes a backslash in the seat path as it is", () => {
  const source = fakeSourceHome();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-target-")), "a\\tb");
  execFileSync("sh", [MAKE_SEAT_HOME, target, source], { encoding: "utf8" });
  const patch = fs.readFileSync(path.join(target, "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes(`root: '${path.join(target, "sessions")}'`), patch);
  assert.ok(!patch.includes("\t"), "no tab where the path had a backslash");
});

test("make-seat-home does not switch compression on an existing sessions root", () => {
  const source = fakeSourceHome();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-target-"));
  fs.mkdirSync(path.join(target, "sessions"));
  execFileSync("sh", [MAKE_SEAT_HOME, target, source], { encoding: "utf8" });

  const patch = fs.readFileSync(path.join(target, "cordis.patch.yml"), "utf8");
  assert.equal(sessionLogVerdict(patch), true);
  assert.doesNotMatch(patch, /session-persistence-jsonl/);
});
