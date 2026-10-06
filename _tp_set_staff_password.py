"""Mavjud xodimlar (staff_users) parolini yangilash — parol KODDA saqlanmaydi.

Parol manbasi:
  1) TP_STAFF_PASSWORD muhit o'zgaruvchisi (tavsiya etiladi)
  2) interaktiv kiritish (getpass)

Ishlatish (PowerShell):
  $env:TP_STAFF_PASSWORD='<yangi parol>'; python _tp_set_staff_password.py
  $env:TP_STAFF_PASSWORD='<parol>'; python _tp_set_staff_password.py --verify

Nima qilinadi:
  - app.py dagi `hash_password` bilan BIR XIL sxema: sha256(salt + '::' + parol)
  - admin / cashier / manager va ularning eski email taxalluslari yangilanadi
  - FAQAT `passHash`, `mustChange`, `updatedAt` maydonlari o'zgaradi
  - id / login / phone / name / role / status O'ZGARMAYDI
  - shu loginlarning eski sessiyalari yopiladi (parol almashganda xavfsiz)
  - `customer` hisobiga tegilmaydi
  - ochiq parol hech qayerga yozilmaydi (baza/LOG/frontend)
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime

DB_PATH = os.getenv('DB_PATH') or os.path.join('Data', 'database.db')

# Yangilanadigan loginlar: 3 ta rol + ularning eski email taxalluslari.
TARGET_LOGINS = (
    'admin', 'cashier', 'manager',
    'admin@texnopark.uz', 'cashier@texnopark.uz', 'manager@texnopark.uz',
)

STAFF_KEY = 'staff_users'
SESSION_KEY = 'active_sessions'


def hash_password(password: str, salt: str) -> str:
    """app.py dagi `hash_password` bilan bir xil (frontend bilan ham mos)."""
    return hashlib.sha256(f'{salt}::{password}'.encode('utf-8')).hexdigest()


def read_password() -> str:
    pwd = (os.getenv('TP_STAFF_PASSWORD') or '').strip()
    if pwd:
        return pwd
    if not sys.stdin.isatty():
        print('[XATO] Parol berilmadi. TP_STAFF_PASSWORD muhit o\'zgaruvchisini o\'rnating.')
        sys.exit(2)
    return getpass.getpass('Yangi parol: ').strip()


def connect() -> sqlite3.Connection:
    if not os.path.exists(DB_PATH):
        print(f'[XATO] Baza topilmadi: {DB_PATH}')
        sys.exit(3)
    return sqlite3.connect(DB_PATH)


def load_key(conn: sqlite3.Connection, key: str):
    row = conn.execute('SELECT value FROM store_data WHERE key = ?', (key,)).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except Exception:
        return None


def save_key(conn: sqlite3.Connection, key: str, value) -> None:
    payload = json.dumps(value, ensure_ascii=False)
    cur = conn.execute('UPDATE store_data SET value = ? WHERE key = ?', (payload, key))
    if cur.rowcount == 0:
        conn.execute('INSERT INTO store_data (key, value) VALUES (?, ?)', (key, payload))
    conn.commit()


def main() -> int:
    verify_only = '--verify' in sys.argv
    password = read_password()
    if len(password) < 6:
        print('[XATO] Parol kamida 6 belgidan iborat bo\'lishi kerak.')
        return 4

    conn = connect()
    staff = load_key(conn, STAFF_KEY)
    if not isinstance(staff, list) or not staff:
        print('[XATO] Bazada staff_users yo\'q — avval serverni bir marta ishga tushiring.')
        return 5

    stamp = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    rows, changed = [], 0

    for user in staff:
        if not isinstance(user, dict):
            continue
        login = str(user.get('login', '')).strip().lower()
        if login not in TARGET_LOGINS:
            continue
        salt = str(user.get('salt') or '')
        expected = hash_password(password, salt)
        stored = str(user.get('passHash') or '')
        ok = hmac_equal(expected, stored)
        rows.append((user.get('login'), user.get('role'), user.get('phone'),
                     str(user.get('status', 'active')), ok))
        if verify_only:
            continue
        if stored != expected:
            changed += 1
        # Faqat parol maydonlari yangilanadi — boshqa ma'lumot tegilmaydi.
        user['passHash'] = expected
        user['mustChange'] = False
        user['updatedAt'] = stamp

    if not rows:
        print('[XATO] Maqsadli loginlar bazadan topilmadi:', ', '.join(TARGET_LOGINS))
        return 6

    print(f'{"LOGIN":<24}{"ROLE":<10}{"PHONE":<16}{"STATUS":<10}PAROL')
    for login, role, phone, status, ok in rows:
        print(f'{login:<24}{str(role):<10}{str(phone or "-"):<16}{status:<10}'
              f'{"TO\'G\'RI" if ok else "MOS EMAS"}')

    if verify_only:
        conn.close()
        return 0 if all(r[4] for r in rows) else 1

    save_key(conn, STAFF_KEY, staff)

    # Parol almashgani uchun shu loginlarning eski sessiyalari yopiladi.
    sessions = load_key(conn, SESSION_KEY)
    if isinstance(sessions, list):
        kept = [s for s in sessions
                if str(s.get('login', '')).lower() not in TARGET_LOGINS]
        if len(kept) != len(sessions):
            save_key(conn, SESSION_KEY, kept)
            print(f'Eski sessiyalar yopildi: {len(sessions) - len(kept)}')

    print(f'Yangilandi: {changed} yozuv (jami {len(rows)}). Ochiq parol saqlanmadi — faqat xesh.')

    # Frontend (oflayn rejim) uchun yangi xeshlar — `USERS` ro'yxatidagi passHash.
    print('\nFrontend `USERS` uchun (ochiq parol EMAS, xesh):')
    seen = set()
    for user in staff:
        login = str(user.get('login', '')).strip().lower()
        if login in TARGET_LOGINS and user.get('salt') not in seen:
            seen.add(user.get('salt'))
            print(f"  {login:<12} salt={user.get('salt')}  passHash={user.get('passHash')}")

    conn.close()
    return 0


def hmac_equal(a: str, b: str) -> bool:
    import hmac
    return hmac.compare_digest(str(a), str(b))


if __name__ == '__main__':
    sys.exit(main())
