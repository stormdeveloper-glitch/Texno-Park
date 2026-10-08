import sqlite3, os, json
from datetime import datetime

DB = os.environ.get("DB_PATH", "data/database.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

tables=[]
try:
    cur=conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables=[r['name'] for r in cur.fetchall()]
except Exception as e:
    tables=[f"ERR:{e}"]

print("DB:",DB)
print(json.dumps(tables,ensure_ascii=False,indent=1))

def col(tn):
    try:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({tn})").fetchall()]
    except Exception as e:
        return [f"ERR:{e}"]

for tn in tables:
    print(f"\nTABLE {tn}")
    print("cols:",json.dumps(col(tn),ensure_ascii=False))
    try:
        cnt=conn.execute(f"SELECT COUNT(*) c FROM {tn}").fetchone()['c']
        print("rows:",cnt)
    except Exception as e:
        print("rows ERR:",e)
    try:
        cur=conn.execute(f"SELECT * FROM {tn} LIMIT 2")
        rows=cur.fetchall()
        if rows:
            print("sample:",json.dumps([dict(r) for r in rows],ensure_ascii=False))
    except Exception as e:
        print("sample ERR:",e)

conn.close()
