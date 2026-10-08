# -*- coding: utf-8 -*-
"""Find ids referenced from JS (getElementById / querySelector('#..')) that
do not exist in index.html. Read-only diagnostic."""
import re, io, os, sys, json

sys.stdout.reconfigure(encoding='utf-8')

base = os.path.dirname(os.path.abspath(__file__))


def read(p):
    with io.open(os.path.join(base, p), 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


html = read('index.html')
html_ids = set(re.findall(r'id="([^"]+)"', html))
# ids created dynamically in JS strings (el.id = 'x') count as existing
js_files = ['scripts.js', 'boss.js']
js = {f: read(f) for f in js_files}

for f in js_files:
    dynamic = set(re.findall(r"\.id\s*=\s*['\"]([^'\"]+)['\"]", js[f]))
    dynamic |= set(re.findall(r"id=\\?[\"']([A-Za-z0-9_-]+)\\?[\"']", js[f]))
    refs = {}
    for m in re.finditer(r"getElementById\(\s*['\"]([^'\"]+)['\"]", js[f]):
        refs.setdefault(m.group(1), 0)
        refs[m.group(1)] += 1
    for m in re.finditer(r"querySelector(?:All)?\(\s*['\"]#([A-Za-z0-9_-]+)", js[f]):
        refs.setdefault(m.group(1), 0)
        refs[m.group(1)] += 1
    missing = {k: v for k, v in refs.items() if k not in html_ids and k not in dynamic}
    print('=== %s : %d refs, %d missing ===' % (f, len(refs), len(missing)))
    for k in sorted(missing, key=lambda x: -missing[x]):
        print('  MISSING  %-28s x%d' % (k, missing[k]))
    print()

# also: ids referenced from inline onclick/oninput handlers in index.html
inline = set(re.findall(r"document\.getElementById\(\s*['\"]([^'\"]+)['\"]", html))
miss_inline = sorted(i for i in inline if i not in html_ids)
print('=== index.html inline handlers: %d refs, %d missing ===' % (len(inline), len(miss_inline)))
for i in miss_inline:
    print('  MISSING  %s' % i)
