// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  SessionLogTail,
  turnsSettled,
  findSessionLog,
  sessionDirName,
  summarizeTurnRows,
  turnUsageFields,
  zstdFrames,
} from "../src/usage.mjs";

// dsh writes checksummed frames (session-persistence-jsonl README, "Physical encoding").
const CHECKSUMMED = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

let seq = 0;
const row = (type, data) => ({ type, seq: ++seq, time: 1_790_000_000_000 + seq, data });
const header = (id) => ({ type: "session", version: 4, id, createdAt: 1, cwd: "/work", isSeeded: false, delegationDepth: 0 });

/** One dsh-shaped turn: a model call with usage, optionally a failing tool. */
function turnRows(turn, { usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }, failTool = false } = {}) {
  return [
    row("turn/start", { turn }),
    row("step/start", { turn, step: 1 }),
    row("request/context", { provider: "deepseek", model: "deepseek-v4-flash", contextWindow: 1_000_000 }),
    row("assistant/message", {
      turn,
      step: 1,
      message: { role: "assistant", content: [], source: { kind: "model", provider: "deepseek", model: "deepseek-v4-flash" } },
      usage,
      stream: [],
    }),
    ...(failTool
      ? [
          row("tool/call", { turn, step: 1, callId: `c${turn}`, name: "bash", arguments: "{}" }),
          row("tool/result", {
            turn,
            step: 1,
            message: { role: "tool", toolCallId: `c${turn}`, source: { kind: "tool", callId: `c${turn}` }, content: [], isError: true },
            error: { name: "ExecError", code: "EXIT" },
          }),
        ]
      : []),
    row("step/end", { turn, step: 1 }),
    row("turn/end", { turn, reason: { kind: "completed" } }),
  ];
}

const lines = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

function sessionsRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-usage-")), "sessions");
}

function logFile(root, id, name = "session.v4.jsonl") {
  const dir = path.join(root, "--work--", sessionDirName(id));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

test("a session id becomes one path segment the way dsh escapes it", () => {
  assert.equal(sessionDirName("0b7c4a52-9f1e-4c1a-8e47-2d4c1b9a0f11"), "0b7c4a52-9f1e-4c1a-8e47-2d4c1b9a0f11");
  assert.equal(sessionDirName("a/b~c"), "a~002Fb~007Ec");
  assert.equal(sessionDirName(".."), "~002E~002E");
});

test("the newest log generation is found under whichever project directory holds it", () => {
  const root = sessionsRoot();
  assert.equal(findSessionLog({ sessionsRoot: root, sessionId: "s1" }), null);

  fs.writeFileSync(logFile(root, "s1", "session.v3.jsonl"), "");
  fs.writeFileSync(logFile(root, "s1", "session.v4.jsonl"), "");
  fs.writeFileSync(logFile(root, "s1", "session.v4.jsonl.tmp"), "");
  const found = findSessionLog({ sessionsRoot: root, sessionId: "s1" });
  assert.equal(found.version, 4);
  assert.equal(found.compressed, false);
  assert.equal(path.basename(found.path), "session.v4.jsonl");
});

test("zstd frames are split by their headers; a frame still being written is left for later", () => {
  const frames = [
    zlib.zstdCompressSync(Buffer.from(lines([header("s")])), CHECKSUMMED),
    zlib.zstdCompressSync(Buffer.from(`${"x".repeat(300_000)}\n`), CHECKSUMMED), // several blocks
    zlib.zstdCompressSync(Buffer.from('{"type":"turn/end"}\n')),
  ];
  const all = Buffer.concat(frames);
  const whole = zstdFrames(all);
  assert.deepEqual(
    whole.spans.map(({ start, end }) => end - start),
    frames.map((frame) => frame.length),
  );
  assert.equal(whole.consumed, all.length);

  const torn = zstdFrames(all.subarray(0, all.length - 3));
  assert.equal(torn.spans.length, 2);
  assert.equal(torn.consumed, frames[0].length + frames[1].length);

  const skippable = Buffer.alloc(8 + 4);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(4, 4);
  assert.deepEqual(zstdFrames(Buffer.concat([skippable, frames[0]])).spans, [{ start: 12, end: 12 + frames[0].length }]);
  assert.throws(() => zstdFrames(Buffer.from("plain text, not zstd")), /no zstd frame/);
});

test("rows settle only once a turn has started and every turn they start has ended", () => {
  const first = turnRows(1);
  const lateEnd = row("turn/end", { turn: 0, reason: { kind: "completed" } });
  assert.equal(turnsSettled(first), true);
  assert.equal(turnsSettled([lateEnd, ...first]), true);
  assert.equal(turnsSettled([...first, row("turn/start", { turn: 2 })]), false, "a turn still under way");
  assert.equal(turnsSettled([lateEnd, row("step/end", { turn: 0, step: 1 })]), false, "an earlier turn's late end is not a turn");
  assert.equal(turnsSettled([]), false);
});

test("a plain log: history is skipped, each turn's rows are handed out once, a half-written line waits", async () => {
  const root = sessionsRoot();
  const file = logFile(root, "s2");
  fs.writeFileSync(file, lines([header("s2"), ...turnRows(1)]));

  const tail = new SessionLogTail({ sessionsRoot: root, sessionId: "s2" });
  assert.equal(tail.skipExisting(), null);

  const second = turnRows(2);
  const third = turnRows(3);
  const partial = JSON.stringify(third[0]);
  fs.appendFileSync(file, lines(second) + partial.slice(0, 10));

  const taken = await tail.takeTurn({ waits: [0] });
  assert.equal(taken.settled, true);
  assert.deepEqual(taken.rows, second);
  assert.deepEqual(taken.lateTurns, []);
  assert.equal(taken.logPath, file);

  fs.appendFileSync(file, `${partial.slice(10)}\n${lines(third.slice(1))}`);
  const next = await tail.takeTurn({ waits: [0] });
  assert.equal(next.settled, true);
  assert.deepEqual(next.rows, third);
});

test("a history longer than the tail window is skipped from its end", async () => {
  const root = sessionsRoot();
  const file = logFile(root, "s6");
  const filler = "y".repeat(500);
  const history = [header("s6")];
  for (let turn = 1; turn <= 2000; turn += 1) {
    history.push(row("turn/start", { turn }), row("user/message", { content: [{ type: "text", text: filler }] }), row("turn/end", { turn, reason: { kind: "completed" } }));
  }
  fs.writeFileSync(file, lines(history));
  assert.ok(fs.statSync(file).size > 1024 * 1024);

  const tail = new SessionLogTail({ sessionsRoot: root, sessionId: "s6" });
  assert.equal(tail.skipExisting(), null);
  const next = turnRows(2001);
  fs.appendFileSync(file, lines(next));
  const taken = await tail.takeTurn({ waits: [0] });
  assert.deepEqual(taken.rows, next);
});

test("a zstd log is read frame by frame, including a frame that finishes after the first read", async () => {
  const root = sessionsRoot();
  const file = logFile(root, "s3", "session.v4.jsonl.zstd");
  const frame = (rows) => zlib.zstdCompressSync(Buffer.from(lines(rows)), CHECKSUMMED);
  fs.writeFileSync(file, Buffer.concat([frame([header("s3")]), frame(turnRows(1))]));

  const tail = new SessionLogTail({ sessionsRoot: root, sessionId: "s3" });
  assert.equal(tail.skipExisting(), null);

  const rows = turnRows(2);
  const body = frame(rows.slice(0, -1));
  const end = frame(rows.slice(-1));
  fs.appendFileSync(file, Buffer.concat([body, end.subarray(0, 5)])); // the closing frame is still being written
  const waiting = tail.takeTurn({ waits: [0, 50, 50, 50] });
  setTimeout(() => fs.appendFileSync(file, end.subarray(5)), 60);
  const taken = await waiting;

  assert.equal(taken.settled, true);
  assert.deepEqual(taken.rows, rows);
});

test("a turn whose closing rows never come is handed out unsettled; a missing log is reported at once", async () => {
  const root = sessionsRoot();
  const file = logFile(root, "s4");
  fs.writeFileSync(file, lines([header("s4")]));
  const tail = new SessionLogTail({ sessionsRoot: root, sessionId: "s4" });
  tail.skipExisting();
  fs.appendFileSync(file, lines(turnRows(1).slice(0, -1)));
  const open = await tail.takeTurn({ waits: [0, 10] });
  assert.equal(open.settled, false);
  assert.equal(open.rows.length, turnRows(1).length - 1);

  const nowhere = new SessionLogTail({ sessionsRoot: root, sessionId: "absent" });
  assert.match(nowhere.skipExisting(), /no session log for absent/);
  const started = Date.now();
  const missing = await nowhere.takeTurn({ waits: [0, 1000, 1000] });
  assert.ok(Date.now() - started < 500, "no waiting for a log that does not exist");
  assert.deepEqual(missing.rows, []);
  assert.match(missing.error, /no session log/);
});

test("a turn whose end lands after its record does not shift the records that follow", async () => {
  const root = sessionsRoot();
  const file = logFile(root, "s7");
  fs.writeFileSync(file, lines([header("s7")]));
  const tail = new SessionLogTail({ sessionsRoot: root, sessionId: "s7" });
  tail.skipExisting();

  // Turn 1 ends after its record gave up waiting.
  const one = turnRows(1);
  fs.appendFileSync(file, lines(one.slice(0, -1)));
  const first = turnUsageFields(await tail.takeTurn({ waits: [0] }));
  assert.equal(first.usageSource, "session-log-partial");

  // Turn 1's end arrives with turn 2's opening rows; turn 2 ends a moment later.
  const two = turnRows(2, { usage: { inputTokens: 222, outputTokens: 22 } });
  fs.appendFileSync(file, lines([one.at(-1), ...two.slice(0, -1)]));
  const waiting = tail.takeTurn({ waits: [0, 50, 50, 50] });
  setTimeout(() => fs.appendFileSync(file, lines(two.slice(-1))), 60);
  const second = turnUsageFields(await waiting);
  assert.deepEqual(second.dshTurns, [1, 2]);
  assert.equal(second.usage.inputTokens, 222, "turn 2's own tokens, none of turn 1's");
  assert.equal(second.usageSource, "session-log-partial", "a record carrying another turn's late rows is not fully trusted");
  assert.match(second.usageNote, /late rows of dsh turn 1/);

  // And the record after that is whole again.
  const three = turnRows(3, { usage: { inputTokens: 333, outputTokens: 33 } });
  fs.appendFileSync(file, lines(three));
  const third = turnUsageFields(await tail.takeTurn({ waits: [0] }));
  assert.deepEqual(third.dshTurns, [3]);
  assert.equal(third.usage.inputTokens, 333);
  assert.equal(third.usageSource, "session-log");
});

test("a zstd log on a Node without a zstd decoder says so instead of waiting", async () => {
  const root = sessionsRoot();
  fs.writeFileSync(logFile(root, "s5", "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(lines([header("s5")]))));
  const tail = new SessionLogTail({ sessionsRoot: root, sessionId: "s5", decompress: null });
  tail.skipExisting();
  fs.appendFileSync(logFile(root, "s5", "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(lines(turnRows(1)))));
  const started = Date.now();
  const taken = await tail.takeTurn({ waits: [0, 1000] });
  assert.ok(Date.now() - started < 500);
  assert.match(turnUsageFields(taken).usageNote, /cannot read zstd/);
});

test("the fold adds up every billed call, by model, and counts tool failures by tool", () => {
  const retried = row("assistant/attempt", {
    turn: 7,
    step: 1,
    stream: [{ type: "chunk", time: 1, chunk: { type: "usage", usage: { inputTokens: 50, outputTokens: 5 } } }],
  });
  const viaStream = row("assistant/message", {
    turn: 7,
    step: 2,
    message: { role: "assistant", content: [], source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" } },
    stream: [{ type: "chunk", time: 2, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 15 } } }],
  });
  const interrupted = row("assistant/message", { turn: 7, step: 3, message: { role: "assistant", content: [], source: {} }, stream: [], interrupted: true });
  const rows = [
    ...turnRows(7, { failTool: true }).slice(0, -1),
    retried,
    viaStream,
    interrupted,
    row("tool/call", { turn: 7, step: 3, callId: "__proto__", name: "__proto__", arguments: "{}" }),
    row("tool/result", { turn: 7, step: 3, message: { toolCallId: "__proto__", isError: true }, error: { name: "E", code: "E" } }),
    row("turn/end", { turn: 7, reason: { kind: "max-tokens" } }),
  ];

  const summary = summarizeTurnRows(rows);
  assert.deepEqual(summary.dshTurns, [7]);
  assert.deepEqual(summary.endReasons, ["max-tokens"]);
  assert.equal(summary.steps, 1);
  assert.equal(summary.llmCalls, 4);
  assert.equal(summary.llmCallsWithoutUsage, 1);
  assert.deepEqual(summary.usage, {
    calls: 3,
    inputTokens: 160,
    cacheReadTokens: 930,
    cacheWriteTokens: 0,
    outputTokens: 35,
    reasoningTokens: 15,
    totalTokens: 1125,
  });
  // The retried attempt has no message source: it is charged to the route requested.
  assert.deepEqual(Object.keys(summary.byModel).sort(), ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]);
  assert.equal(summary.byModel["deepseek/deepseek-v4-flash"].calls, 2);
  assert.equal(summary.byModel["deepseek/deepseek-v4-pro"].outputTokens, 20);
  assert.equal(summary.contextWindow, 1_000_000);
  assert.equal(summary.tools.calls, 2);
  assert.equal(summary.tools.errors, 2);
  assert.deepEqual({ ...summary.tools.byName.bash }, { calls: 1, errors: 1 });
  assert.deepEqual({ ...summary.tools.byName.__proto__ }, { calls: 1, errors: 1 });
  assert.equal({}.calls, undefined, "a hostile tool name touches no prototype");
});

test("turn fields say how far to trust the numbers", () => {
  const settled = turnUsageFields({ rows: turnRows(1), settled: true, error: null });
  assert.equal(settled.usageSource, "session-log");
  assert.equal(settled.usageNote, null);
  assert.equal(settled.usage.inputTokens, 100);

  const unsettled = turnUsageFields({ rows: turnRows(2).slice(0, -1), settled: false, error: null });
  assert.equal(unsettled.usageSource, "session-log-partial");
  assert.match(unsettled.usageNote, /had not ended .* counts toward the next record/);

  const noUsage = turnUsageFields({ rows: turnRows(3, { usage: null }), settled: true, error: null });
  assert.equal(noUsage.usageSource, "session-log-partial");
  assert.match(noUsage.usageNote, /1 model call\(s\) reported no usage/);

  const none = turnUsageFields({ rows: [], settled: false, error: "no session log for x under /y" });
  assert.deepEqual(none, { usageSource: "unavailable", usageNote: "no session log for x under /y", usage: null, lateDshTurns: [] });
});
