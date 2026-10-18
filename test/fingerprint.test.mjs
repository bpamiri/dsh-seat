// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HarnessFingerprinter, diffHarness, findProjectRoot, harnessSources } from "../src/fingerprint.mjs";

const SETTINGS = { runner: "0.1.0", agent: "dsh@0.2.1", profile: "acp", posture: "floor", mcpServers: null };

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A project checkout plus a dsh home and an agents home, with a harness in each. */
function seatTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-harness-"));
  const project = path.join(base, "project");
  const cwd = path.join(project, "packages", "api");
  const dshHome = path.join(base, "dsh-home");
  const agentsHome = path.join(base, "agents-home");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  write(path.join(base, "AGENTS.md"), "above the project root: not read");
  write(path.join(project, "AGENTS.md"), "repo rules");
  write(path.join(cwd, "CLAUDE.local.md"), "local notes");
  write(path.join(project, ".dsh", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
  write(path.join(dshHome, "cordis.patch.yml"), "- id: session-log-deepseek\n  config:\n    enabled: false\n");
  write(path.join(dshHome, ".env"), "DEEPSEEK_API_KEY=secret");
  write(path.join(dshHome, "skills", "review", "SKILL.md"), "---\nname: review\n---\n");
  write(path.join(dshHome, "skills", ".system", "builtin", "SKILL.md"), "shipped with dsh");
  write(path.join(agentsHome, "skills", "tests", "SKILL.md"), "---\nname: tests\n---\n");
  write(path.join(agentsHome, "skills", "tests", "node_modules", "dep", "index.js"), "dependency");
  return { base, project, cwd, dshHome, agentsHome };
}

const fingerprinter = (tree, extra = {}) =>
  new HarnessFingerprinter({ cwd: tree.cwd, dshHome: tree.dshHome, agentsHome: tree.agentsHome, profile: "acp", ...extra });

test("the project root is the nearest ancestor holding .git, else cwd", () => {
  const tree = seatTree();
  assert.equal(findProjectRoot(tree.cwd), tree.project);
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-loose-"));
  assert.equal(findProjectRoot(loose), loose);
});

test("the harness is every file dsh reads, named by role; secrets, .system and dependencies are left out", () => {
  const tree = seatTree();
  const harness = fingerprinter(tree).compute(SETTINGS);
  assert.deepEqual(
    harness.files.map((entry) => entry.label),
    [
      "dsh-home/cordis.patch.yml",
      "project/AGENTS.md",
      "project/packages/api/CLAUDE.local.md",
      "skills/agents-home/tests/SKILL.md",
      "skills/dsh-home/review/SKILL.md",
      "skills/project-dsh/deploy/SKILL.md",
    ],
  );
  assert.equal(harness.projectRoot, tree.project);
  assert.equal(harness.truncated, false);
  assert.match(harness.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(harness.settings, SETTINGS);

  const sources = harnessSources({ cwd: tree.cwd, dshHome: tree.dshHome, agentsHome: tree.agentsHome, profile: "acp" });
  assert.ok(sources.files.some((source) => source.label === "dsh-home/profiles/acp/cordis.patch.yml"));
});

test("files that hold secrets, and dependency or cache directories, are never read from skill trees", () => {
  const tree = seatTree();
  const skill = path.join(tree.dshHome, "skills", "deploy");
  write(path.join(skill, "SKILL.md"), "---\nname: deploy\n---\n");
  for (const secret of [".env", ".env.production", "server.pem", "deploy.key", "id_ed25519", ".netrc", ".credentials.yaml"]) {
    write(path.join(skill, secret), "secret");
  }
  write(path.join(skill, ".venv", "lib", "site.py"), "venv");
  write(path.join(skill, "scripts", "__pycache__", "x.pyc"), "cache");
  write(path.join(skill, "scripts", "run.py"), "print('deploy')");

  const labels = fingerprinter(tree).compute(SETTINGS).files.map((entry) => entry.label);
  assert.deepEqual(
    labels.filter((label) => label.startsWith("skills/dsh-home/deploy/")),
    ["skills/dsh-home/deploy/SKILL.md", "skills/dsh-home/deploy/scripts/run.py"],
  );
});

test("the same harness content in other homes has the same fingerprint", () => {
  const one = seatTree();
  const two = seatTree();
  assert.notEqual(one.base, two.base);
  assert.equal(fingerprinter(one).compute(SETTINGS).fingerprint, fingerprinter(two).compute(SETTINGS).fingerprint);
});

test("an edited, added or removed harness file changes the fingerprint, and the diff names it", () => {
  const tree = seatTree();
  const prints = fingerprinter(tree);
  const before = prints.compute(SETTINGS);
  assert.equal(prints.compute(SETTINGS).fingerprint, before.fingerprint, "stable when nothing changed");

  write(path.join(tree.project, "AGENTS.md"), "repo rules, revised");
  write(path.join(tree.agentsHome, "AGENTS.md"), "global rules");
  fs.rmSync(path.join(tree.project, ".dsh"), { recursive: true });
  const after = prints.compute(SETTINGS);

  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.deepEqual(diffHarness(before, after), {
    added: ["agents-home/AGENTS.md"],
    changed: ["project/AGENTS.md"],
    removed: ["skills/project-dsh/deploy/SKILL.md"],
    settings: [],
  });
});

test("posture and the dsh version are harness; model and effort are not passed in at all", () => {
  const tree = seatTree();
  const prints = fingerprinter(tree);
  const floor = prints.compute(SETTINGS);
  const bypass = prints.compute({ ...SETTINGS, posture: "full_bypass" });
  const upgraded = prints.compute({ ...SETTINGS, agent: "dsh@0.2.2" });
  assert.notEqual(bypass.fingerprint, floor.fingerprint);
  assert.notEqual(upgraded.fingerprint, floor.fingerprint);
  assert.deepEqual(diffHarness(floor, bypass).settings, ["posture"]);
});

test("a harness larger than the budget is hashed as far as it goes and marked truncated", () => {
  const tree = seatTree();
  const harness = fingerprinter(tree, { maxFiles: 2 }).compute(SETTINGS);
  assert.equal(harness.files.length, 2);
  assert.equal(harness.truncated, true);
  assert.notEqual(harness.fingerprint, fingerprinter(tree).compute(SETTINGS).fingerprint);
});

test("a linked skill library is followed, and a link back to an ancestor does not loop", () => {
  const tree = seatTree();
  const library = path.join(tree.base, "library", "lint");
  write(path.join(library, "SKILL.md"), "---\nname: lint\n---\n");
  fs.symlinkSync(library, path.join(tree.agentsHome, "skills", "lint"));
  fs.symlinkSync(path.join(tree.agentsHome, "skills"), path.join(library, "loop"));

  const labels = fingerprinter(tree).compute(SETTINGS).files.map((entry) => entry.label);
  assert.ok(labels.includes("skills/agents-home/lint/SKILL.md"));
  assert.ok(!labels.some((label) => label.includes("/loop/")), labels.join("\n"));
});
