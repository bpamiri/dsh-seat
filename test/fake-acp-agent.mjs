// SPDX-License-Identifier: Apache-2.0
// A scriptable fake ACP agent for tests. Speaks just enough of ACP v1 over
// stdio to exercise the runner without a model, credentials, or the network.
//
// Behaviour is driven by environment variables so each test states its scenario:
//   FAKE_ACP_SESSION_ID       id returned by session/new (default session-fake-1)
//   FAKE_ACP_CHUNKS           "|"-separated agent_message_chunk deltas
//   FAKE_ACP_THOUGHT          emit one agent_thought_chunk first
//   FAKE_ACP_USAGE            emit a usage_update
//   FAKE_ACP_ASK_PERMISSION   issue session/request_permission and report the answer
//   FAKE_ACP_STOP_REASON      stopReason for session/prompt (default end_turn)
//   FAKE_ACP_RESUME_FAILS     session/resume returns an error
//   FAKE_ACP_EXIT_ON_PROMPT   exit(3) instead of answering the prompt
//   FAKE_ACP_GARBAGE          print a non-JSON line on stdout
//   FAKE_ACP_CAPTURE          path to write the received session/prompt texts
//   FAKE_ACP_HOLD_MS          hold each prompt open this long; session/cancel
//                             ends it early with stopReason "cancelled"

import fs from "node:fs";
import readline from "node:readline";

const SESSION_ID = process.env.FAKE_ACP_SESSION_ID ?? "session-fake-1";

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

let seq = 1000;
const awaiting = new Map();
let releaseHold = null;

/** Wait `ms`, or until session/cancel arrives. Resolves true when cancelled. */
function hold(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      releaseHold = null;
      resolve(false);
    }, ms);
    releaseHold = () => {
      clearTimeout(timer);
      releaseHold = null;
      resolve(true);
    };
  });
}

function serverRequest(method, params) {
  const id = ++seq;
  return new Promise((resolve) => {
    awaiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
}

async function handlePrompt(msg) {
  if (process.env.FAKE_ACP_EXIT_ON_PROMPT) process.exit(3);
  if (process.env.FAKE_ACP_GARBAGE) process.stdout.write("this line is not JSON\n");

  const sessionId = msg.params.sessionId;
  const texts = (msg.params.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text);
  if (process.env.FAKE_ACP_CAPTURE) {
    fs.appendFileSync(process.env.FAKE_ACP_CAPTURE, `${JSON.stringify(texts)}\n`);
  }

  let permissionSuffix = "";
  if (process.env.FAKE_ACP_ASK_PERMISSION) {
    const response = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-1", title: "Run a dangerous command", kind: "execute" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    });
    const outcome = response?.result?.outcome ?? response?.error ?? "no-response";
    permissionSuffix = `|permission=${outcome.optionId ?? outcome.outcome ?? JSON.stringify(outcome)}`;
  }

  if (process.env.FAKE_ACP_THOUGHT) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering…\n" } },
    });
  }

  const chunks = (process.env.FAKE_ACP_CHUNKS ?? "hello from fake acp").split("|");
  for (const chunk of chunks) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
    });
  }

  if (permissionSuffix) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: permissionSuffix } },
    });
  }

  if (process.env.FAKE_ACP_USAGE) {
    notify("session/update", { sessionId, update: { sessionUpdate: "usage_update", used: 250, size: 1000 } });
  }

  if (process.env.FAKE_ACP_HOLD_MS && (await hold(Number(process.env.FAKE_ACP_HOLD_MS)))) {
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
    return;
  }

  write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: process.env.FAKE_ACP_STOP_REASON ?? "end_turn" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // A response to one of our server->client requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = awaiting.get(msg.id);
    if (resolve) {
      awaiting.delete(msg.id);
      resolve(msg);
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp", version: "0.0.0" },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
          authMethods: [],
        },
      });
      break;
    case "session/new":
      write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SESSION_ID, configOptions: [] } });
      break;
    case "session/resume":
      if (process.env.FAKE_ACP_RESUME_FAILS) {
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "resume refused by fake agent" } });
      } else {
        write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId, configOptions: [] } });
      }
      break;
    case "session/set_config_option":
      write({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
      break;
    case "session/prompt":
      handlePrompt(msg).catch((err) => {
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } });
      });
      break;
    case "session/close":
      write({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "session/cancel":
      // A notification: no response, just end any held prompt.
      releaseHold?.();
      break;
    default:
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no such method ${msg.method}` } });
  }
});
