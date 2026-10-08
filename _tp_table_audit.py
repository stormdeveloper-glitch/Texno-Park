# -*- coding: utf-8 -*-
"""Table column audit: compares each <table> header count in index.html with
the number of <td> cells the JS row renderer emits for its <tbody>, and with
colspan= values used for empty states. Read-only diagnostic."""
import re
import io
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
base = os.path.dirname(os.path.abspath(__file__))


def read(p):
    with io.open(os.path.join(base, p), 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


html = read('index.html')
js = read('scripts.js')

# 1) map each <tbody id="x"> to the number of <th> in its <table>
tables = []
for m in re.finditer(r'<table[^>]*>(.*?)</table>', html, re.S):
    block = m.group(1)
    body = re.search(r'<tbody[^>]*id="([^"]+)"', block)
    if not body:
        continue
    nhead = len(re.findall(r'<th[ >]', block))
    tables.append((body.group(1), nhead))

print('=== %d tables with id-ed tbody ===' % len(tables))
problems = 0
for tid, nhead in tables:
    # find the JS assignment that fills this tbody
    idx = js.find("getElementById('%s')" % tid)
    if idx < 0:
        print('%-24s header=%-3d  (no JS writer found)' % (tid, nhead))
        continue
    window = js[idx:idx + 6000]
    # count <td occurrences in the row template(s) until innerHTML assignment ends
    tds = len(re.findall(r'<td[ >]', window))
    cols = sorted(set(int(c) for c in re.findall(r'colspan="(\d+)"', window)))
    mismatch = (tds and tds != nhead) or any(c != nhead for c in cols)
    flag = 'MISMATCH' if mismatch else 'ok      '
    if mismatch:
        problems += 1
    print('%-24s header=%-3d row_tds=%-3d colspan=%s  %s' % (tid, nhead, tds, cols or '-', flag))

print()
print('=== colspan= not matching header count, anywhere in scripts.js ===')
for m in re.finditer(r"colspan=\\?['\"]?(\d+)", js):
    pass
print('tables flagged: %d / %d' % (problems, len(tables)))
