import sys
sys.path.insert(0, '.')
import app as tp
from datetime import datetime

CASES = [
    ('05.10.2026', 'DD.MM.YYYY -> 2026-10-05'),
    ('09.10.2026', 'DD.MM.YYYY -> 2026-10-09'),
    ('28.12.2025', 'DD.MM.YYYY -> 2025-12-28'),
    ('2026-10-05', 'ISO -> 2026-10-05'),
    ('2026-10-05T12:30:00', 'ISO+time -> 2026-10-05'),
    ('2026-10-05 12:30:00', 'ISO space -> 2026-10-05'),
]

# Kutilgan natija HAR BIR kirish uchun aniq (oldingi kod faqat '05.10' uchun
# `want` hisoblab, qolgan to'g'ri javoblarni noto'g'ri FAIL deb ko'rsatgan edi).
EXPECTED = {
    '05.10.2026': datetime(2026, 10, 5),
    '09.10.2026': datetime(2026, 10, 9),
    '28.12.2025': datetime(2025, 12, 28),
    '2026-10-05': datetime(2026, 10, 5),
    '2026-10-05T12:30:00': datetime(2026, 10, 5),
    '2026-10-05 12:30:00': datetime(2026, 10, 5),
}

print('=== SANA PARSINGI ===')
bad = 0
for raw, label in CASES:
    got = tp.parse_business_date(raw)
    want = EXPECTED.get(raw)
    ok = got == want
    if not ok:
        bad += 1
    print(f"  {'OK  ' if ok else 'FAIL'} {raw:22} -> {got}   ({label})")

print('\n=== DAVR FILTRI ===')
today = datetime.now().strftime('%d.%m.%Y')
store = {'sales': [
    {'date': today, 'total': 100, 'cashier': 'A'},
    {'date': (datetime.now().replace(day=max(1, datetime.now().day - 3))).strftime('%d.%m.%Y'),
     'total': 200, 'cashier': 'A'},
]}
for period in ('day', 'week', 'month', 'all'):
    rows = tp.sales_in_period(store, period)
    print(f'  {period:6} -> {len(rows)} ta yozuv')

print(f'\n=== XATO: {bad} ===')