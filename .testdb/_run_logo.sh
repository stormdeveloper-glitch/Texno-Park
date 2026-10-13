#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"
export DB_PATH="$PWD/.testdb/logo_verify.db"
export PORT=5088
export FLASK_DEBUG=false
export CLICK_SECRET_KEY=testsecret
export CLICK_SERVICE_ID=222
export CLICK_MERCHANT_ID=333
export BOSS_DEFAULT_PASSWORD="$(grep -m1 '^BOSS_DEFAULT_PASSWORD=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r')"
exec python app.py
