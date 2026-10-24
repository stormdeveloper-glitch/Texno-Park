import sqlite3, json, os

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Data', 'database.db')
db = sqlite3.connect(DB)
c = db.cursor()
c.execute("SELECT name FROM sqlite_master WHERE type='table'")
print('TABLES:', [r[0] for r in c.fetchall()])
c.execute("SELECT key, length(value) FROM store_data ORDER BY key")
print('KEYS:')
for k, l in c.fetchall():
    print('  ', k, l)

def get(key):
    c.execute("SELECT value FROM store_data WHERE key=?", (key,))
    r = c.fetchone()
    if not r:
        return None
    try:
        return json.loads(r[0])
    except Exception:
        return r[0]

staff = get('staff_users')
print('\n=== staff_users count:', len(staff) if staff else 0)
if staff:
    for u in staff:
        print('  id=%s login=%s name=%s role=%s salary=%r branch=%s active=%s' % (
            u.get('id'), u.get('login'), u.get('name'), u.get('role'),
            u.get('salary'), u.get('branch'), u.get('active')))

for k in ('salaryRecords', 'salaryHistory', 'staffSalaryHistory', 'cashFlow', 'expenses', 'employees'):
    v = get(k)
    if isinstance(v, list):
        print('\n=== %s (list, len=%d)' % (k, len(v)))
        for it in v[:10]:
            print('   ', json.dumps(it, ensure_ascii=False))
    elif isinstance(v, dict):
        print('\n=== %s (dict, keys=%s)' % (k, list(v.keys())))
    else:
        print('\n=== %s = %r' % (k, v))

db.close()
