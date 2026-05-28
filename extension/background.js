"use strict";

// =============================================================================
// UNIVERSAL WEBHOOK MUTATION TRIGGER — Background Service Worker
//
// Responsibilities:
//   1. Per-tab monitor state persistence (SAVE / CLEAR / RESUME on page load)
//   2. Tab lifecycle management (onUpdated → resume, onRemoved → cleanup)
//   3. Webhook dispatch with exponential backoff retry
// =============================================================================

const RETRY_DELAYS = [2000, 5000, 15000];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Webhook sender — returns { ok, reason, detail? }
// ---------------------------------------------------------------------------
async function sendWithRetry(payload, url, token, attempt = 0) {
  try {
    const response = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401) {
        console.error("[MWT] Auth rejected (401)", { trigger_id: payload.trigger_id });
        return { ok: false, reason: "auth_failed" };
      }
      if (response.status === 422) {
        console.error("[MWT] Payload rejected (422)", { trigger_id: payload.trigger_id, detail: body });
        return { ok: false, reason: "validation_error", detail: body };
      }
      console.error(`[MWT] HTTP ${response.status}`, { trigger_id: payload.trigger_id });
      return { ok: false, reason: `http_${response.status}` };
    }

    console.info("[MWT] Webhook accepted", { trigger_id: payload.trigger_id, attempt });
    return { ok: true };

  } catch (err) {
    if (err instanceof TypeError) {
      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(`[MWT] Network error — retrying in ${delay}ms (attempt ${attempt + 1})`, { error: err.message });
        await sleep(delay);
        return sendWithRetry(payload, url, token, attempt + 1);
      }
      console.error("[MWT] All retries exhausted", { error: err.message });
      return { ok: false, reason: "network_failed" };
    }
    console.error("[MWT] Unexpected fetch error", err);
    return { ok: false, reason: "unexpected_error" };
  }
}

// ---------------------------------------------------------------------------
// Resume helper — sends RESUME_MONITORING to a tab if it has a saved monitor
// ---------------------------------------------------------------------------
function resumeIfMonitored(tabId) {
  chrome.storage.local.get("monitors", ({ monitors = {} }) => {
    const saved = monitors[String(tabId)];
    if (!saved || saved.state !== "MONITORING") return;

    chrome.tabs.sendMessage(
      tabId,
      { type: "RESUME_MONITORING", tabId, selector: saved.selector, previousState: saved.previousState },
      () => void chrome.runtime.lastError
    );
  });
}

// ---------------------------------------------------------------------------
// Tab lifecycle — fallback resume via onUpdated (safety net only)
// Primary resume path is CONTENT_SCRIPT_READY below, which is timing-safe.
// This catches edge cases where CONTENT_SCRIPT_READY never fires.
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  // 1200 ms gives even heavy pages time to reach document_idle and register
  // their onMessage listener before we send RESUME_MONITORING.
  setTimeout(() => resumeIfMonitored(tabId), 1200);
});

// Clean up stale monitor entries when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("monitors", ({ monitors = {} }) => {
    if (!monitors[String(tabId)]) return;
    delete monitors[String(tabId)];
    chrome.storage.local.set({ monitors });
    console.info(`[MWT] Cleaned up monitor for closed tab ${tabId}`);
  });
});

// ---------------------------------------------------------------------------
// Message dispatcher
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Content script ready — primary resume trigger ────────────────────────
  // Content script sends this immediately after registering its onMessage
  // listener. This is timing-safe: we know the listener is up before we reply.
  if (msg.type === "CONTENT_SCRIPT_READY") {
    const tabId = sender.tab?.id;
    if (tabId) resumeIfMonitored(tabId);
    sendResponse({ ok: true });
    return false;
  }

  // ── Tab ID lookup (content script asks on init) ───────────────────────────
  if (msg.type === "GET_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  // ── Save per-tab monitor state ────────────────────────────────────────────
  if (msg.type === "SAVE_MONITOR_STATE") {
    const tabId = String(sender.tab?.id);
    if (!tabId || tabId === "undefined") { sendResponse({ ok: false }); return false; }

    chrome.storage.local.get("monitors", ({ monitors = {} }) => {
      monitors[tabId] = msg.data;   // { state, selector, previousState, url }
      chrome.storage.local.set({ monitors }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // ── Clear per-tab monitor state ───────────────────────────────────────────
  if (msg.type === "CLEAR_MONITOR_STATE") {
    const tabId = String(sender.tab?.id);
    if (!tabId || tabId === "undefined") { sendResponse({ ok: false }); return false; }

    chrome.storage.local.get("monitors", ({ monitors = {} }) => {
      delete monitors[tabId];
      chrome.storage.local.set({ monitors }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // ── Webhook dispatch ──────────────────────────────────────────────────────
  if (msg.type === "FIRE_WEBHOOK") {
    const { payload } = msg;

    chrome.storage.local.get(["webhookUrl", "authToken"], ({ webhookUrl, authToken }) => {
      const url   = (webhookUrl  || "").trim();
      const token = (authToken   || "").trim();

      if (!url || !token) {
        console.warn("[MWT] Not configured — skipping dispatch.", { trigger_id: payload?.trigger_id });
        sendResponse({ ok: false, reason: "not_configured" });
        return;
      }

      console.info("[MWT] Dispatching webhook", {
        event_type: payload.event_type,
        url:        payload.url,
        trigger_id: payload.trigger_id,
      });

      sendWithRetry(payload, url, token, 0).then(sendResponse);
    });
    return true;
  }

  return false;
});
