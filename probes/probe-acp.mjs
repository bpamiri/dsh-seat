// SPDX-License-Identifier: Apache-2.0
// Phase-1 probe: prove the ACP wire against the real `dsh --profile acp`.
// Throwaway / diagnostic. Run: node probes/probe-acp.mjs
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// NOTE: the ambient DSH_HOME points at the live ~/.dsh (this process may itself run
// under dsh). The probe deliberately does NOT inherit it. Build the home with
// scripts/make-seat-home.sh first.
const home = process.env.PROBE_DSH_HOME ?? path.resolve(here, "../.seat-home");
const cwd = process.env.PROBE_CWD ?? path.resolve(here, "..");

const child = spawn("dsh", ["--profile", "acp"], {
  cwd,
  env: { ...process.env, DSH_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let seq = 0;

child.stderr.on("data", (d) => process.stderr.write(`[dsh stderr] ${d}`));
child.on("exit", (code, sig) => {
  console.error(`[probe] dsh exited code=${code} signal=${sig}`);
  for (const [, p] of pending) p.reject(new Error("dsh exited"));
});

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[probe] non-JSON stdout: ${line.slice(0, 200)}`);
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return console.error(`[probe] response for unknown id ${msg.id}`);
    pending.delete(msg.id);
    msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    console.error(`[probe] update ${JSON.stringify(msg.params?.update?.sessionUpdate)} ${JSON.stringify(msg.params?.update).slice(0, 160)}`);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    // server -> client request we must answer
    console.error(`[probe] server request ${msg.method} ${JSON.stringify(msg.params).slice(0, 300)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } })}\n`);
    return;
  }
  console.error(`[probe] notification ${msg.method}`);
});

function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function die(msg, code = 1) {
  console.error(`[probe] FAIL: ${msg}`);
  child.kill("SIGKILL");
  process.exit(code);
}

setTimeout(() => die("overall timeout"), 120_000).unref();

try {
  console.error("[probe] initialize …");
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "dsh-seat-probe", version: "0.0.1" },
  });
  console.log("INITIALIZE →", JSON.stringify(init, null, 2));

  console.error("[probe] session/new …");
  const ns = await request("session/new", { cwd, mcpServers: [] });
  console.log("SESSION/NEW →", JSON.stringify(ns, null, 2));

  if (!ns?.sessionId) die("no sessionId returned");

  if (process.env.PROBE_PROMPT) {
    console.error("[probe] session/prompt …");
    const pr = await request("session/prompt", {
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: process.env.PROBE_PROMPT }],
    });
    console.log("SESSION/PROMPT →", JSON.stringify(pr, null, 2));
  }

  console.error("[probe] session/close …");
  const cl = await request("session/close", { sessionId: ns.sessionId });
  console.log("SESSION/CLOSE →", JSON.stringify(cl ?? null));

  console.log("PROBE OK");
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300).unref();
} catch (err) {
  die(`${err.message}${err.rpc ? ` (rpc ${JSON.stringify(err.rpc)})` : ""}`);
}
