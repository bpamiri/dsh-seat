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
//   FAKE_ACP_SESSION_LOG      keep a dsh-shaped session log under
//                             $DSH_HOME/sessions/--fake-project--/<id>/
//   FAKE_ACP_LOG_ZSTD         ...as zstd frames, one per write, as dsh does by default
//   FAKE_ACP_LOG_USAGE        JSON usage for each assistant/message ("none" omits it)
//   FAKE_ACP_LOG_TOOL_ERROR   log one failing tool call per turn
//   FAKE_ACP_LOG_LATE_END_MS  write the turn/end row this long after answering;
//                             "400,0" delays turn 1 by 400ms and later turns by 0

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

const SESSION_ID = process.env.FAKE_ACP_SESSION_ID ?? "session-fake-1";

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

let seq = 1000;
const awaiting = new Map();
let releaseHold = null;

// ── session log ─────────────────────────────────────────────────────────────
// Row shapes follow dsh's v4 log: a header row, then {type, seq, time, data}.

const DEFAULT_LOG_USAGE = { inputTokens: 1200, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 80, reasoningTokens: 20, totalTokens: 5280 };
let logFile = null;
let logSeq = 0;
let logTurn = 0;

function appendRows(rows) {
  if (!logFile) return;
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  fs.appendFileSync(logFile, process.env.FAKE_ACP_LOG_ZSTD ? zlib.zstdCompressSync(Buffer.from(text)) : text);
}

const logRow = (type, data) => ({ type, seq: ++logSeq, time: Date.now(), data });

function openLog(sessionId, cwd) {
  if (!process.env.FAKE_ACP_SESSION_LOG || !process.env.DSH_HOME) return;
  const name = process.env.FAKE_ACP_LOG_ZSTD ? "session.v4.jsonl.zstd" : "session.v4.jsonl";
  logFile = path.join(process.env.DSH_HOME, "sessions", "--fake-project--", sessionId, name);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (fs.existsSync(logFile) && !process.env.FAKE_ACP_LOG_ZSTD) {
    // A resumed session continues its numbering.
    for (const line of fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      logSeq = Math.max(logSeq, row.seq ?? 0);
      if (row.type === "turn/start") logTurn = Math.max(logTurn, row.data.turn);
    }
    return;
  }
  appendRows([{ type: "session", version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }]);
}

function lateEndMs(turn) {
  const delays = (process.env.FAKE_ACP_LOG_LATE_END_MS ?? "").split(",").filter(Boolean).map(Number);
  return delays.length ? delays[Math.min(turn, delays.length) - 1] : 0;
}

/** Log one turn. Returns {row, delayMs} when its turn/end row is to be written late. */
function logPrompt({ texts, answer, cancelled }) {
  if (!logFile) return null;
  const turn = ++logTurn;
  const usageEnv = process.env.FAKE_ACP_LOG_USAGE;
  const usage = usageEnv === "none" ? undefined : usageEnv ? JSON.parse(usageEnv) : DEFAULT_LOG_USAGE;
  const rows = [
    logRow("turn/start", { turn }),
    logRow("step/start", { turn, step: 1 }),
    logRow("user/message", { role: "user", content: texts.map((text) => ({ type: "text", text })), source: { kind: "user" }, id: `m${logSeq}` }),
    logRow("request/context", { provider: "deepseek", model: "deepseek-v4-flash", contextWindow: 1000000 }),
    logRow("assistant/message", {
      turn,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: answer }], source: { kind: "model", provider: "deepseek", model: "deepseek-v4-flash" } },
      ...(usage ? { usage } : {}),
      stream: [],
    }),
  ];
  if (process.env.FAKE_ACP_LOG_TOOL_ERROR) {
    rows.push(
      logRow("tool/call", { turn, step: 1, callId: `call-${turn}`, name: "bash", arguments: "{}" }),
      logRow("tool/result", {
        turn,
        step: 1,
        message: { role: "tool", toolCallId: `call-${turn}`, source: { kind: "tool", callId: `call-${turn}` }, content: [], isError: true },
        error: { name: "ExecError", code: "EXIT_NONZERO" },
      }),
    );
  }
  rows.push(logRow("step/end", { turn, step: 1 }));
  const end = logRow("turn/end", { turn, reason: cancelled ? { kind: "aborted", reason: { kind: "user" } } : { kind: "completed" } });
  const delayMs = lateEndMs(turn);
  if (delayMs > 0) {
    appendRows(rows);
    return { row: end, delayMs };
  }
  appendRows([...rows, end]);
  return null;
}

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

  const cancelled = Boolean(process.env.FAKE_ACP_HOLD_MS) && (await hold(Number(process.env.FAKE_ACP_HOLD_MS)));
  const lateEnd = logPrompt({ texts, answer: chunks.join(""), cancelled });
  const stopReason = cancelled ? "cancelled" : process.env.FAKE_ACP_STOP_REASON ?? "end_turn";
  write({ jsonrpc: "2.0", id: msg.id, result: { stopReason } });
  // dsh answers the prompt without waiting for its last log batch.
  if (lateEnd) setTimeout(() => appendRows([lateEnd.row]), lateEnd.delayMs);
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
      openLog(SESSION_ID, msg.params.cwd);
      write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SESSION_ID, configOptions: [] } });
      break;
    case "session/resume":
      if (process.env.FAKE_ACP_RESUME_FAILS) {
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "resume refused by fake agent" } });
      } else {
        openLog(msg.params.sessionId, msg.params.cwd);
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
