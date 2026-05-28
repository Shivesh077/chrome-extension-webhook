import logging
import httpx
from models import WebhookPayload, EventType
from config import settings

logger = logging.getLogger(__name__)

TELEGRAM_API_URL = "https://api.telegram.org/bot{token}/sendMessage"

_ICONS = {
    EventType.MUTATION_DETECTED: "🟡",
    EventType.AUTH_REQUIRED: "🔐",
    EventType.SELECTOR_BROKEN: "⚠️",
}


def _format_message(payload: WebhookPayload) -> str:
    icon = _ICONS.get(payload.event_type, "ℹ️")
    ts = payload.timestamp.strftime("%Y-%m-%d %H:%M:%S UTC")

    lines = [
        f"{icon} <b>Webhook Alert: {payload.event_type.value}</b>",
        "",
        f"<b>Trigger ID:</b> <code>{payload.trigger_id}</code>",
        f"<b>URL:</b> {payload.url}",
        f"<b>Selector:</b> <code>{payload.selector}</code>",
        f"<b>Time:</b> {ts}",
    ]

    if payload.event_type == EventType.MUTATION_DETECTED and payload.data:
        lines += [
            "",
            "<b>State Change:</b>",
            f"  🔴 <b>Before:</b> <code>{payload.data.get('previous_state', 'N/A')}</code>",
            f"  🟢 <b>After:</b>  <code>{payload.data.get('current_state', 'N/A')}</code>",
        ]
    elif payload.event_type == EventType.AUTH_REQUIRED:
        lines += ["", "⚠️ <i>Session expired — re-authentication required on the monitored page.</i>"]
    elif payload.event_type == EventType.SELECTOR_BROKEN:
        lines += ["", "🛑 <i>CSS selector no longer resolves. The page layout may have changed.</i>"]

    return "\n".join(lines)


async def dispatch_telegram(payload: WebhookPayload) -> None:
    message = _format_message(payload)
    url = TELEGRAM_API_URL.format(token=settings.telegram_bot_token)
    body = {
        "chat_id": settings.telegram_chat_id,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=body)
            response.raise_for_status()
            logger.info(
                "Telegram dispatch succeeded",
                extra={"telegram_message_id": response.json().get("result", {}).get("message_id")},
            )
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Telegram API returned error status",
            extra={"status_code": exc.response.status_code, "body": exc.response.text},
        )
    except httpx.RequestError as exc:
        logger.error("Telegram API request failed (network/timeout)", extra={"error": str(exc)})
