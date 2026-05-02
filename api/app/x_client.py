from __future__ import annotations

import os

import httpx

_BASE_URL = "https://api.twitter.com"
_TIMEOUT = 15.0


class XRateLimitError(Exception):
    pass


class XUpstreamError(Exception):
    pass


class XNotFoundError(Exception):
    pass


class XAuthError(Exception):
    pass


def _bearer_token() -> str:
    token = os.environ.get("X_BEARER_TOKEN", "")
    if not token:
        raise XAuthError("X_BEARER_TOKEN not set")
    return token


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_bearer_token()}"}


async def fetch_user_by_username(username: str) -> dict | None:
    url = f"{_BASE_URL}/2/users/by/username/{username}"
    params = {"user.fields": "public_metrics,description,verified"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(url, headers=_headers(), params=params)
    if resp.status_code == 401:
        raise XAuthError("X Bearer token rejected")
    if resp.status_code == 404:
        raise XNotFoundError(f"User @{username} not found")
    if resp.status_code == 429:
        raise XRateLimitError("X API rate limit hit")
    if resp.status_code >= 500:
        raise XUpstreamError(f"X API returned {resp.status_code}")
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body and "data" not in body:
        raise XNotFoundError(f"User @{username} not found")
    return body.get("data")


async def fetch_followers_sample(user_id: str, n: int = 100) -> list[dict]:
    return await _fetch_connections(user_id, "followers", n)


async def fetch_following_sample(user_id: str, n: int = 100) -> list[dict]:
    return await _fetch_connections(user_id, "following", n)


async def _fetch_connections(user_id: str, kind: str, n: int) -> list[dict]:
    url = f"{_BASE_URL}/2/users/{user_id}/{kind}"
    params = {
        "max_results": min(n, 1000),
        "user.fields": "description,public_metrics,verified",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(url, headers=_headers(), params=params)
        if resp.status_code == 429:
            reset = resp.headers.get("x-rate-limit-reset")
            # one retry after the rate-limit window — skip the wait in tests/CI
            if reset:
                import asyncio
                import time
                delay = max(0.0, float(reset) - time.time())
                await asyncio.sleep(min(delay, 900))
            resp = await client.get(url, headers=_headers(), params=params)
            if resp.status_code == 429:
                raise XRateLimitError("X API rate limit hit")
        if resp.status_code == 401:
            raise XAuthError("X Bearer token rejected")
        if resp.status_code >= 500:
            raise XUpstreamError(f"X API returned {resp.status_code}")
        resp.raise_for_status()
        return resp.json().get("data") or []


async def fetch_me(access_token: str) -> dict:
    url = f"{_BASE_URL}/2/users/me"
    params = {"user.fields": "public_metrics,description,verified,username"}
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(url, headers=headers, params=params)
    if resp.status_code == 401:
        raise XAuthError("User token rejected")
    if resp.status_code == 429:
        raise XRateLimitError("X API rate limit hit")
    if resp.status_code >= 500:
        raise XUpstreamError(f"X API returned {resp.status_code}")
    resp.raise_for_status()
    return resp.json().get("data") or {}


async def fetch_user_by_username_with_token(access_token: str) -> dict:
    return await fetch_me(access_token)


async def fetch_followers_sample_with_token(user_id: str, access_token: str, n: int = 100) -> list[dict]:
    return await _fetch_connections_with_token(user_id, "followers", access_token, n)


async def fetch_following_sample_with_token(user_id: str, access_token: str, n: int = 100) -> list[dict]:
    return await _fetch_connections_with_token(user_id, "following", access_token, n)


async def _fetch_connections_with_token(user_id: str, kind: str, access_token: str, n: int) -> list[dict]:
    url = f"{_BASE_URL}/2/users/{user_id}/{kind}"
    params = {"max_results": min(n, 1000), "user.fields": "description,public_metrics,verified"}
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(url, headers=headers, params=params)
        if resp.status_code == 429:
            reset = resp.headers.get("x-rate-limit-reset")
            if reset:
                import asyncio, time
                delay = max(0.0, float(reset) - time.time())
                await asyncio.sleep(min(delay, 900))
            resp = await client.get(url, headers=headers, params=params)
            if resp.status_code == 429:
                raise XRateLimitError("X API rate limit hit")
        if resp.status_code == 401:
            raise XAuthError("User token rejected")
        if resp.status_code >= 500:
            raise XUpstreamError(f"X API returned {resp.status_code}")
        resp.raise_for_status()
    return resp.json().get("data") or []
