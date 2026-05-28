"use strict";

const { chromium } = require("playwright");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXTENSION_PATH = path.resolve(__dirname, "../extension");
const DEMO_HTML      = path.resolve(__dirname, "demo.html");
const PROFILE_DIR    = path.resolve(__dirname, "chrome-profile");
const SCREENSHOTS    = path.resolve(__dirname, "screenshots");
const WEBHOOK_URL    = "http://localhost:8000/api/webhook";
const AUTH_TOKEN     = "test-secret-token-abc123";
const DEMO_PORT      = 8001;
const SERVER_LOG     = path.resolve(__dirname, "../backend/server.err");

fs.mkdirSync(SCREENSHOTS, { recursive: true });
fs.mkdirSync(PROFILE_DIR,  { recursive: true });

// ---------------------------------------------------------------------------
// Minimal HTTP server for demo.html
// ---------------------------------------------------------------------------
function startDemoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/demo.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fs.readFileSync(DEMO_HTML));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(DEMO_PORT, "127.0.0.1", () => {
      console.log(`[demo] Serving on http://127.0.0.1:${DEMO_PORT}`);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shot(page, name) {
  const file = path.join(SCREENSHOTS, `${name}.png`);
  return page.screenshot({ path: file, fullPage: false })
    .then(() => console.log(`[screenshot] ${file}`))
    .catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tailLog(marker) {
  try {
    const text = fs.readFileSync(SERVER_LOG, "utf8");
    return text.split("\n").filter(l => l.includes(marker));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------
async function runTest() {
  const demoServer = await startDemoServer();

  console.log("\n[1/8] Launching Chrome with extension loaded…");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 800 },
    slowMo: 80,
  });

  // ── Get extension ID from the service worker URL ─────────────────────────
  console.log("[2/8] Waiting for extension service worker…");
  let extensionId = null;

  // Give Chrome time to register the service worker, then poll.
  for (let attempt = 0; attempt < 10 && !extensionId; attempt++) {
    await sleep(800);
    const workers = context.serviceWorkers();
    console.log(`    Attempt ${attempt + 1}: ${workers.length} service worker(s) found.`);
    for (const sw of workers) {
      console.log(`      → ${sw.url()}`);
      const m = sw.url().match(/^chrome-extension:\/\/([a-z]+)\//);
      if (m) { extensionId = m[1]; break; }
    }
  }

  if (!extensionId) {
    // Last resort: read from chrome://extensions page
    const extPage = await context.newPage();
    await extPage.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await shot(extPage, "00-chrome-extensions");
    await extPage.close();
    throw new Error("Could not determine extension ID. Check screenshot 00-chrome-extensions.png");
  }

  console.log(`    Extension ID: ${extensionId}`);

  // ── Open demo page in a FRESH tab (ensures content script injects cleanly) ─
  console.log("[3/8] Opening demo page in a new tab…");
  // Create a fresh tab first, THEN close leftover startup tabs
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${DEMO_PORT}/`, { waitUntil: "domcontentloaded" });
  // Close any leftover startup tabs (keep only our demo page)
  for (const p of context.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }
  // Give content script time to initialise (injectPickerStyle runs at document_idle)
  await sleep(800);

  // Verify content script is present by checking for its injected <style> tag
  const csReady = await page.evaluate(() =>
    !!document.getElementById("__mwt_style__")
  );
  console.log(`    Content script present: ${csReady}`);
  if (!csReady) {
    console.log("    Content script not found — reloading page…");
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1000);
    const csReady2 = await page.evaluate(() => !!document.getElementById("__mwt_style__"));
    console.log(`    After reload — content script present: ${csReady2}`);
  }
  await shot(page, "01-demo-page");

  // ── Configure extension via popup ─────────────────────────────────────────
  // Open popup in the context of the demo page's window so that
  // chrome.tabs.query({active:true, currentWindow:true}) resolves to the demo tab.
  console.log("[4/8] Configuring extension (popup)…");
  await page.bringToFront();
  const popupPromise = context.waitForEvent("page");
  // Simulate clicking the extension action button (toolbar icon)
  await page.evaluate((extId) => {
    // Programmatically open the popup by navigating a new window to it
    window.__mwtPopupUrl = `chrome-extension://${extId}/popup.html`;
  }, extensionId);

  // Open popup as a real new page within the same context
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  // Bring the demo page to front so it is the "active" tab in its window
  await page.bringToFront();
  await sleep(300);
  // Now bring the popup to front for interaction
  await popup.bringToFront();
  await shot(popup, "02-popup-blank");

  // Save token via the one-time setup panel (only visible when no token stored)
  const tokenSetupVisible = await popup.isVisible("#token-setup");
  if (tokenSetupVisible) {
    await popup.fill("#cfg-token", AUTH_TOKEN);
    await popup.click("#btn-save-token");
    await sleep(400);
    console.log("    Token saved via setup panel.");
  } else {
    console.log("    Token already configured (skipping setup).");
  }

  // Save webhook URL
  await popup.fill("#cfg-url", WEBHOOK_URL);
  await popup.click("#btn-save");
  await sleep(400);
  await shot(popup, "03-popup-configured");
  console.log("    URL saved.");

  // ── Start picking mode ────────────────────────────────────────────────────
  // Bring demo page to front (makes it the active tab) THEN click Pick in popup
  console.log("[5/8] Activating element picker…");
  await page.bringToFront();
  await sleep(200);
  await popup.bringToFront();

  const [closedPopup] = await Promise.all([
    popup.waitForEvent("close", { timeout: 5_000 }).catch(() => null),
    popup.click("#btn-pick"),
  ]);
  console.log(closedPopup ? "    Popup closed (expected)." : "    Popup did not close — continuing anyway.");

  await sleep(600);

  // ── Pick the stock button ─────────────────────────────────────────────────
  console.log("[6/8] Hovering and picking #stock-btn…");
  await page.hover("#stock-btn");
  await sleep(300);
  await shot(page, "04-hover-highlight");
  await page.click("#stock-btn");   // onPickerClick intercepts, prevents default
  await sleep(800);
  await shot(page, "05-element-picked");
  console.log("    Element picked.");

  // ── Verify monitoring state in storage ───────────────────────────────────
  console.log("[7/8] Verifying monitoring state in chrome.storage…");
  const storageState = await page.evaluate(() =>
    new Promise(res => chrome.storage.local.get(["extensionState", "monitorInfo"], res))
  ).catch(() => null);

  // Open popup to check state (new schema: monitors[tabId])
  console.log("    (Checking via popup — new per-tab storage schema)");
  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(500);
  const badge      = await popup2.textContent("#status-badge").catch(() => "?");
  const selectorTxt = await popup2.textContent("#info-selector").catch(() => "—");
  console.log(`    Badge text : ${badge}`);
  console.log(`    Selector   : ${selectorTxt}`);
  await shot(popup2, "06-popup-monitoring");
  await popup2.close();

  // ── Trigger a DOM mutation to fire the webhook ────────────────────────────
  console.log("[8/8] Triggering DOM mutation (toggling stock status)…");
  const logBefore = tailLog("Webhook received").length;
  await page.click("#toggle-stock");    // changes #stock-btn text
  await sleep(500);
  await shot(page, "07-after-mutation");
  console.log("    Waiting 3 s for debounce + network…");
  await sleep(3_000);
  await shot(page, "08-after-debounce");

  // ── Check backend received the webhook ───────────────────────────────────
  const newEntries = tailLog("Webhook received");
  const newCount   = newEntries.length - logBefore;

  console.log("\n────────────────────────────────────────");
  if (newCount > 0) {
    console.log("✅  PASS — backend received the MUTATION_DETECTED webhook");
    newEntries.slice(-newCount).forEach(l => console.log("   ", l));
  } else {
    console.log("❌  Webhook not seen in backend log yet (may still be in debounce).");
    console.log("    Check server.err for details.");
  }

  // Also check if Telegram was attempted
  const telegramLines = tailLog("Telegram");
  if (telegramLines.length) {
    console.log("\nTelegram dispatch:");
    telegramLines.forEach(l => console.log("  ", l));
  }
  console.log("────────────────────────────────────────\n");
  console.log(`Screenshots saved to: ${SCREENSHOTS}`);

  // ── Bonus: verify RESUME_MONITORING survives a page reload ──────────────
  console.log("\n[BONUS] Testing RESUME_MONITORING after page reload…");
  const logBeforeReload = tailLog("Webhook received").length;

  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1200);   // allow background onUpdated → RESUME_MONITORING → observer attached
  console.log("    Page reloaded. Triggering mutation on resumed observer…");

  await page.click("#toggle-stock");
  await sleep(3_500);
  await shot(page, "09-after-reload-mutation");

  const afterReload = tailLog("Webhook received").length;
  console.log(afterReload > logBeforeReload
    ? "✅  RESUME PASS — webhook fired after page reload"
    : "❌  RESUME FAIL — no webhook after reload (observer not resumed)");

  // Keep browser open for 5 s
  await sleep(5_000);

  await context.close();
  demoServer.close();
}

runTest().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});
