// SPDX-License-Identifier: Apache-2.0
// Pane input framing: one prompt per submitted message, with pastes kept whole.
//
// Why this exists: OpenRig delivers `rig send` by pasting, not typing —
// `tmux load-buffer` then `tmux paste-buffer -d -r -p`, then a separate Enter
// (packages/daemon/src/adapters/tmux.ts:610-626). `-r` keeps raw LFs, and `-p`
// brackets the paste whenever the pane has asked for bracketed paste. The
// message is multi-line by construction: the pane envelope puts `From:`/`To:`/
// `Sent:` header lines above the body (packages/daemon/src/lib/pane-envelope.ts:95-109).
// Reading stdin line by line in cooked mode splits that one message into one
// prompt per line, so the agent answers the `From:` header on a turn of its own
// and can act on half an instruction. The runner therefore reads raw input,
// turns bracketed paste on, and submits only on Enter: a paste of any size is
// one prompt.
//
// InputFramer is a pure state machine (feed text in, get callbacks out) so it is
// testable without a terminal; attachPaneInput() wires it to a real pane.

/** Largest message accepted from the pane, in UTF-8 bytes. */
export const MAX_INPUT_BYTES = 1024 * 1024;

/** DECSET 2004: ask the terminal (here, tmux) to frame pastes. */
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_ESCAPE_LENGTH = 32;

/** UTF-8 length of one code point, without allocating a Buffer per character. */
function codePointBytes(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * Turns pane keystrokes and pastes into submitted messages.
 *
 * - Enter (CR, LF or CRLF) submits whatever has been composed.
 * - Everything between the bracketed-paste markers is message content, newlines
 *   included; CRLF and lone CR inside a paste become LF.
 * - Backspace edits; Ctrl-C clears a half-composed message, or — with nothing
 *   composed — asks the owner to interrupt. Other control keys and escape
 *   sequences (arrows, function keys, focus reports) are ignored. A control
 *   key also ends an unfinished escape sequence, so Enter and Ctrl-C are never
 *   swallowed by one.
 * - A message larger than `maxBytes` is refused whole at Enter, never truncated.
 * - onSubmit(text, {pasted}) says whether any of the message was pasted, so the
 *   owner can tell a typed command from delivered text.
 */
export class InputFramer {
  #onSubmit;
  #onClear;
  #onInterrupt;
  #onReject;
  #echo;
  #maxBytes;

  #text = "";
  #bytes = 0;
  #oversize = false;
  #escape = null;
  #inPaste = false;
  #pasted = false;
  #pasteEnd = "";
  #pasteCR = false;
  #afterCR = false;
  #pendingEcho = "";

  constructor({
    onSubmit,
    onClear = () => {},
    onInterrupt = () => {},
    onReject = () => {},
    echo = null,
    maxBytes = MAX_INPUT_BYTES,
  } = {}) {
    if (typeof onSubmit !== "function") throw new TypeError("InputFramer needs an onSubmit callback");
    this.#onSubmit = onSubmit;
    this.#onClear = onClear;
    this.#onInterrupt = onInterrupt;
    this.#onReject = onReject;
    this.#echo = echo;
    this.#maxBytes = maxBytes;
  }

  /** The message composed so far (not yet submitted). */
  get pending() {
    return this.#text;
  }

  feed(chunk) {
    for (const ch of String(chunk)) {
      if (this.#inPaste) this.#pasteChar(ch);
      else if (this.#escape !== null) this.#escapeChar(ch);
      else this.#keyChar(ch);
    }
    this.#flushEcho();
  }

  /** Input ended (pipe EOF, dead pane): an unterminated last message still counts. */
  end() {
    if (this.#pasteEnd) this.#pasteText(this.#pasteEnd);
    this.#pasteEnd = "";
    this.#inPaste = false;
    this.#escape = null;
    if (this.#text || this.#oversize) this.#submit();
    this.#flushEcho();
  }

  #keyChar(ch) {
    const afterCR = this.#afterCR;
    this.#afterCR = false;
    switch (ch) {
      case "\x1b":
        this.#escape = ch;
        return;
      case "\r":
        this.#afterCR = true;
        this.#submit();
        return;
      case "\n":
        if (!afterCR) this.#submit();
        return;
      case "\x7f":
      case "\b":
        this.#backspace();
        return;
      case "\x03":
        this.#ctrlC();
        return;
      case "\t":
        this.#append(ch);
        return;
      default:
        // Ctrl-D, Ctrl-L and the other C0 controls mean nothing to a seat.
        if (ch < " ") return;
        this.#append(ch);
    }
  }

  #escapeChar(ch) {
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      // A control key ends the unfinished sequence, then acts: Enter submits,
      // Ctrl-C clears or interrupts, ESC starts a new sequence.
      const unfinished = this.#escape;
      this.#escape = null;
      if (unfinished === "\x1bO") this.#keyChar("O"); // that was Alt+O
      this.#keyChar(ch);
      return;
    }
    this.#escape += ch;
    const seq = this.#escape;
    if (seq.length === 2) {
      if (ch === "[" || ch === "O") return; // CSI or SS3: keep reading
      // A lone ESC (Escape, or Alt+key): drop the ESC, keep the key.
      this.#escape = null;
      this.#keyChar(ch);
      return;
    }
    if (seq[1] === "O") {
      this.#escape = null;
      // SS3 is ESC O plus one final byte (F1–F4, keypad keys): ignored. Any
      // other byte means the ESC O was Alt+O: keep the O and the key.
      if (code >= 0x40 && code <= 0x7e) return;
      this.#keyChar("O");
      this.#keyChar(ch);
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      // A complete CSI sequence. Only the paste start means anything here;
      // arrows, Home/End and a stray paste end are ignored.
      this.#escape = null;
      if (seq === PASTE_START) {
        this.#inPaste = true;
        this.#pasted = true;
      }
      return;
    }
    if (seq.length >= MAX_ESCAPE_LENGTH) this.#escape = null;
  }

  #pasteChar(ch) {
    // Match the paste end incrementally: it can land mid-chunk, and the marker
    // itself can be split across chunks.
    if (ch === PASTE_END[this.#pasteEnd.length]) {
      this.#pasteEnd += ch;
      if (this.#pasteEnd === PASTE_END) {
        this.#pasteEnd = "";
        this.#pasteCR = false;
        this.#inPaste = false;
      }
      return;
    }
    if (this.#pasteEnd) {
      // Not the end after all: what matched so far was content.
      const partial = this.#pasteEnd;
      this.#pasteEnd = "";
      this.#pasteText(partial);
      if (ch === PASTE_END[0]) {
        this.#pasteEnd = ch;
        return;
      }
    }
    this.#pasteText(ch);
  }

  #pasteText(text) {
    for (const ch of text) {
      if (ch === "\r") {
        this.#pasteCR = true;
        this.#append("\n");
        continue;
      }
      if (ch === "\n" && this.#pasteCR) {
        this.#pasteCR = false;
        continue;
      }
      this.#pasteCR = false;
      this.#append(ch);
    }
  }

  #append(ch) {
    if (this.#oversize) return;
    const bytes = codePointBytes(ch);
    if (this.#bytes + bytes > this.#maxBytes) {
      this.#oversize = true;
      return;
    }
    this.#text += ch;
    this.#bytes += bytes;
    this.#pendingEcho += ch;
  }

  #backspace() {
    if (!this.#text) return;
    const chars = this.#text.length;
    const last = this.#text.codePointAt(chars - 1);
    // Step back over a whole surrogate pair, never half of one.
    const width = chars >= 2 && last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
    const removed = this.#text.slice(chars - width);
    this.#text = this.#text.slice(0, chars - width);
    this.#bytes -= codePointBytes(removed);
    // A removed newline cannot be un-drawn; the composed text is still right.
    if (removed !== "\n") this.#pendingEcho += "\b \b";
  }

  #ctrlC() {
    if (this.#text || this.#oversize) {
      this.#reset();
      this.#pendingEcho += "^C\n";
      this.#flushEcho();
      this.#onClear();
      return;
    }
    this.#flushEcho();
    this.#onInterrupt();
  }

  #submit() {
    const oversize = this.#oversize;
    const pasted = this.#pasted;
    const text = this.#text.replace(/\n+$/, "");
    this.#reset();
    this.#pendingEcho += "\n";
    this.#flushEcho();
    if (oversize) {
      this.#onReject(this.#maxBytes);
      return;
    }
    if (text.trim()) this.#onSubmit(text, { pasted });
  }

  #reset() {
    this.#text = "";
    this.#bytes = 0;
    this.#oversize = false;
    this.#pasted = false;
  }

  #flushEcho() {
    if (!this.#pendingEcho) return;
    const text = this.#pendingEcho;
    this.#pendingEcho = "";
    if (this.#echo) this.#echo(text);
  }
}

/**
 * Wire an InputFramer to the pane's input.
 *
 * A TTY gets raw mode and bracketed paste: pastes arrive framed, Enter is a key
 * the runner sees, and the runner echoes input itself — which matters, because
 * OpenRig's delivery check captures the pane looking for the staged text. A pipe
 * (tests, scripted use) is read as it comes, each newline submitting; the same
 * framer, minus the terminal.
 *
 * @returns {{tty: boolean, detach: () => void}}
 */
export function attachPaneInput({
  input,
  output,
  echo = (text) => output.write(text),
  onSubmit,
  onClear,
  onInterrupt,
  onReject,
  onClose = () => {},
  maxBytes = MAX_INPUT_BYTES,
}) {
  const tty = Boolean(input.isTTY) && typeof input.setRawMode === "function";
  const framer = new InputFramer({
    onSubmit,
    onClear,
    onInterrupt,
    onReject,
    maxBytes,
    echo: tty ? echo : null,
  });

  if (tty) {
    input.setRawMode(true);
    output.write(BRACKETED_PASTE_ON);
  }
  input.setEncoding?.("utf8");

  let ended = false;
  const onData = (chunk) => framer.feed(chunk);
  const onEnd = () => {
    if (ended) return;
    ended = true;
    framer.end();
    onClose();
  };
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  // A pane that hangs up can surface as EIO; that is the end of input too.
  input.on("error", onEnd);

  return {
    tty,
    detach() {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onEnd);
      if (tty) {
        try {
          output.write(BRACKETED_PASTE_OFF);
          input.setRawMode(false);
        } catch {
          /* the pane may already be gone */
        }
      }
      input.pause?.();
    },
  };
}
