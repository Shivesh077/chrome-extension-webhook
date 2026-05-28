"use strict";

// =============================================================================
// UNIVERSAL WEBHOOK MUTATION TRIGGER — Content Script
// State Machine: IDLE → SELECTING → MONITORING → PAUSED_AUTH_REQUIRED
//                                                → ERROR_SELECTOR_BROKEN
//
// Per-tab persistence: state is stored in background via SAVE_MONITOR_STATE.
// On every page load, background sends RESUME_MONITORING so the observer
// reattaches automatically — surviving refreshes and navigations.
// =============================================================================

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const STATES = {
  IDLE:                  "IDLE",
  SELECTING:             "SELECTING",
  MONITORING:            "MONITORING",
  PAUSED_AUTH_REQUIRED:  "PAUSED_AUTH_REQUIRED",
  ERROR_SELECTOR_BROKEN: "ERROR_SELECTOR_BROKEN",
};

let currentState  = STATES.IDLE;
let savedSelector = null;
let previousState = null;
let observer      = null;
let debounceTimer = null;
let nullCounter   = 0;
let keepAliveTimer  = null;
let authWatchTimer  = null;
let hoveredEl       = null;
let myTabId         = null;   // resolved once via GET_TAB_ID on init

// ---------------------------------------------------------------------------
// Picker outline style (injected once per page)
// ---------------------------------------------------------------------------
(function injectPickerStyle() {
  if (document.getElementById("__mwt_style__")) return;
  const s = document.createElement("style");
  s.id = "__mwt_style__";
  s.textContent = `
    .__mwt_hover__ {
      outline: 3px solid #00D1B2 !important;
      cursor: crosshair !important;
    }
  `;
  document.head.appendChild(s);
})();

// ---------------------------------------------------------------------------
// Tab ID bootstrap — ask background for our own tab ID once on init
// ---------------------------------------------------------------------------
chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, (res) => {
  if (chrome.runtime.lastError) return;
  myTabId = res?.tabId ?? null;
});

// ---------------------------------------------------------------------------
// Safe sendMessage wrapper (Promise API landed Chrome 99+, undefined before)
// ---------------------------------------------------------------------------
function safeSendMessage(msg) {
  const result = chrome.runtime.sendMessage(msg);
  if (result && typeof result.catch === "function") result.catch(() => {});
}

// ---------------------------------------------------------------------------
// State machine transition
// Writes per-tab state to background; notifies popup via STATE_UPDATE.
// ---------------------------------------------------------------------------
function transition(newState) {
  currentState = newState;

  if (newState === STATES.MONITORING) {
    // Persist this tab's monitor so background can resume it after reload
    chrome.runtime.sendMessage({
      type: "SAVE_MONITOR_STATE",
      data: {
        state:         "MONITORING",
        selector:      savedSelector,
        previousState: previousState,
        url:           window.location.href,
      },
    });
    safeSendMessage({
      type:        "STATE_UPDATE",
      state:       newState,
      tabId:       myTabId,
      monitorInfo: { selector: savedSelector, previousState, currentState: previousState },
    });
  } else {
    // All non-monitoring states clear the saved entry for this tab
    chrome.runtime.sendMessage({ type: "CLEAR_MONITOR_STATE" });
    safeSendMessage({ type: "STATE_UPDATE", state: newState, tabId: myTabId });
  }
}

// ---------------------------------------------------------------------------
// CSS Selector Engine
// ---------------------------------------------------------------------------
function buildSelector(el) {
  // 1. Prefer #id
  if (el.id) {
    const id = CSS.escape(el.id);
    if (document.querySelectorAll(`#${id}`).length === 1) return `#${id}`;
  }

  // 2. Prefer unique class combination
  if (el.classList.length > 0) {
    const classes = Array.from(el.classList)
      .filter(c => /^[a-zA-Z_-]/.test(c))
      .map(c => `.${CSS.escape(c)}`)
      .join("");
    if (classes && document.querySelectorAll(classes).length === 1) return classes;
  }

  // 3. Walk up the DOM building an nth-of-type path
  const parts = [];
  let node = el;

  while (node && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();

    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }

    let idx = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) idx++;
      sib = sib.previousElementSibling;
    }

    parts.unshift(`${tag}:nth-of-type(${idx})`);
    node = node.parentElement;
  }

  return parts.join(" > ");
}

// ---------------------------------------------------------------------------
// Picker event handlers
// ---------------------------------------------------------------------------
function onMouseOver(e) {
  if (currentState !== STATES.SELECTING) return;
  if (hoveredEl) hoveredEl.classList.remove("__mwt_hover__");
  hoveredEl = e.target;
  hoveredEl.classList.add("__mwt_hover__");
}

function onMouseOut(e) {
  if (currentState !== STATES.SELECTING) return;
  e.target.classList.remove("__mwt_hover__");
}

function onPickerClick(e) {
  if (currentState !== STATES.SELECTING) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const el = e.target;
  el.classList.remove("__mwt_hover__");

  savedSelector = buildSelector(el);
  previousState = (el.innerText || el.textContent || "").trim();
  nullCounter   = 0;

  stopPickerListeners();
  startMonitoring();
}

function startPickerListeners() {
  document.addEventListener("mouseover", onMouseOver,    true);
  document.addEventListener("mouseout",  onMouseOut,     true);
  document.addEventListener("click",     onPickerClick,  true);
}

function stopPickerListeners() {
  document.removeEventListener("mouseover", onMouseOver,    true);
  document.removeEventListener("mouseout",  onMouseOut,     true);
  document.removeEventListener("click",     onPickerClick,  true);
  if (hoveredEl) { hoveredEl.classList.remove("__mwt_hover__"); hoveredEl = null; }
}

// ---------------------------------------------------------------------------
// Core sensor
// ---------------------------------------------------------------------------

// Auth watchdog — fires AUTH_REQUIRED if redirected to a login page
function startAuthWatchdog() {
  clearInterval(authWatchTimer);
  authWatchTimer = setInterval(() => {
    if (/\/(login|signin|auth)(\?|\/|$)/i.test(window.location.href)) {
      stopAll();
      transition(STATES.PAUSED_AUTH_REQUIRED);
      dispatchWebhook("AUTH_REQUIRED", null);
    }
  }, 3000);
}

// Keep-alive heartbeat — prevents session expiry on idle sites
function startKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    window.dispatchEvent(new Event("mousemove"));
  }, 5 * 60 * 1000);
}

// Debounced mutation evaluator — 2 s cooldown, trims whitespace, diffs state
function evaluateMutation() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const el = document.querySelector(savedSelector);

    if (!el) {
      nullCounter++;
      if (nullCounter >= 5) {
        stopAll();
        transition(STATES.ERROR_SELECTOR_BROKEN);
        dispatchWebhook("SELECTOR_BROKEN", null);
      }
      return;
    }

    nullCounter = 0;
    const currentText = (el.innerText || el.textContent || "").trim();

    if (currentText !== previousState.trim()) {
      const data = { previous_state: previousState, current_state: currentText };
      previousState = currentText;

      // Persist updated baseline for this tab
      chrome.runtime.sendMessage({
        type: "SAVE_MONITOR_STATE",
        data: {
          state:         "MONITORING",
          selector:      savedSelector,
          previousState: previousState,
          url:           window.location.href,
        },
      });

      // Notify popup (live update of state chips)
      safeSendMessage({
        type:        "STATE_UPDATE",
        state:       STATES.MONITORING,
        tabId:       myTabId,
        monitorInfo: {
          selector:      savedSelector,
          previousState: data.previous_state,
          currentState:  currentText,
        },
      });

      dispatchWebhook("MUTATION_DETECTED", data);
    }
  }, 2000);
}

// Attach MutationObserver to document.body for SPA resilience
function startMonitoring() {
  transition(STATES.MONITORING);
  startAuthWatchdog();
  startKeepAlive();

  observer = new MutationObserver(evaluateMutation);
  observer.observe(document.body, {
    childList:     true,
    subtree:       true,
    characterData: true,
  });
}

function stopAll() {
  if (observer) { observer.disconnect(); observer = null; }
  clearTimeout(debounceTimer);
  clearInterval(authWatchTimer);
  clearInterval(keepAliveTimer);
  stopPickerListeners();
}

// ---------------------------------------------------------------------------
// Webhook dispatch
// ---------------------------------------------------------------------------
function dispatchWebhook(eventType, data) {
  if (!savedSelector) {
    console.warn("[MWT] dispatchWebhook called with no selector — skipping", { eventType });
    return;
  }

  const payload = {
    trigger_id: `trg_${Math.random().toString(36).slice(2, 10)}`,
    url:        window.location.href,
    selector:   savedSelector,
    event_type: eventType,
    timestamp:  new Date().toISOString(),
    data,
  };

  chrome.runtime.sendMessage({ type: "FIRE_WEBHOOK", payload }, (result) => {
    if (chrome.runtime.lastError) return;
    if (result?.reason === "not_configured")
      console.warn("[MWT] Webhook not sent — URL/token not configured in extension popup.");
    else if (result?.reason === "auth_failed")
      console.error("[MWT] Server rejected our token (401). Update the Auth Token in the popup.");
    else if (result?.reason === "validation_error")
      console.error("[MWT] Server rejected payload (422):", result.detail);
  });
}

// ---------------------------------------------------------------------------
// Message listener (from popup and background)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // Background → content: resume monitoring after page load / navigation
  if (msg.type === "RESUME_MONITORING") {
    if (currentState === STATES.MONITORING) {
      // Already monitoring (e.g., SPA navigation without full reload) — ignore
      sendResponse({ ok: true, skipped: true });
      return;
    }

    myTabId       = msg.tabId ?? myTabId;
    savedSelector = msg.selector;
    previousState = msg.previousState || "";
    nullCounter   = 0;

    startMonitoring();

    // Immediate check: did the element change while the page was reloading?
    const el = document.querySelector(savedSelector);
    if (el) {
      const currentText = (el.innerText || el.textContent || "").trim();
      if (currentText !== previousState.trim()) {
        const data = { previous_state: previousState, current_state: currentText };
        previousState = currentText;

        chrome.runtime.sendMessage({
          type: "SAVE_MONITOR_STATE",
          data: { state: "MONITORING", selector: savedSelector, previousState, url: window.location.href },
        });

        dispatchWebhook("MUTATION_DETECTED", data);
      }
    }

    sendResponse({ ok: true });
    return;
  }

  // Popup → content: start element picker
  if (msg.type === "START_PICKING") {
    if (currentState !== STATES.IDLE) {
      sendResponse({ ok: false, reason: "not_idle" });
      return;
    }
    transition(STATES.SELECTING);
    startPickerListeners();
    sendResponse({ ok: true });
    return;
  }

  // Popup → content: stop monitoring
  if (msg.type === "STOP_MONITORING") {
    stopAll();
    savedSelector = null;
    previousState = null;
    nullCounter   = 0;
    transition(STATES.IDLE);
    sendResponse({ ok: true });
    return;
  }
});

// ---------------------------------------------------------------------------
// Signal background that this content script's listener is now registered.
// Background immediately checks for saved monitor state and sends
// RESUME_MONITORING if this tab was being monitored — no timing guesswork.
// ---------------------------------------------------------------------------
chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY" }, () => void chrome.runtime.lastError);
