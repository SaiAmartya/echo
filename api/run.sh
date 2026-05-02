#!/usr/bin/env bash
# Convenience runner. Activates .venv and starts uvicorn on :8000.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi
exec ./.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
