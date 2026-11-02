#!/usr/bin/env node
// Sanitized liveness-reproduction harness. It runs a dsh-seat build against a
// local activity endpoint (no daemon, no tmux, no seat) and records the exact
// post sequence and wall-clock gaps for one long, silent turn.
//
// Usage: run-capture.mjs <a|b> <path/to/dsh-seat> <output-dir> <path/to/fake-agent.mjs>
// Env: CAPTURE_BUILD (label), FAKE_AGENT_SILENCE_MS (default 60000)
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const label = process.argv[2];
const runner = process.argv[3];
const outDir = process.argv[4];
const fakeAgent = process.argv[5];
const silenceMs = Number(process.env.FAKE_AGENT_SILENCE_MS ?? 60000);
const build = process.env.CAPTURE_BUILD ?? path.basename(path.dirname(path.dirname(runner)));
const startedIso = new Date().toISOString();
mkdirSync(outDir, { recursive: true });
mkdirSync(path.join(outDir, `workspace-${label}`), { recursive: true });
mkdirSync(path.join(outDir, `fake-home-${label}`), { recursive: true });
mkdirSync(path.join(outDir, `fake-openrig-home-${label}`), { recursive: true });

const postsPath = path.join(outDir, `capture-${label}-posts.jsonl`);
const agentLog = path.join(outDir, `capture-${label}-agent.log`);
const runnerStdout = path.join(outDir, `capture-${label}-runner.stdout.log`);
const runnerStderr = path.join(outDir, `capture-${label}-runner.stderr.log`);
const firstInput = path.join(outDir, `capture-${label}-first-input.txt`);
writeFileSync(firstInput, "Sanitized liveness reproduction: hold the turn open, then report done.\n");
writeFileSync(postsPath, "");
writeFileSync(agentLog, "");

const posts = [];
let stopResolve = () => {};
const stopSeen = new Promise((resolve) => { stopResolve = resolve; });
let serverPort = null;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* recorded raw below */ }
    const entry = {
      recvAt: Date.now(),
      iso: new Date().toISOString(),
      method: req.method,
      url: req.url,
      hasAuthorization: Boolean(req.headers.authorization),
      body: parsed,
      rawLength: body.length,
    };
    posts.push(entry);
    appendFileSync(postsPath, JSON.stringify(entry) + "\n");
    if (parsed?.hookEvent === "Stop") stopResolve(entry);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
serverPort = server.address().port;

const env = {
  ...process.env,
  HOME: path.join(outDir, `fake-home-${label}`),
  OPENRIG_HOME: path.join(outDir, `fake-openrig-home-${label}`),
  OPENRIG_SESSION_NAME: `seat-${label}@liveness-demo`,
  OPENRIG_NODE_ID: `node-${label}`,
  OPENRIG_RUNTIME: `liveness-${label}`,
  OPENRIG_OCCUPANT_GENERATION: `generation-${label}`,
  OPENRIG_URL: `http://127.0.0.1:${serverPort}`,
  OPENRIG_ACTIVITY_HOOK_TOKEN: "local-activity-token",
  OPENRIG_LAUNCH_RESULT: path.join(outDir, `fake-openrig-home-${label}`, "launch-result.json"),
  OPENRIG_LAUNCH_ATTEMPT: `attempt-${label}`,
  OPENRIG_FIRST_INPUT: firstInput,
  FAKE_AGENT_LOG: agentLog,
  FAKE_AGENT_SILENCE_MS: String(silenceMs),
};
delete env.DSH_HOME;
delete env.OPENRIG_SESSION;
delete env.OPENRIG_AGENT;

const agentCommand = `${process.execPath} ${fakeAgent} --log ${agentLog} --silence ${silenceMs}`;
const child = spawn(process.execPath, [runner, "--agent-command", agentCommand], {
  cwd: path.join(outDir, `workspace-${label}`),
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = wait(silenceMs + 20000).then(() => ({ timeout: true }));
const stop = await Promise.race([stopSeen, timeout]);
await wait(1000);
child.stdin.end();
child.kill("SIGTERM");
await Promise.race([
  new Promise((resolve) => child.once("exit", resolve)),
  wait(3000),
]);
if (child.exitCode === null) child.kill("SIGKILL");
server.close();
writeFileSync(runnerStdout, stdout);
writeFileSync(runnerStderr, stderr);

const base = posts.find((p) => p.body?.hookEvent === "UserPromptSubmit")?.recvAt ?? posts[0]?.recvAt ?? Date.now();
const sequence = posts.map((p) => {
  const body = p.body ?? {};
  return {
    offsetMs: p.recvAt - base,
    iso: p.iso,
    recvAt: p.recvAt,
    hookEvent: body.hookEvent ?? null,
    subtype: body.subtype ?? null,
    turnId: body.turnId ?? null,
    sequence: body.sequence ?? null,
    livenessSeconds: body.livenessSeconds ?? null,
    generation: body.generation ?? null,
    sessionName: body.sessionName ?? null,
    nodeId: body.nodeId ?? null,
    runtime: body.runtime ?? null,
    status: p.rawLength >= 0 ? "accepted" : "other",
  };
});
const meta = {
  label,
  build,
  runner,
  fakeAgent,
  silenceMs,
  serverPort,
  startedIso,
  finishedIso: new Date().toISOString(),
  stopSeen: !stop.timeout,
  postCount: posts.length,
  posts: sequence,
  runnerStdoutTail: stdout.slice(-4000),
  runnerStderrTail: stderr.slice(-4000),
};
writeFileSync(path.join(outDir, `capture-${label}-timeline.json`), JSON.stringify(meta, null, 2));

console.log(`capture ${label}: build=${build} stopSeen=${meta.stopSeen} posts=${posts.length}`);
for (const p of sequence) {
  const gap = p.offsetMs;
  console.log(`${(gap / 1000).toFixed(2)}s ${p.hookEvent}/${p.subtype} seq=${p.sequence ?? "-"} turn=${p.turnId ?? "-"} liveness=${p.livenessSeconds ?? "-"}`);
}
console.log(`wrote ${path.join(outDir, `capture-${label}-timeline.json`)}`);
