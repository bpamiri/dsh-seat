#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Minimal ACP agent for the contract-runner tests: records requests, answers
// initialize/session/new or session/resume, and logs its own environment.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const log = arg("--log");
const envLog = arg("--env-log");
const marker = arg("--marker");
const mode = arg("--mode") ?? "fresh";
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
const record = (entry) => log && appendFileSync(log, `${JSON.stringify(entry)}\n`);
if (envLog) writeFileSync(envLog, JSON.stringify(process.env));
// A start marker proves the runner never spawned the agent (--require-resume).
if (marker) writeFileSync(marker, "started");
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  record(msg);
  switch (msg.method) {
    case "initialize": reply(msg.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }); break;
    case "session/new": reply(msg.id, { sessionId: "fake-new", configOptions: MODEL_OPTIONS }); break;
    case "session/resume":
      if (mode === "missing") fail(msg.id, -32002, "Session not found: fake-old");
      else reply(msg.id, { configOptions: MODEL_OPTIONS });
      break;
    case "session/load": fail(msg.id, -32601, "Method not found: session/load"); break;
    case "session/set_config_option": reply(msg.id, {}); break;
    case "session/prompt":
      if (mode === "activity") {
        // One tool call and two message chunks (the runner's 10 s throttle must
        // collapse the second chunk); then the agent's own end_turn.
        const sessionId = "fake-new";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "call-1", kind: "read", title: "Read file", status: "pending" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "again" } } } });
      }
      reply(msg.id, { stopReason: "end_turn" });
      break;
    case "session/cancel": break;
    default: if (msg.id !== undefined) fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});
