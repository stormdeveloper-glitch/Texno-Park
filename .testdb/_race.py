"""Parallel yozuv sinovi: /api/sync ga bir vaqtda 25 ta so'rov."""
import json
import os
import threading
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:5077'
N = 25
results = []
lock = threading.Lock()


def post(path, data, token):
    body = json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, data=body, method='POST',
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode('utf-8', 'replace')


def login():
    body = json.dumps({'login': '+998901234554', 'password': os.environ['BOSS_DEFAULT_PASSWORD']}).encode()
    req = urllib.request.Request(BASE + '/api/auth/login', data=body, method='POST',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())['token']


token = login()
barrier = threading.Barrier(N)


def worker(i):
    barrier.wait()
    payload = {'logs': [{'type': f'RACE-{i}', 'desc': f'konkurent yozuv {i}',
                         'time': '13.10.2026 23:00:00'}]}
    status, text = post('/api/sync', payload, token)
    with lock:
        results.append((status, text[:120]))


threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
for t in threads:
    t.start()
for t in threads:
    t.join()

codes = {}
for status, _ in results:
    codes[status] = codes.get(status, 0) + 1
print('natijalar (HTTP kod → soni):', codes)
for status, text in results:
    if status != 200:
        print('  XATO:', status, text)

# Oxirgi holat qanday?
req = urllib.request.Request(BASE + '/api/data', headers={'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(req, timeout=20) as resp:
    data = json.loads(resp.read())
logs = data.get('logs') or []
print('bazadagi logs soni:', len(logs), '| oxirgi yozuv:', (logs[-1] if logs else None))
