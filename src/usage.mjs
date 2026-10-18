// SPDX-License-Identifier: Apache-2.0
// Per-turn usage, read from the dsh session log.
//
// ACP tells the seat almost nothing about cost: `usage_update` carries how full
// the context window is ({used, size}) and nothing per request. dsh logs every
// model call it makes, with the provider's token counts, in the session's
// append-only log ("model-visible means logged"). So after each turn the runner
// reads the rows the turn appended and folds them into one record.
//
// Layout and row shapes, per dsh at 687f282e
// (packages/session/session-persistence-jsonl/README.md and src/format.ts,
// packages/session/session-format-v1-to-v2/src/codec.ts):
//   <root>/--<project>--/<escaped session id>/session.v<N>.jsonl[.zstd]
//   The root defaults to $DSH_HOME/sessions (packages/bundle/base/cordis.patch.yml)
//   and the ACP session id is the dsh session id (packages/acp/acp/src/index.ts).
//   The first row is the header {type: "session", version, id, ...}; then one row
//   per event, {type, seq, time, data, ...}. The zstd encoding is one frame per
//   append batch, and Node's zstd decoder stops at the end of the first frame,
//   so frames are split here and decoded one at a time.
//
//   assistant/message  data.usage {inputTokens (uncached only), cacheReadTokens,
//                      cacheWriteTokens, outputTokens, reasoningTokens (part of
//                      output), totalTokens}; data.message.source {provider,
//                      model}; a usage chunk in data.stream is the fallback
//   assistant/attempt  an attempt that was retried; its stream's usage is billed too
//   request/context    {provider, model, contextWindow}, ahead of each request
//   tool/call          {callId, name}
//   tool/result        {message: {toolCallId, isError}, error?}
//   turn/start {turn}, turn/end {turn, reason: {kind}}, step/end {turn, step}
//   (TokenUsage: packages/llm/llm/src/types.ts; events: packages/core/session/src/types.ts)
//
// dsh writes the log in batches, holding events up to 200ms
// (LIVE_WRITE_BATCH_MAX_DELAY_MS, session-persistence-jsonl/src/storage.ts), and
// answers the ACP prompt without waiting for the last batch, so a turn's closing
// rows can land just after the answer. The tail waits briefly until a turn has
// started and every turn it has seen has closed. A turn that ends later still is
// handed out unfinished; its late rows go with the next record, which says so.
//
// Counted: the session's own model calls. Subagents log to child sessions of
// their own and are not counted here.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const TURN_RECORD_SCHEMA = "dsh-seat/turn/v1";

/** Delays between reads while a turn's closing rows are still on their way (ms). */
export const TAKE_WAITS_MS = [0, 100, 250, 500, 1000];

const LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;
const ZSTD_MAGIC = 0xfd2fb528;

// A held timer: the wait is short, and the record it waits for should be written before exit.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * dsh's escape for a session id as one path segment: letters, digits, `.`,
 * `_` and `-` stay; every other UTF-16 unit becomes ~XXXX.
 */
export function sessionDirName(sessionId) {
  const raw = String(sessionId);
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    out += /^[A-Za-z0-9._-]$/.test(raw[i]) ? raw[i] : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * The newest generation of a session's log under any project directory.
 * @returns {{path: string, version: number, compressed: boolean} | null}
 */
export function findSessionLog({ sessionsRoot, sessionId }) {
  const dirName = sessionDirName(sessionId);
  let projects;
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(sessionsRoot, project.name, dirName);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = LOG_NAME.exec(name);
      if (!match) continue;
      const version = match[1] ? Number(match[1]) : 0;
      if (!best || version > best.version) best = { path: path.join(dir, name), version, compressed: Boolean(match[2]) };
    }
  }
  return best;
}

/**
 * Split a buffer into complete zstd frames by walking their headers (RFC 8878
 * §3.1). A frame still being written is left out; `consumed` is where it starts.
 * Skippable frames are stepped over.
 * @returns {{spans: {start: number, end: number}[], consumed: number}}
 */
export function zstdFrames(buffer) {
  const spans = [];
  let pos = 0;
  while (pos + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(pos);
    if (magic >>> 4 === 0x184d2a5) {
      if (pos + 8 > buffer.length) break;
      const end = pos + 8 + buffer.readUInt32LE(pos + 4);
      if (end > buffer.length) break;
      pos = end;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`no zstd frame at byte ${pos}`);
    if (pos + 5 > buffer.length) break;
    const descriptor = buffer[pos + 4];
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    let p = pos + 5;
    p += singleSegment ? 0 : 1; // window descriptor
    p += [0, 1, 2, 4][descriptor & 3]; // dictionary id
    p += contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag];
    let last = false;
    while (!last && p + 3 <= buffer.length) {
      const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
      last = (header & 1) === 1;
      const type = (header >> 1) & 3;
      if (type === 3) throw new Error(`reserved zstd block type at byte ${p}`);
      p += 3 + (type === 1 ? 1 : header >>> 3); // an RLE block stores one byte
    }
    if (!last) break;
    if (checksum) p += 4;
    if (p > buffer.length) break;
    spans.push({ start: pos, end: p });
    pos = p;
  }
  return { spans, consumed: pos };
}

function readRange(file, start, end) {
  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(file, "r");
  try {
    let done = 0;
    while (done < buffer.length) {
      const read = fs.readSync(fd, buffer, done, buffer.length - done, start + done);
      if (read === 0) break;
      done += read;
    }
    return buffer.subarray(0, done);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether rows hold a whole turn: one has started, and every turn they start
 * has ended. The end of an earlier turn alone does not count — that is the late
 * tail of a turn already handed out, not the turn being waited for.
 */
export function turnsSettled(rows) {
  const open = new Set();
  let started = false;
  for (const row of rows) {
    if (row?.type === "turn/start") {
      open.add(row.data?.turn);
      started = true;
    } else if (row?.type === "turn/end") open.delete(row.data?.turn);
  }
  return started && open.size === 0;
}

/** Follows one session's log and hands out the rows each turn appended. */
export class SessionLogTail {
  #root;
  #sessionId;
  #decompress;
  #log = null; // {path, compressed}
  #offset = 0; // bytes of the log already turned into rows
  #carry = ""; // decoded text after the last complete line
  #rows = []; // rows read and not yet handed out
  #unfinished = new Set(); // dsh turns handed out before they ended
  #everFound = false;

  constructor({ sessionsRoot, sessionId, decompress = zlib.zstdDecompressSync }) {
    this.#root = sessionsRoot;
    this.#sessionId = sessionId;
    this.#decompress = decompress;
  }

  get logPath() {
    return this.#log?.path ?? null;
  }

  /**
   * Start after what is logged already: a resumed session's history is not this
   * launch's work. Rows are skipped without being parsed.
   * @returns {string|null} why there is nothing to follow yet
   */
  skipExisting() {
    this.#rows = [];
    return this.#read({ skip: true }).error;
  }

  /**
   * Everything the log gained since the last take, once it holds a whole turn
   * (see turnsSettled), waiting between reads (`waits`, ms). After the last wait
   * the rows are handed out as they are, unsettled. Never throws.
   * @returns {Promise<{rows: object[], settled: boolean, lateTurns: number[], error: string|null,
   *   logPath: string|null}>} lateTurns: dsh turns an earlier take handed out before they ended
   */
  async takeTurn({ waits = TAKE_WAITS_MS } = {}) {
    let error = null;
    let settled = false;
    for (const delay of waits) {
      if (delay) await sleep(delay);
      const read = this.#read();
      error = read.error;
      settled = turnsSettled(this.#rows);
      if (settled || read.final) break; // waiting would not change the answer
    }
    const rows = this.#rows.splice(0);
    const lateTurns = [];
    for (const row of rows) {
      const turn = row?.data?.turn;
      if (this.#unfinished.has(turn) && !lateTurns.includes(turn)) lateTurns.push(turn);
    }
    for (const row of rows) {
      if (row?.type === "turn/start") this.#unfinished.add(row.data?.turn);
      else if (row?.type === "turn/end") this.#unfinished.delete(row.data?.turn);
    }
    return { rows, settled, lateTurns, error: settled ? null : error, logPath: this.logPath };
  }

  /** @returns {{error: string|null, final: boolean}} final: a later read would not do better */
  #read({ skip = false } = {}) {
    try {
      const error = this.#readOrThrow(skip);
      return { error, final: error !== null };
    } catch (err) {
      return { error: `session log unreadable: ${err.message}`, final: true };
    }
  }

  /** Read whatever the log gained; a string says why nothing could be read. */
  #readOrThrow(skip) {
    if (!this.#log) {
      const found = findSessionLog({ sessionsRoot: this.#root, sessionId: this.#sessionId });
      if (!found) return `no session log for ${this.#sessionId} under ${this.#root}`;
      // A log that went away and came back has history this launch already saw.
      if (this.#everFound) skip = true;
      this.#log = found;
      this.#everFound = true;
      this.#offset = 0;
      this.#carry = "";
    }

    let size;
    try {
      size = fs.statSync(this.#log.path).size;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.#log = null;
      return "the session log went away";
    }
    if (size < this.#offset) {
      // Rewritten under us (dsh repairs a torn tail only when it reopens a log).
      this.#offset = size;
      this.#carry = "";
      return "the session log was rewritten; skipped to its end";
    }
    if (size === this.#offset) return null;
    if (skip && !this.#log.compressed) {
      // Only the end matters: the last complete line in the final MiB. Landing
      // inside a line still being written costs one unparseable line, later.
      const start = Math.max(this.#offset, size - 1024 * 1024);
      const end = readRange(this.#log.path, start, size).lastIndexOf(0x0a) + 1;
      this.#offset = end > 0 ? start + end : size;
      return null;
    }
    const buffer = readRange(this.#log.path, this.#offset, size);

    let text;
    if (this.#log.compressed) {
      if (typeof this.#decompress !== "function") {
        return "this Node cannot read zstd session logs (22.15 or later can); a seat home with compression: none avoids it";
      }
      const { spans, consumed } = zstdFrames(buffer);
      if (!skip) text = spans.map(({ start, end }) => this.#decompress(buffer.subarray(start, end)).toString("utf8")).join("");
      this.#offset += consumed;
    } else {
      const end = buffer.lastIndexOf(0x0a) + 1; // a line still being written waits
      if (!skip) text = buffer.subarray(0, end).toString("utf8");
      this.#offset += end;
    }
    if (skip) return null;

    const lines = (this.#carry + text).split("\n");
    this.#carry = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row && typeof row === "object" && row.type !== "session") this.#rows.push(row);
    }
    return null;
  }
}

// ── The fold ────────────────────────────────────────────────────────────────

const TOKEN_FIELDS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"];

const isCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function emptyUsage() {
  return { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

/** A provider usage report the fold can trust, or null. */
function readUsage(usage) {
  if (!usage || typeof usage !== "object" || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return null;
  return TOKEN_FIELDS.every((field) => usage[field] === undefined || isCount(usage[field])) ? usage : null;
}

/** The last usage chunk in an assistant stream record list. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    if (stream[i]?.type === "chunk" && stream[i].chunk?.type === "usage") return stream[i].chunk.usage;
  }
  return null;
}

function addUsage(into, usage) {
  into.calls += 1;
  for (const field of TOKEN_FIELDS) into[field] += usage[field] ?? 0;
  // The buckets are disjoint, and reasoning is part of output.
  into.totalTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
}

/**
 * Fold a turn's session-log rows into token usage, model calls and tool calls.
 * Token buckets a provider did not report count as 0.
 */
export function summarizeTurnRows(rows) {
  const dshTurns = [];
  const endReasons = [];
  const usage = emptyUsage();
  // Keys come from the provider and the model; no prototype to collide with.
  const byModel = Object.create(null);
  const tools = { calls: 0, errors: 0, byName: Object.create(null) };
  const toolNames = new Map();
  let steps = 0;
  let callsWithoutUsage = 0;
  let route = null;
  let contextWindow = null;

  const noteTurn = (turn) => {
    if (Number.isInteger(turn) && !dshTurns.includes(turn)) dshTurns.push(turn);
  };
  const tool = (name) => (tools.byName[name] ??= { calls: 0, errors: 0 });

  for (const row of rows) {
    const data = row?.data ?? {};
    switch (row?.type) {
      case "turn/start":
        noteTurn(data.turn);
        break;
      case "turn/end":
        noteTurn(data.turn);
        endReasons.push(typeof data.reason?.kind === "string" ? data.reason.kind : "unknown");
        break;
      case "step/end":
        steps += 1;
        break;
      case "request/context":
        if (typeof data.provider === "string" && typeof data.model === "string") route = `${data.provider}/${data.model}`;
        if (isCount(data.contextWindow)) contextWindow = data.contextWindow;
        break;
      case "assistant/message":
      case "assistant/attempt": {
        const source = data.message?.source;
        const model =
          typeof source?.provider === "string" && typeof source?.model === "string" && source.model
            ? `${source.provider}/${source.model}`
            : route ?? "unknown";
        const reported = readUsage(data.usage) ?? readUsage(streamUsage(data.stream));
        if (!reported) {
          callsWithoutUsage += 1;
          break;
        }
        addUsage(usage, reported);
        addUsage((byModel[model] ??= emptyUsage()), reported);
        break;
      }
      case "tool/call": {
        const name = typeof data.name === "string" ? data.name : "unknown";
        toolNames.set(data.callId, name);
        tools.calls += 1;
        tool(name).calls += 1;
        break;
      }
      case "tool/result": {
        if (!data.error && data.message?.isError !== true) break;
        tools.errors += 1;
        tool(toolNames.get(data.message?.toolCallId ?? data.message?.source?.callId) ?? "unknown").errors += 1;
        break;
      }
      default:
        break;
    }
  }

  return {
    dshTurns,
    endReasons,
    steps,
    llmCalls: usage.calls + callsWithoutUsage,
    llmCallsWithoutUsage: callsWithoutUsage,
    usage,
    byModel,
    contextWindow,
    tools,
  };
}

/**
 * The usage half of a turn record, from what the tail handed out. `usageSource`
 * says how far to trust it: "session-log" (a whole turn, every model call
 * reporting usage, nothing of another turn's), "session-log-partial" (the note
 * says why), or "unavailable" (`usage` is null). Late rows of an earlier turn
 * are counted here rather than lost, so totals across records stay whole.
 */
export function turnUsageFields({ rows, settled, error, lateTurns = [] }) {
  if (rows.length === 0 && error) return { usageSource: "unavailable", usageNote: error, usage: null, lateDshTurns: [] };
  const summary = summarizeTurnRows(rows);
  const notes = [];
  if (!settled) notes.push(error ?? "the turn had not ended in the session log; what it logs later counts toward the next record");
  if (lateTurns.length) notes.push(`includes the late rows of dsh turn ${lateTurns.join(", ")}, which an earlier record took before it ended`);
  if (summary.llmCallsWithoutUsage) notes.push(`${summary.llmCallsWithoutUsage} model call(s) reported no usage`);
  return {
    usageSource: notes.length ? "session-log-partial" : "session-log",
    usageNote: notes.length ? notes.join("; ") : null,
    lateDshTurns: lateTurns,
    ...summary,
  };
}
