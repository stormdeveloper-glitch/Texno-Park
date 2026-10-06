# -*- coding: utf-8 -*-
"""
TEXNO PARK N1 — STALE LOGIN LOCK RESET / AUDIT (dev/test)

Vazifa (faqat development/test muhiti uchun):
  1) SQLite `staff_users` yozuvlarida qolib ketgan (stale) lock maydonlarini
     topadi: failedAttempts / lockedUntil / lockUntil / blocked / loginAttempts
     (va boshqa shu kabi nomlar). Ular bo'lsa `--reset` bilan xavfsiz olib
     tashlaydi / hisobni 'active' holatiga qaytaradi.
  2) 4 ta asosiy hisobni tekshiradi:
        BOSHLIQ  +998901234554
        ADMIN    +998908480921
        MANAGER  +998902750921
        CASHIER  +998905450921
     — hech biri BLOCKED/LOCKED bo'lmasligi kerak.
  3) Har bir hisobning parol xeshi 'diyorbek6272' bilan mosligini tekshiradi
     (app.py dagi sxema: sha256(salt + '::' + password)).
  4) Server tomonidagi IP rate-limit (in-memory `_login_attempts`) ishga
     tushirilgan jarayon xotirasida turadi — server qayta ishga tushirilsa
     o'zi tozalanadi (bu skript uni o'chira olmaydi).

ISHLATISH:
    python _reset_auth_lock.py            # faqat AUDIT (hech nima o'zgartirmaydi)
    python _reset_auth_lock.py --reset    # audit + stale lock maydonlarini tozalash

MUHIM:
    - PRODUCTION lockout mexanizmi o'chirilmaydi. Bu skript faqat DB dagi
      eskirgan/yopishib qolgan holatlarni tuzatadi.
    - Brauzerdagi `tp_login_guard` (localStorage) kaliti konsolda
      `resetLoginLock()` yoki `localStorage.removeItem('tp_login_guard')`
      orqali tozalanadi (buni DB skripti qila olmaydi — brauzer tomoni).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv('DB_PATH') or os.path.join(BASE_DIR, 'Data', 'database.db')

PASSWORD = 'diyorbek6272'

ACCOUNTS = [
    ('BOSHLIQ', '+998901234554', 'boss'),
    ('ADMIN', '+998908480921', 'admin'),
    ('MANAGER', '+998902750921', 'manager'),
    ('CASHIER', '+998905450921', 'cashier'),
]

LOCK_FIELDS = (
    'failedAttempts', 'failed_attempts', 'failedattempts',
    'lockedUntil', 'lockUntil', 'locked_until',
    'blocked', 'blockedUntil', 'isBlocked',
    'loginAttempts', 'login_attempts', 'failCount',
)

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def normalize_phone(value: str) -> str:
    """app.py normalize_phone bilan bir xil: yaroqli bo'lsa +998XXXXXXXXX."""
    digits = re.sub(r'\D', '', str(value or ''))
    if not digits:
        return ''
    if len(digits) == 12 and digits.startswith('998'):
        local = digits[3:]
    elif len(digits) == 9:
        local = digits
    else:
        return ''
    if local[0] == '0':
        return ''
    return f'+998{local}'


def hash_password(password: str, salt: str) -> str:
    """app.py hash_password bilan bir xil: sha256(salt + '::' + parol)."""
    return hashlib.sha256(f'{salt}::{password}'.encode('utf-8')).hexdigest()


def connect() -> sqlite3.Connection:
    if not os.path.exists(DB_PATH):
        print(f'[XATO] Baza topilmadi: {DB_PATH}')
        sys.exit(3)
    return sqlite3.connect(DB_PATH)


def load_staff(conn: sqlite3.Connection):
    row = conn.execute("SELECT value FROM store_data WHERE key = 'staff_users'").fetchone()
    if not row:
        return []
    try:
        val = json.loads(row[0])
    except Exception:
        return []
    return val if isinstance(val, list) else []


def save_staff(conn: sqlite3.Connection, staff) -> bool:
    conn.execute(
        "UPDATE store_data SET value = ? WHERE key = 'staff_users'",
        (json.dumps(staff, ensure_ascii=False),),
    )
    conn.commit()
    return True


def main() -> int:
    reset = '--reset' in sys.argv
    print('=' * 70)
    print('TEXNO PARK N1 — STALE LOGIN LOCK AUDIT/RESET (dev/test)')
    print('=' * 70)
    print(f'Baza: {DB_PATH}')
    print(f'Rejim: {"RESET (tuzatish)" if reset else "AUDIT (faqat tekshiruv)"}')
    print()

    conn = connect()
    staff = load_staff(conn)
    if not staff:
        print('[XATO] staff_users bo\'sh yoki topilmadi.')
        return 2

    changed = False
    fails = 0

    print('--- 1) HISOB HOLATI (status / lock maydonlari) ---')
    for label, phone, role in ACCOUNTS:
        user = next((u for u in staff if normalize_phone(u.get('phone', '')) == phone), None)
        if user is None:
            print(f'  [FAIL] {label}: {phone} — akkaunt bazada TOPILMADI')
            fails += 1
            continue

        status = str(user.get('status', 'active')).strip().lower() or 'active'
        ok_status = status == 'active'
        lock_fields = [k for k in LOCK_FIELDS if k in user and user[k] not in (None, '', 0, False)]
        if not ok_status or lock_fields:
            print(f'  [WARN] {label}: {phone} — status={status!r}, lock maydonlari={lock_fields}')
            if reset:
                user['status'] = 'active'
                for k in lock_fields:
                    user.pop(k, None)
                changed = True
                print(f'         -> --reset: status "active", {lock_fields} olib tashlandi')
            else:
                fails += 1
        else:
            print(f'  [OK]   {label}: {phone} — status=active, lock maydonlari yo\'q')

    print()
    print('--- 2) PAROL XESHI TEKSHIRUVI (diyorbek6272) ---')
    for label, phone, role in ACCOUNTS:
        user = next((u for u in staff if normalize_phone(u.get('phone', '')) == phone), None)
        if user is None:
            continue
        salt = str(user.get('salt') or '')
        expected = hash_password(PASSWORD, salt)
        stored = str(user.get('passHash') or '')
        ok = bool(expected) and bool(stored) and expected == stored
        if not ok:
            fails += 1
            print(f'  [FAIL] {label}: {phone} — parol xeshi MOS EMAS '
                  f'(stored={stored[:16]}…, expected={expected[:16]}…)')
        else:
            print(f'  [OK]   {label}: {phone} — xesh mos ({stored[:16]}…, rol={user.get("role")})')

    print()
    print('--- 3) BARCHA XODIMLAR: BLOCKED/LOCKED HOLATI ---')
    for user in staff:
        status = str(user.get('status', 'active')).strip().lower() or 'active'
        lock_fields = [k for k in LOCK_FIELDS if k in user and user[k] not in (None, '', 0, False)]
        if status != 'active' or lock_fields:
            print(f'  [WARN] {user.get("login")} ({user.get("phone")}) status={status!r} lock={lock_fields}')
            if reset:
                user['status'] = 'active'
                for k in lock_fields:
                    user.pop(k, None)
                changed = True
                print('         -> --reset: "active" qilindi / lock maydonlari olib tashlandi')
        else:
            print(f'  [OK]   {user.get("login")} ({user.get("phone")}) — active, lock yo\'q')

    if changed:
        ok_save = save_staff(conn, staff)
        print()
        print(f'[SAQLANDI] staff_users yangilandi ({ok_save}).')
    conn.close()
    print_instructions()
    print()
    print(f'Jami muammo: {fails}')
    return 1 if (fails and not reset) else 0


def print_instructions():
    print()
    print('--- 4) BRAUZER TOMONI (localStorage tp_login_guard) ---')
    print('  DB dagi lock <-> brauzerdagi lock ALOHIDA. Tozalash uchun:')
    print('  1) Sahifani oching (file:// yoki http://localhost:5000)')
    print('  2) Chrome/Firefox DevTools -> Console da quyidagilarni kiriting:')
    print('       resetLoginLock();            // barcha eski urlanishlar')
    print('       localStorage.removeItem("tp_login_guard");')
    print('  3) Server IP-rate-limit (in-memory) server qayta ishga')
    print('     tushirilganda o\'zi tozalanadi (Flask jarayoni xotirasida).')


if __name__ == '__main__':
    sys.exit(main())