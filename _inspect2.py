import sys, io, sqlite3, os

# Write results to a file with UTF-8 encoding
out = []
def log(msg=""):
    out.append(str(msg))

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Data", "database.db")
c = sqlite3.connect(DB)
cur = c.cursor()

print("=== store_data FULL SCHEMA ===")
for row in cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_data'"):
    print(row[0])

print("\n=== store_data sample rows ===")
for row in cur.execute("SELECT * FROM store_data LIMIT 5"):
    print(repr(row))

print("\n=== store_data total count ===")
print(cur.execute("SELECT COUNT(*) FROM store_data").fetchone())

print("\n=== branches ===")
try:
    for row in cur.execute("SELECT id, name, address, phone, deleted, createdAt FROM branches ORDER BY id"):
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== products (first 10) ===")
try:
    for row in cur.execute("SELECT id, name, price, cost, stock, branch_id, deleted, createdAt FROM products ORDER BY id LIMIT 10"):
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== products count ===")
try:
    print(cur.execute("SELECT COUNT(*), SUM(stock), SUM(deleted) FROM products").fetchone())
except Exception as e:
    print("ERR:", e)

print("\n=== sales (first 15) ===")
try:
    for row in cur.execute("SELECT id, product_id, quantity, unit_price, branch_id, status, createdAt FROM sales ORDER BY id DESC LIMIT 15"):
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

print("\n=== settings (first 30) ===")
try:
    for row in cur.execute("SELECT name, value FROM settings LIMIT 30"):
        print(row)
except Exception as e:
    print("ERR:", e)

print("\n=== categories count ===")
try:
    print(cur.execute("SELECT COUNT(*) FROM categories").fetchone())
except Exception as e:
    print("ERR:", e)

c.close()
