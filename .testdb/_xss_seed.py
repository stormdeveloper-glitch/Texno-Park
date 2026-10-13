"""XSS tuzatishini brauzerda tekshirish uchun payload mahsulotlarini yozadi (klon baza)."""
import json
import os
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:5077'

PAYLOADS = [
    {"id": 7001, "name": "XSS-TEST');window.__XSS=1;('", "cat": "Telefon", "price": 123456, "stock": 5, "img": ""},
    {"id": 7002, "name": "<img src=x onerror=window.__XSS=2>", "cat": "Telefon", "price": 1, "stock": 1, "img": ""},
    {"id": 7003, "name": 'XSS-Q"onmouseover="window.__XSS=3', "cat": "Telefon", "price": 10, "stock": 1, "img": ""},
]


def req(method, path, data=None, token=None):
    hdrs = {'Content-Type': 'application/json'}
    if token:
        hdrs['Authorization'] = 'Bearer ' + token
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(BASE + path, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode('utf-8', 'replace')


status, raw = req('POST', '/api/auth/login', {'login': 'admin@texnopark.uz', 'password': '123456'})
token = json.loads(raw).get('token', '') if status == 200 else ''
print('login:', status, 'token:', bool(token))

status, raw = req('POST', '/api/sync', {'products': PAYLOADS}, token=token)
print('sync:', status, raw[:120])

status, raw = req('GET', '/api/catalog')
data = json.loads(raw)
products = data.get('products') if isinstance(data, dict) else data
names = [str(p.get('name', ''))[:45] for p in (products or [])]
print('catalog:', status, 'count:', len(names))
for n in names[:8]:
    print('   -', n)
