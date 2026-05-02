from __future__ import annotations
import base64, hashlib, hmac, json, os, secrets, time
import httpx

_CLIENT_ID = lambda: os.environ.get("X_CLIENT_ID", "")
_CLIENT_SECRET = lambda: os.environ.get("X_CLIENT_SECRET", "")
_REDIRECT_URI = lambda: os.environ.get("X_REDIRECT_URI", "http://localhost:8000/x/callback")
_STATE_SECRET = lambda: os.environ.get("X_OAUTH_STATE_SECRET", "echo-dev-secret").encode()

SCOPES = "tweet.read users.read follows.read offline.access"
_AUTH_URL = "https://twitter.com/i/oauth2/authorize"
_TOKEN_URL = "https://api.twitter.com/2/oauth2/token"

def make_pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge

def make_state(uid: str) -> str:
    payload = json.dumps({"uid": uid, "exp": int(time.time()) + 600})
    b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    sig = hmac.new(_STATE_SECRET(), b64.encode(), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"

def verify_state(state: str, uid: str) -> bool:
    try:
        b64, sig = state.rsplit(".", 1)
        expected = hmac.new(_STATE_SECRET(), b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        payload = json.loads(base64.urlsafe_b64decode(b64 + "=="))
        return payload.get("uid") == uid and payload.get("exp", 0) > time.time()
    except Exception:
        return False

def build_authorize_url(state: str, code_challenge: str) -> str:
    import urllib.parse
    params = {
        "response_type": "code",
        "client_id": _CLIENT_ID(),
        "redirect_uri": _REDIRECT_URI(),
        "scope": SCOPES,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{_AUTH_URL}?{urllib.parse.urlencode(params)}"

async def exchange_code(code: str, code_verifier: str) -> dict:
    # Native App (public client) — send client_id in body, no Basic auth.
    # Web App (confidential client) would use auth=(_CLIENT_ID(), _CLIENT_SECRET()).
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": _CLIENT_ID(),
                "code": code,
                "redirect_uri": _REDIRECT_URI(),
                "code_verifier": code_verifier,
            },
        )
    resp.raise_for_status()
    return resp.json()

async def refresh_token(token: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": _CLIENT_ID(),
                "refresh_token": token,
            },
        )
    resp.raise_for_status()
    return resp.json()
