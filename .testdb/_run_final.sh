#!/usr/bin/env bash
# Tuzatishlarni yakuniy tekshirish uchun vaqtinchalik server (faqat KLON baza).
cd "$(git rev-parse --show-toplevel)"
export DB_PATH="$PWD/.testdb/bughunt.db"
export PORT=5077
export FLASK_DEBUG=false
export CLICK_SECRET_KEY=testsecret
export CLICK_SERVICE_ID=222
export CLICK_MERCHANT_ID=333
export BOSS_DEFAULT_PASSWORD="$(grep -m1 '^BOSS_DEFAULT_PASSWORD=' .env | cut -d= -f2- | tr -d '\r')"
exec python app.py > .testdb/_final_server.log 2>&1
