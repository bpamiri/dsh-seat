// SPDX-License-Identifier: Apache-2.0
// The seat's harness fingerprint: one hash over the files and settings that
// shape how this dsh agent works, apart from the model and the prompt.
//
// A self-improvement loop changes the harness between turns — a new skill, an
// edited AGENTS.md, a different patch. To learn which changes helped, every
// turn has to say which harness ran it: the move harness2 makes when it
// fingerprints the harness tree on every rollout. Model and effort stay out
// of the hash on purpose; they are recorded beside it, so one harness can be
// compared across models.
//
// What dsh reads, per its source at 687f282e:
//   instructions  $DSH_HOME/AGENTS.md, then <agentsHome>/AGENTS.md, then every
//                 AGENTS.md, CLAUDE.md, AGENTS.local.md, CLAUDE.local.md from the
//                 project root (nearest ancestor holding .git, else cwd) down to
//                 cwd (packages/context/agent-instructions/src/config.ts, files.ts)
//   skills        <projectRoot>/.dsh/skills, <projectRoot>/.agents/skills,
//                 $DSH_HOME/skills minus .system, <agentsHome>/skills
//                 (packages/skill/skill-filesystem/src/index.ts)
//   composition   $DSH_HOME/cordis.patch.yml and $DSH_HOME/profiles/<profile>/
//                 cordis.patch.yml
// agentsHome is $DSH_AGENTS_HOME, else ~/.agents.
//
// Files are named by role, not location (dsh-home/…, project/…, skills/…), so
// seats with the same harness content share a fingerprint wherever their
// homes live. Content is hashed, never copied; the manifest lists each file's
// size and sha256 so two fingerprints can be diffed. Files that commonly hold
// secrets are not harness and are never read, nor are dependency and cache
// directories inside a skill.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"];

// Dependencies, caches and VCS internals inside a skill are not the skill.
const SKIPPED_NAMES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".cache"]);
// Nor is a secret that happens to sit beside it; it is never even read.
const SECRET_FILE = /^(?:\.env(?:\..+)?|\.netrc|\.npmrc|\.pypirc|\.credentials\.(?:ya?ml|json)|credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:pem|key|p12|pfx)$/;
const MAX_DEPTH = 12;

export function defaultAgentsHome(env = process.env) {
  return env.DSH_AGENTS_HOME && env.DSH_AGENTS_HOME.trim()
    ? path.resolve(env.DSH_AGENTS_HOME.trim())
    : path.join(os.homedir(), ".agents");
}

/** The nearest ancestor of cwd (itself included) holding a marker, else cwd — dsh's rule. */
export function findProjectRoot(cwd, markers = [".git"]) {
  const start = path.resolve(cwd);
  for (let current = start; ; current = path.dirname(current)) {
    if (markers.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
    if (path.dirname(current) === current) return start;
  }
}

/** Every place dsh reads harness from, each named by its role. */
export function harnessSources({ cwd, dshHome, agentsHome, profile }) {
  const projectRoot = findProjectRoot(cwd);
  const files = [
    { label: "dsh-home/cordis.patch.yml", file: path.join(dshHome, "cordis.patch.yml") },
    { label: `dsh-home/profiles/${profile}/cordis.patch.yml`, file: path.join(dshHome, "profiles", profile, "cordis.patch.yml") },
    { label: "dsh-home/AGENTS.md", file: path.join(dshHome, "AGENTS.md") },
    { label: "agents-home/AGENTS.md", file: path.join(agentsHome, "AGENTS.md") },
  ];

  // Project root down to cwd, broadest first.
  const chain = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (dir === projectRoot || path.dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    const parts = path.relative(projectRoot, dir).split(path.sep).filter(Boolean);
    for (const name of INSTRUCTION_FILES) {
      files.push({ label: ["project", ...parts, name].join("/"), file: path.join(dir, name) });
    }
  }

  const trees = [
    { label: "skills/project-dsh", dir: path.join(projectRoot, ".dsh", "skills") },
    { label: "skills/project-agents", dir: path.join(projectRoot, ".agents", "skills") },
    { label: "skills/dsh-home", dir: path.join(dshHome, "skills"), skipTop: [".system"] },
    { label: "skills/agents-home", dir: path.join(agentsHome, "skills") },
  ];
  return { projectRoot, files, trees };
}

const byLabel = (a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

export class HarnessFingerprinter {
  #sources;
  #maxFiles;
  #maxBytes;
  // file -> {size, mtimeMs, ctimeMs, ino, sha256}: an unchanged file is not reread.
  #hashes = new Map();

  constructor({ cwd, dshHome, agentsHome, profile, maxFiles = 2000, maxBytes = 32 * 1024 * 1024 }) {
    this.#sources = { cwd, dshHome, agentsHome, profile };
    this.#maxFiles = maxFiles;
    this.#maxBytes = maxBytes;
  }

  /**
   * Hash the harness as it is on disk now.
   * @param settings - seat settings that belong to the harness (not model or effort).
   * @returns {{fingerprint: string, settings: object, files: {label: string, bytes: number, sha256: string}[],
   *           truncated: boolean, projectRoot: string}}
   */
  compute(settings = {}) {
    const { projectRoot, files, trees } = harnessSources(this.#sources);
    const entries = [];
    const budget = { files: 0, bytes: 0, truncated: false };
    for (const { label, file } of files) this.#add(entries, budget, label, file);
    for (const tree of trees) this.#walk(entries, budget, tree);
    entries.sort(byLabel);

    const kept = Object.keys(settings)
      .filter((key) => settings[key] !== undefined)
      .sort()
      .map((key) => [key, settings[key]]);
    const hash = createHash("sha256").update("dsh-seat harness v1\n");
    for (const [key, value] of kept) hash.update(`setting ${key} ${JSON.stringify(value)}\n`);
    for (const entry of entries) hash.update(`file ${entry.label} ${entry.sha256}\n`);
    if (budget.truncated) hash.update("truncated\n");

    return {
      fingerprint: hash.digest("hex"),
      settings: Object.fromEntries(kept),
      files: entries,
      truncated: budget.truncated,
      projectRoot,
    };
  }

  #add(entries, budget, label, file, known = null) {
    let stat = known;
    if (!stat) {
      try {
        stat = fs.statSync(file);
      } catch {
        return;
      }
    }
    if (!stat.isFile()) return;
    if (budget.files >= this.#maxFiles || budget.bytes + stat.size > this.#maxBytes) {
      budget.truncated = true;
      return;
    }
    budget.files += 1;
    budget.bytes += stat.size;

    const cached = this.#hashes.get(file);
    const unchanged =
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs &&
      cached.ino === stat.ino;
    let sha256 = unchanged ? cached.sha256 : null;
    let bytes = stat.size;
    if (!sha256) {
      let content;
      try {
        content = fs.readFileSync(file);
      } catch {
        return;
      }
      sha256 = createHash("sha256").update(content).digest("hex");
      bytes = content.length;
      this.#hashes.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, sha256 });
    }
    entries.push({ label, bytes, sha256 });
  }

  #walk(entries, budget, { label, dir, skipTop = [] }) {
    // Symlinks are followed, as a skill library is often linked in; a link
    // back to an ancestor directory is not.
    const visit = (current, parts, ancestors) => {
      if (budget.truncated) return; // past the budget the result is settled
      let real;
      try {
        real = fs.realpathSync(current);
      } catch {
        return;
      }
      if (ancestors.has(real) || parts.length > MAX_DEPTH) return;
      const inside = new Set(ancestors).add(real);
      let names;
      try {
        names = fs.readdirSync(current).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (budget.truncated) return;
        if (SKIPPED_NAMES.has(name) || (parts.length === 0 && skipTop.includes(name))) continue;
        const full = path.join(current, name);
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) visit(full, [...parts, name], inside);
        else if (stat.isFile() && !SECRET_FILE.test(name)) this.#add(entries, budget, [label, ...parts, name].join("/"), full, stat);
      }
    };
    visit(dir, [], new Set());
  }
}

/** What changed between two computed harnesses: file labels and setting names. */
export function diffHarness(before, after) {
  const old = new Map((before?.files ?? []).map((entry) => [entry.label, entry.sha256]));
  const now = new Map((after?.files ?? []).map((entry) => [entry.label, entry.sha256]));
  const settingNames = new Set([...Object.keys(before?.settings ?? {}), ...Object.keys(after?.settings ?? {})]);
  return {
    added: [...now.keys()].filter((label) => !old.has(label)),
    changed: [...now.keys()].filter((label) => old.has(label) && old.get(label) !== now.get(label)),
    removed: [...old.keys()].filter((label) => !now.has(label)),
    settings: [...settingNames]
      .filter((name) => JSON.stringify(before?.settings?.[name]) !== JSON.stringify(after?.settings?.[name]))
      .sort(),
  };
}
