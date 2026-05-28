// Run this script once from the Chrome extension's background service worker console
// to set the auth token without it ever appearing in the popup UI.
//
// How to use:
//   1. Go to chrome://extensions
//   2. Find "Mutation Trigger" → click "Service Worker" (Inspect)
//   3. In the console, paste:
//        chrome.storage.local.set({ authToken: "your-token-here" }, () => console.log("Token saved."))
//
// Or paste the full contents of this file into that console.

chrome.storage.local.set(
  { authToken: "REPLACE_WITH_YOUR_TOKEN" },
  () => console.log("[MWT] Auth token saved. You can close this console.")
);
