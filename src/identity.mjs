// SPDX-License-Identifier: Apache-2.0
// Learn which OpenRig seat this pane became, after adoption.
//
// Why this exists: the daemon decides a seat's state from its turn hooks only
// when a hook carries the emitting occupant generation. Without it the hook is
// accepted but untrusted and window sampling decides instead — the daemon says
// "a recent hook exists … but carried NO occupant generation"
// (packages/daemon/src/domain/session-transport.ts:1918-1933). A runner started
// by hand and then adopted cannot know its node or generation at launch, because
// adoption creates them after the pane exists. Both are readable afterwards from
// two loopback routes that need no token:
//
//   GET /api/whoami?sessionName=<seat>              identity.nodeId
//       (packages/daemon/src/routes/whoami.ts)
//   GET /api/telemetry/v1/nodes/<nodeId>/tenures    rows[].generationUuid,
//       newest first (packages/daemon/src/domain/finite-telemetry.ts:59)
//
// The natural moment to ask is when OpenRig types its claim hint into the pane
// (packages/daemon/src/domain/claim-service.ts:196), which the runner reads
// before the agent does.

/** The hint OpenRig types into a pane it has just adopted. */
export const CLAIM_HINT = /OpenRig: You have been adopted into rig\b/;

async function getJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the seat's node and current occupant generation from the daemon.
 *
 * @returns {Promise<{ok: true, nodeId: string, generation: string|null, rigName: string|null,
 *   memberId: string|null, reason: string|null} | {ok: false, reason: string}>}
 *   `ok: false` with reason "not-adopted" is the normal answer for a pane no rig
 *   has bound yet; a missing generation comes back as `generation: null`.
 */
export async function resolveSeatIdentity({ baseUrl, sessionName, fetchImpl = globalThis.fetch, timeoutMs = 3000 }) {
  try {
    const whoamiUrl = new URL("/api/whoami", baseUrl);
    whoamiUrl.searchParams.set("sessionName", sessionName);
    whoamiUrl.searchParams.set("compact", "1");
    const who = await getJson(fetchImpl, whoamiUrl, timeoutMs);
    if (who.status === 404) return { ok: false, reason: "not-adopted" };
    if (who.status === 409) return { ok: false, reason: "ambiguous: the session name is bound in more than one rig" };
    if (!who.ok) return { ok: false, reason: `whoami HTTP ${who.status}` };

    const identity = who.body?.identity ?? {};
    const nodeId = typeof identity.nodeId === "string" && identity.nodeId ? identity.nodeId : null;
    if (!nodeId) return { ok: false, reason: "whoami returned no nodeId" };
    const found = {
      ok: true,
      nodeId,
      generation: null,
      rigName: typeof identity.rigName === "string" ? identity.rigName : null,
      memberId: typeof identity.memberId === "string" ? identity.memberId : null,
      reason: null,
    };

    const tenuresUrl = new URL(`/api/telemetry/v1/nodes/${encodeURIComponent(nodeId)}/tenures`, baseUrl);
    const tenures = await getJson(fetchImpl, tenuresUrl, timeoutMs);
    if (!tenures.ok) return { ...found, reason: `tenures HTTP ${tenures.status}` };

    // The first page is newest-first; take the highest ordinal regardless.
    const rows = Array.isArray(tenures.body?.rows) ? tenures.body.rows : [];
    let current = null;
    for (const row of rows) {
      if (typeof row?.generationUuid !== "string" || !row.generationUuid) continue;
      if (!current || Number(row.generationOrdinal) > Number(current.generationOrdinal)) current = row;
    }
    return current ? { ...found, generation: current.generationUuid } : { ...found, reason: "no occupant tenure recorded" };
  } catch (err) {
    return { ok: false, reason: err?.name === "AbortError" ? "daemon did not answer in time" : String(err?.message ?? err) };
  }
}
