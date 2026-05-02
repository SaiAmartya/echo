"""Firebase Auth verification for the Echo API.

Loads a Firebase service account at module import (idempotent — Firebase Admin
keeps a single default app), then exposes two FastAPI dependencies:

  * `current_user_uid(authorization)` — for normal endpoints; reads the
    `Authorization: Bearer <id_token>` header.
  * `current_user_uid_from_query(token)` — for SSE/EventSource endpoints
    where browsers can't attach Authorization headers; reads `?token=...`.

Configure exactly one of:
  GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/service-account.json
  FIREBASE_SERVICE_ACCOUNT_JSON=<inline JSON string>

In dev (no creds), set FIREBASE_AUTH_DISABLED=1 to bypass verification — every
request gets uid="dev-local". Never set in prod.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Annotated

from fastapi import Header, HTTPException, Query

log = logging.getLogger("echo.auth")

_DEV_BYPASS = os.environ.get("FIREBASE_AUTH_DISABLED") == "1"
_DEV_UID = "dev-local"

_admin_initialized = False


def _init_admin() -> None:
    """Idempotent firebase-admin init. Raises if no creds and not in dev mode."""
    global _admin_initialized
    if _admin_initialized:
        return

    if _DEV_BYPASS:
        log.warning("FIREBASE_AUTH_DISABLED=1 — auth verification is BYPASSED")
        _admin_initialized = True
        return

    import firebase_admin
    from firebase_admin import credentials

    if firebase_admin._apps:
        _admin_initialized = True
        return

    inline = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")

    if inline:
        cred = credentials.Certificate(json.loads(inline))
    elif cred_path:
        cred = credentials.Certificate(cred_path)
    else:
        raise RuntimeError(
            "Firebase Admin not configured. Set GOOGLE_APPLICATION_CREDENTIALS "
            "or FIREBASE_SERVICE_ACCOUNT_JSON, or FIREBASE_AUTH_DISABLED=1 for dev."
        )

    firebase_admin.initialize_app(cred)
    _admin_initialized = True


def _verify_token(id_token: str) -> str:
    """Verify a Firebase ID token. Returns uid. Raises HTTPException(401)."""
    if _DEV_BYPASS:
        return _DEV_UID

    _init_admin()

    from firebase_admin import auth as fb_auth

    try:
        decoded = fb_auth.verify_id_token(id_token)
    except (
        fb_auth.ExpiredIdTokenError,
        fb_auth.RevokedIdTokenError,
        fb_auth.InvalidIdTokenError,
    ) as exc:
        raise HTTPException(
            status_code=401,
            detail={"detail": "invalid or expired token", "code": "auth_invalid"},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("token verification crashed: %r", exc)
        raise HTTPException(
            status_code=401,
            detail={"detail": "token verification failed", "code": "auth_invalid"},
        ) from exc

    uid = decoded.get("uid")
    if not uid or not isinstance(uid, str):
        raise HTTPException(
            status_code=401,
            detail={"detail": "token missing uid", "code": "auth_invalid"},
        )
    return uid


def current_user_uid(
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    """FastAPI dependency: extract Firebase uid from `Authorization: Bearer ...`."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail={"detail": "missing bearer token", "code": "auth_missing"},
        )
    token = authorization.split(None, 1)[1].strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"detail": "missing bearer token", "code": "auth_missing"},
        )
    return _verify_token(token)


def current_user_uid_from_query(
    token: Annotated[str | None, Query()] = None,
) -> str:
    """FastAPI dependency for SSE: extract uid from `?token=<id_token>`."""
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"detail": "missing token query param", "code": "auth_missing"},
        )
    return _verify_token(token)
