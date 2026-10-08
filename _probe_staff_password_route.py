# Minimal probe to describe which password-change routes exist right now
# and whether they require boss seed or only staff token.
import json, re, urllib.request, urllib.error

def req(method, path, body=None, headers=None):
    url = 'http://127.0.0.1:5000' + path
    hdrs = {'Content-Type': 'application/json'}
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
    req_obj = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req_obj, timeout=5) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 'ERR', str(e)

print('GET /api/auth/staff')
print(req('GET', '/api/auth/staff'))
print('\nGET /api/auth/change-password (no body)')
print(req('GET', '/api/auth/change-password'))
print('\nPOST /api/auth/change-password (empty)')
print(req('POST', '/api/auth/change-password', {}))
print('\nGET /api/boss/staff/1/password (no auth)')
print(req('GET', '/api/boss/staff/1/password'))
print('\nPOST /api/boss/password (no auth)')
print(req('POST', '/api/boss/password', {}))
