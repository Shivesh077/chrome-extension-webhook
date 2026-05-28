"use strict";

const { chromium } = require("playwright");
const path = require("path");
const fs   = require("fs");

const EXTENSION_PATH = path.resolve(__dirname, "../extension");
const PROFILE_DIR    = path.resolve(__dirname, "chrome-profile-real");
const SCREENSHOTS    = path.resolve(__dirname, "screenshots-real");
const SERVER_LOG     = path.resolve(__dirname, "../backend/server.err");
const WEBHOOK_URL    = "http://localhost:8000/api/webhook";
const AUTH_TOKEN     = "test-secret-token-abc123";

fs.mkdirSync(SCREENSHOTS, { recursive: true });
fs.mkdirSync(PROFILE_DIR,  { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) }).catch(() => {});
  console.log(`  [ss] ${name}.png`);
}

function webhookCount() {
  try { return fs.readFileSync(SERVER_LOG, "utf8").split("\n").filter(l => l.includes("Webhook received")).length; }
  catch { return 0; }
}

async function getExtensionId(context) {
  for (let i = 0; i < 12; i++) {
    await sleep(600);
    for (const sw of context.serviceWorkers()) {
      const m = sw.url().match(/^chrome-extension:\/\/([a-z]+)\//);
      if (m) return m[1];
    }
  }
  throw new Error("Extension service worker not found");
}

async function openPopup(context, extId) {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(300);
  return p;
}

// ---------------------------------------------------------------------------
async function runTest() {
  console.log("Starting real-website resume test (target: https://example.com)\n");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
    ],
    viewport: { width: 1280, height: 800 },
    slowMo: 60,
  });

  const extId = await getExtensionId(context);
  console.log(`Extension ID: ${extId}\n`);

  // ── 1. Navigate to real website ──────────────────────────────────────────
  console.log("[1] Navigating to https://example.com …");
  const page = await context.newPage();
  for (const p of context.pages()) { if (p !== page) await p.close().catch(() => {}); }
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  await sleep(1000);

  const csReady = await page.evaluate(() => !!document.getElementById("__mwt_style__"));
  console.log(`    Content script injected: ${csReady}`);
  await shot(page, "01-example-com");

  // ── 2. Configure extension ───────────────────────────────────────────────
  console.log("[2] Configuring extension…");
  const popup = await openPopup(context, extId);
  await page.bringToFront(); await sleep(200); await popup.bringToFront();

  if (await popup.isVisible("#token-setup")) {
    await popup.fill("#cfg-token", AUTH_TOKEN);
    await popup.click("#btn-save-token");
    await sleep(300);
  }
  await popup.fill("#cfg-url", WEBHOOK_URL);
  await popup.click("#btn-save");
  await sleep(300);
  await shot(popup, "02-configured");
  console.log("    Done.");

  // ── 3. Pick the h1 element ───────────────────────────────────────────────
  console.log("[3] Picking <h1> element…");
  await page.bringToFront(); await sleep(200); await popup.bringToFront();

  await Promise.all([
    popup.waitForEvent("close", { timeout: 5000 }).catch(() => null),
    popup.click("#btn-pick"),
  ]);
  await sleep(600);

  await page.hover("h1");
  await sleep(300);
  await shot(page, "03-hover-h1");
  await page.click("h1");
  await sleep(800);
  await shot(page, "04-h1-picked");
  console.log("    Picked.");

  // ── 4. First mutation — confirm baseline works ───────────────────────────
  console.log("[4] Injecting first DOM mutation…");
  const before1 = webhookCount();
  await page.evaluate(() => { document.querySelector("h1").textContent = "Mutation Test 1"; });
  await sleep(3500);
  await shot(page, "05-first-mutation");
  const pass1 = webhookCount() > before1;
  console.log(`    ${pass1 ? "✅ PASS" : "❌ FAIL"} — first mutation ${pass1 ? "detected" : "NOT detected"}`);

  // ── 5. Page refresh ──────────────────────────────────────────────────────
  console.log("[5] Refreshing page (F5)…");
  await page.reload({ waitUntil: "domcontentloaded" });

  // Wait for CONTENT_SCRIPT_READY → RESUME_MONITORING handshake
  // Poll for the style tag to confirm content script re-injected
  let csBack = false;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    csBack = await page.evaluate(() => !!document.getElementById("__mwt_style__")).catch(() => false);
    if (csBack) break;
  }
  console.log(`    Content script re-injected after reload: ${csBack}`);
  await shot(page, "06-after-reload");

  // Give the CONTENT_SCRIPT_READY → RESUME handshake time to complete
  await sleep(800);

  // ── 6. Verify observer resumed by injecting second mutation ──────────────
  console.log("[6] Injecting second DOM mutation (post-reload)…");
  const before2 = webhookCount();
  await page.evaluate(() => { document.querySelector("h1").textContent = "Mutation Test 2 — after reload"; });
  await sleep(3500);
  await shot(page, "07-second-mutation");
  const pass2 = webhookCount() > before2;
  console.log(`    ${pass2 ? "✅ PASS" : "❌ FAIL"} — post-reload mutation ${pass2 ? "detected" : "NOT detected"}`);

  // ── 7. Check popup state after reload ────────────────────────────────────
  console.log("[7] Checking popup state after reload…");
  const popup2 = await openPopup(context, extId);
  await sleep(500);
  const badge = await popup2.textContent("#status-badge").catch(() => "?");
  console.log(`    Badge: ${badge}`);
  await shot(popup2, "08-popup-after-reload");
  await popup2.close();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════");
  console.log(`  Test 1 (baseline mutation):      ${pass1 ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  Test 2 (post-reload mutation):   ${pass2 ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  Content script re-injected:      ${csBack ? "✅ YES" : "❌ NO"}`);
  console.log("══════════════════════════════════════");
  console.log(`Screenshots: ${SCREENSHOTS}\n`);

  // Check backend log for what arrived
  const received = fs.readFileSync(SERVER_LOG, "utf8").split("\n")
    .filter(l => l.includes("Webhook received") || l.includes("Telegram dispatch"))
    .slice(-6);
  console.log("Recent backend entries:");
  received.forEach(l => console.log(" ", l));

  await sleep(4000);
  await context.close();
}

runTest().catch(err => { console.error("[FATAL]", err); process.exit(1); });
