#!/usr/bin/env node
// Minimal ACP agent for the sanitized liveness reproduction. It accepts one prompt
// and stays completely silent for FAKE_AGENT_SILENCE_MS, then replies and ends the
// turn. No model, credentials, or network. It logs every request with a wall-clock
// timestamp so the capture can line up runner posts against real turn events.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const arg = (name, fallback = undefined) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const logFile = arg("--log", process.env.FAKE_AGENT_LOG || "");
const silenceMs = Number(arg("--silence", process.env.FAKE_AGENT_SILENCE_MS ?? 90000));
const log = (entry) => {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), iso: new Date().toISOString(), ...entry }) + "\n");
};
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

let promptId = null;
let promptSession = null;
let timer = null;

const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { log({ event: "non-json-line" }); return; }
  log({ event: "recv", method: msg.method ?? null, id: msg.id ?? null });
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: "liveness-fake-acp-agent", version: "1.0.0" },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      });
      break;
    case "session/new":
      reply(msg.id, { sessionId: `fake-${process.pid}`, configOptions: [] });
      break;
    case "session/prompt":
      promptId = msg.id;
      promptSession = msg.params?.sessionId ?? null;
      log({ event: "prompt-start", sessionId: promptSession, silenceMs });
      timer = setTimeout(() => {
        timer = null;
        send({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: promptSession, update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "fake-message-1",
            content: { type: "text", text: "done" },
          } },
        });
        reply(promptId, { stopReason: "end_turn" });
        log({ event: "prompt-end", sessionId: promptSession });
        promptId = null;
      }, silenceMs);
      break;
    case "session/cancel":
      if (timer) {
        clearTimeout(timer);
        timer = null;
        reply(promptId, { stopReason: "cancelled" });
        log({ event: "prompt-cancelled", sessionId: promptSession });
        promptId = null;
      }
      break;
    case "session/load":
      fail(msg.id, -32601, "Method not found");
      break;
    default:
      if (msg.id !== undefined) fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});
rl.on("close", () => {
  log({ event: "stdin-close" });
  setTimeout(() => process.exit(0), 50);
});
