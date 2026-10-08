# Boss login probe (no boss seed / no env password expected to fail safely).
import json, os, urllib.request, urllib.error

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:5000')
BOSS_PHONE = '+998901234554'
BOSS_PASS = os.environ.get('BOSS_DEFAULT_PASSWORD', '')

def req(path, method='GET', body=None, headers=None):
    url = f'{BASE}{path}'
    hdrs = {'Content-Type': 'application/json'}
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=hdrs, method=method))
        return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 'ERR', str(e)

print('BASE=', BASE)

if BOSS_PASS:
    print('\n== boss login ==')
    s, b = req('/api/auth/login', 'POST', {'login': BOSS_PHONE, 'password': BOSS_PASS})
    print('status', s)
    print(b[:2000])
else:
    print('\nBOSS_DEFAULT_PASSWORD empty — skipping boss login probe (known fail mode).')
