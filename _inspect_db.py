import sqlite3, json, os

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Data", "database.db")
print("DB path:", DB)
print("Exists:", os.path.exists(DB))
c = sqlite3.connect(DB)
cur = c.cursor()

print("\n=== TABLES ===")
for row in cur.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"):
    print(row[0])
    print("  SQL:", row[1][:500])

print("\n=== INDEXES ===")
for row in cur.execute("SELECT name, sql FROM sqlite_master WHERE type='index'"):
    print(row[0])
    sql = row[1] if row[1] else "(none)"
    print("  SQL:", sql[:400])


print("\n=== store_data keys (first 40) ===")
rows = cur.execute("SELECT name, substr(value,1,300) FROM store_data ORDER BY name LIMIT 40").fetchall()
for name, val in rows:
    print(f"  {name} = {val}")

print("\n=== store_data total count ===")
print(cur.execute("SELECT COUNT(*) FROM store_data").fetchone())

print("\n=== branches ===")
try:
    for row in cur.execute("SELECT id, name, address, phone, createdAt FROM branches ORDER BY id"):
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== products (first 20) ===")
try:
    for row in cur.execute("SELECT id, name, price, tannarx, cost, stock, branch_id, deleted, createdAt FROM products ORDER BY id LIMIT 20").fetchall():
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== products count ===")
try:
    print(cur.execute("SELECT COUNT(*), SUM(stock), SUM(deleted) FROM products").fetchone())
except Exception as e:
    print("ERR:", e)

print("\n=== sales (first 20) ===")
try:
    for row in cur.execute("SELECT id, product_id, quantity, unit_price, branch_id, status, createdAt FROM sales ORDER BY id DESC LIMIT 20").fetchall():
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== sales count by status ===")
try:
    print(cur.execute("SELECT status, COUNT(*) FROM sales GROUP BY status").fetchall())
except Exception as e:
    print("ERR:", e)

print("\n=== categories ===")
try:
    for row in cur.execute("SELECT id, name, color, icon, sort_order FROM categories ORDER BY sort_order"):
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== settings ===")
try:
    for row in cur.execute("SELECT name, value FROM settings"):
        print(row)
except Exception as e:
    print("ERR:", e)

c.close()
