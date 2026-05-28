from typing import Optional, Dict
from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from enum import Enum


class EventType(str, Enum):
    MUTATION_DETECTED = "MUTATION_DETECTED"
    AUTH_REQUIRED = "AUTH_REQUIRED"
    SELECTOR_BROKEN = "SELECTOR_BROKEN"


class WebhookPayload(BaseModel):
    trigger_id: str = Field(..., min_length=1)
    url: str = Field(..., min_length=1)
    selector: str = Field(..., min_length=1)
    event_type: EventType
    timestamp: datetime
    data: Optional[Dict[str, str]] = None

    @field_validator("trigger_id", "url", "selector", mode="before")
    @classmethod
    def strip_and_require(cls, v: str) -> str:
        stripped = v.strip() if isinstance(v, str) else v
        if not stripped:
            raise ValueError("field must not be empty or whitespace-only")
        return stripped
