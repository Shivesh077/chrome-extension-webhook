import logging
import logging.config
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader

from config import settings
from models import WebhookPayload
from telegram import dispatch_telegram

# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------
LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json_like": {
            "format": '{"time": "%(asctime)s", "level": "%(levelname)s", "logger": "%(name)s", "msg": "%(message)s"}',
            "datefmt": "%Y-%m-%dT%H:%M:%SZ",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "json_like",
        }
    },
    "root": {"handlers": ["console"], "level": "INFO"},
}

logging.config.dictConfig(LOGGING_CONFIG)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Webhook server starting up")
    yield
    logger.info("Webhook server shutting down")


app = FastAPI(
    title="Universal Webhook Mutation Trigger",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tightened in production via env
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------
_api_key_header = APIKeyHeader(name="Authorization", auto_error=False)


async def verify_token(raw_header: str | None = Depends(_api_key_header)) -> None:
    """Accepts 'Bearer <token>' or bare '<token>' in the Authorization header."""
    if raw_header is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")

    token = raw_header.removeprefix("Bearer ").strip()
    if token != settings.webhook_auth_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health", tags=["ops"])
async def health_check():
    return {"status": "ok"}


@app.post("/api/webhook", status_code=status.HTTP_200_OK, tags=["webhook"])
async def receive_webhook(
    payload: WebhookPayload,
    _: None = Depends(verify_token),
):
    logger.info(
        "Webhook received",
        extra={
            "event_type": payload.event_type.value,
            "url": payload.url,
            "trigger_id": payload.trigger_id,
        },
    )

    await dispatch_telegram(payload)

    logger.info(
        "Webhook processed",
        extra={"trigger_id": payload.trigger_id, "event_type": payload.event_type.value},
    )

    return {"status": "accepted", "trigger_id": payload.trigger_id}
