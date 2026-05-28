"use strict";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const statusBadge   = document.getElementById("status-badge");
const targetCard    = document.getElementById("target-card");
const infoSelector  = document.getElementById("info-selector");
const infoPrev      = document.getElementById("info-prev");
const infoCurr      = document.getElementById("info-curr");
const activeCount   = document.getElementById("active-count");
const monitorsPanel = document.getElementById("monitors-panel");
const monitorsList  = document.getElementById("monitors-list");
const cfgUrl        = document.getElementById("cfg-url");
const cfgToken      = document.getElementById("cfg-token");
const tokenSetup    = document.getElementById("token-setup");
const tokenStatus   = document.getElementById("token-status");
const btnSaveToken  = document.getElementById("btn-save-token");
const btnResetToken = document.getElementById("btn-reset-token");
const btnSave       = document.getElementById("btn-save");
const btnPick       = document.getElementById("btn-pick");
const btnStop       = document.getElementById("btn-stop");
const toast         = document.getElementById("toast");

// ---------------------------------------------------------------------------
// Badge rendering — scoped to the current tab's state
// ---------------------------------------------------------------------------
const BADGE_CLASSES = ["idle", "selecting", "monitoring", "paused", "error"];

const STATE_META = {
  IDLE:                  { label: "Idle",            cls: "idle"       },
  SELECTING:             { label: "Selecting…",      cls: "selecting"  },
  MONITORING:            { label: "Monitoring",      cls: "monitoring" },
  PAUSED_AUTH_REQUIRED:  { label: "Auth Required",   cls: "paused"     },
  ERROR_SELECTOR_BROKEN: { label: "Selector Broken", cls: "error"      },
};

function renderState(state, monitor) {
  const meta = STATE_META[state] || STATE_META.IDLE;
  statusBadge.textContent = meta.label;
  BADGE_CLASSES.forEach(c => statusBadge.classList.remove(c));
  statusBadge.classList.add(meta.cls);

  const isMonitoring = state === "MONITORING";
  btnPick.disabled = state === "SELECTING" || isMonitoring;
  btnStop.disabled = state === "IDLE";

  if (isMonitoring && monitor) {
    targetCard.classList.add("visible");
    infoSelector.textContent = monitor.selector      || "—";
    infoPrev.textContent     = monitor.previousState || "—";
    infoCurr.textContent     = monitor.currentState  || monitor.previousState || "—";
  } else {
    targetCard.classList.remove("visible");
  }
}

// ---------------------------------------------------------------------------
// All-monitors panel — shows every tab currently being monitored
// ---------------------------------------------------------------------------
function renderAllMonitors(monitors = {}) {
  const entries = Object.entries(monitors);
  const count   = entries.length;

  // Header count chip
  if (count > 0) {
    activeCount.textContent = `${count} active`;
    activeCount.style.display = "";
  } else {
    activeCount.style.display = "none";
  }

  // Expanded list (only shown when > 1 tab monitored)
  if (count > 1) {
    monitorsList.innerHTML = "";
    entries.forEach(([tabId, m]) => {
      const row = document.createElement("div");
      row.className = "monitor-row";

      const hostname = (() => { try { return new URL(m.url).hostname; } catch { return m.url; } })();

      row.innerHTML = `
        <span class="dot-sm"></span>
        <span class="mon-selector">${m.selector}</span>
        <span class="mon-site">${hostname}</span>
      `;
      monitorsList.appendChild(row);
    });
    monitorsPanel.classList.add("visible");
  } else {
    monitorsPanel.classList.remove("visible");
  }
}

// ---------------------------------------------------------------------------
// Token panel helpers — write-only, value never surfaces back to UI
// ---------------------------------------------------------------------------
function showTokenConfigured() {
  tokenSetup.style.display = "none";
  tokenStatus.classList.add("visible");
}

function showTokenSetup() {
  tokenSetup.style.display = "";
  tokenStatus.classList.remove("visible");
  cfgToken.value = "";
}

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------
let _toastTimer = null;

function showToast(msg, type = "success") {
  toast.textContent = msg;
  toast.className   = `toast ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.className = "toast"; }, 3000);
}

// ---------------------------------------------------------------------------
// Load state on popup open — tab-aware
// ---------------------------------------------------------------------------
async function loadPopupState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.storage.local.get(["webhookUrl", "authToken", "monitors"], ({ webhookUrl, authToken, monitors = {} }) => {
    cfgUrl.value = webhookUrl || "";

    authToken ? showTokenConfigured() : showTokenSetup();

    // Render current tab's state
    const tabState = tab ? monitors[String(tab.id)] : null;
    renderState(
      tabState?.state || "IDLE",
      tabState ? {
        selector:      tabState.selector,
        previousState: tabState.previousState,
        currentState:  tabState.previousState,   // chips start equal; live update refines it
      } : null
    );

    renderAllMonitors(monitors);
  });
}

loadPopupState();

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------
btnSaveToken.addEventListener("click", () => {
  const token = cfgToken.value.trim();
  if (!token) { showToast("Token cannot be empty.", "error"); return; }

  chrome.storage.local.set({ authToken: token }, () => {
    cfgToken.value = "";
    showTokenConfigured();
    showToast("Token saved securely.");
  });
});

btnResetToken.addEventListener("click", () => {
  chrome.storage.local.remove("authToken", () => {
    showTokenSetup();
    showToast("Token cleared. Enter a new one.", "error");
  });
});

// ---------------------------------------------------------------------------
// Save webhook URL
// ---------------------------------------------------------------------------
btnSave.addEventListener("click", () => {
  const url = cfgUrl.value.trim();
  if (!url) { showToast("Webhook URL is required.", "error"); return; }
  chrome.storage.local.set({ webhookUrl: url }, () => showToast("URL saved."));
});

// ---------------------------------------------------------------------------
// Tab resolution — prefers current window, falls back to any real tab
// ---------------------------------------------------------------------------
async function findTargetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && !tab.url?.startsWith("chrome-extension://") && !tab.url?.startsWith("chrome://")) {
    return tab;
  }
  const all = await chrome.tabs.query({});
  return all.find(t => t.id && t.url && !t.url.startsWith("chrome-extension://") && !t.url.startsWith("chrome://")) ?? null;
}

// ---------------------------------------------------------------------------
// Pick Element
// ---------------------------------------------------------------------------
btnPick.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["webhookUrl", "authToken"]);
  if (!(stored.webhookUrl || "").trim()) { showToast("Save a Webhook URL first.", "error"); return; }
  if (!(stored.authToken  || "").trim()) { showToast("Set up your auth token first.", "error"); return; }

  const tab = await findTargetTab();
  if (!tab?.id) { showToast("No active page found. Try refreshing.", "error"); return; }

  chrome.tabs.sendMessage(tab.id, { type: "START_PICKING" }, (resp) => {
    if (chrome.runtime.lastError) { showToast("Could not contact page. Try refreshing.", "error"); return; }
    if (resp?.ok === false) { showToast("Already monitoring. Click Stop first.", "error"); return; }
    window.close();
  });
});

// ---------------------------------------------------------------------------
// Stop monitoring on current tab
// ---------------------------------------------------------------------------
btnStop.addEventListener("click", async () => {
  const tab = await findTargetTab();
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "STOP_MONITORING" }, () => {
    void chrome.runtime.lastError;
    renderState("IDLE", null);
    // Refresh the monitors panel after stop
    chrome.storage.local.get("monitors", ({ monitors = {} }) => renderAllMonitors(monitors));
    showToast("Monitoring stopped.");
  });
});

// ---------------------------------------------------------------------------
// Live state updates from content script — scoped to current tab
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== "STATE_UPDATE") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Only update the display if this message is from the tab we're looking at
  if (tab && msg.tabId && msg.tabId !== tab.id) return;

  renderState(msg.state, msg.monitorInfo || null);
  // Refresh the all-monitors panel count
  chrome.storage.local.get("monitors", ({ monitors = {} }) => renderAllMonitors(monitors));
});
