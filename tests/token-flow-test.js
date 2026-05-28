"use strict";

const { chromium } = require("playwright");
const path = require("path");
const fs   = require("fs");

const EXTENSION_PATH = path.resolve(__dirname, "../extension");
const PROFILE_DIR    = path.resolve(__dirname, "chrome-profile-token-test");
const SCREENSHOTS    = path.resolve(__dirname, "screenshots-token");
const AUTH_TOKEN     = "test-secret-token-abc123";

fs.mkdirSync(SCREENSHOTS, { recursive: true });
fs.mkdirSync(PROFILE_DIR,  { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shot(page, name) {
  const file = path.join(SCREENSHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  console.log(`  [screenshot] ${name}.png`);
}

async function getExtensionId(context) {
  for (let i = 0; i < 10; i++) {
    await sleep(600);
    for (const sw of context.serviceWorkers()) {
      const m = sw.url().match(/^chrome-extension:\/\/([a-z]+)\//);
      if (m) return m[1];
    }
  }
  throw new Error("Extension service worker not found");
}

async function openPopup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(300);
  return popup;
}

async function runTest() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
    ],
    viewport: { width: 900, height: 700 },
    slowMo: 60,
  });

  const extensionId = await getExtensionId(context);
  console.log(`Extension ID: ${extensionId}\n`);

  // ── Test 1: First open — setup panel visible, token field blank ──────────
  console.log("Test 1: First open shows token setup panel");
  let popup = await openPopup(context, extensionId);

  const setupVisible  = await popup.isVisible("#token-setup");
  const statusVisible = await popup.isVisible("#token-status");
  const tokenValue    = await popup.$eval("#cfg-token", el => el.value);

  console.log(`  token-setup visible  : ${setupVisible}   (expected: true)`);
  console.log(`  token-status visible : ${statusVisible}  (expected: false)`);
  console.log(`  token input value    : "${tokenValue}"   (expected: "")`);
  await shot(popup, "01-first-open");

  const t1 = setupVisible && !statusVisible && tokenValue === "";
  console.log(`  → ${t1 ? "PASS ✅" : "FAIL ❌"}\n`);

  // ── Test 2: Pick without token shows error toast ─────────────────────────
  console.log("Test 2: Clicking Pick without token shows error toast");
  await popup.fill("#cfg-url", "http://localhost:8000/api/webhook");
  await popup.click("#btn-save");
  await sleep(300);
  await popup.click("#btn-pick");
  await sleep(500);
  const toastText2 = await popup.textContent("#toast");
  console.log(`  toast text: "${toastText2}"   (expected: "Set up your auth token first.")`);
  await shot(popup, "02-pick-without-token");
  const t2 = toastText2.includes("auth token");
  console.log(`  → ${t2 ? "PASS ✅" : "FAIL ❌"}\n`);

  // ── Test 3: Save token — panel collapses, value not readable ─────────────
  console.log("Test 3: Saving token hides setup, shows configured status");
  await popup.fill("#cfg-token", AUTH_TOKEN);
  await popup.click("#btn-save-token");
  await sleep(500);

  const setupAfter   = await popup.isVisible("#token-setup");
  const statusAfter  = await popup.$eval("#token-status", el => el.classList.contains("visible"));
  const inputCleared = await popup.$eval("#cfg-token", el => el.value);
  const toastText3   = await popup.textContent("#toast");

  console.log(`  token-setup hidden     : ${!setupAfter}    (expected: true)`);
  console.log(`  token-status visible   : ${statusAfter}   (expected: true)`);
  console.log(`  input cleared to ""    : ${inputCleared === ""}  (expected: true)`);
  console.log(`  toast: "${toastText3}"   (expected: "Token saved securely.")`);
  await shot(popup, "03-token-saved");

  const t3 = !setupAfter && statusAfter && inputCleared === "" && toastText3.includes("saved");
  console.log(`  → ${t3 ? "PASS ✅" : "FAIL ❌"}\n`);
  await popup.close();

  // ── Test 4: Reopen popup — still shows configured, no token field ─────────
  console.log("Test 4: Reopening popup — token stays configured, no input field");
  popup = await openPopup(context, extensionId);

  const setupReopen  = await popup.isVisible("#token-setup");
  const statusReopen = await popup.$eval("#token-status", el => el.classList.contains("visible"));

  console.log(`  token-setup hidden   : ${!setupReopen}   (expected: true)`);
  console.log(`  token-status visible : ${statusReopen}   (expected: true)`);
  await shot(popup, "04-reopen-configured");

  const t4 = !setupReopen && statusReopen;
  console.log(`  → ${t4 ? "PASS ✅" : "FAIL ❌"}\n`);

  // ── Test 5: Reset button — setup panel reappears, blank ──────────────────
  console.log("Test 5: Reset clears token and shows setup panel again");
  await popup.click("#btn-reset-token");
  await sleep(500);

  const setupAfterReset  = await popup.isVisible("#token-setup");
  const statusAfterReset = await popup.$eval("#token-status", el => el.classList.contains("visible"));
  const inputAfterReset  = await popup.$eval("#cfg-token", el => el.value);

  console.log(`  token-setup visible  : ${setupAfterReset}   (expected: true)`);
  console.log(`  token-status hidden  : ${!statusAfterReset}  (expected: true)`);
  console.log(`  input blank          : ${inputAfterReset === ""}  (expected: true)`);
  await shot(popup, "05-after-reset");

  const t5 = setupAfterReset && !statusAfterReset && inputAfterReset === "";
  console.log(`  → ${t5 ? "PASS ✅" : "FAIL ❌"}\n`);

  // ── Test 6: Re-save token — configured again ─────────────────────────────
  console.log("Test 6: Re-saving token after reset works correctly");
  await popup.fill("#cfg-token", AUTH_TOKEN);
  await popup.click("#btn-save-token");
  await sleep(400);

  const setupFinal  = await popup.isVisible("#token-setup");
  const statusFinal = await popup.$eval("#token-status", el => el.classList.contains("visible"));

  console.log(`  token-setup hidden   : ${!setupFinal}  (expected: true)`);
  console.log(`  token-status visible : ${statusFinal}  (expected: true)`);
  await shot(popup, "06-re-saved");

  const t6 = !setupFinal && statusFinal;
  console.log(`  → ${t6 ? "PASS ✅" : "FAIL ❌"}\n`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const all = [t1, t2, t3, t4, t5, t6];
  const passed = all.filter(Boolean).length;
  console.log("─────────────────────────────────────");
  console.log(`Result: ${passed}/${all.length} tests passed`);
  all.forEach((r, i) => console.log(`  Test ${i + 1}: ${r ? "✅ PASS" : "❌ FAIL"}`));
  console.log("─────────────────────────────────────");
  console.log(`Screenshots: ${SCREENSHOTS}`);

  await sleep(4000);
  await context.close();
}

runTest().catch(err => { console.error("[FATAL]", err); process.exit(1); });
