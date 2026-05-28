# Universal Webhook Mutation Trigger

A production-grade web monitoring system that lets you visually select any element on a live webpage and receive instant Telegram notifications when its content changes — without any server-side scraping or bot detection issues.

All page monitoring happens **client-side** inside your real browser session via a Chrome Extension, completely bypassing anti-bot systems like Cloudflare, DataDome, and Akamai.

---

## How It Works

```
[Chrome Extension]  →  picks element, observes mutations
        ↓
[Background Worker] →  fires signed webhook with state diff
        ↓
[FastAPI Backend]   →  validates payload, formats message
        ↓
[Telegram Bot]      →  delivers notification to your chat
```

---

## Features

- **Visual Element Picker** — hover to highlight, click to lock any element on any page
- **Smart CSS Selector Engine** — fallback chain: `#id` → `.class` → `nth-of-type` path
- **Survives Page Refresh** — monitors resume automatically after any navigation via `CONTENT_SCRIPT_READY` handshake
- **Multi-Tab Support** — monitor different elements across multiple tabs simultaneously
- **State Diffing** — trims whitespace, debounces 2s, ignores invisible DOM noise
- **Exponential Backoff** — retries failed webhooks at 2s → 5s → 15s
- **Secure Token Storage** — write-only UI, token value never surfaces after first save
- **Auth Watchdog** — detects login redirects, fires `AUTH_REQUIRED` alert
- **Broken Selector Detection** — fires `SELECTOR_BROKEN` alert after 5 consecutive null lookups
- **Keep-Alive Heartbeat** — prevents session expiry on idle-sensitive sites

---

## Project Structure

```
├── backend/
│   ├── main.py           FastAPI app with /api/webhook endpoint
│   ├── models.py         Pydantic payload models + whitespace validators
│   ├── telegram.py       Async Telegram dispatch via httpx
│   ├── config.py         pydantic-settings .env loader
│   ├── requirements.txt
│   └── .env.example      Environment variable template
│
├── extension/
│   ├── manifest.json     MV3 manifest
│   ├── content.js        State machine + MutationObserver sensor
│   ├── background.js     Per-tab persistence, resume orchestration, webhook retry
│   ├── popup.html        Dark UI popup
│   ├── popup.js          Tab-aware state, write-only token setup
│   └── setup-token.js    Headless token setup via service worker console
│
└── tests/
    ├── demo.html              Local test page with toggleable elements
    ├── serve.js               Simple HTTP server for demo page
    ├── extension-test.js      End-to-end Playwright test
    ├── token-flow-test.js     Token setup UI test
    └── real-website-test.js   Resume-after-reload test on a real HTTPS site
```

---

## Setup

### 1. Telegram Bot

1. Message **@BotFather** on Telegram → `/newbot` → follow prompts → copy the token
2. Send your bot a message, then visit:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Copy the `chat.id` from the response

### 2. Backend

```bash
cd backend
cp .env.example .env
# Fill in your values:
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_CHAT_ID=...
#   WEBHOOK_AUTH_TOKEN=any-long-random-secret

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon → enter your webhook URL and auth token
5. Click **Save**

---

## Usage

1. Navigate to any page you want to monitor
2. Click the extension icon → **Pick Element**
3. Hover to highlight the target element → click to lock it
4. The extension enters **Monitoring** state — the popup shows the selector and baseline value
5. When the element's text changes, you receive a Telegram message instantly

### Telegram Notification Types

| Event | When it fires |
|---|---|
| `MUTATION_DETECTED` | Element text changed — includes before/after values |
| `AUTH_REQUIRED` | Page redirected to `/login`, `/signin`, or `/auth` |
| `SELECTOR_BROKEN` | CSS selector returned null 5 consecutive times |

---

## Webhook Payload

```json
{
  "trigger_id": "trg_9f37b2da",
  "url": "https://example.com/product",
  "selector": "button.add-to-cart",
  "event_type": "MUTATION_DETECTED",
  "timestamp": "2026-05-28T13:45:00Z",
  "data": {
    "previous_state": "Out of Stock",
    "current_state": "Add to Cart"
  }
}
```

All requests are authenticated via `Authorization: Bearer <token>` header. The server returns `401` for missing or invalid tokens and `422` for malformed payloads.

---

## Running Tests

```bash
cd tests
npm install
npx playwright install chromium

# Start the backend first
cd ../backend && uvicorn main:app --port 8000

# Full end-to-end test (localhost demo page)
node extension-test.js

# Token setup UI test
node token-flow-test.js

# Resume-after-reload on a real website
node real-website-test.js
```

---

## Security Notes

- Never commit your `.env` file — it's gitignored
- Use a strong random string for `WEBHOOK_AUTH_TOKEN` before exposing the backend publicly
- The auth token is stored in `chrome.storage.local` (sandboxed to the extension, not readable by web pages)
- The popup UI never displays the token value after the initial setup — it's write-only

---

## Tech Stack

| Layer | Technology |
|---|---|
| Chrome Extension | Manifest V3, MutationObserver, Service Worker |
| Backend | Python, FastAPI, Uvicorn, httpx, Pydantic |
| Notifications | Telegram Bot API |
| Tests | Playwright (Node.js) |
