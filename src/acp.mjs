// SPDX-License-Identifier: Apache-2.0
// Minimal ACP (Agent Client Protocol) v1 client over stdio.
//
// Deliberately dependency-free (node builtins only), mirroring OpenRig's
// pi-runner discipline: "only node builtins + the protocol module are imported
// so the compiled entry stays runnable as a plain `node <entry>` with no daemon
// deps" (packages/daemon/src/adapters/pi-runner.ts:15-18).
//
// The surface used here is exactly what DeepSeek Harness's `acp` profile
// advertises (verified live against dsh 0.2.0-rc.2):
//   initialize, session/new, session/resume, session/prompt, session/cancel,
//   session/close, session/set_config_option
// plus the server->client request `session/request_permission` and the
// `session/update` notification.
//
// stdout carries protocol frames only; anything non-JSON there is a protocol
// violation and is surfaced rather than silently swallowed.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

/** ACP v1. `PROTOCOL_VERSION` in @agentclientprotocol/sdk/dist/schema/index.js:51. */
export const ACP_PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(message, { code = null, data = null, method = null } = {}) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

/**
 * Events emitted:
 *   "notification" {method, params}          server -> client notification
 *   "request"      {method, params, respond} server -> client request
 *   "stderr"       {line}                    a line of the child's stderr
 *   "stdout"       {line}                    a non-JSON line on the child's stdout
 *   "exit"         {code, signal}            child process exited
 */
export class AcpClient extends EventEmitter {
  #child = null;
  #pending = new Map();
  #seq = 0;
  #closing = false;
  #requestTimeoutMs;
  #options;

  constructor({ command = "dsh", args = [], cwd, env, requestTimeoutMs = 0 } = {}) {
    super();
    this.#options = { command, args, cwd, env };
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get alive() {
    return this.#child !== null && this.#child.exitCode === null && !this.#closing;
  }

  start() {
    if (this.#child) throw new Error("AcpClient already started");
    const { command, args, cwd, env } = this.#options;
    this.#child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    this.#child.on("error", (err) => {
      this.#failAll(new AcpError(`failed to spawn ${command}: ${err.message}`));
    });
    this.#child.on("exit", (code, signal) => {
      this.#closing = true;
      this.#failAll(new AcpError(`agent exited (code=${code} signal=${signal})`));
      this.emit("exit", { code, signal });
    });

    readline.createInterface({ input: this.#child.stderr }).on("line", (line) => {
      this.emit("stderr", { line });
    });
    readline.createInterface({ input: this.#child.stdout }).on("line", (line) => {
      this.#onStdoutLine(line);
    });
    return this;
  }

  #onStdoutLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // ACP reserves stdout for protocol frames. Surface the violation.
      this.emit("stdout", { line });
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.#pending.get(msg.id);
      if (!entry) {
        this.emit("stdout", { line: `response for unknown id ${JSON.stringify(msg.id)}` });
        return;
      }
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new AcpError(msg.error.message ?? "ACP error", {
            code: msg.error.code ?? null,
            data: msg.error.data ?? null,
            method: entry.method,
          }),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.method && msg.id !== undefined) {
      // Server -> client request. Default to an error response so an
      // unhandled request can never wedge the agent.
      let answered = false;
      const respond = (result) => {
        if (answered) return;
        answered = true;
        this.#write({ jsonrpc: "2.0", id: msg.id, result });
      };
      respond.error = (code, message, data) => {
        if (answered) return;
        answered = true;
        this.#write({ jsonrpc: "2.0", id: msg.id, error: { code, message, ...(data ? { data } : {}) } });
      };
      this.emit("request", { method: msg.method, params: msg.params ?? {}, respond });
      return;
    }

    if (msg.method) {
      this.emit("notification", { method: msg.method, params: msg.params ?? {} });
      return;
    }

    this.emit("stdout", { line });
  }

  /** Send a client -> server request and await its result. */
  request(method, params, { timeoutMs = this.#requestTimeoutMs } = {}) {
    if (!this.#child || this.#child.exitCode !== null) {
      return Promise.reject(new AcpError(`${method}: agent is not running`, { method }));
    }
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new AcpError(`${method}: timed out after ${timeoutMs}ms`, { method }));
            }, timeoutMs)
          : null;
      this.#pending.set(id, { resolve, reject, method, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a client -> server notification (no response expected). */
  notification(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(msg) {
    if (!this.#child || this.#child.exitCode !== null) {
      throw new AcpError("cannot write: agent is not running");
    }
    this.#child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #failAll(err) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
  }

  // ── Convenience wrappers ──────────────────────────────────────────────────

  initialize({ clientInfo = { name: "dsh-seat", version: "0.1.0" }, clientCapabilities = {} } = {}) {
    return this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo,
    });
  }

  newSession({ cwd, mcpServers = [] }) {
    return this.request("session/new", { cwd, mcpServers });
  }

  resumeSession({ sessionId, cwd, mcpServers = [] }) {
    return this.request("session/resume", { sessionId, cwd, mcpServers });
  }

  prompt({ sessionId, text }) {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  /** Cancellation is a notification in ACP v1 (no response). */
  cancel({ sessionId }) {
    this.notification("session/cancel", { sessionId });
  }

  closeSession({ sessionId }) {
    return this.request("session/close", { sessionId });
  }

  setConfigOption({ sessionId, configId, value }) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  /** Ask the child to exit, then make sure it does. */
  async dispose({ graceMs = 3000 } = {}) {
    if (!this.#child) return;
    if (this.#child.exitCode !== null) return;
    this.#closing = true;
    const exited = new Promise((resolve) => this.#child.once("exit", resolve));
    try {
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        this.#child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
    await exited;
    clearTimeout(timer);
  }
}
