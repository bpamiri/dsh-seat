// SPDX-License-Identifier: Apache-2.0
// A seat must run with its own writable DSH_HOME. dsh rewrites the profile on
// every boot and writes sessions/storages/.anonymous-user-id into the home; if
// that is the operator's ~/.dsh, a public seat mutates the operator's own dsh.
//
// With DSH_HOME set, the runner uses it — but refuses the operator's own home.
// Without it, the runner provisions a per-seat home under OPENRIG_HOME (or
// ~/.openrig), copying the operator's acp profile when one exists and writing a
// patch that turns off dsh's session-log and plugin-inventory uploads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function sanitizeSessionName(name) {
  return String(name || "dsh-seat").replace(/[^A-Za-z0-9._@-]+/g, "_").replace(/^\.+$/, "dsh-seat") || "dsh-seat";
}

const DISABLE_UPLOADS_PATCH = `# dsh-seat seat defaults: do not attach session logs or the plugin package
# inventory to DeepSeek API requests. See the runner's privacy notes.
- id: session-log-deepseek
  config:
    enabled: false
- id: plugin-package-inventory-deepseek
  config:
    enabled: false
`;

/**
 * @returns {{ok: true, home: string, provisioned: boolean, sourceProfile: string|null}
 *          | {ok: false, error: string}}
 */
export function prepareDshHome(env = process.env) {
  const homeDir = env.HOME && env.HOME.trim() ? env.HOME.trim() : os.homedir();
  const operatorHome = path.resolve(homeDir, ".dsh");
  const explicit = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (resolved === operatorHome) {
      return { ok: false, error: `refusing DSH_HOME=${resolved}: that is the operator's own dsh home; point the seat at a per-seat writable home` };
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
      return { ok: true, home: resolved, provisioned: false, sourceProfile: null };
    } catch (error) {
      return { ok: false, error: `DSH_HOME ${resolved} is not writable: ${error.message}` };
    }
  }

  const openrigHome = env.OPENRIG_HOME && env.OPENRIG_HOME.trim()
    ? path.resolve(env.OPENRIG_HOME.trim())
    : path.join(homeDir, ".openrig");
  const seatName = sanitizeSessionName(env.OPENRIG_SESSION_NAME);
  const target = path.join(openrigHome, "state", "dsh", seatName, "dsh-home");
  const source = path.join(operatorHome, "profiles", "acp");
  const sourceProfile = fs.existsSync(source) ? source : null;

  try {
    fs.mkdirSync(path.join(target, "profiles"), { recursive: true });
    if (sourceProfile && !fs.existsSync(path.join(target, "profiles", "acp"))) {
      fs.cpSync(sourceProfile, path.join(target, "profiles", "acp"), {
        recursive: true,
        filter: (entry) => path.basename(entry) !== "node_modules",
      });
    }
    const sharedModules = path.join(operatorHome, "profiles", "node_modules");
    const seatModules = path.join(target, "profiles", "node_modules");
    if (fs.existsSync(sharedModules) && !fs.existsSync(seatModules)) {
      fs.symlinkSync(sharedModules, seatModules, "dir");
    }
    for (const extra of [".agent-presets", "settings.yaml.imported"]) {
      const from = path.join(operatorHome, extra);
      const to = path.join(target, extra);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
    }
    const patch = path.join(target, "cordis.patch.yml");
    if (!fs.existsSync(patch)) fs.writeFileSync(patch, DISABLE_UPLOADS_PATCH);
    return { ok: true, home: target, provisioned: true, sourceProfile };
  } catch (error) {
    return { ok: false, error: `could not provision a per-seat DSH_HOME at ${target}: ${error.message}` };
  }
}
