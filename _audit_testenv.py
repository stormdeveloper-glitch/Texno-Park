"""Vaqtinchalik test muhiti: jonli bazaning NUSXASI + vaqtinchalik akountlar.

Jonli bazaga (`C:\\app\\data\\database.db`) HECH NARSA yozilmaydi.
"""
import hashlib, json, os, shutil, sqlite3, sys

LIVE = r'C:\app\data\database.db'
DST_DIR = '.testdb'
DST = os.path.join(DST_DIR, 'test.db')

TEST_USERS = [
    {'login': 'auditadmin', 'phone': '+998900000001', 'role': 'admin',
     'name': 'Audit Admin', 'password': 'AuditTest-Admin-2026'},
    {'login': 'auditboss', 'phone': '+998900000002', 'role': 'boss',
     'name': 'Audit Boshliq', 'password': 'AuditTest-Boss-2026'},
]


def hash_password(password, salt):
    return hashlib.sha256(f'{salt}::{password}'.encode('utf-8')).hexdigest()


def main():
    os.makedirs(DST_DIR, exist_ok=True)
    # sqlite backup — WAL dagi ma'lumotlar ham to'liq ko'chadi
    src = sqlite3.connect(LIVE)
    dst = sqlite3.connect(DST)
    src.backup(dst)
    dst.close()
    src.close()

    con = sqlite3.connect(DST)
    row = con.execute("SELECT value FROM store_data WHERE key='staff_users'").fetchone()
    staff = json.loads(row[0]) if row else []
    existing = {str(u.get('login')) for u in staff}
    next_id = max([int(u.get('id') or 0) for u in staff] + [0]) + 1
    added = []
    for item in TEST_USERS:
        if item['login'] in existing:
            continue
        salt = 'aud-' + os.urandom(4).hex()
        staff.append({
            'id': next_id, 'login': item['login'], 'phone': item['phone'],
            'salt': salt, 'passHash': hash_password(item['password'], salt),
            'name': item['name'], 'role': item['role'], 'status': 'active',
            'mustChange': False, 'branchId': '',
            'createdAt': '09.10.2026 22:00:00', 'updatedAt': '09.10.2026 22:00:00',
        })
        added.append(item['login'])
        next_id += 1
    if added:
        con.execute("UPDATE store_data SET value=? WHERE key='staff_users'",
                    (json.dumps(staff, ensure_ascii=False),))
        con.commit()
    con.close()
    print('test baza tayyor:', DST, '| qo\'shilgan:', added or '(bor)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
