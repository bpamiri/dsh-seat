// SPDX-License-Identifier: Apache-2.0
// Shared test helpers.

import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { AcpClient } from "../src/acp.mjs";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));

/** A client factory that runs the fake ACP agent instead of dsh. */
export function fakeAgentFactory(env = {}) {
  return (opts) =>
    new AcpClient({
      command: process.execPath,
      // The runner passes ["--profile", "acp"]; the fake ignores argv.
      args: [FAKE_AGENT],
      cwd: opts.cwd,
      env: { ...opts.env, ...env },
      requestTimeoutMs: opts.requestTimeoutMs || 10_000,
    });
}

/** Records activity posts instead of hitting the daemon. */
export function recordingActivity() {
  const posts = [];
  return {
    enabled: true,
    posts,
    turnStart: (subtype = null) => posts.push({ kind: "turnStart", subtype }),
    turnEnd: (subtype = null) => posts.push({ kind: "turnEnd", subtype }),
    sessionIdentity: ({ sessionId }) => posts.push({ kind: "identity", sessionId }),
    attention: (reason) => posts.push({ kind: "attention", reason }),
    kinds: () => posts.map((post) => post.kind),
  };
}

/** A writable sink capturing everything the runner prints. */
export function captureStream() {
  const chunks = [];
  return {
    isTTY: false,
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(""),
  };
}

export function openInput() {
  return new PassThrough();
}

export async function waitFor(predicate, { timeoutMs = 8000, label = "condition", intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
