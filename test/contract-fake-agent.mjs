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
const twoAsks = process.argv.includes("--two-asks");
const twoAsksExit = process.argv.includes("--two-asks-exit");
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answers = new Map();
let nextId = 900;
function ask(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => answers.set(id, resolve));
}

async function handle(msg) {
  record(msg);
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = answers.get(msg.id);
    if (resolve) { answers.delete(msg.id); resolve(msg); }
    return;
  }
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
      if (twoAsks || twoAsksExit) {
        // Real dsh can have two approvals outstanding (parallel tool calls).
        ask("session/request_permission", {
          sessionId: "fake-new",
          toolCall: { toolCallId: "call-1", title: "Ask one", kind: "edit" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        const second = ask("session/request_permission", {
          sessionId: "fake-new",
          toolCall: { toolCallId: "call-2", title: "Ask two", kind: "edit" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        if (twoAsksExit) {
          setTimeout(() => exit(3, "exit while two asks wait"), 1000);
        } else {
          await Promise.race([second, sleep(2000)]);
          await sleep(7000);
          reply(msg.id, { stopReason: "end_turn" });
        }
        return;
      }
      if (mode === "permission") {
        const answer = await ask("session/request_permission", {
          sessionId: "fake-new",
          toolCall: { toolCallId: "call-1", title: "Edit notes.txt", kind: "edit" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        record({ answer: answer.result ?? answer.error });
      }
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
}

createInterface({ input: process.stdin }).on("line", (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  void handle(msg);
});
