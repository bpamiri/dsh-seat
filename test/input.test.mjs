// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { InputFramer, attachPaneInput, BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF } from "../src/input.mjs";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A framer that records everything it reports. */
function framer(options = {}) {
  const events = { submitted: [], cleared: 0, interrupts: 0, rejected: [], echoed: "" };
  const f = new InputFramer({
    onSubmit: (text) => events.submitted.push(text),
    onClear: () => (events.cleared += 1),
    onInterrupt: () => (events.interrupts += 1),
    onReject: (max) => events.rejected.push(max),
    echo: (text) => (events.echoed += text),
    ...options,
  });
  return { f, events };
}

// What OpenRig's `rig send` produces with bracketed paste on: an enveloped,
// multi-line message, pasted in one piece, then Enter
// (packages/daemon/src/adapters/tmux.ts:610-626, lib/pane-envelope.ts:95-109).
const ENVELOPE = "From: orch-lead@rig\nTo: dev1-dsh@rig\nSent: 2026-10-18T12:00:00Z\n\nImplement X.\nThen run the tests.";

test("an enveloped multi-line paste followed by Enter is one message", () => {
  const { f, events } = framer();
  f.feed(`${PASTE_START}${ENVELOPE}${PASTE_END}\r`);
  assert.deepEqual(events.submitted, [ENVELOPE]);
});

test("paste markers split across chunks still frame one message", () => {
  const { f, events } = framer();
  for (const ch of `${PASTE_START}line one\nline two${PASTE_END}\r`) f.feed(ch);
  assert.deepEqual(events.submitted, ["line one\nline two"]);
});

test("Enter submits typed text; CR, LF and CRLF each submit once", () => {
  const { f, events } = framer();
  f.feed("first\r");
  f.feed("second\n");
  f.feed("third\r\n");
  f.feed("fourth\r");
  f.feed("\nfifth\n");
  assert.deepEqual(events.submitted, ["first", "second", "third", "fourth", "fifth"]);
});

test("line endings inside a paste become LF, and trailing newlines are trimmed", () => {
  const { f, events } = framer();
  f.feed(`${PASTE_START}a\r\nb\rc\n\n${PASTE_END}\r`);
  assert.deepEqual(events.submitted, ["a\nb\nc"]);
});

test("typed text and a paste combine into the message Enter submits", () => {
  const { f, events } = framer();
  f.feed(`see: ${PASTE_START}two\nlines${PASTE_END} please\r`);
  assert.deepEqual(events.submitted, ["see: two\nlines please"]);
});

test("a paste with no Enter is still pending, not submitted", () => {
  const { f, events } = framer();
  f.feed(`${PASTE_START}staged text${PASTE_END}`);
  assert.deepEqual(events.submitted, []);
  assert.equal(f.pending, "staged text");
});

test("a lookalike of the paste end inside a paste stays content", () => {
  const { f, events } = framer();
  f.feed(`${PASTE_START}x\x1b[20y${PASTE_END}\r`);
  assert.deepEqual(events.submitted, ["x\x1b[20y"]);
});

test("backspace edits typed text, including a whole surrogate pair", () => {
  const { f, events } = framer();
  f.feed("helo\x7flo 😀\x7f!\r");
  assert.deepEqual(events.submitted, ["hello !"]);
});

test("Ctrl-C clears a half-composed message, and interrupts when there is none", () => {
  const { f, events } = framer();
  f.feed("never mind\x03");
  assert.equal(events.cleared, 1);
  assert.equal(events.interrupts, 0);
  assert.equal(f.pending, "");

  f.feed("\x03");
  assert.equal(events.interrupts, 1);
  assert.deepEqual(events.submitted, []);
});

test("arrow keys, function keys and other control characters are ignored", () => {
  const { f, events } = framer();
  f.feed("a\x1b[Ab\x1bOPc\x1b[1;5Dd\x04\x0ce\r");
  assert.deepEqual(events.submitted, ["abcde"]);
});

test("Alt+key drops the ESC and keeps the key", () => {
  const { f, events } = framer();
  f.feed("\x1bx\r");
  assert.deepEqual(events.submitted, ["x"]);
});

test("blank submissions are ignored", () => {
  const { f, events } = framer();
  f.feed("\r\r   \r");
  f.feed(`${PASTE_START}\n\n${PASTE_END}\r`);
  assert.deepEqual(events.submitted, []);
});

test("an oversize message is refused whole at Enter, and the next one works", () => {
  const { f, events } = framer({ maxBytes: 8 });
  f.feed(`${PASTE_START}0123456789${PASTE_END}\r`);
  assert.deepEqual(events.submitted, []);
  assert.deepEqual(events.rejected, [8]);

  f.feed("ok\r");
  assert.deepEqual(events.submitted, ["ok"]);
});

test("the byte limit counts UTF-8 bytes, not characters", () => {
  const { f, events } = framer({ maxBytes: 4 });
  f.feed("éé\r"); // 4 bytes: fits
  f.feed("ééé\r"); // 6 bytes: refused
  assert.deepEqual(events.submitted, ["éé"]);
  assert.deepEqual(events.rejected, [4]);
});

test("end() submits an unterminated last message", () => {
  const { f, events } = framer();
  f.feed("last words");
  f.end();
  assert.deepEqual(events.submitted, ["last words"]);
});

test("input is echoed, and Enter echoes the newline", () => {
  const { f, events } = framer();
  f.feed("ab\x7fc");
  f.feed(`${PASTE_START}x\ny${PASTE_END}\r`);
  assert.equal(events.echoed, "ab\b \bcx\ny\n");
});

test("a pipe is read as-is: no raw mode, no echo, one message per line", async () => {
  const input = new PassThrough();
  const output = { written: "", write(text) { this.written += text; } };
  const submitted = [];
  let closed = false;
  const pane = attachPaneInput({ input, output, onSubmit: (text) => submitted.push(text), onClose: () => (closed = true) });
  assert.equal(pane.tty, false);

  input.write("one\ntwo\n");
  input.end("three");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(submitted, ["one", "two", "three"]);
  assert.equal(closed, true);
  assert.equal(output.written, "");
  pane.detach();
});

test("a TTY is put in raw mode with bracketed paste on, and restored on detach", () => {
  const input = new PassThrough();
  input.isTTY = true;
  const modes = [];
  input.setRawMode = (on) => modes.push(on);
  const output = { written: "", write(text) { this.written += text; } };
  const submitted = [];

  const pane = attachPaneInput({ input, output, onSubmit: (text) => submitted.push(text) });
  assert.equal(pane.tty, true);
  assert.deepEqual(modes, [true]);
  assert.ok(output.written.startsWith(BRACKETED_PASTE_ON));

  input.emit("data", `${PASTE_START}a\nb${PASTE_END}\r`);
  assert.deepEqual(submitted, ["a\nb"]);
  assert.ok(output.written.includes("a\nb\n"), "the paste and Enter are echoed into the pane");

  pane.detach();
  assert.deepEqual(modes, [true, false]);
  assert.ok(output.written.endsWith(BRACKETED_PASTE_OFF));
});
