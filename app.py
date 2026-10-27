import os
import re
import functools
import threading
import sqlite3
import json
import math
import uuid
import base64
import hashlib
import hmac
import secrets
# boto3 faqat S3 (ob'ekt saqlash) uchun — ixtiyoriy. Modul mavjud bo'lmasa ham
# app ishga tushadi; faqat S3 yo'naltirish ishlatilganda xatos tug'iladi.
try:
    import boto3  # noqa: F401
    _HAS_BOTO3 = True
except ImportError:  # pragma: no cover
    _HAS_BOTO3 = False
import traceback
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone, date
from flask import Flask, request, jsonify, send_from_directory, redirect, abort
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

load_dotenv()

# Loyiha ildizi: DB yo'li ishga tushirish papkasiga bog'liq bo'lib qolmasin.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Fiskal chek moduli (QR-kodli chek) — O'zbekiston qonunchiligi talablari.
# Modul bo'lmasa ham ilova ishga tushadi (fiskal chek chiqmaydi).
try:
    import fiscal as fiscal_service
except Exception as _fiscal_import_error:  # pragma: no cover
    fiscal_service = None
    print(f"[FISCAL] Modulni yuklab bo'lmadi: {_fiscal_import_error}")

app = Flask(__name__, static_folder='.')
# CORS quyida, ruxsat etilgan manbalar (ALLOWED_ORIGINS / SITE_DOMAIN)
# aniqlangach sozlanadi — shu sababli bu yerda "*" ishlatilmaydi.

# Yuklash hajmi chegarasi (DoS himoyasi)
app.config['MAX_CONTENT_LENGTH'] = 35 * 1024 * 1024


# ── JSON javobi QAT'IY bo'lishi shart ────────────────────────────────
# `NaN` / `Infinity` JSON standartiga (RFC 8259) zid. Python'ning json moduli
# ularni jimgina yozib yuboradi, brauzerdagi `JSON.parse()` esa bunday javobni
# BUTUNLAY rad etadi — natijada /api/data ishlamay qolib, butun ilova
# "ma'lumot yuklanmadi" holatiga tushardi (auditda tasdiqlangan).
# Shuning uchun jsonify hech qachon NaN chiqarmaydi: qiymat NaN bo'lib qolsa
# 500 xato qaytadi (buzilgan JSON emas).
class _StrictJSONProvider(DefaultJSONProvider):
    def dumps(self, obj, **kwargs):
        kwargs['allow_nan'] = False
        return super().dumps(obj, **kwargs)


app.json = _StrictJSONProvider(app)

# ============================================================
# XAVFSIZLIK SOZLAMALARI (ENV orqali boshqariladi)
# ============================================================
# CORS uchun ruxsat etilgan manbalar (vergul bilan ajratilgan).
# Bo'sh bo'lsa — barcha manbalar (development uchun qulay).
ALLOWED_ORIGINS = [o.strip() for o in os.getenv('ALLOWED_ORIGINS', '').split(',') if o.strip()]

# Ruxsat etilgan rasm kengaytmalari (upload whitelist)
ALLOWED_IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'}
ALLOWED_IMAGE_MIME = {'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'}

# Maxfiy kalit: callback imzolarini tekshirish uchun umumiy webhook tokeni
WEBHOOK_TOKEN = os.getenv('PAYMENT_WEBHOOK_TOKEN', '')

# HTTPS majburlash (production uchun tavsiya etiladi)
FORCE_HTTPS = os.getenv('FORCE_HTTPS', 'false').lower() == 'true'

# ============================================================
# CLOUDFLARE (proxy, CAPTCHA/Turnstile, WAF)
# ============================================================
# TRUST_CLOUDFLARE=true — sayt Cloudflare orqasida ishlayotganini bildiradi.
# Faqat shu holatda CF-Connecting-IP va CF-Visitor sarlavhalariga ishonamiz
# (aks holda hujumchi ularni qalbakilashtirib IP asosidagi limitlarni chetlab
#  o'tishi mumkin).
TRUST_CLOUDFLARE = os.getenv('TRUST_CLOUDFLARE', 'false').lower() == 'true'
# Umumiy teskari proxy (Railway, Nginx va h.k.) ortida ishlaganda X-Forwarded-For
# ga ishonish uchun. Faqat proxy haqiqatan sozlangan bo'lsa true qilinadi.
TRUST_PROXY = os.getenv('TRUST_PROXY', 'false').lower() == 'true'

# Cloudflare Turnstile (CAPTCHA) — saytdagi "bot emasligingizni tasdiqlang"
CF_TURNSTILE_SITE_KEY = (os.getenv('CF_TURNSTILE_SITE_KEY') or '').strip()
CF_TURNSTILE_SECRET_KEY = (os.getenv('CF_TURNSTILE_SECRET_KEY') or '').strip()
CF_TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
# true bo'lsa login uchun CAPTCHA majburiy (mobil ilova ham token yuborishi kerak)
CF_TURNSTILE_ENFORCE = os.getenv('CF_TURNSTILE_ENFORCE', 'false').lower() == 'true'
CF_TURNSTILE_ENABLED = bool(CF_TURNSTILE_SECRET_KEY)

# ============================================================
# SAYT DOMENI — bitta joydan boshqariladi (.env → SITE_DOMAIN)
# ============================================================
# Yangi domen olinganda faqat .env ga yoziladi:
#     SITE_DOMAIN=pos.yangi-domen.uz
# va dastur o'zi quyidagilarni sozlaydi:
#   • CORS manbalari (https://domen, https://www.domen);
#   • Host sarlavhasi tekshiruvi (Host header hujumlariga qarshi);
#   • kanonik domenga 301 yo'naltirish (CANONICAL_REDIRECT=true bo'lsa);
#   • Turnstile widget domenlariga qo'shish (CF_API_TOKEN bo'lsa, avtomatik).
SITE_DOMAIN = (os.getenv('SITE_DOMAIN') or '').strip().lower()
SITE_DOMAIN = SITE_DOMAIN.replace('https://', '').replace('http://', '').strip('/').split('/')[0]
SITE_URL = f'https://{SITE_DOMAIN}' if SITE_DOMAIN else ''
CANONICAL_REDIRECT = os.getenv('CANONICAL_REDIRECT', 'false').lower() == 'true'

# Host sarlavhasi uchun ruxsat etilgan nomlar (.env → TRUSTED_HOSTS, vergul bilan)
TRUSTED_HOSTS = [h.strip().lower() for h in os.getenv('TRUSTED_HOSTS', '').split(',') if h.strip()]
if SITE_DOMAIN:
    for host in (SITE_DOMAIN, f'www.{SITE_DOMAIN}'):
        if host not in TRUSTED_HOSTS:
            TRUSTED_HOSTS.append(host)

# CORS: faqat ro'yxatdagi manbalar (bo'sh bo'lsa — barchasi, dev uchun)
for origin in ([SITE_URL, f'https://www.{SITE_DOMAIN}'] if SITE_DOMAIN else []):
    if origin not in ALLOWED_ORIGINS:
        ALLOWED_ORIGINS.append(origin)
# Xavfsizlik: bo'sh ro'yxat CORS sarlavhalarini umuman qo'shmaydi. Same-origin
# SPA uchun bu yetarli; boshqa domen kerak bo'lsa ALLOWED_ORIGINS ga yoziladi.
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGINS}})

# Cloudflare API (Turnstile domenlarini avtomatik qo'shish uchun).
# Token faqat "Turnstile: Edit" huquqi bilan yaratilsa yetarli.
CF_API_BASE = 'https://api.cloudflare.com/client/v4'
CF_API_TOKEN = (os.getenv('CF_API_TOKEN') or '').strip()
CF_ACCOUNT_ID = (os.getenv('CF_ACCOUNT_ID') or '').strip()
CF_TURNSTILE_WIDGET_ID = (os.getenv('CF_TURNSTILE_WIDGET_ID') or '').strip()
CF_AUTO_ADD_DOMAIN = os.getenv('CF_AUTO_ADD_DOMAIN', 'true').lower() == 'true'
CF_DOMAIN_SYNC = {'state': 'idle', 'message': 'hali ishga tushirilmagan',
                  'domains': [], 'time': ''}

import time

# Thread-safe in-memory rate limiting dictionary for basic DDoS/brute-force protection
IP_REQUESTS = {}
IP_REQUESTS_LOCK = threading.Lock()

# Rate limit configuration: max requests per minute per IP on API endpoints
RATE_LIMIT_MAX = 100     # max 100 requests
RATE_LIMIT_WINDOW = 60   # per 60 seconds

@app.before_request
def rate_limit_middleware():
    path = request.path
    # Rate limit only /api endpoints to prevent blocking static files
    if not path.startswith('/api'):
        return
        
    ip = get_client_ip()

    now = time.time()
    
    with IP_REQUESTS_LOCK:
        if ip not in IP_REQUESTS:
            IP_REQUESTS[ip] = []
            
        # Keep only timestamps within the current window
        IP_REQUESTS[ip] = [t for t in IP_REQUESTS[ip] if now - t < RATE_LIMIT_WINDOW]
        
        if len(IP_REQUESTS[ip]) >= RATE_LIMIT_MAX:
            return jsonify({
                'status': 'error',
                'message': 'DDoS/Suhbat himoyasi: Juda ko\'p so\'rovlar kiritildi. Birozdan so\'ng qayta urining.'
            }), 429
            
        IP_REQUESTS[ip].append(now)


def get_client_ip():
    """Haqiqiy mijoz IP manzilini aniqlaydi (Cloudflare orqasida ham).

    Ustuvorlik: CF-Connecting-IP (faqat TRUST_CLOUDFLARE=true bo'lsa) ->
    X-Forwarded-For (faqat TRUST_PROXY=true bo'lsa) -> bevosita ulanish IP'si.
    Fake sarlavhalar orqali IP limitlarini chetlab o'tishning oldi olinadi.
    """
    if TRUST_CLOUDFLARE:
        cf_ip = (request.headers.get('CF-Connecting-IP') or '').strip()
        if cf_ip:
            return cf_ip[:60]
    if TRUST_PROXY:
        forwarded = request.headers.get('X-Forwarded-For', '')
        if forwarded:
            return forwarded.split(',')[0].strip()[:60]
    return (request.remote_addr or 'unknown')[:60]


def is_via_cloudflare():
    """So'rov Cloudflare proksisidan o'tganini bildiradi (CF-Ray sarlavhasi)."""
    return bool((request.headers.get('CF-Ray') or '').strip())


def request_is_https():
    """HTTPS ekanini aniqlaydi (Cloudflare: CF-Visitor JSON sxemasi)."""
    proto = (request.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
    if proto:
        return proto == 'https'
    visitor = request.headers.get('CF-Visitor') or ''
    if visitor:
        try:
            return str(json.loads(visitor).get('scheme', '')).lower() == 'https'
        except Exception:
            return 'https' in visitor.lower()
    return request.scheme == 'https'


def verify_turnstile(token, remote_ip=''):
    """Cloudflare Turnstile javobini serverda tekshiradi (siteverify).

    Qaytaradi: (ok, sabab). Secret o'rnatilmagan bo'lsa tekshiruv o'tkazilmaydi.
    """
    if not CF_TURNSTILE_ENABLED:
        return True, 'turnstile-sozlanmagan'
    raw_token = str(token or '').strip()[:2048]
    if not raw_token:
        return False, 'CAPTCHA tokeni yuborilmadi'
    body = json.dumps({'secret': CF_TURNSTILE_SECRET_KEY, 'response': raw_token,
                       'remoteip': remote_ip or ''}).encode('utf-8')
    req = urllib.request.Request(CF_TURNSTILE_VERIFY_URL, data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[TURNSTILE] Tekshirib bo\'lmadi: {e}')
        return False, 'CAPTCHA xizmatiga ulanib bo\'lmadi'
    if data.get('success'):
        return True, ''
    codes = ', '.join(str(c) for c in (data.get('error-codes') or [])) or 'noma\'lum xato'
    return False, f'CAPTCHA tasdiqlanmadi ({codes})'


def extract_turnstile_token(payload=None):
    """Tokenni so'rovdan oladi: JSON maydoni yoki CF-Turnstile-Response sarlavhasi."""
    token = ''
    if isinstance(payload, dict):
        token = payload.get('turnstileToken') or payload.get('cfTurnstileResponse') or ''
    if not token:
        token = request.headers.get('CF-Turnstile-Response', '') or ''
    return str(token)[:2048]


def cloudflare_api(method, path, body=None):
    """Cloudflare API'ga so'rov. Token bo'lmasa (None, sabab) qaytaradi."""
    if not CF_API_TOKEN:
        return None, 'CF_API_TOKEN sozlanmagan'
    payload = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(f'{CF_API_BASE}{path}', data=payload, method=method,
                                 headers={'Authorization': f'Bearer {CF_API_TOKEN}',
                                          'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.loads(resp.read().decode('utf-8')), ''
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'ignore')[:220]
        except Exception:
            detail = ''
        return None, f'HTTP {e.code}: {detail}'
    except Exception as e:
        return None, str(e)[:200]


def sync_turnstile_domain(force=False):
    """SITE_DOMAIN ni Cloudflare Turnstile widget domenlariga qo'shadi.

    Kerak: CF_API_TOKEN (Turnstile: Edit), CF_ACCOUNT_ID,
    CF_TURNSTILE_WIDGET_ID va SITE_DOMAIN. Yetarli ma'lumot bo'lmasa —
    holat 'skipped' bo'ladi va dastur baribir ishlashda davom etadi.
    """
    if not SITE_DOMAIN:
        CF_DOMAIN_SYNC.update(state='skipped', message='SITE_DOMAIN .env da ko\'rsatilmagan')
        return CF_DOMAIN_SYNC
    if not CF_AUTO_ADD_DOMAIN and not force:
        CF_DOMAIN_SYNC.update(state='skipped', message='CF_AUTO_ADD_DOMAIN=false')
        return CF_DOMAIN_SYNC
    if not (CF_API_TOKEN and CF_ACCOUNT_ID and CF_TURNSTILE_WIDGET_ID):
        CF_DOMAIN_SYNC.update(
            state='needs_token',
            message="Avtomatik qo'shish uchun .env da CF_API_TOKEN, CF_ACCOUNT_ID va "
                    "CF_TURNSTILE_WIDGET_ID kerak (yoki domenni dashboard orqali qo'shing)")
        return CF_DOMAIN_SYNC

    path = f'/accounts/{CF_ACCOUNT_ID}/challenges/widgets/{CF_TURNSTILE_WIDGET_ID}'
    info, error = cloudflare_api('GET', path)
    if error or not info or not info.get('success'):
        CF_DOMAIN_SYNC.update(state='error', message=f'Widget o\'qilmadi: {error}')
        print(f'[CLOUDFLARE] {CF_DOMAIN_SYNC["message"]}')
        return CF_DOMAIN_SYNC

    result = info.get('result') or {}
    current = [str(d).lower() for d in (result.get('domains') or [])]
    wanted = [SITE_DOMAIN, f'www.{SITE_DOMAIN}']
    merged = list(dict.fromkeys(current + [d for d in wanted if d]))[:10]
    CF_DOMAIN_SYNC['domains'] = merged

    if set(merged) == set(current):
        CF_DOMAIN_SYNC.update(state='ok', message=f'{SITE_DOMAIN} allaqachon widgetda')
        print(f'[CLOUDFLARE] Turnstile: {SITE_DOMAIN} allaqachon ruxsat etilgan domenlar ichida')
        return CF_DOMAIN_SYNC

    body = {'name': result.get('name') or 'Texno Park N1 POS',
            'mode': result.get('mode') or 'managed',
            'domains': merged}
    updated, error = cloudflare_api('PUT', path, body)
    if error or not updated or not updated.get('success'):
        message = error or json.dumps((updated or {}).get('errors'))[:200]
        CF_DOMAIN_SYNC.update(state='error', message=f'Domenni qo\'shib bo\'lmadi: {message}')
        print(f'[CLOUDFLARE] {CF_DOMAIN_SYNC["message"]}')
        return CF_DOMAIN_SYNC

    CF_DOMAIN_SYNC.update(state='updated', message=f'{SITE_DOMAIN} Turnstile widgetiga qo\'shildi')
    print(f'[CLOUDFLARE] Turnstile domenlari yangilandi: {", ".join(merged)}')
    return CF_DOMAIN_SYNC


def start_domain_sync():
    """Domen sinxronizatsiyasini fonda boshlaydi (serverni bloklamaydi)."""
    if not SITE_DOMAIN:
        return
    threading.Thread(target=sync_turnstile_domain, daemon=True).start()


@app.after_request
def add_security_headers(response):
    """XSS, clickjacking, MIME-sniffing va referrer leak himoyasi."""
    # CSP: CDN'lar uchun aniq whitelist (inline onclick ishlatilgani uchun 'unsafe-inline' zarur)
    response.headers.setdefault('Content-Security-Policy', (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://challenges.cloudflare.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; "
        "img-src 'self' data: blob: https:; "
        "connect-src 'self' https:; "
        # frame-src: o'z sahifamizdagi Google Maps manzil embed'i (index.html
        # .store-map-frame) uchun ANIQ hostlar — embed avval maps.google.com'ga,
        # keyin Google tomonidan www.google.com'ga redirect qiladi (jonli testda
        # ikkala URL ham kuzatildi). 'self' — o'z saytimizning ichki embed'lari
        # (masalan mobil test harness iframelari); tashqi saytlar frame-src'da
        # yo'q, X-Frame-Options SAMEORIGIN esa clickjackingni himoyalaydi.
        "frame-src 'self' https://challenges.cloudflare.com https://*.click.uz https://checkout.paycom.uz https://*.uzumbank.uz https://maps.google.com https://www.google.com; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    ))
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('X-XSS-Protection', '1; mode=block')
    # Geolokatsiya FAQAT o'z saytimizga ruxsat etiladi (filiallarga eng yaqin
    # manzilni hisoblash uchun). Kamerа/mikrofon butunlay o'chirilgan.
    response.headers.setdefault('Permissions-Policy',
                                'geolocation=(self), microphone=(), camera=(), payment=(self)')
    if FORCE_HTTPS:
        response.headers.setdefault('Strict-Transport-Security',
                                    'max-age=31536000; includeSubDomains')
    # API javoblari keshlanmasin (maxfiy ma'lumot oqib ketmasligi uchun)
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private'
        response.headers['Pragma'] = 'no-cache'
    return response


@app.before_request
def enforce_https():
    """FORCE_HTTPS=true bo'lsa HTTP so'rovlarni HTTPS'ga yo'naltiradi.

    Cloudflare orqasida sxema X-Forwarded-Proto / CF-Visitor orqali aniqlanadi —
    shu sababli "cheksiz redirect" xatosi bo'lmaydi.
    """
    if not FORCE_HTTPS:
        return
    if not request_is_https():
        secure_url = request.url.replace('http://', 'https://', 1)
        if request.path.startswith('/api/'):
            return json_error('HTTPS talab qilinadi', 301)
        return jsonify({'status': 'error', 'message': 'HTTPS talab qilinadi',
                        'url': secure_url}), 301


@app.before_request
def enforce_site_domain():
    """Host sarlavhasi tekshiruvi va kanonik domenga yo'naltirish.

    • TRUSTED_HOSTS ro'yxatidan tashqari Host — bloklanadi (Host header
      hujumlari va parol tiklash havolalarini o'g'irlashga qarshi);
    • CANONICAL_REDIRECT=true bo'lsa eski domen/IP kanonik domenga 301
      yo'naltiriladi (API va webhook'lar tegilmaydi — ular istalgan hostda
      ishlashda davom etadi);
    • localhost va ichki IP manzillar ishlab chiqish uchun doim ochiq.
    """
    host = (request.host or '').split(':')[0].strip().lower()
    if not host:
        return
    if (host in ('localhost', '127.0.0.1', '0.0.0.0', 'testserver')
            or host.startswith('192.168.') or host.startswith('10.') or host.endswith('.local')):
        return

    if TRUSTED_HOSTS and host not in TRUSTED_HOSTS:
        server_security_log('bad-host', 'high', f'Noma\'lum Host sarlavhasi: {host}')
        if request.path.startswith('/api/'):
            return json_error('Noto\'g\'ri host', 400)
        return jsonify({'status': 'error', 'message': 'Noto\'g\'ri host'}), 400

    if CANONICAL_REDIRECT and SITE_DOMAIN and host != SITE_DOMAIN:
        if request.path.startswith('/api/'):
            return
        target = f'{SITE_URL}{request.path}'
        if request.query_string:
            target += '?' + request.query_string.decode('utf-8', 'ignore')
        return redirect(target, code=301)


PORT = int(os.getenv('PORT', 5000))

from urllib.parse import urlparse
import queue
import threading

class PG8000ConnectionPool:
    def __init__(self, db_url, minconn=2, maxconn=10):
        self.db_url = db_url
        self.minconn = minconn
        self.maxconn = maxconn
        self.pool = queue.Queue(maxsize=maxconn)
        self.lock = threading.Lock()
        self.created = 0
        
        # Pre-populate pool with min connections
        for _ in range(minconn):
            try:
                self._create_and_put()
            except Exception as e:
                print(f"Failed to pre-populate DB pool: {e}")
            
    def _create_and_put(self):
        import pg8000
        parsed = urlparse(self.db_url)
        conn = pg8000.connect(
            user=parsed.username,
            password=parsed.password,
            host=parsed.hostname,
            port=parsed.port or 5432,
            database=parsed.path.lstrip('/')
        )
        self.pool.put(conn)
        self.created += 1
        
    def getconn(self):
        with self.lock:
            # If pool is empty and we can create more connections, create one
            if self.pool.empty() and self.created < self.maxconn:
                try:
                    self._create_and_put()
                except Exception as e:
                    print(f"Failed to create pooled connection: {e}")
                    
        try:
            return self.pool.get(timeout=5.0)
        except queue.Empty:
            raise Exception("Database connection pool exhausted. Try again later.")
            
    def putconn(self, conn):
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            cursor.close()
            self.pool.put(conn)
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            with self.lock:
                self.created -= 1

class PooledConnectionWrapper:
    def __init__(self, conn, pool):
        self._conn = conn
        self._pool = pool
        
    def __getattr__(self, name):
        return getattr(self._conn, name)
        
    def close(self):
        self._pool.putconn(self._conn)

class DBManager:
    def __init__(self):
        # Check PostgreSQL URL or fallback to MySQL URL automatically
        self.db_url = os.getenv('DATABASE_URL', '')
        if not self.db_url.startswith(('postgresql://', 'postgres://')):
            mysql_url = os.getenv('MYSQL_URL', '')
            if mysql_url:
                self.db_url = mysql_url
                
        self.db_type = 'sqlite'
        if self.db_url.startswith(('postgresql://', 'postgres://')):
            self.db_type = 'postgres'
        elif self.db_url.startswith('mysql://'):
            self.db_type = 'mysql'
            
        self.db_path = None
        self._pg_pool = None
        self._sqlite_path = None  # SQLite yo'li bir marta aniqlanadi (kesh)
        if self.db_type == 'postgres':
            try:
                self._pg_pool = PG8000ConnectionPool(self.db_url, minconn=2, maxconn=10)
                print("PostgreSQL connection pool initialized successfully.")
            except Exception as e:
                print(f"Failed to initialize PostgreSQL pool: {e}")
            
    def get_connection(self):
        if self.db_type == 'postgres':
            if self._pg_pool:
                try:
                    raw_conn = self._pg_pool.getconn()
                    return PooledConnectionWrapper(raw_conn, self._pg_pool)
                except Exception as pool_err:
                    print(f"Pool exhausted/failed, fallback to direct conn: {pool_err}")
            
            import pg8000
            parsed = urlparse(self.db_url)
            return pg8000.connect(
                user=parsed.username,
                password=parsed.password,
                host=parsed.hostname,
                port=parsed.port or 5432,
                database=parsed.path.lstrip('/')
            )
            
        elif self.db_type == 'mysql':
            import pymysql
            parsed = urlparse(self.db_url)
            return pymysql.connect(
                host=parsed.hostname,
                user=parsed.username,
                password=parsed.password,
                database=parsed.path.lstrip('/'),
                port=parsed.port or 3306
            )
            
        else:
            # MUHIM: SQLite yo'li BIR MARTA aniqlanadi va keshlanadi.
            # Ilgari har bir ulanishda "/app/data" yozish qobiliyati tekshirilar
            # va vaqtincha xato bo'lsa `Data/database.db` ga (boshqa, bo'sh
            # bazaga) o'tib ketardi. Natijada bitta so'rov bo'sh bazani ko'rib
            # "xodimlar yo'q" deb standart xodimlarni QAYTA seed qilishi va
            # haqiqiy xodimlar ro'yxatini bosib ketishi mumkin edi.
            db_path = getattr(self, '_sqlite_path', None)
            if not db_path:
                configured = (os.getenv('DB_PATH') or '').strip()
                if configured:
                    # Nisbiy DB_PATH loyiha ildiziga nisbatan olinadi — server qaysi
                    # papkadan ishga tushirilishidan qat'i nazar bitta baza ishlatiladi.
                    db_path = configured if os.path.isabs(configured) else os.path.join(BASE_DIR, configured)
                else:
                    db_path = ''
                    for vpath in ["/app/data", "/data", "/data/app", "/dara/app"]:
                        try:
                            if os.path.exists(vpath) or os.path.isdir(vpath):
                                # Faqat yozish mumkin bo'lgan papkani tanlaymiz.
                                test_file = os.path.join(vpath, ".write_test")
                                with open(test_file, 'w') as f:
                                    f.write('test')
                                os.remove(test_file)
                                db_path = os.path.join(vpath, "database.db")
                                break
                        except OSError:
                            continue
                    if not db_path:
                        db_path = os.path.join(BASE_DIR, 'Data', 'database.db')
                self._sqlite_path = db_path
            self.db_path = db_path
            try:
                db_dir = os.path.dirname(db_path)
                if db_dir:
                    os.makedirs(db_dir, exist_ok=True)
                return sqlite3.connect(db_path)
            except Exception as e:
                # BOSHQA bazaga o'tmaymiz — o'sha faylga qayta urinamiz.
                print(f"Failed to connect to SQLite at {db_path}: {str(e)}. Retrying same database.")
                return sqlite3.connect(db_path, timeout=10)

    def init_db(self):
        conn = self.get_connection()
        cursor = conn.cursor()
        if self.db_type == 'postgres':
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS store_data (
                    key VARCHAR(255) PRIMARY KEY,
                    value TEXT
                )
            ''')
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS support_reports (
                    id SERIAL PRIMARY KEY,
                    type VARCHAR(50),
                    message TEXT,
                    contact VARCHAR(255),
                    date VARCHAR(50),
                    time VARCHAR(50),
                    username VARCHAR(100)
                )
            ''')
        elif self.db_type == 'mysql':
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS store_data (
                    `key` VARCHAR(255) PRIMARY KEY,
                    `value` LONGTEXT
                )
            ''')
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS support_reports (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    type VARCHAR(50),
                    message TEXT,
                    contact VARCHAR(255),
                    date VARCHAR(50),
                    time VARCHAR(50),
                    username VARCHAR(100)
                )
            ''')
        else:
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS store_data (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            ''')
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS support_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT,
                    message TEXT,
                    contact TEXT,
                    date TEXT,
                    time TEXT,
                    username TEXT
                )
            ''')
        conn.commit()
        conn.close()

    def save_report(self, type_, message, contact, date, time, username):
        conn = self.get_connection()
        try:
            self._insert_report(conn, type_, message, contact, date, time, username)
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    def _insert_report(self, conn, type_, message, contact, date, time, username):
        cursor = conn.cursor()
        if self.db_type == 'postgres':
            cursor.execute('''
                INSERT INTO support_reports (type, message, contact, date, time, username)
                VALUES (%s, %s, %s, %s, %s, %s)
            ''', (type_, message, contact, date, time, username))
        elif self.db_type == 'mysql':
            cursor.execute('''
                INSERT INTO support_reports (type, message, contact, date, time, username)
                VALUES (%s, %s, %s, %s, %s, %s)
            ''', (type_, message, contact, date, time, username))
        else:
            cursor.execute('''
                INSERT INTO support_reports (type, message, contact, date, time, username)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (type_, message, contact, date, time, username))

    def get_all(self):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute('SELECT key, value FROM store_data')
            rows = cursor.fetchall()
        finally:
            conn.close()

        data = {}
        for row in rows:
            try:
                data[row[0]] = json.loads(row[1])
            except (TypeError, ValueError):
                # Buzilgan yozuv butun bazani (ya'ni /api/data javobini)
                # yiqitmasin — faqat shu kalit tashlab ketiladi.
                print(f"[DB] '{row[0]}' yozuvi o'qilmadi (buzilgan JSON)")
        return data

    def save_keys(self, data_dict):
        # `allow_nan=False`: NaN/Infinity bazaga HECH QACHON yozilmaydi
        # (aks holda /api/data javobi JSON standartiga zid bo'lib, brauzerda
        # JSON.parse yiqilardi). Xato bo'lsa — 500 va baza toza qoladi.
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            for key, val in data_dict.items():
                val_str = json.dumps(val, ensure_ascii=False, allow_nan=False)

                # Universal Upsert logic (Dialect independent)
                if self.db_type in ('postgres', 'mysql'):
                    cursor.execute('SELECT 1 FROM store_data WHERE key = %s', (key,))
                    exists = cursor.fetchone()
                    if exists:
                        cursor.execute('UPDATE store_data SET value = %s WHERE key = %s', (val_str, key))
                    else:
                        cursor.execute('INSERT INTO store_data (key, value) VALUES (%s, %s)', (key, val_str))
                else:
                    cursor.execute('SELECT 1 FROM store_data WHERE key = ?', (key,))
                    exists = cursor.fetchone()
                    if exists:
                        cursor.execute('UPDATE store_data SET value = ? WHERE key = ?', (val_str, key))
                    else:
                        cursor.execute('INSERT INTO store_data (key, value) VALUES (?, ?)', (key, val_str))
            conn.commit()
        except Exception:
            # Ulanish HAR QANDAY holatda yopiladi va tranzaksiya orqaga
            # qaytariladi — aks holda fayl deskriptorlari/qulflar to'planadi.
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

db_manager = DBManager()
db_manager.init_db()


# ============================================================
# 1) AUTENTIFIKATSIYA VA AVTORIZATSIYA (server tomonida)
# ============================================================
# Xavfsizlik qoidasi (darsliklardan): autentifikatsiya va avtorizatsiya faqat
# serverda hal qilinadi. Shuning uchun muhim API'lar endi imzolangan token
# talab qiladi: baza sinxronizatsiyasi, AI yordamchi va fayl yuklash.
# Rol iyerarxiyasi — BOSHLIQ butun biznesni boshqaradi:
#   BOSHLIQ > ADMIN > MANAGER > CASHIER
# `rank` qiymati katta bo'lgan ro'l pastdagini o'z ichiga oladi.
# `require_staff()` bo'sh ro'llar bilan chaqirilganda STAFF_ROLES ishlatiladi.
STAFF_ROLES = ('boss', 'admin', 'manager', 'cashier')
ROLE_RANK = {'boss': 40, 'admin': 30, 'manager': 20, 'cashier': 10}
# Eski kodda `customer` roli ham bor (ommaviy do'kon uchun) — u ichki tizimga kirmaydi.
# Eski/alternativ rol nomlari yagona manbadan kanonik kalitga keltiriladi:
# bazada `Administrator`, `rahbariyat`, `menejer` kabi qiymatlar qolgan bo'lsa
# ham RBAC, sidebar va /api/data bir xil ishlaydi.
ROLE_ALIASES = {'rahbariyat': 'boss', 'boshliq': 'boss', 'boshlq': 'boss',
                'administrator': 'admin', 'menejer': 'manager', 'kassa': 'cashier'}


def canonical_role(role):
    """Rolni kanonik kalitga keltiradi (noma'lum rol → '')."""
    key = str(role or '').strip().lower()
    key = ROLE_ALIASES.get(key, key)
    # `customer` — ommaviy do'kon roli; ichki RBAC'dan o'tmaydi (rank 0),
    # lekin tokenda saqlanadi — aks holda mijoz rejimi noto'g'ri ko'rinadi.
    return key if (key in ROLE_RANK or key == 'customer') else ''


def role_rank(role):
    """Rolning iyerarxiya darajasini qaytaradi (noma'lum rol → 0)."""
    return ROLE_RANK.get(canonical_role(role), 0)


def role_contains(allowed, role):
    """`role` roli `allowed` ro'llaridan birining yoki undan yuqorimi.

    Masalan: role_contains(('admin',), 'boss') → True (Boshliq admin imkoniyatlariga ega).
    `allowed` bo'sh bo'lsa — barcha ichki rollar o'tadi (eski @require_staff() semantikasi).
    """
    if not allowed:
        return role_rank(role) > 0
    mine = role_rank(role)
    if mine <= 0:
        return False
    # Ro'l ro'yxati ichida eng past chegarani belgilaydi.
    return mine >= min(role_rank(r) for r in allowed)


TOKEN_TTL_HOURS = max(1, min(72, int(os.getenv('API_TOKEN_TTL_HOURS', '12') or 12)))
LOGIN_MAX_ATTEMPTS = max(3, min(30, int(os.getenv('LOGIN_MAX_ATTEMPTS', '8') or 8)))
LOGIN_WINDOW_SECONDS = 300

_AUTH_SECRET = ''
_login_attempts = {}
_login_lock = threading.Lock()

# Butun holat (products/sales va h.k.) JSON blob sifatida saqlanadi, ya'ni
# har bir yozuv — bu read-modify-write. Ikki parallel so'rov (masalan, ikki
# kassir) bir-birining qoldiq o'zgarishini bosib ketishi (lost update) yoki
# bir savdo ikki marta kamayishi mumkin. Shu qulf yozuvlarni ketma-ketlashtiradi.
_store_write_lock = threading.RLock()


def _first_env(*names):
    """Bir nechta muhit o'zgaruvchilaridagi birinchi to'ldirilgan qiymatni qaytaradi."""
    for name in names:
        value = (os.getenv(name) or '').strip()
        if value:
            return value
    return ''


# ── PAROL XESHI SXEMASI ─────────────────────────────────────────────
# Ilgari bitta SHA-256 ishlatilardi: GPU'da sekundiga milliardlab urinish
# qilinadi, ya'ni baza qo'lga tushsa parollar juda tez ochilardi. Endi:
#     pbkdf2_sha256$<iteratsiya>$<xesh>      (yangi parollar)
# Eski (64 belgili hex) xeshlar hamon tekshiriladi va foydalanuvchi keyingi
# safar muvaffaqiyatli kirganda AVTOMATIK yangi sxemaga o'tkaziladi —
# mavjud akountlar hech narsani yo'qotmaydi.
PASSWORD_HASH_PREFIX = 'pbkdf2_sha256'
PASSWORD_HASH_ITERATIONS = max(
    50_000, min(600_000, int(os.getenv('PASSWORD_HASH_ITERATIONS', '') or 150000)))


def legacy_hash_password(password, salt):
    """ESKI sxema: sha256(salt + '::' + parol) — faqat moslik uchun."""
    return hashlib.sha256(f'{salt}::{password}'.encode('utf-8')).hexdigest()


def hash_password(password, salt):
    """Yangi parollar uchun PBKDF2-HMAC-SHA256 xeshi."""
    raw = hashlib.pbkdf2_hmac(
        'sha256', str(password).encode('utf-8'), str(salt or '').encode('utf-8'),
        PASSWORD_HASH_ITERATIONS)
    return f'{PASSWORD_HASH_PREFIX}${PASSWORD_HASH_ITERATIONS}${raw.hex()}'


def verify_password(password, salt, stored):
    """Saqlangan xeshni tekshiradi — yangi (PBKDF2) yoki eski (SHA-256) sxema."""
    stored = str(stored or '')
    if not stored:
        return False
    if stored.startswith(PASSWORD_HASH_PREFIX + '$'):
        parts = stored.split('$')
        if len(parts) != 3:
            return False
        try:
            iterations = int(parts[1])
        except (TypeError, ValueError):
            return False
        if iterations < 1000 or iterations > 2_000_000:
            return False
        raw = hashlib.pbkdf2_hmac(
            'sha256', str(password).encode('utf-8'), str(salt or '').encode('utf-8'),
            iterations)
        return hmac.compare_digest(raw.hex(), parts[2])
    # Eski sxema — moslik uchun
    return hmac.compare_digest(legacy_hash_password(password, salt), stored)


def password_needs_rehash(stored):
    """Xesh eski yoki kuchsizroq parametrda bo'lsa — True (kirishda yangilanadi)."""
    stored = str(stored or '')
    if not stored.startswith(PASSWORD_HASH_PREFIX + '$'):
        return True
    parts = stored.split('$')
    if len(parts) != 3:
        return True
    try:
        return int(parts[1]) < PASSWORD_HASH_ITERATIONS
    except (TypeError, ValueError):
        return True


def persist_staff_hash(user):
    """Bitta xodimning xesh/salt maydonlarini bazaga yozadi (boshqasiga tegmaydi)."""
    try:
        login = str(user.get('login', '')).lower()
        staff = load_staff()
        for item in staff:
            if str(item.get('login', '')).lower() == login:
                item['passHash'] = user.get('passHash')
                item['salt'] = user.get('salt')
                if user.get('passHashAt'):
                    item['passHashAt'] = user.get('passHashAt')
                break
        else:
            return False
        db_manager.save_keys({'staff_users': staff})
        return True
    except Exception as exc:
        print(f"[SECURITY] Xodim xeshini saqlab bo'lmadi: {exc}")
        return False


def rehash_staff_password(user, password):
    """Kirish muvaffaqiyatli bo'lgach eski xeshni yangi sxemaga o'tkazadi."""
    try:
        if not password_needs_rehash(user.get('passHash')):
            return False
        user['passHash'] = hash_password(password, user.get('salt', ''))
        user['passHashAt'] = _now_stamp()
        return persist_staff_hash(user)
    except Exception as exc:
        print(f"[SECURITY] Xeshni yangilab bo'lmadi: {exc}")
        return False


def make_salt(prefix='tp'):
    return f'{prefix}-{secrets.token_hex(6)}'


# ── Telefon raqami (O'zbekiston): YAGONA normalizatsiya ──
# Kanonik (backend ichki) format: +998XXXXXXXXX.
# Qabul qilinadigan kirishlar bir xil ko'rinishga keltiriladi:
#   "+998 90 848 09 21" → +998908480921
#   "998908480921"      → +998908480921
#   "908480921"         → +998908480921
# Yaroqsiz bo'lsa — bo'sh satr qaytaradi.
def normalize_phone(value):
    digits = re.sub(r'\D', '', str(value or ''))
    if not digits:
        return ''
    if len(digits) == 12 and digits.startswith('998'):
        local = digits[3:]
    elif len(digits) == 9:
        local = digits
    else:
        return ''
    if local[0] == '0':
        return ''
    return f'+998{local}'


def phones_match(a, b):
    na, nb = normalize_phone(a), normalize_phone(b)
    return bool(na) and na == nb


def auth_secret():
    """Token imzosi uchun maxfiy kalit. .env'da bo'lmasa — bazada saqlanadi."""
    global _AUTH_SECRET
    if _AUTH_SECRET:
        return _AUTH_SECRET
    env_secret = (os.getenv('API_AUTH_SECRET') or '').strip()
    if env_secret:
        _AUTH_SECRET = env_secret
        return _AUTH_SECRET
    try:
        stored = (db_manager.get_all() or {}).get('auth_secret')
    except Exception:
        stored = None
    if not stored:
        stored = secrets.token_urlsafe(48)
        try:
            db_manager.save_keys({'auth_secret': stored})
        except Exception:
            pass
        print("[SECURITY] API_AUTH_SECRET .env'da yo'q — avtomatik kalit yaratildi."
              " Productionda API_AUTH_SECRET ni .env ga qo'ying.")
    _AUTH_SECRET = stored
    return _AUTH_SECRET


# ============================================================
# PAROL SIYOSATI — faqat bir tomonlama xesh, qayta tiklanadigan nusxa YO'Q
# ============================================================
# Ilgari bu yerda parollarning shifrlangan (qayta tiklanadigan) nusxasi
# saqlanardi va Boshliq ularni panelda ko'ra olardi. Yangi xavfsizlik
# talabiga ko'ra bu AMALDA O'CHIRILGAN:
#   • parol faqat PBKDF2-SHA256 xesh ko'rinishida saqlanadi;
#   • `passVault` / `passVaultAt` maydonlari yangi yozuvlarda yaratilmaydi;
#   • mavjud nusxalar `load_staff()` migratsiyasida bazadan o'chiriladi;
#   • parolni ko'rsatish API'si 410 (Gone) qaytaradi.
# Bu ataylab kodda qat'iy `False` — .env orqali qayta yoqib bo'lmaydi.
PASSWORD_VAULT_ENABLED = False

try:
    from cryptography.fernet import Fernet as _Fernet
    _HAS_FERNET = True
except Exception:  # pragma: no cover
    _Fernet = None
    _HAS_FERNET = False

_vault_cipher = None
_vault_lock = threading.Lock()


def vault_available():
    """Xazina ishlashga tayyormi (yoqilgan + kutubxona bor)."""
    return bool(PASSWORD_VAULT_ENABLED and _HAS_FERNET)


def _vault_cipher_get():
    """Fernet shifrlagichini bir marta tayyorlaydi."""
    global _vault_cipher
    if _vault_cipher is not None:
        return _vault_cipher
    with _vault_lock:
        if _vault_cipher is not None:
            return _vault_cipher
        raw = (os.getenv('PASSWORD_VAULT_KEY') or '').strip()
        cipher = None
        if raw:
            try:
                cipher = _Fernet(raw.encode('ascii'))
            except Exception:
                cipher = None
        if cipher is None:
            # Kalit berilmagan/xato — API_AUTH_SECRET dan hosil qilamiz
            material = (raw or auth_secret()).encode('utf-8')
            key = base64.urlsafe_b64encode(
                hashlib.sha256(b'tp-pos-parol-xazinasi::' + material).digest())
            cipher = _Fernet(key)
        _vault_cipher = cipher
    return _vault_cipher


def vault_encrypt(password):
    """Parolning shifrlangan (qayta tiklanadigan) nusxasini qaytaradi."""
    value = str(password or '')
    if not value or not vault_available():
        return ''
    try:
        token = _vault_cipher_get().encrypt(value.encode('utf-8'))
        return 'fernet:' + token.decode('ascii')
    except Exception as e:
        print(f'[VAULT] Parolni shifrlab bo\'lmadi: {e}')
        return ''


def vault_decrypt(stored):
    """Shifrlangan nusxadan parolni qaytaradi (bo'lmasa yoki ochilmasa — '').

    STAFF_PASSWORD_VAULT=false bo'lsa mavjud nusxalar ham KO'RSATILMAYDI.
    """
    raw = str(stored or '')
    if not raw or not vault_available() or not raw.startswith('fernet:'):
        return ''
    try:
        return _vault_cipher_get().decrypt(raw[7:].encode('ascii')).decode('utf-8')
    except Exception:
        return ''


def _now_stamp():
    return datetime.now().strftime('%d.%m.%Y %H:%M:%S')


def apply_staff_password(user, password, changed_by='', 
                         revoke_sessions=False, keep_jti=''):
    """Xodim parolini o'rnatadi: faqat xesh + audit meta ma'lumoti.

    Meta maydonlar (boshliq panelida ko'rinadi):
      • passChangedAt — parol oxirgi marta qachon o'zgargani;
      • passChangedBy — kim o'zgartirgani ("Xodim o'zi" / xodim nomi / Boshliq).

    Parolning qayta tiklanadigan nusxasi SAQLANMAYDI. Eski bazalarda qolib
    ketgan `passVault` maydonlari ham shu yerda o'chiriladi.
    """
    salt = make_salt('tp-' + str(user.get('role', 'usr'))[:3] + '-')
    user['salt'] = salt
    user['passHash'] = hash_password(str(password), salt)
    # Standart/ma'lum zaif parol qo'yilsa, keyingi kirishda almashtirish shart.
    user['mustChange'] = is_known_default_password(password)
    user['updatedAt'] = _now_stamp()
    # Qayta tiklanadigan parol nusxasi umuman saqlanmaydi.
    user.pop('passVault', None)
    user.pop('passVaultAt', None)
    user['passChangedAt'] = user['updatedAt']
    user['passChangedBy'] = str(changed_by or '')[:120]
    if revoke_sessions:
        revoke_login_sessions(str(user.get('login', '')), keep_jti=keep_jti)
    return True


def apply_staff_phone(user, new_phone, changed_by=''):
    """Xodimning LOGIN (telefon) raqamini o'rnatadi + meta ma'lumot.

    Telefon — login identifikatori bo'lgani uchun:
      • `phone` yangilanadi;
      • eski `login` telefon ko'rinishida bo'lsa (boshliq qo'shgan xodimlar
        shunday yaratiladi), `login` ham yangi raqamga o'tadi — aks holda
        eski raqam bilan kirish mumkin bo'lib qolardi;
      • `phoneChangedAt` / `phoneChangedBy` / `phonePrev` — boshliq panelida
        kim va qachon o'zgartirganini ko'rsatish uchun (xodim O'ZI
        almashtirsa ham ko'rinadi).
    """
    old_phone = normalize_phone(user.get('phone'))
    stamp = _now_stamp()
    user['phone'] = new_phone
    old_login = str(user.get('login') or '').strip()
    # Telefon login sifatida ishlatilayotgan bo'lsa — loginni ham yangilaymiz.
    if not old_login or normalize_phone(old_login) == old_phone:
        user['login'] = new_phone
    user['updatedAt'] = stamp
    user['phoneChangedAt'] = stamp
    user['phoneChangedBy'] = str(changed_by or '')[:120]
    if old_phone and old_phone != new_phone:
        user['phonePrev'] = old_phone
    return True


def capture_staff_password(user, password):
    """Login paytida parolni xazinaga yozib oladi (nusxa yo'q bo'lsa).

    Eski akountlar (xazina yoqilishidan oldin yaratilgan) shu yo'l bilan
    ko'rinadigan bo'ladi — xodim tizimga kirishi bilan.
    """
    if not vault_available():
        return False
    # Nusxa mavjud bo'lsa ham, u HAQIQIY parolga mos kelishini tekshiramiz.
    # Ilgari bu yerda faqat "nusxa bormi?" tekshirilardi: parol CLI orqali
    # (masalan _tp_set_staff_password.py) yoki eski yo'l bilan almashtirilsa,
    # xazinada ESKI parol qolib, boshliq panelida "mos kelmaydigan" parol
    # ko'rinardi. Endi muvaffaqiyatli kirishda nusxa yangilanadi.
    current = str(user.get('passVault') or '')
    if current and vault_decrypt(current) == str(password):
        return False
    token = vault_encrypt(password)
    if not token:
        return False
    key = str(user.get('login', '')).strip().lower()
    try:
        people = load_staff()
    except Exception:
        return False
    for item in people:
        if not isinstance(item, dict):
            continue
        if str(item.get('login', '')).strip().lower() != key:
            continue
        item['passVault'] = token
        item['passVaultAt'] = _now_stamp()
        if not item.get('passChangedAt'):
            item['passChangedAt'] = item['passVaultAt']
            item['passChangedBy'] = "Noma'lum (kirishda yozib olindi)"
        try:
            db_manager.save_keys({'staff_users': people})
            return True
        except Exception as e:
            print(f'[VAULT] Parolni yozib olib bo\'lmadi: {e}')
            return False
    return False


def staff_current_password(user):
    """Xodimning joriy parolini qaytaradi. (parol, sabab) ko'rinishida.

    Sabab bo'sh bo'lsa — parol muvaffaqiyatli o'qildi.
    """
    if not PASSWORD_VAULT_ENABLED:
        return '', 'Parol xazinasi o\'chirilgan (STAFF_PASSWORD_VAULT=false)'
    if not _HAS_FERNET:
        return '', 'cryptography kutubxonasi o\'rnatilmagan (requirements.txt)'
    password = vault_decrypt(user.get('passVault'))
    if not password:
        return '', ('Parol noma\'lum — bu xodim parolni xazina yoqilgandan keyin '
                    'hali kiritmagan (u parolni almashtirsa yoki tizimga kirsa, '
                    'avtomatik yozib olinadi)')
    return password, ''


# Standart xodimlar (frontend'dagi bilan bir xil parol sxemasi).
# Productionda STAFF_DEFAULT_PASSWORD orqali almashtiring yoki
# /api/auth/change-password orqali parolni yangilang.
_DEFAULT_STAFF = [
    # Telefon raqami — login identifikatori (kanonik: +998XXXXXXXXX).
    {'login': 'admin', 'phone': '+998908480921', 'salt': 'tp-adm-9x2', 'name': 'Abdullayev Admin', 'role': 'admin'},
    {'login': 'cashier', 'phone': '+998905450921', 'salt': 'tp-csh-4k7', 'name': 'Karimov Kassir', 'role': 'cashier'},
    {'login': 'manager', 'phone': '+998902750921', 'salt': 'tp-mng-3z8', 'name': 'Toshmatov Menejer', 'role': 'manager'},
    {'login': 'customer', 'phone': '', 'salt': 'tp-usr-6q1', 'name': 'Online Xaridor', 'role': 'customer'},
    # Eski (username/email) login bilan moslik uchun taxalluslar. Telefon
    # berilmaydi — shu bilan har bir telefon raqami yagona (unique) qoladi.
    {'login': 'admin@texnopark.uz', 'phone': '', 'salt': 'tp-adm-9x2', 'name': 'Abdullayev Admin', 'role': 'admin'},
    {'login': 'cashier@texnopark.uz', 'phone': '', 'salt': 'tp-csh-4k7', 'name': 'Karimov Kassir', 'role': 'cashier'},
    {'login': 'manager@texnopark.uz', 'phone': '', 'salt': 'tp-mng-3z8', 'name': 'Toshmatov Menejer', 'role': 'manager'},
]
_DEFAULT_PASSWORD = '123456'


def known_default_passwords():
    """Ma'lum standart/zaif parollar ro'yxati (ochiq matnda qaytarilmaydi)."""
    values = {_DEFAULT_PASSWORD}
    for env_name in ('STAFF_DEFAULT_PASSWORD', 'TP_STAFF_PASSWORD',
                     'BOSS_DEFAULT_PASSWORD'):
        value = (os.getenv(env_name) or '').strip()
        if value:
            values.add(value)
    return values


def is_known_default_password(password):
    candidate = str(password or '')
    return bool(candidate) and candidate in known_default_passwords()


_DEFAULT_PASSWORD_AUDIT_DONE = False


def audit_default_passwords():
    """Bazadagi ma'lum standart parolli akountlarni `mustChange` qiladi.

    Parol o'zgartirilmaydi — foydalanuvchi birinchi kirishda o'zi almashtiradi.
    Bu migratsiya bir marta ishlaydi; natija bazaga saqlanadi.
    """
    global _DEFAULT_PASSWORD_AUDIT_DONE
    if _DEFAULT_PASSWORD_AUDIT_DONE:
        return 0
    _DEFAULT_PASSWORD_AUDIT_DONE = True
    staff = load_staff()
    changed = 0
    shown = []
    for item in staff:
        if not isinstance(item, dict) or item.get('mustChange'):
            continue
        salt = item.get('salt', '')
        pass_hash = item.get('passHash', '')
        if not pass_hash:
            continue
        for password in known_default_passwords():
            if verify_password(password, salt, pass_hash):
                item['mustChange'] = True
                item['passChangedBy'] = 'Tizim (standart parol aniqlandi)'
                changed += 1
                shown.append(f"{item.get('login')} ({item.get('role')})")
                break
    if changed:
        try:
            db_manager.save_keys({'staff_users': staff})
        except Exception as e:
            print(f'[SECURITY] Standart parol migratsiyasini saqlab bo\'lmadi: {e}')
            return 0
        print(f'[SECURITY] {changed} ta akount standart parolda: '
              f'{", ".join(shown[:8])}. Kirishda parol almashtirish majburiy.')
    return changed

# Kanonik login → telefon raqami. Mavjud bazadagi yozuvlarga bir marta
# (migratsiya sifatida) telefon qo'shish uchun ishlatiladi.
_PHONE_BY_LOGIN = {
    'admin': '+998908480921',
    'cashier': '+998905450921',
    'manager': '+998902750921',
}


def _ensure_staff_fields(staff):
    """Mavjud xodim yozuvlarini yangi sxema bilan to'ldiradi (ma'lumot yo'qolmaydi).

    - `id` va `status` maydonlari yo'q bo'lsa qo'shiladi;
    - kanonik loginlar (admin/cashier/manager) uchun telefon raqami yo'q
      bo'lsa beriladi — ammo raqam allaqachon boshqa yozuvda ishlatilgan
      bo'lsa qo'shilmaydi (telefon yagona/unique bo'lib qoladi).

    Qaytaradi: (staff, changed) — changed=True bo'lsa bazaga qayta yozish kerak.
    """
    changed = False
    used_phones = set()
    for item in staff:
        if not isinstance(item, dict):
            continue
        phone = normalize_phone(item.get('phone'))
        if phone:
            used_phones.add(phone)

    next_id = 1
    for item in staff:
        if not isinstance(item, dict):
            continue
        # Xavfsizlik migratsiyasi: eski parol xazinasi nusxalarini butunlay
        # o'chiramiz. Xesh (`passHash`) o'zgarmaydi — kirish buzilmaydi.
        if item.pop('passVault', None) is not None:
            changed = True
        if item.pop('passVaultAt', None) is not None:
            changed = True
        try:
            current_id = int(item.get('id') or 0)
        except (TypeError, ValueError):
            current_id = 0
        if current_id <= 0:
            item['id'] = next_id
            changed = True
        else:
            next_id = max(next_id, current_id + 1)
        if not item.get('status'):
            item['status'] = 'active'
            changed = True
        # Mavjud maosh qiymati bo'lsa — butun songa keltiramiz (xavfsiz migratsiya).
        if 'salary' in item and item.get('salary') is not None:
            amount, salary_error = parse_staff_salary(item.get('salary'))
            if not salary_error and amount != item.get('salary'):
                item['salary'] = amount
                changed = True
        # Eski bazalarda rol `Administrator`, `rahbariyat`, `menejer` yoki
        # bo'sh joy bilan yozilgan bo'lishi mumkin. Bir marta kanoniklashtiramiz
        # — aks holda server ruxsat beradi, lekin /api/data va sidebar bo'sh qoladi.
        canon_role = canonical_role(item.get('role'))
        if canon_role and canon_role != str(item.get('role') or ''):
            item['role'] = canon_role
            changed = True
        login_key = str(item.get('login', '')).strip().lower()
        default_phone = _PHONE_BY_LOGIN.get(login_key)
        if default_phone and not normalize_phone(item.get('phone')) and default_phone not in used_phones:
            item['phone'] = default_phone
            used_phones.add(default_phone)
            changed = True
    return staff, changed


# ============================================================
# BOSHLIQ (RAHBARIYAT) AKOUNTI — loyihaning eng yuqori roli
# ============================================================
# Boshliq butun biznesni ko'radi va boshqaradi: xodimlar nazorati,
# reyting, mahsulot/filial tahlili, moliya va hisobotlar.
#
# Xavfsizlik qoidalari:
#  • Parol hech qachon kodga yozilmaydi — `BOSS_DEFAULT_PASSWORD` orqali
#    .env dan olinadi (yoki `python _tp_create_boss.py` skripti orqali).
#  • Bazada FAQAT SHA-256 xesh saqlanadi (sha256(salt + '::' + parol)).
#  • Boshliq akounti oddiy "xodim qo'shish" formasidan YARATILMAYDI:
#    /api/boss/staff endpoint'i rol-variantlarida BOSHLIQ ni taklif qilmaydi.
#    Faqat shu migratsiya yoki yuqori darajadagi CLI skripti orqali yaratiladi.
BOSS_LOGIN = 'boss'
BOSS_PHONE = '+998901234554'
BOSS_NAME = 'Boshliq'
MAX_AUDIT_LOG = 400


def _next_staff_id(staff):
    """Xodim uchun YANGI id: mavjudlarning eng kattasi + 1.

    Ilgari bo'sh (eng kichik) id qayta ishlatilardi. Natijada o'chirilgan
    xodimning id'si yangi xodimga berilib, eski maosh tarixi/savdo
    yozuvlari yangi xodimga "yopishib" qolardi — Boshliq panelida esa
    ma'lumot ikki marta ko'rinardi. Endi id hech qachon qayta ishlatilmaydi.
    """
    used = set()
    for item in staff:
        if isinstance(item, dict):
            try:
                used.add(int(item.get('id') or 0))
            except (TypeError, ValueError):
                pass
    # Tarixiy yozuvlarda uchraydigan id'lar ham "band" — o'chirilgan
    # xodimning id'si yangi xodimga berilmasin (eski savdo/maosh
    # yozuvlari yangi xodimga bog'lanib qolmasligi uchun).
    try:
        store = db_manager.get_all() or {}
    except Exception:
        store = {}
    for key, fields in (
            ('sales', ('staffId', 'cashierId', 'employeeId')),
            ('salaryHistory', ('staffId', 'empId', 'employeeId')),
            ('salaryRecords', ('staffId', 'empId', 'employeeId')),
            ('staffSalaryHistory', ('staffId', 'empId', 'employeeId')),
    ):
        records = store.get(key)
        if not isinstance(records, list):
            continue
        for record in records:
            if not isinstance(record, dict):
                continue
            for field in fields:
                value = int(_num(record.get(field), 0))
                if value > 0:
                    used.add(value)
    # Doimiy hisoblagich: eng yuqori berilgan id saqlanadi, shunda eng katta
    # id'li xodim o'chirilsa ham uning id'si qayta ishlatilmaydi.
    seq = int(_num(store.get('staffIdSeq'), 0))
    return max(max(used) if used else 0, seq) + 1


def _boss_seeded(staff):
    """Bazada Boshliq akounti allaqachon bormi?"""
    for item in staff:
        if not isinstance(item, dict):
            continue
        if str(item.get('role', '')).strip().lower() == 'boss':
            return True
        if str(item.get('login', '')).strip().lower() == BOSS_LOGIN:
            return True
    return False


_boss_seed_in_progress = False


def ensure_boss_account():
    """Boshliq akountini idempotent yaratadi (migratsiya).

    Xavfsizlik: parol `.env` dan olinadi; hech qayerda ochiq matn saqlanmaydi.
    `.env` da `BOSS_DEFAULT_PASSWORD` berilmagan bo'lsa, akount yaratilMAYDI —
    aks holda tasodifiy/noo'rin parol bilan xodim paydo bo'lardi. Bunday
    holatda aniq ogohlantirish chiqadi va akountni keyin CLI orqali yaratish
    mumkin (`python _tp_create_boss.py`).
    """
    global _boss_seed_in_progress
    # `load_staff()` ham shu funksiyani chaqiradi — qayta kirishni to'xtayamiz,
    # aks holda zanjir bo'lib, bir xil akount bir necha marta yoziladi.
    if _boss_seed_in_progress:
        return None
    _boss_seed_in_progress = True
    try:
        return _ensure_boss_account_locked()
    finally:
        _boss_seed_in_progress = False


def _ensure_boss_account_locked():
    staff = load_staff()
    if _boss_seeded(staff):
        return None

    password = (os.getenv('BOSS_DEFAULT_PASSWORD') or '').strip()
    if not password:
        print('[SECURITY] BOSS_DEFAULT_PASSWORD .env\'da yo\'q — Boshliq akounti yaratilmadi.\n'
              '           Boshliq parolini .env ga yozing yoki `python _tp_create_boss.py` ishga tushiring.')
        return None

    account = {
        'id': _next_staff_id(staff),
        'login': BOSS_LOGIN,
        'phone': BOSS_PHONE,
        'name': (os.getenv('BOSS_DISPLAY_NAME') or '').strip() or BOSS_NAME,
        'role': 'boss',
        'status': 'active',
        'mustChange': True,
        'branchId': '',
        'createdAt': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
        'updatedAt': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
    }
    # Parol: faqat xesh + meta. Boshlang'ich parol har doim almashtiriladi.
    apply_staff_password(account, password, 'Tizim (akount yaratildi)')
    account['mustChange'] = True
    staff.append(account)
    try:
        db_manager.save_keys({'staff_users': staff})
    except Exception as e:
        print(f'[SECURITY] Boshliq akountini saqlab bo\'lmadi: {e}')
        return None
    print(f'[SECURITY] Boshliq akounti yaratildi (telefon: {BOSS_PHONE}, rol: boss).')
    return account


def load_staff():
    """Xodimlar ro'yxatini qaytaradi; bo'lmasa .env asosida seed qiladi."""
    try:
        data = db_manager.get_all() or {}
        staff = data.get('staff_users')
    except Exception:
        staff = None
    if isinstance(staff, list) and staff:
        # Mavjud (eski) yozuvlarga telefon/status/id qo'shamiz — data yo'qolmaydi.
        staff, changed = _ensure_staff_fields(staff)
        if changed:
            try:
                db_manager.save_keys({'staff_users': staff})
            except Exception as e:
                print(f'[SECURITY] Xodim yozuvlarini yangilab bo\'lmadi: {e}')
        # Boshliq akounti mavjudligini ta'minlaydi (idempotent migratsiya).
        # Parol FAQAT xesh ko'rinishida saqlanadi.
        if not _boss_seeded(staff):
            ensure_boss_account()
        return staff

    # DIQQAT: ilgari bu yerda BOSS_DEFAULT_PASSWORD ham ishlatilardi — ya'ni
    # Boshliq paroli barcha standart xodimlarning paroli bo'lib qolardi
    # (auditda CRITICAL deb belgilangan: ommaviy repodagi parol orqali
    # oddiy xodim akountiga ham kirish mumkin edi). Endi alohida parol
    # ko'rsatilmasa — tasodifiy parol yaratiladi va FAQAT bir marta
    # konsolga chiqariladi; u ham `mustChange` bo'ladi.
    password = _first_env('STAFF_DEFAULT_PASSWORD', 'TP_STAFF_PASSWORD')
    generated_password = False
    if not password:
        password = secrets.token_urlsafe(12)
        generated_password = True
    password_is_default = password == _DEFAULT_PASSWORD
    seeded = []
    for idx, item in enumerate(_DEFAULT_STAFF, start=1):
        salt = item['salt'] if password_is_default else make_salt('tp-' + item['role'][:3] + '-')
        seeded.append({
            'id': idx,
            'login': item['login'],
            'phone': item.get('phone', ''),
            'salt': salt,
            'passHash': hash_password(password, salt),
            'name': item['name'],
            'role': item['role'],
            'status': 'active',
            # Boshlang'ich/umumiy parol har qanday holatda almashtiriladi.
            'mustChange': True,
            'passChangedAt': _now_stamp(),
            'passChangedBy': "Tizim (boshlang'ich parol)",
        })
    try:
        db_manager.save_keys({'staff_users': seeded})
    except Exception as e:
        print(f'[SECURITY] Xodimlarni saqlab bo\'lmadi: {e}')
    # MUHIM: Boshliq akountini SHU YERDA yaratamiz. Aks holda bo'sh bazada
    # BOSHLIQ ning birinchi login urinishi "Login yoki parol xato" (401)
    # qaytarardi: ro'yxat akount qo'shilishidan OLDIN olingan bo'lardi.
    ensure_boss_account()
    try:
        fresh = (db_manager.get_all() or {}).get('staff_users')
    except Exception:
        fresh = None
    if isinstance(fresh, list) and fresh:
        seeded = fresh
    if password_is_default:
        print("[SECURITY] Standart parol (123456) ishlatilmoqda! "
              "Iltimos, STAFF_DEFAULT_PASSWORD o'rnating yoki parollarni o'zgartiring.")
    elif generated_password:
        print(f"[SECURITY] Standart xodimlar uchun TASODIFIY parol yaratildi: {password}")
        print("[SECURITY] Uni saqlab qo'ying — xodimlar birinchi kirishda almashtiradi "
              "yoki Boshliq panelidan yangi parol berasiz.")
    return seeded


def is_legacy_alias(user, staff=None):
    """Eski `login@domen` aliasi ekanini aniqlaydi.

    Bunday yozuvlar faqat ko'rinish uchun emas — login uchun ham yaroqsiz.
    Asosiy (telefonli yoki oddiy loginli) bir xil ism+rol yozuvi mavjud bo'lsa,
    alias orqali autentifikatsiya qilish taqiqlanadi.
    """
    if not isinstance(user, dict):
        return False
    login = str(user.get('login') or '').strip()
    if '@' not in login:
        return False
    if normalize_phone(user.get('phone')):
        return False
    key = (str(user.get('name') or '').strip().lower(),
           str(user.get('role') or '').strip().lower())
    rows = staff if staff is not None else load_staff()
    for other in rows:
        if not isinstance(other, dict) or other is user:
            continue
        other_key = (str(other.get('name') or '').strip().lower(),
                     str(other.get('role') or '').strip().lower())
        if other_key != key:
            continue
        other_login = str(other.get('login') or '').strip()
        if '@' not in other_login or normalize_phone(other.get('phone')):
            return True
    return False


def find_staff(login):
    key = str(login or '').strip().lower()
    staff = load_staff()
    for user in staff:
        if (str(user.get('login', '')).lower() == key
                and not is_legacy_alias(user, staff)):
            return user
    return None


def find_staff_by_phone(phone):
    """Telefon raqami bo'yicha xodimni topadi (normalizatsiya qilingan)."""
    key = normalize_phone(phone)
    if not key:
        return None
    staff = load_staff()
    for user in staff:
        if (phones_match(user.get('phone'), key)
                and not is_legacy_alias(user, staff)):
            return user
    return None


def _staff_phone_in_use(staff, phone, exclude_id=None):
    """Faol telefonni eski xodim yozuvlari va login aliaslari bilan solishtiradi."""
    key = normalize_phone(phone)
    if not key:
        return False
    for user in staff:
        if not isinstance(user, dict):
            continue
        if exclude_id is not None and str(user.get('id')) == str(exclude_id):
            continue
        if phones_match(user.get('phone'), key) or phones_match(user.get('login'), key):
            return True
    return False


def server_security_log(event, level, message, user='—'):
    """Server tomonidagi xavfsizlik jurnali (maxfiy ma'lumot yozilmaydi)."""
    try:
        data = db_manager.get_all() or {}
        events = data.get('serverSecurityLog')
        if not isinstance(events, list):
            events = []
        events.insert(0, {
            'time': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
            'ip': get_client_ip(),
            'type': str(event)[:60],
            'level': level if level in ('low', 'medium', 'high', 'critical') else 'low',
            'message': str(message)[:240],
            'user': str(user)[:120],
        })
        db_manager.save_keys({'serverSecurityLog': events[:300]})
    except Exception as e:
        print(f'[SECURITY-LOG-ERROR] {e}')


def _b64url(data):
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def _b64url_decode(text):
    pad = '=' * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def create_token(user):
    """Token yaratadi va (token, payload) qaytaradi.

    Har bir token `jti` (yagona ID) bilan chiqadi — shu orqali sessiya
    ro'yxatda ko'rinadi va administrator uni alohida yopib qo'ya oladi.
    """
    payload = {
        'sub': user.get('login'),
        'name': user.get('name'),
        'role': canonical_role(user.get('role')),
        'mustChange': bool(user.get('mustChange')),
        'jti': secrets.token_hex(8),
        'exp': int(time.time()) + TOKEN_TTL_HOURS * 3600,
        'iat': int(time.time()),
    }
    body = _b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    sig = hmac.new(auth_secret().encode('utf-8'), body.encode('ascii'), hashlib.sha256).hexdigest()
    return f'{body}.{sig}', payload


# ============================================================
# FAOL SESSIYALAR (qurilma, IP, vaqt) — admin panel uchun
# ============================================================
# Har bir token uchun bitta yozuv saqlanadi. Yozuvlar faqat qurilma turi
# (User-Agent'dan qisqa xulosa) va IP manzilni saqlaydi — hech qanday
# maxfiy ma'lumot (parol, token, mijoz PII) yozilmaydi.
SESSION_KEY = 'active_sessions'
MAX_TRACKED_SESSIONS = 200


def summarize_device(agent):
    """User-Agent'dan qurilma va brauzer nomini ajratib oladi."""
    low = str(agent or '').lower()[:300]
    device = 'Noma\'lum qurilma'
    for key, label in (('iphone', 'iPhone'), ('ipad', 'iPad'), ('android', 'Android'),
                       ('windows', 'Windows'), ('mac os', 'macOS'), ('macintosh', 'macOS'),
                       ('linux', 'Linux'), ('curl', 'Dastur (API)'), ('python', 'Dastur (API)')):
        if key in low:
            device = label
            break
    browser = ''
    for key, label in (('edg/', 'Edge'), ('chrome/', 'Chrome'), ('firefox/', 'Firefox'),
                       ('safari/', 'Safari'), ('trident', 'Internet Explorer')):
        if key in low:
            browser = label
            break
    return f'{device} · {browser}' if browser else device


def load_sessions():
    try:
        rows = (db_manager.get_all() or {}).get(SESSION_KEY)
    except Exception:
        rows = None
    return rows if isinstance(rows, list) else []


def save_sessions(rows):
    try:
        db_manager.save_keys({SESSION_KEY: rows[:MAX_TRACKED_SESSIONS]})
    except Exception as e:
        print(f'[SESSION] Sessiyalarni saqlab bo\'lmadi: {e}')


def prune_sessions(rows=None):
    """Muddati o'tgan sessiyalarni olib tashlaydi."""
    now = int(time.time())
    source = load_sessions() if rows is None else rows
    return [r for r in source if isinstance(r, dict) and int(r.get('exp') or 0) > now]


def register_session(payload):
    """Yangi token uchun sessiya yozuvi (qurilma, IP, vaqtlar)."""
    rows = prune_sessions()
    rows = [r for r in rows if r.get('jti') != payload.get('jti')]
    rows.insert(0, {
        'jti': str(payload.get('jti') or ''),
        'login': str(payload.get('sub'))[:120],
        'name': str(payload.get('name'))[:120],
        'role': payload.get('role'),
        'ip': get_client_ip(),
        'device': summarize_device(request.headers.get('User-Agent')),
        'created': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
        'lastSeen': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
        '_seen': int(time.time()),
        'exp': int(payload.get('exp') or 0),
    })
    save_sessions(rows)
    return rows[0]


def find_session(jti):
    key = str(jti or '')
    if not key:
        return None
    for row in prune_sessions():
        if str(row.get('jti')) == key:
            return row
    return None


def touch_session(jti):
    """Oxirgi faollik vaqtini yangilaydi (60 sekundda ko'pi bilan bir marta)."""
    key = str(jti or '')
    now = int(time.time())
    rows = prune_sessions()
    changed = False
    for row in rows:
        if str(row.get('jti')) == key:
            if now - int(row.get('_seen') or 0) >= 60:
                row['lastSeen'] = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
                row['_seen'] = now
                changed = True
            break
    if changed:
        save_sessions(rows)


def revoke_session(jti):
    """Bitta sessiyani bekor qiladi (o'zgargan ro'yxatni qaytaradi)."""
    key = str(jti or '')
    rows = [r for r in load_sessions() if str(r.get('jti')) != key]
    save_sessions(rows)
    return rows


def revoke_login_sessions(login, keep_jti=''):
    """Bitta xodimning barcha sessiyalarini yopadi (parol almashganda)."""
    target = str(login or '').lower()
    keep = str(keep_jti or '')
    rows = [r for r in load_sessions()
            if str(r.get('login', '')).lower() != target or str(r.get('jti')) == keep]
    save_sessions(rows)


def verify_token(token):
    """Tokenni tekshiradi (imzo + muddat). Yaroqli bo'lsa payload, aks holda None."""
    raw = str(token or '').strip()
    if not raw or '.' not in raw:
        return None
    body, _, sig = raw.rpartition('.')
    expected = hmac.new(auth_secret().encode('utf-8'), body.encode('ascii'), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        payload = json.loads(_b64url_decode(body).decode('utf-8'))
    except Exception:
        return None
    if int(payload.get('exp') or 0) <= int(time.time()):
        return None
    return payload


def current_staff():
    """So'rovdagi tokendan foydalanuvchini oladi va JORIY holatini tekshiradi.

    Token ichidagi rol/ism eskirgan bo'lishi mumkin (masalan, Boshliq xodimni
    bloklagan yoki rolini pasaytirgan). Shuning uchun har bir so'rovda:
      1) xodim bazada hali ham mavjudligi;
      2) holati `active` ekanligi;
      3) roli va ismi bazadagi ENG SO'NGGI qiymat ekanligi tekshiriladi.

    Bloklangan/arxivlangan xodimning eski tokeni darhol kuchini yo'qotadi.
    """
    header = request.headers.get('Authorization', '')
    token = ''
    if header.lower().startswith('bearer '):
        token = header[7:].strip()
    if not token:
        token = request.headers.get('X-Staff-Token', '') or ''
    payload = verify_token(token)
    if not payload:
        return None
    # Sessiya reyestri: admin yopgan yoki muddati o'tgan sessiya qabul qilinmaydi
    jti = str(payload.get('jti') or '')
    if jti:
        if not find_session(jti):
            return None
        touch_session(jti)

    login = str(payload.get('sub') or '').strip()
    try:
        user = find_staff(login) or find_staff_by_phone(login)
    except Exception as e:
        print(f'[AUTH] Xodim holatini tekshirib bo\'lmadi: {e}')
        user = None
    if not user:
        if jti:
            revoke_session(jti)
        return None

    status = str(user.get('status') or 'active').strip().lower()
    if status not in ('active', ''):
        if jti:
            revoke_session(jti)
        server_security_log('auth-revoked', 'medium',
                            f'{status} holatdagi akount tokeni rad etildi: {login}',
                            user.get('name', '—'))
        return None

    # Rol/ism/ID ni bazadagi joriy qiymatlar bilan yangilaymiz. Shu tufayli
    # rol pasaytirilganda eski token bilan yuqori huquq saqlanib qolmaydi.
    payload['sub'] = str(user.get('login') or login)
    payload['role'] = canonical_role(user.get('role') or payload.get('role'))
    payload['name'] = str(user.get('name') or payload.get('name') or '')
    payload['id'] = user.get('id')
    payload['mustChange'] = bool(user.get('mustChange'))
    return payload


def require_staff(*roles):
    """Faqat kerakli rollarga ruxsat beruvchi dekorator (server-side RBAC)."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            payload = current_staff()
            if not payload:
                server_security_log('auth-required', 'medium',
                                    f'Tokensiz kirish urinishi: {request.path}')
                return jsonify({'status': 'error', 'code': 'unauthorized',
                                'message': 'Avtorizatsiya talab qilinadi'}), 401
            # Rol iyerarxiyasi: BOSHLIQ > ADMIN > MANAGER > CASHIER.
            # `customer` kabi ichki tizimga kirmaydigan rollar hech qachon o'tmaydi.
            allowed = roles or STAFF_ROLES
            if not role_contains(allowed, payload.get('role')):
                server_security_log('access-denied', 'high',
                                    f'Ruxsat yo\'q: {payload.get("role")} -> {request.path}',
                                    payload.get('name', '—'))
                return jsonify({'status': 'error', 'code': 'forbidden',
                                'message': 'Bu amal uchun huquq yetarli emas'}), 403
            request.staff = payload  # type: ignore[attr-defined]
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def login_allowed(ip):
    """Brute-force himoyasi: IP bo'yicha urinishlar soni."""
    now = time.time()
    with _login_lock:
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_attempts[ip] = attempts
        return len(attempts) < LOGIN_MAX_ATTEMPTS


def register_login_attempt(ip):
    with _login_lock:
        _login_attempts.setdefault(ip, []).append(time.time())


def clear_login_attempts(ip):
    """Muvaffaqiyatli kirishdan keyin IP uchun eski urinishlarni tozalaydi."""
    with _login_lock:
        _login_attempts.pop(ip, None)


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    """Xodim login: parol bazadagi xesh bilan tekshiriladi, token qaytariladi."""
    ip = get_client_ip()
    if not login_allowed(ip):
        server_security_log('login-rate-limit', 'high', 'Juda ko\'p login urinishi (brute-force)', '—')
        return jsonify({'status': 'error', 'code': 'rate_limited',
                        'message': 'Juda ko\'p urinish. Bir necha daqiqadan so\'ng qayta urinib ko\'ring'}), 429

    payload = request.get_json(silent=True) or {}
    # Frontend telefon raqamini `login` maydonida yuboradi; `phone` ham qabul qilinadi.
    # Eski username loginlari ham ishlashda davom etadi (backward-compatible).
    login = str(payload.get('login') or payload.get('phone') or '').strip()[:120]
    password = str(payload.get('password') or '')[:200]
    if not login or not password:
        return jsonify({'status': 'error', 'message': 'Login va parol kiritilishi shart'}), 400

    # ── Cloudflare Turnstile (CAPTCHA) tekshiruvi ──
    # token yuborilgan bo'lsa doim tekshiriladi; CF_TURNSTILE_ENFORCE=true
    # bo'lsa token umuman yuborilmasa ham kirish rad etiladi.
    if CF_TURNSTILE_ENABLED:
        ts_token = extract_turnstile_token(payload)
        if ts_token or CF_TURNSTILE_ENFORCE:
            captcha_ok, captcha_reason = verify_turnstile(ts_token, get_client_ip())
            if not captcha_ok:
                server_security_log('captcha-failed', 'high',
                                    f'CAPTCHA tasdiqlanmadi: {captcha_reason}', login)
                return jsonify({'status': 'error', 'code': 'captcha_failed',
                                'message': captcha_reason}), 403
        else:
            server_security_log('captcha-missing', 'medium',
                                'CAPTCHA tokenisiz login urinishi (mobil yoki eski mijoz?)', login)

    user = find_staff(login) or find_staff_by_phone(login)
    ok = bool(user) and verify_password(password, user.get('salt', ''), user.get('passHash', ''))
    if ok and str(user.get('status', 'active')).strip().lower() not in ('active', ''):
        # Parol to'g'ri, lekin hisob bloklangan/inactive — kirishga ruxsat berilmaydi.
        server_security_log('login-blocked', 'medium',
                            f'Bloklangan hisobga kirish urinishi: {user.get("role")}', user.get('name'))
        return jsonify({'status': 'error', 'code': 'account_blocked',
                        'message': 'Hisob bloklangan — administratorga murojaat qiling'}), 403
    if not ok:
        register_login_attempt(ip)
        server_security_log('login-failed', 'medium', f'Muvaffaqiyatsiz login: {login}', login)
        return jsonify({'status': 'error', 'code': 'bad_credentials',
                        'message': 'Login yoki parol xato'}), 401

    # Parolning qayta tiklanadigan nusxasi SAQLANMAYDI (xavfsizlik siyosati).
    # Eski (SHA-256) xesh bo'lsa — jimgina yangi PBKDF2 sxemasiga o'tkazamiz.
    # Foydalanuvchi buni sezmaydi; keyingi kirishlar allaqachon xavfsiz xeshda.
    rehash_staff_password(user, password)
    clear_login_attempts(ip)

    token, payload = create_token(user)
    session = register_session(payload)
    server_security_log('login-success', 'low',
                        f'Kirish: {user.get("role")} · {session.get("device")}', user.get('name'))
    return jsonify({
        'status': 'success',
        'token': token,
        'expiresIn': TOKEN_TTL_HOURS * 3600,
        'mustChangePassword': bool(user.get('mustChange')),
        'user': {'login': user.get('login'), 'name': user.get('name'),
                 'role': canonical_role(user.get('role')), 'phone': user.get('phone'),
                 'branchId': str(user.get('branchId') or '')[:40]},
    })


@app.route('/api/auth/session', methods=['GET'])
def auth_session():
    payload = current_staff()
    if not payload:
        return jsonify({'status': 'error', 'code': 'unauthorized'}), 401
    me = find_staff(str(payload.get('sub') or '')) or find_staff_by_phone(payload.get('sub'))
    return jsonify({'status': 'success', 'user': {
        'login': payload.get('sub'), 'name': payload.get('name'),
        'role': canonical_role(payload.get('role')),
        'phone': (me or {}).get('phone', ''),
        'branchId': str((me or {}).get('branchId') or '')[:40],
    }, 'exp': payload.get('exp')})
@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    """Joriy sessiyani server tomondan yopadi (chiqish).

    Klient tokenini o'chirishi yetarli emas — token yaroqli bo'lib qolishi
    mumkin, shuning uchun server sessiya reyestridan ham o'chiradi.
    """
    payload = current_staff()
    if not payload:
        return jsonify({'status': 'success', 'message': 'Sessiya yopilgan'}), 200
    jti = str(payload.get('jti') or '')
    if jti:
        revoke_session(jti)
    server_security_log('logout', 'low',
                        f'Chiqish: {payload.get("role")}', payload.get('name', '—'))
    return jsonify({'status': 'success', 'message': 'Chiqildi'})


@app.route('/api/auth/change-password', methods=['POST'])
def auth_change_password():
    """Parolni almashtirish: o'zi yoki yuqori rolli rahbar boshqa xodim uchun.

    Xavfsizlik qoidasi:
      - o'z parolini har qanday faol xodim almashtira oladi;
      - boshqa xodim parolini faqat undan YUQORI rol (admin yoki boss)
        almashtira oladi. Shu bilan admin `boss` parolini o'zgartirib,
        uning nomidan token olib, huquqni oshirishi mumkin emas.
      - boshqa xodimga parol qo'yilganda unga token QAYTARILMAYDI.
    """
    payload = current_staff()
    if not payload:
        return jsonify({'status': 'error', 'code': 'unauthorized',
                        'message': 'Avtorizatsiya talab qilinadi'}), 401

    body = request.get_json(silent=True) or {}
    target_login = str(body.get('login') or payload.get('sub') or '').strip()[:120]
    current_password = str(body.get('currentPassword') or '')[:200]
    new_password = str(body.get('newPassword') or '')[:200]

    if len(new_password) < 6:
        return jsonify({'status': 'error', 'message': 'Yangi parol kamida 6 belgidan iborat bo\'lishi kerak'}), 400

    is_self = str(payload.get('sub', '')).lower() == target_login.lower()

    # Alias (`admin@texnopark.uz`) orqali kirish yoki parol almashtirish yo'q.
    staff = load_staff()
    target = None
    for item in staff:
        if (str(item.get('login', '')).lower() == target_login.lower()
                and not is_legacy_alias(item, staff)):
            target = item
            break
    if not target:
        return jsonify({'status': 'error', 'message': 'Xodim topilmadi'}), 404

    if not is_self:
        actor_rank = role_rank(payload.get('role'))
        target_rank = role_rank(target.get('role'))
        if actor_rank < role_rank('admin') or target_rank >= actor_rank:
            server_security_log('password-change-denied', 'high',
                                f'Ruxsatsiz parol almashtirish urinishi: {target_login}',
                                payload.get('name', '-'))
            return jsonify({'status': 'error', 'code': 'forbidden',
                            'message': 'Faqat o\'zingizdan yuqori bo\'lmagan xodim '
                                       'parolini o\'zgartira olasiz'}), 403

    if is_self:
        if not verify_password(current_password, target.get('salt', ''), target.get('passHash', '')):
            server_security_log('password-change-failed', 'medium',
                                'Joriy parol xato', target_login)
            return jsonify({'status': 'error', 'message': 'Joriy parol xato'}), 401

    apply_staff_password(target, new_password,
                         "Xodim o'zi" if is_self else str(payload.get('name') or ''))
    try:
        db_manager.save_keys({'staff_users': staff})
    except Exception:
        return jsonify({'status': 'error', 'message': 'Parolni saqlab bo\'lmadi'}), 500

    server_security_log('password-changed', 'medium', f'Parol yangilandi: {target_login}',
                        payload.get('name', '-'))

    if not is_self:
        # Boshqa xodimning barcha sessiyalari yopiladi; token qaytarilmaydi.
        revoke_login_sessions(target_login)
        return jsonify({'status': 'success',
                        'message': 'Parol yangilandi. Xodim qayta kirishi kerak.'})

    # O'z paroli: eski sessiyalar yopiladi va yangi token beriladi.
    new_token, new_payload = create_token(target)
    revoke_login_sessions(target_login, keep_jti=new_payload.get('jti'))
    register_session(new_payload)
    return jsonify({'status': 'success', 'message': 'Parol yangilandi.',
                    'token': new_token, 'mustChangePassword': False})


@app.route('/api/auth/change-phone', methods=['POST'])
def auth_change_phone():
    """Xodim O'ZI login (telefon) raqamini almashtiradi.

    Xavfsizlik:
      • joriy parol tasdiqlanadi;
      • raqam boshqa xodimda band bo'lsa — 409;
      • telefon login bo'lgani uchun yangi token beriladi va eski sessiyalar
        yopiladi (eski raqam bilan kirish mumkin bo'lib qolmaydi);
      • o'zgarish Boshliq panelida ko'rinadi (audit + xavfsizlik jurnali).
    """
    payload = current_staff()
    if not payload:
        return jsonify({'status': 'error', 'code': 'unauthorized',
                        'message': 'Avtorizatsiya talab qilinadi'}), 401

    body = request.get_json(silent=True) or {}
    current_password = str(body.get('currentPassword') or '')[:200]
    new_phone = normalize_phone(body.get('newPhone') or body.get('phone'))
    if not new_phone:
        return jsonify({'status': 'error', 'code': 'bad_phone',
                        'message': "Telefon raqami noto'g'ri. Namuna: +998 90 123 45 67"}), 400

    me_login = str(payload.get('sub') or '').strip()
    staff = load_staff()
    target = next((u for u in staff if isinstance(u, dict)
                   and str(u.get('login', '')).strip().lower() == me_login.lower()), None)
    if not target:
        return jsonify({'status': 'error', 'message': 'Xodim topilmadi'}), 404

    if not current_password or not verify_password(
            current_password, target.get('salt', ''), target.get('passHash', '')):
        server_security_log('phone-change-failed', 'medium',
                            'Login almashtirishda joriy parol xato', me_login)
        return jsonify({'status': 'error', 'message': 'Joriy parol xato'}), 401

    if phones_match(target.get('phone'), new_phone):
        return jsonify({'status': 'success',
                        'message': 'Bu raqam allaqachon sizning loginingiz',
                        'user': {'login': target.get('login'), 'name': target.get('name'),
                                 'role': target.get('role'), 'phone': target.get('phone')}})

    clash = find_staff_by_phone(new_phone)
    if clash and _num(clash.get('id'), -1) != _num(target.get('id'), -1):
        return jsonify({'status': 'error', 'code': 'phone_taken',
                        'message': 'Bu telefon raqami boshqa xodimda band'}), 409

    old_login = str(target.get('login') or '')
    apply_staff_phone(target, new_phone, "Xodim o'zi")
    try:
        db_manager.save_keys({'staff_users': staff})
    except Exception:
        return jsonify({'status': 'error', 'message': "Raqamni saqlab bo'lmadi"}), 500

    audit_log('staff-phone-change', str(target.get('name', '')),
              f'login: {old_login} -> {new_phone}', "Xodim o'zi")
    server_security_log('phone-changed', 'medium',
                        f'Login (telefon) almashtirildi: {old_login} -> {new_phone}',
                        target.get('name', '—'))
    new_token, new_payload = create_token(target)
    revoke_login_sessions(old_login, keep_jti=new_payload.get('jti'))
    register_session(new_payload)
    return jsonify({'status': 'success',
                    'message': 'Login (telefon) yangilandi — keyingi kirishda '
                               'yangi raqamdan foydalanasiz',
                    'token': new_token,
                    'user': {'login': target.get('login'), 'name': target.get('name'),
                             'role': target.get('role'), 'phone': target.get('phone')}})


@app.route('/api/auth/logout-all', methods=['POST'])
@require_staff('admin')
def auth_logout_all():
    """Barcha faol tokenlarni bekor qiladi.

    Tokenlar HMAC bilan imzolanadi; imzo kaliti almashtirilishi bilan
    ilgari berilgan BARCHA tokenlar kuchini yo'qotadi (shu jumladan
    joriy administrator sessiyasi ham)."""
    global _AUTH_SECRET
    new_secret = secrets.token_urlsafe(48)
    try:
        db_manager.save_keys({'auth_secret': new_secret})
    except Exception as e:
        print(f'[SECURITY] logout-all xatosi: {e}')
        return json_error('Kalitni almashtirib bo\'lmadi', 500)
    _AUTH_SECRET = new_secret
    server_security_log('logout-all', 'high', 'Barcha sessiyalar majburiy yopildi',
                        request.staff.get('name', '—'))  # type: ignore[attr-defined]
    return jsonify({'status': 'success', 'message': 'Barcha sessiyalar yopildi. Qayta kiring.'})


@app.route('/api/security/sessions', methods=['GET'])
@require_staff('admin')
def security_sessions():
    """Faol sessiyalar va login/chiqish tarixi (faqat administrator uchun)."""
    me = request.staff  # type: ignore[attr-defined]
    my_jti = str(me.get('jti') or '')
    rows = prune_sessions()
    save_sessions(rows)
    sessions = [{
        'jti': str(r.get('jti')),
        'login': r.get('login'),
        'name': r.get('name'),
        'role': r.get('role'),
        'ip': r.get('ip'),
        'device': r.get('device'),
        'created': r.get('created'),
        'lastSeen': r.get('lastSeen'),
        'current': str(r.get('jti')) == my_jti,
    } for r in rows]

    data = db_manager.get_all() or {}
    events = [e for e in (data.get('serverSecurityLog') or []) if isinstance(e, dict)]
    attempts = [{
        'time': str(e.get('time'))[:20],
        'ip': str(e.get('ip'))[:60],
        'type': str(e.get('type'))[:40],
        'level': e.get('level'),
        'message': str(e.get('message'))[:160],
        'user': str(e.get('user'))[:120],
    } for e in events if 'login' in str(e.get('type', '')) or 'logout' in str(e.get('type', ''))][:60]

    return jsonify({'status': 'success', 'sessions': sessions, 'attempts': attempts,
                    'count': len(sessions), 'currentJti': my_jti})


@app.route('/api/cloudflare/sync-domain', methods=['POST'])
@require_staff('admin')
def cloudflare_sync_domain():
    """SITE_DOMAIN ni Turnstile widgetiga qo'shishni qo'lda ishga tushiradi."""
    state = sync_turnstile_domain(force=True)
    ok = state.get('state') in ('ok', 'updated')
    server_security_log('cloudflare-domain-sync', 'low' if ok else 'medium',
                        f"Domen sinxronizatsiyasi: {state.get('state')} — {state.get('message')}",
                        request.staff.get('name', '—'))  # type: ignore[attr-defined]
    return jsonify({'status': 'success' if ok else 'error', **state}), 200 if ok else 400


@app.route('/api/security/sessions/revoke', methods=['POST'])
@require_staff('admin')
def security_session_revoke():
    """Bitta sessiyani masofadan yopadi (o'z sessiyasi bu yerdan yopilmaydi)."""
    me = request.staff  # type: ignore[attr-defined]
    body = request.get_json(silent=True) or {}
    jti = str(body.get('jti') or '').strip()[:64]
    if not jti:
        return json_error('Sessiya identifikatori kerak')
    if jti == str(me.get('jti') or ''):
        return json_error('O\'z sessiyangizni bu yerdan yopib bo\'lmaydi — «Tizimdan chiqish» dan foydalaning', 400)

    target = find_session(jti)
    if not target:
        return json_error('Sessiya topilmadi (allaqachon yopilgan)', 404)

    revoke_session(jti)
    server_security_log('session-revoked', 'medium',
                        f'Sessiya yopildi: {target.get("login")} · {target.get("device")} · {target.get("ip")}',
                        me.get('name'))
    return jsonify({'status': 'success', 'message': f'Sessiya yopildi: {target.get("name")}'})


@app.route('/api/auth/staff', methods=['GET'])
@require_staff('admin')
def auth_staff_list():
    """Admin uchun xodimlar ro'yxati (faqat ochiq maydonlar)."""
    return jsonify({'status': 'success', 'staff': [
        {'login': u.get('login'), 'name': u.get('name'), 'role': u.get('role'),
         'mustChange': bool(u.get('mustChange')), 'updatedAt': u.get('updatedAt', '—')}
        for u in load_staff()
    ]})


# ============================================================
# BOSHLIQ BOSHQARUVI — executive dashboard + xodimlar nazorati
# ============================================================
# Xodimlar ro'yxati va yaratish endpointlarida Menejer uchun alohida
# filial-doirasidagi kassir siyosati bor; tahrirlash/arxivlash Admin darajasida,
# executive/payroll endpointlari esa faqat Boshliq uchun qoladi.
# Server tomoni tekshiradi — frontend'dagi menyu yashirishga tayanilmaydi.
#
# Barcha statistika MAVJUD bazadagi haqiqiy savdo (`sales`), mahsulot
# (`products`), filial (`branches`) va kirim/chiqim (`cashFlow`) yozuvlaridan
# hisoblanadi. Namuna/demo qiymatlar ishlatilmaydi: ma'lumot bo'lmasa — 0.
# ============================================================

def audit_log(action, target='', detail='', actor=''):
    """Boshliqning muhim amallarini jurnalga yozadi.

    Parol hech qachon yozilmaydi: `detail` ga faqat xodim login/rol kabi
    ochiq ma'lumotlar beriladi. Jurnal `audit_log` kaliti ostida saqlanadi.
    """
    try:
        data = db_manager.get_all() or {}
        events = data.get('audit_log')
        if not isinstance(events, list):
            events = []
        events.insert(0, {
            'time': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
            'actor': str(actor or '')[:120],
            'action': str(action)[:60],
            'target': str(target)[:120],
            'detail': str(detail)[:200],
            'ip': get_client_ip(),
        })
        db_manager.save_keys({'audit_log': events[:MAX_AUDIT_LOG]})
    except Exception as e:
        print(f'[AUDIT-LOG-ERROR] {e}')


def record_staff_salary_change(staff_id, staff_name, old_salary, new_salary,
                               actor='', note=''):
    """Oylik maosh o'zgarishini tarixga yozadi (staffSalaryHistory).

    `old_salary` / `new_salary` — butun so'm yoki None ("Belgilanmagan").
    Yozuv yangidan eskiga tartibda saqlanadi; tarix chegarasi 20000 ta.
    """
    try:
        store = db_manager.get_all() or {}
        history = store.get('staffSalaryHistory')
        if not isinstance(history, list):
            history = []
        now = datetime.now()
        history.insert(0, {
            'id': uuid.uuid4().hex[:12],
            'staffId': staff_id,
            'staffName': str(staff_name or '')[:120],
            'oldSalary': old_salary,
            'newSalary': new_salary,
            'effectiveDate': now.strftime('%Y-%m-%d'),
            'changedAt': now.strftime('%d.%m.%Y %H:%M:%S'),
            'changedBy': str(actor or '')[:120],
            'note': str(note or '')[:200],
        })
        db_manager.save_keys({'staffSalaryHistory': history[:20000]})
    except Exception as e:
        print(f'[BOSS] Maosh tarixini saqlab bo\'lmadi: {e}')


def _num(value, default=0.0):
    """Xavfsiz raqamga aylantirish (None/NaN/noto'g'ri satr → default)."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if result != result:
        return default
    return result


def store_settings():
    data = db_manager.get_all() or {}
    settings = data.get('settings')
    return settings if isinstance(settings, dict) else {}


def low_stock_threshold():
    """Kam qolgan mahsulot chegarasi (boshqa modullardagi kabi 5)."""
    return max(1, int(_num(store_settings().get('lowStockThreshold'), 5.0)))


# ── Sana va filtr yordamchilari ─────────────────────────────────
# Savdo yozuvlari `date` maydoni `toLocaleDateString('uz-UZ')` ko'rinishida
# saqlanadi — O'zbekistonda bu "DD.MM.YYYY" (masalan 05.10.2026).
# Eski yozuvlar boshqa formatlarda bo'lishi mumkin, shuning uchun ajratgich
# bo'yicha aniqlanadi: `.` → kun-oldinda, `-`/`/` → ISO yoki MM/DD/YYYY.
def parse_business_date(raw):
    """Sana satrini `datetime` ga aylantiradi; aniqlanmasa None."""
    text = str(raw or '').strip()
    if not text:
        return None
    nums = re.findall(r'\d+', text)
    if len(nums) >= 3:
        four = [n for n in nums if len(n) == 4]
        if four:
            year = int(four[0])
            rest = [int(n) for n in nums if len(n) != 4]
            a, b = rest[0], rest[1]
            # (oy, kun) juftligi to'g'ri qurilishi kerak:
            #  • "05.10.2026" (uz-UZ, nuqta bilan) → oy=10(b), kun=05(a)
            #  • "2026-10-05" (ISO, 4 xonali sana birinchi) → oy=10(a), kun=05(b)
            #  • "10/05/2026" (US) → oy=10(a), kun=05(b)
            # Noto'g'ri talqin qilinishi mumkin bo'lgan holat uchun
            # zaxira variant ham sinab ko'riladi.
            dot_form = '.' in text and '-' not in text and '/' not in text
            primary = (b, a) if dot_form else (a, b)
            for month, day in (primary, (primary[1], primary[0])):
                if 1 <= month <= 12 and 1 <= day <= 31:
                    try:
                        return datetime(year, month, day)
                    except ValueError:
                        continue
        else:
            d, m, y = int(nums[0]), int(nums[1]), int(nums[2])
            if y < 100:
                y += 2000
            try:
                return datetime(y, m, d)
            except ValueError:
                pass
    for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            return datetime.strptime(text[:19], fmt)
        except ValueError:
            continue
    return None


def period_bounds(period, ref=None):
    """`period` uchun (start, end) sanalar.

    Qo'llab-quvvatlanadi: 'day'/'today', 'week', 'month', '7d', '30d', 'all'.
    """
    ref = ref or datetime.now()
    key = str(period or 'all').strip().lower()
    if key in ('day', 'today'):
        return ref.replace(hour=0, minute=0, second=0, microsecond=0), ref
    if key == 'week':
        start = ref - timedelta(days=ref.weekday())
        return start.replace(hour=0, minute=0, second=0, microsecond=0), ref
    if key == 'month':
        start = ref.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return start, ref
    if key == '7d':
        return (ref - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0), ref
    if key == '30d':
        return (ref - timedelta(days=30)).replace(hour=0, minute=0, second=0, microsecond=0), ref
    return None, None


# Boshliq modullarida qabul qilinadigan davr kalitlari.
PERIOD_CHOICES = ('day', 'today', 'week', 'month', 'all', '7d', '30d')


def normalize_period(raw):
    """So'rovdagi davr parametrini tasdiqlangan qiymatga keltiradi ('all' standart)."""
    key = str(raw or 'all').strip().lower()
    return key if key in PERIOD_CHOICES else 'all'


def custom_period_range(args):
    """`from`/`to` sana parametrlaridan (start, end) datetime juftligi.

    Ikkala parametr ixtiyoriy: faqat `from` bo'lsa end=hozir, faqat `to`
    bo'lsa start=to-30 kun. Sana aniqlanmasa (None, None) qaytadi.
    """
    args = args or {}
    raw_from = (args.get('from') or args.get('fromDate') or '').strip()
    raw_to = (args.get('to') or args.get('toDate') or '').strip()
    start = parse_business_date(raw_from) if raw_from else None
    end = parse_business_date(raw_to) if raw_to else None
    # Diqqat: sana berilmasa `None` qaytariladi (tuple EMAS). Ilgari bu yerda
    # `(None, None)` qaytardi va `in_period` uni "aniq oraliq" deb qabul qilib
    # HAMMA yozuvni o'tkazib yuborardi — natijada "Kun/Oy" davr filtrlari
    # umuman ishlamasdi (sana tanlanmaguncha barcha savdo ko'rinardi).
    if not (start or end):
        return None
    if start and not end:
        end = datetime.now()
    if end and not start:
        start = end - timedelta(days=30)
    if start:
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    if end:
        end = end.replace(hour=23, minute=59, second=59, microsecond=0)
    return start, end


def in_period(raw, period, rng=None):
    """Savdo yozuvi tanlangan davrga mos keladimi?

    `rng` — (start, end) ko'rinishidagi aniq oraliq (custom sana filtri).
    """
    if rng is not None:
        start, end = rng
        if not (start or end):
            return True
        dt = parse_business_date(raw)
        if not dt:
            return False
        if start and dt < start:
            return False
        if end and dt > end:
            return False
        return True
    if str(period or 'all').lower() in ('all', ''):
        return True
    dt = parse_business_date(raw)
    if not dt:
        return False
    start, end = period_bounds(period)
    if not start:
        return True
    return start <= dt <= (end + timedelta(days=1))


def sales_in_period(store, period, rng=None):
    """Tanlangan davrdagi haqiqiy savdo yozuvlari."""
    rows = store.get('sales') or []
    if not isinstance(rows, list):
        return []
    return [s for s in rows if isinstance(s, dict) and in_period(s.get('date'), period, rng)]


def completed_sales(rows):
    """Takrorlanmagan va bekor qilinmagan (yakunlangan) savdolar."""
    return [sale for sale in _dedupe_sales(rows or [])
            if sale_is_completed(sale)]


def completed_sales_in_period(store, period, rng=None):
    return completed_sales(sales_in_period(store, period, rng))


def boss_scope(store, args):
    """Boshliq endpointlari uchun davr + custom sana oralig'i.

    DIQQAT: `branchId` bu yerda qo'llanilmaydi — filial bo'yicha ajratish
    frontend'da (boss.js) bajariladi, server butun davr yozuvlarini
    qaytaradi (ilgari ishlatilmagan o'zgaruvchi chalg'itardi).
    Qaytaradi: (period, rng, scoped_sales).
    """
    period = normalize_period((args or {}).get('period'))
    rng = custom_period_range(args)
    scoped = completed_sales_in_period(store, period, rng)
    return period, rng, scoped


# ── Foyda hisoboti ─────────────────────────────────────────────
# Xuddi frontend'dagi mantiq: (sotuv narxi - tan narxi) * dona, chegirmaning
# tegishli ulushi ayiriladi. `cost` maydoni yo'q bo'lsa — 0 (tasodifiy marja
# emas, haqiqiy ma'lumot yo'qligi ko'rsatiladi).
def sale_profit(sale):
    if not isinstance(sale, dict):
        return 0.0
    raw = sale.get('profit')
    if raw not in (None, ''):
        return _num(raw)
    items = sale.get('items')
    if not isinstance(items, list):
        return 0.0
    subtotal = 0.0
    lines = []
    for item in items:
        if not isinstance(item, dict):
            continue
        price = _num(item.get('price'))
        qty = _num(item.get('qty'))
        cost = _num(item.get('cost'))
        line = price * qty
        subtotal += line
        lines.append((price, qty, cost, line))
    disc = _num(sale.get('discAmt'))
    profit = 0.0
    for price, qty, cost, line in lines:
        share = (line / subtotal) if subtotal > 0 else 0.0
        profit += (price - cost) * qty - disc * share
    return round(profit, 2)


def sale_units(sale):
    """Chekdagi mahsulot donasi."""
    if not isinstance(sale, dict):
        return 0.0
    total = 0.0
    for item in sale.get('items') or []:
        if isinstance(item, dict):
            total += _num(item.get('qty'))
    return total


def sale_branch(sale, products_by_id):
    """Savdo qaysi filialga tegishli (savdodan, aks holda mahsulotdan)."""
    direct = str(sale.get('branchId') or '').strip()
    if direct:
        return direct
    ids = set()
    for item in sale.get('items') or []:
        if isinstance(item, dict) and item.get('id') is not None:
            ids.add(item.get('id'))
    branches = set()
    for pid in ids:
        product = products_by_id.get(pid)
        if product and product.get('branchId'):
            branches.add(str(product['branchId']))
    # Barcha mahsulot bitta filialda bo'lsa — savdo o'shandan.
    return branches.pop() if len(branches) == 1 else ''


def products_index(store):
    """id → mahsulot lug'ati (branches_key shaklida)."""
    index = {}
    for product in store.get('products') or []:
        if isinstance(product, dict) and product.get('id') is not None:
            index[product['id']] = product
    return index


def branches_index(store):
    """id → filial lug'ati."""
    index = {}
    for branch in store.get('branches') or []:
        if isinstance(branch, dict):
            index[str(branch.get('id', ''))] = branch
    return index


def unique_staff(staff):
    """Legacy `@` aliaslarini olib tashlaydi, REAL xodimlarni birlashtirmaydi.

    Ilgari barcha yozuvlar ISM bo'yicha birlashtirilardi. Natijada bir xil
    ismli ikki haqiqiy xodimdan bittasi jadvaldan BUTUNLAY yo'qolardi va
    uning savdolari ikkinchisiga qo'shilib ketardi. Endi faqat eski
    `admin@texnopark.uz` kabi aliaslar filtrlanadi: ularning logini `@`
    belgisini o'z ichiga oladi, telefoni yo'q va xuddi shu ism + roldagi
    asosiy (telefonli / oddiy loginli) yozuv mavjud.

    Bir xil ismli haqiqiy xodimlar (masalan, ikkita "Aliyev Ali") o'z
    yozuvlari bilan qoladi — bu savdo statistikasini to'g'ri ajratish uchun
    muhim.
    """
    people = [u for u in staff
              if isinstance(u, dict) and str(u.get('name', '')).strip()]
    primaries = {}
    for user in people:
        login = str(user.get('login') or '').strip()
        if '@' not in login:
            key = (str(user.get('name', '')).strip().lower(),
                   str(user.get('role', '')).strip().lower())
            primaries.setdefault(key, []).append(user)

    result = []
    for user in people:
        login = str(user.get('login') or '').strip()
        phone = str(user.get('phone') or '').strip()
        if '@' in login and not phone:
            key = (str(user.get('name', '')).strip().lower(),
                   str(user.get('role', '')).strip().lower())
            if primaries.get(key):
                continue  # eski alias — asosiy yozuv allaqachon bor
        result.append(user)
    return result


# ── OYLIK MAOSH (BELGILANGAN ISH HAQI) ────────────────────────────
# Bu qiymat xodimga BELGILANGAN oylik maosh (butun so'm). Haqiqiy
# to'lovlar bilan aralashtirilmaydi: to'lovlar `salaryRecords` /
# `salaryHistory` kalitlarida alohida yuritiladi.
STAFF_SALARY_MAX = 999_999_999_999


def parse_staff_salary(value, required=False):
    """Oylik maoshni butun so'mga aylantiradi va tekshiradi.

    Qabul qilinadi: 4000000, "4 000 000", "4,000,000", "4.000.000",
    "4 000 000 so'm". Manfiy, kasr va noaniq format rad etiladi.
    Qaytaradi: (amount|None, error|None). `required=True` va qiymat bo'sh
    bo'lsa xato qaytaradi.
    """
    if isinstance(value, bool):
        return None, 'Oylik maosh noto\'g\'ri formatda'
    if value is None:
        if required:
            return None, 'Oylik maosh kiritilishi shart'
        return None, None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not value.is_integer():
            return None, 'Oylik maosh butun so\'mda bo\'lishi kerak'
        amount = int(value)
    else:
        text = str(value).strip()
        if not text:
            if required:
                return None, 'Oylik maosh kiritilishi shart'
            return None, None
        # Valyuta birligi va bo'shliqlarni olib tashlaymiz.
        text = re.sub(r'(?i)\s*(so[\'`ʻ‘’]?m|sum|сўм)\s*$', '', text).strip()
        text = re.sub(r'[\s\u00a0\u202f\'’‘]', '', text)
        # 4.000.000 / 4,000,000 ko'rinishidagi minglik ajratgichlar.
        if re.fullmatch(r'\d{1,3}(?:[.,]\d{3})+', text):
            text = re.sub(r'[.,]', '', text)
        if not re.fullmatch(r'\d+', text):
            return None, 'Oylik maosh faqat raqamlardan iborat bo\'lishi kerak'
        amount = int(text)
    if amount < 0:
        return None, 'Oylik maosh manfiy bo\'lishi mumkin emas'
    if amount > STAFF_SALARY_MAX:
        return None, 'Oylik maosh juda katta'
    return amount, None


def _staff_salary_value(user):
    """Xodim yozuvidagi maoshni int (so'm) sifatida qaytaradi.

    Maydon umuman yo'q yoki `null` bo'lsa — None ("Belgilanmagan").
    0 esa haqiqiy qiymat sifatida qaytariladi.
    """
    if not isinstance(user, dict) or 'salary' not in user:
        return None
    amount, error = parse_staff_salary(user.get('salary'))
    if error or amount is None:
        return None
    return amount


def _staff_salary_for_period(user, salary_history, month):
    """Tanlangan oy uchun ID bo'yicha maosh tarixidan tegishli qiymatni oladi.

    Oylik o'zgarishlari oy ichida kunma-kun taqsimlanmaydi: davr ichida amal
    qilgan oxirgi qiymat qo'llanadi. Tarix bo'lmagan eski yozuvlarda joriy
    `salary` qiymati saqlanadi.
    """
    staff_id = int(_num(user.get('id'), 0))
    if staff_id <= 0:
        return _staff_salary_value(user)
    year, month_number = int(month[:4]), int(month[5:7])
    next_month = date(year + (month_number == 12), month_number % 12 + 1, 1)
    events = []
    for record in salary_history:
        if not isinstance(record, dict) or int(_num(record.get('staffId'), 0)) != staff_id:
            continue
        effective_raw = str(record.get('effectiveDate') or '').strip()
        try:
            effective = date.fromisoformat(effective_raw)
        except ValueError:
            continue
        try:
            changed = datetime.strptime(
                str(record.get('changedAt') or ''), '%d.%m.%Y %H:%M:%S')
        except ValueError:
            changed = datetime.min
        events.append((effective, changed, record))
    events.sort(key=lambda event: (event[0], event[1]))

    period_events = [event for event in events if event[0] < next_month]
    if period_events:
        return parse_staff_salary(period_events[-1][2].get('newSalary'))[0]
    future_events = [event for event in events if event[0] >= next_month]
    if future_events:
        return parse_staff_salary(future_events[0][2].get('oldSalary'))[0]
    return _staff_salary_value(user)


def staff_public_view(user, stats=None, include_salary=True):
    """Xodim yozuvini ochiq maydonlarga aylantiradi (parol/xash YO'Q)."""
    stats = stats or {}
    view = {
        'id': user.get('id'),
        'name': str(user.get('name', ''))[:120],
        'login': str(user.get('login', ''))[:120],
        'phone': str(user.get('phone', ''))[:40],
        'role': str(user.get('role', ''))[:30],
        'roleRank': role_rank(user.get('role')),
        'status': str(user.get('status') or 'active')[:30],
        'branchId': str(user.get('branchId') or '')[:40],
        'mustChange': bool(user.get('mustChange')),
        # Parolning O'ZI hech qachon qaytarilmaydi — faqat mavjudligi.
        'hasPassword': bool(str(user.get('passHash') or '')),
        'passChangedAt': str(user.get('passChangedAt') or '')[:30],
        'passChangedBy': str(user.get('passChangedBy') or '')[:120],
        'phonePrev': str(user.get('phonePrev') or '')[:40],
        'phoneChangedAt': str(user.get('phoneChangedAt') or '')[:30],
        'phoneChangedBy': str(user.get('phoneChangedBy') or '')[:120],
        'createdAt': str(user.get('createdAt') or '')[:30],
        'createdBy': str(user.get('createdBy') or '')[:120],
        'updatedAt': str(user.get('updatedAt') or '—')[:30],
        'deletedAt': str(user.get('deletedAt') or '')[:30],
        'deletedBy': str(user.get('deletedBy') or '')[:120],
        'lastSeen': str(user.get('lastSeen') or '')[:30],
        'sales': stats.get('sales', 0),
        'units': stats.get('units', 0),
        'total': stats.get('total', 0.0),
        'profit': stats.get('profit', 0.0),
        'avgCheck': stats.get('avgCheck', 0.0),
    }
    if include_salary:
        view.update({
            'salary': _staff_salary_value(user),
            'salaryPayDay': _salary_pay_day(user),
            'salaryMethod': _salary_method(user),
            'salaryChangedAt': str(user.get('salaryChangedAt') or '')[:30],
            'salaryChangedBy': str(user.get('salaryChangedBy') or '')[:120],
        })
    return view


# Yakunlanmagan / bekor qilingan savdolar statistikaga QO'SHILMAYDI.
# Bo'sh status eski yozuvlar uchun — ular tarixda yakunlangan hisoblanadi.
VOID_SALE_STATUSES = frozenset({
    'cancelled', 'canceled', 'refunded', 'refund', 'returned', 'return',
    'void', 'voided', 'failed', 'expired', 'pending', 'draft', 'deleted',
})


def sale_is_completed(sale):
    """Savdo yakunlangan (pul olingan) holatdami?"""
    status = str(sale.get('status') or '').strip().lower()
    return status not in VOID_SALE_STATUSES


def _dedupe_sales(sales):
    """Bir xil `id` bilan ikki marta kelgan savdoni bir marta hisoblaydi."""
    seen = set()
    unique = []
    for sale in sales or []:
        if not isinstance(sale, dict):
            continue
        raw_id = sale.get('id')
        key = str(raw_id).strip() if raw_id is not None else ''
        if key:
            if key in seen:
                continue
            seen.add(key)
        unique.append(sale)
    return unique


def staff_name_counts(staff):
    """Ism → nechta faol xodimda uchraydi (noaniq ism mosligini oldini oladi)."""
    counts = {}
    for user in staff or []:
        if not isinstance(user, dict) or role_rank(user.get('role')) <= 0:
            continue
        name = str(user.get('name') or '').strip().lower()
        if name:
            counts[name] = counts.get(name, 0) + 1
    return counts


def sale_belongs_to_staff(sale, user, name_counts):
    """Savdo aynan shu xodimga tegishlimi.

    Ustuvorlik:
      1) `cashierId` / `staffId` — eng ishonchli;
      2) `cashierLogin` — yangi savdolarda server tomonidan to'ldiriladi;
      3) eski savdolarda login yo'q — ism bo'yicha FAQAT ism yagona bo'lsa.
         Bir xil ismli ikki xodim bo'lsa, savdo hech biriga ikki marta
         qo'shilmaydi (0 bo'lib qoladi) — bu noto'g'ri taqsimlashdan yaxshiroq.
    """
    user_id = str(user.get('id') or '').strip()
    if user_id:
        for field in ('cashierId', 'staffId'):
            if str(sale.get(field) or '').strip() == user_id:
                return True

    login = str(user.get('login') or '').strip().lower()
    phone = normalize_phone(user.get('phone'))
    sale_login = str(sale.get('cashierLogin') or '').strip().lower()
    if sale_login:
        if login and sale_login == login:
            return True
        if phone and normalize_phone(sale_login) == phone:
            return True
        return False

    name = str(user.get('name') or '').strip().lower()
    if not name or counts_for_name(name_counts, name) != 1:
        return False
    return str(sale.get('cashier') or '').strip().lower() == name


def counts_for_name(name_counts, name):
    return int((name_counts or {}).get(name, 0) or 0)


def staff_metrics(sales, user, staff, branch_id='', products_by_id=None):
    """Bitta xodimning haqiqiy, takrorlanmagan savdo ko'rsatkichlari."""
    name_counts = staff_name_counts(staff)
    rows = _dedupe_sales(sales)
    mine = []
    for sale in rows:
        if not sale_is_completed(sale):
            continue
        if branch_id and products_by_id is not None:
            if str(sale_branch(sale, products_by_id)) != str(branch_id):
                continue
        if sale_belongs_to_staff(sale, user, name_counts):
            mine.append(sale)
    total = sum(_num(s.get('total')) for s in mine)
    profit = sum(sale_profit(s) for s in mine)
    units = sum(sale_units(s) for s in mine)
    count = len(mine)
    return {
        'sales': count,
        'units': units,
        'total': round(total, 2),
        'profit': round(profit, 2),
        'avgCheck': round(total / count, 2) if count else 0.0,
    }


def employee_metrics(sales, cashier_name):
    """Eski imzo uchun zaxira: ism bo'yicha yakunlangan savdolar."""
    name = str(cashier_name or '').strip().lower()
    mine = [s for s in _dedupe_sales(sales)
            if sale_is_completed(s) and str(s.get('cashier', '')).strip().lower() == name]
    total = sum(_num(s.get('total')) for s in mine)
    profit = sum(sale_profit(s) for s in mine)
    units = sum(sale_units(s) for s in mine)
    count = len(mine)
    return {
        'sales': count,
        'units': units,
        'total': round(total, 2),
        'profit': round(profit, 2),
        'avgCheck': round(total / count, 2) if count else 0.0,
    }


def last_seen_by_login(login):
    """Xodimning oxirgi faollik vaqti (sessiya reyestridan)."""
    target = str(login or '').strip().lower()
    if not target:
        return ''
    best = ''
    for row in load_sessions():
        if str(row.get('login', '')).strip().lower() != target:
            continue
        stamp = str(row.get('lastSeen') or '')
        if stamp > best:
            best = stamp
    return best


# ============================================================
# 1) BOSHQLIQ DASHBOARD — umumiy biznes holati
# ============================================================
@app.route('/api/boss/overview', methods=['GET'])
@require_staff('boss')
def boss_overview():
    """Boshliq dashboardi uchun barcha KPI — faqat haqiqiy bazadagi ma'lumot.

    Hisobotlar: bugungi savdo/buyurtmalar, umumiy savdo va foyda, mahsulot
    va kam qolganlar soni, mijozlar, xodimlar (jami/faol), filiallar (jami/faol).
    """
    store = db_manager.get_all() or {}
    sales = completed_sales(store.get('sales') if isinstance(store.get('sales'), list) else [])
    products = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    customers = [c for c in (store.get('customers') or []) if isinstance(c, dict)]
    branches = [b for b in (store.get('branches') or []) if isinstance(b, dict)]
    staff = unique_staff(load_staff())

    def totals(rows):
        return {
            'sales': len(rows),
            'units': sum(sale_units(s) for s in rows),
            'total': round(sum(_num(s.get('total')) for s in rows), 2),
            'profit': round(sum(sale_profit(s) for s in rows), 2),
        }

    today_stats = totals(completed_sales_in_period(store, 'day'))
    week_stats = totals(completed_sales_in_period(store, 'week'))
    month_stats = totals(completed_sales_in_period(store, 'month'))
    all_stats = totals(sales)

    threshold = low_stock_threshold()
    low = [p for p in products if _num(p.get('stock')) < threshold]
    internal = [u for u in staff if role_rank(u.get('role')) > 0]
    active = [u for u in internal
              if str(u.get('status') or 'active').strip().lower() in ('active', '')]

    return jsonify({
        'status': 'success',
        'generatedAt': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
        'lowStockThreshold': threshold,
        'kpi': {
            'todaySales': today_stats['total'],
            'todayOrders': today_stats['sales'],
            'todayUnits': today_stats['units'],
            'todayProfit': today_stats['profit'],
            'weekSales': week_stats['total'],
            'weekOrders': week_stats['sales'],
            'monthSales': month_stats['total'],
            'monthOrders': month_stats['sales'],
            'totalSales': all_stats['total'],
            'totalOrders': all_stats['sales'],
            'totalUnits': all_stats['units'],
            'totalProfit': all_stats['profit'],
            'products': len(products),
            'lowStock': len(low),
            'customers': len(customers),
            'staff': len(internal),
            'staffActive': len(active),
            'branches': len(branches),
            'branchesActive': len([b for b in branches
                                   if str(b.get('status') or 'active').strip().lower()
                                   in ('active', '', 'open')]),
        },
        'signals': {
            'hasSales': bool(sales),
            'hasProducts': bool(products),
            'lowStockNames': [str(p.get('name', ''))[:60] for p in low[:5]],
        },
    })


# ============================================================
# 1b) BOSHLIQ DASHBOARD — REAL CHARTLAR (time-series agregatsiya)
# ============================================================
@app.route('/api/boss/charts', methods=['GET'])
@require_staff('boss')
def boss_charts():
    """Boshliq dashboard chartlari uchun REAL agregatsiya.

    Barcha qatorlar haqiqiy `sales` va `cashFlow` yozuvlaridan hisoblanadi;
    biror davrda ma'lumot bo'lmasa 0 (yoki bo'sh qator) qaytariladi —
    ko'r-ko'rona qiymatlar ishlatilmaydi.
    """
    store = db_manager.get_all() or {}
    period, rng, scoped = boss_scope(store, request.args)
    products_by_id = products_index(store)
    branches = branches_index(store)

    branch_filter = str(request.args.get('branchId') or '').strip()
    if branch_filter:
        scoped = [s for s in scoped if sale_branch(s, products_by_id) == branch_filter]

    now = datetime.now()

    # 1) So'nggi 14 kun — kunlik savdo (bo'sh kunlar 0 bilan to'ldiriladi)
    by_day = {}
    for s in scoped:
        dt = parse_business_date(s.get('date'))
        if not dt:
            continue
        key = dt.strftime('%Y-%m-%d')
        row = by_day.setdefault(key, {'revenue': 0.0, 'orders': 0, 'units': 0.0})
        row['revenue'] += _num(s.get('total'))
        row['orders'] += 1
        row['units'] += sale_units(s)
    daily = []
    for i in range(13, -1, -1):
        day = now - timedelta(days=i)
        key = day.strftime('%Y-%m-%d')
        r = by_day.get(key, {'revenue': 0.0, 'orders': 0, 'units': 0.0})
        daily.append({
            'label': day.strftime('%d.%m'),
            'date': day.strftime('%d.%m.%Y'),
            'revenue': round(r['revenue'], 2),
            'orders': r['orders'],
            'units': round(r['units'], 2),
        })

    # 2) So'nggi 8 hafta
    weekly = []
    for i in range(7, -1, -1):
        week_start = (now - timedelta(days=now.weekday() + i * 7))\
            .replace(hour=0, minute=0, second=0, microsecond=0)
        week_end = week_start + timedelta(days=6, hours=23, minutes=59, seconds=59)
        rev = 0.0
        cnt = 0
        for s in scoped:
            dt = parse_business_date(s.get('date'))
            if dt and week_start <= dt <= week_end:
                rev += _num(s.get('total'))
                cnt += 1
        weekly.append({'label': week_start.strftime('%d.%m'),
                       'revenue': round(rev, 2), 'orders': cnt})

    # 3) So'nggi 6 oy (foyda bilan)
    monthly = []
    for i in range(5, -1, -1):
        y, m = now.year, now.month - i
        while m <= 0:
            m += 12
            y -= 1
        start = datetime(y, m, 1)
        if m == 12:
            end = datetime(y + 1, 1, 1) - timedelta(seconds=1)
        else:
            end = datetime(y, m + 1, 1) - timedelta(seconds=1)
        rev = 0.0
        profit = 0.0
        cnt = 0
        for s in scoped:
            dt = parse_business_date(s.get('date'))
            if dt and start <= dt <= end:
                rev += _num(s.get('total'))
                profit += sale_profit(s)
                cnt += 1
        monthly.append({'label': start.strftime('%m.%y'),
                        'revenue': round(rev, 2), 'profit': round(profit, 2),
                        'orders': cnt})
# ============================================================
# 4) To'lov turlari bo'yicha (ushbu davrda)
    pay_buckets = {}
    for s in scoped:
        key = str(s.get('pay') or s.get('provider') or 'Naqd')[:40].strip() or 'Naqd'
        row = pay_buckets.setdefault(key, {'orders': 0, 'amount': 0.0})
        row['orders'] += 1
        row['amount'] += _num(s.get('total'))
    payments = {
        'labels': list(pay_buckets.keys()),
        'orders': [row['orders'] for row in pay_buckets.values()],
        'amounts': [round(row['amount'], 2) for row in pay_buckets.values()],
    }

    # 5) Filiallar bo'yicha savdo (ushbu davrda)
    branch_buckets = {}
    for s in scoped:
        bid = sale_branch(s, products_by_id)
        if not bid:
            continue
        row = branch_buckets.setdefault(bid, {'revenue': 0.0, 'sales': 0})
        row['revenue'] += _num(s.get('total'))
        row['sales'] += 1
    branch_rows = []
    for bid, branch in branches.items():
        row = branch_buckets.get(bid, {'revenue': 0.0, 'sales': 0})
        branch_rows.append({
            'label': str(branch.get('name') or bid)[:60],
            'revenue': round(row['revenue'], 2),
            'sales': row['sales'],
        })
    branch_rows.sort(key=lambda r: -r['revenue'])
    branchSales = {
        'labels': [r['label'] for r in branch_rows],
        'values': [r['revenue'] for r in branch_rows],
        'orders': [r['sales'] for r in branch_rows],
    }

    # 6) Kirim/chiqim — so'nggi 6 oy (cashFlow'dan real)
    cash_flow = [c for c in (store.get('cashFlow') or store.get('expenses') or [])
                 if isinstance(c, dict)]
    if branch_filter:
        cash_flow = [c for c in cash_flow if str(c.get('branchId') or '') == branch_filter]
    flow = {'labels': [], 'kirim': [], 'chiqim': []}
    for i in range(5, -1, -1):
        y, m = now.year, now.month - i
        while m <= 0:
            m += 12
            y -= 1
        start = datetime(y, m, 1)
        if m == 12:
            end = datetime(y + 1, 1, 1) - timedelta(seconds=1)
        else:
            end = datetime(y, m + 1, 1) - timedelta(seconds=1)
        inflow = 0.0
        outflow = 0.0
        for record in cash_flow:
            dt = parse_business_date(record.get('date'))
            if dt and start <= dt <= end:
                key = str(record.get('type') or 'chiqim').strip().lower()
                amt = _num(record.get('amount'))
                if key == 'kirim':
                    inflow += amt
                else:
                    outflow += amt
        flow['labels'].append(start.strftime('%m.%y'))
        flow['kirim'].append(round(inflow, 2))
        flow['chiqim'].append(round(outflow, 2))

    return jsonify({
        'status': 'success',
        'period': period,
        'hasData': bool(scoped),
        'daily': daily,
        'weekly': weekly,
        'monthly': monthly,
        'payments': payments,
        'branchSales': branchSales,
        'flow': flow,
    })
# 2) XODIMLAR RO'YXATI + REYTINGI
# ============================================================
@app.route('/api/boss/staff', methods=['GET'])
@require_staff('manager')
def boss_staff_list():
    """Barcha xodimlar, ularning haqiqiy savdo ko'rsatkichlari va reytingi.

    Query: period (day|week|month|all), q (ism/telefon/role qidirish),
           role, branchId, status (inactive → arxivlanganlar), sort, order, limit, offset.

    ARXIVLANGAN (inactive) xodimlar standart ro'yxatda qaytarilmaydi — ular
    o'chirilgan hisoblanadi va faqat aniq `status=inactive` so'rovda ko'rinadi.
    """
    store = db_manager.get_all() or {}
    actor = getattr(request, 'staff', {}) or {}
    actor_role = canonical_role(actor.get('role'))
    is_boss_actor = actor_role == 'boss'
    is_manager_actor = actor_role == 'manager'
    manager_branch_id = ''
    if is_manager_actor:
        actor_user = next((u for u in load_staff()
                           if isinstance(u, dict)
                           and str(u.get('id')) == str(actor.get('id'))), None)
        manager_branch_id = str((actor_user or {}).get('branchId') or '').strip()
        if not manager_branch_id:
            return json_error('Xodim qo\'shish uchun menejerga filial biriktirilgan bo\'lishi kerak', 403)
    all_staff = [u for u in unique_staff(load_staff())
                 if isinstance(u, dict) and role_rank(u.get('role')) > 0
                 and (is_boss_actor
                      or (str(u.get('role') or '').lower() in ('manager', 'cashier')
                          and (not is_manager_actor
                               or (str(u.get('role') or '').lower() == 'cashier'
                                   and str(u.get('branchId') or '') == manager_branch_id))))]
    branches = branches_index(store)
    products_by_id = products_index(store)
    period = normalize_period(request.args.get('period'))
    rng = custom_period_range(request.args)
    scoped = sales_in_period(store, period, rng)

    query = str(request.args.get('q') or '').strip().lower()
    role_filter = str(request.args.get('role') or '').strip().lower()
    branch_filter = str(request.args.get('branchId') or '').strip()
    if is_manager_actor and branch_filter and branch_filter != manager_branch_id:
        return json_error('Menejer faqat o\'z filialidagi xodimlarni ko\'ra oladi', 403)
    status_filter = str(request.args.get('status', 'active') or '').strip().lower()
    if status_filter not in STAFF_STATUSES and status_filter != 'all':
        status_filter = 'active'

    # Mobil paneldagi umumiy ko'rsatkichlar — barcha xodimlar bo'yicha
    # (qidiruv/filtrdan qat'i nazar), shunda raqamlar "sakrab" ketmaydi.
    status_counts = {'active': 0, 'blocked': 0, 'inactive': 0}
    for user in all_staff:
        status = str(user.get('status') or 'active').strip().lower()
        if status not in status_counts:
            status = 'inactive'
        status_counts[status] += 1

    # Oylik maosh endi xodim yozuvining o'zida (`salary`) saqlanadi.
    # Ilgari ism bo'yicha `salaryRecords` dan olinardi — bu bir xil ismli
    # xodimlarda maoshni noto'g'ri bog'lash xavfini tug'dirardi.

    rows = []
    for user in all_staff:
        role = str(user.get('role', '')).strip().lower()
        status = str(user.get('status') or 'active').strip().lower()
        # O'CHIRILGAN (arxivlangan) xodim standart ro'yxatdan chiqariladi:
        # sahifani yangilaganda, qidiruvda yoki boshqa filtr tanlaganda
        # qayta paydo bo'lmasin. Uni faqat aniq «Nofaol» filtri
        # (status=inactive) ochib ko'rsatadi — shu orqali arxivdan
        # qayta faollashtirish ham davom ettiriladi.
        if status == 'inactive' and status_filter != 'inactive':
            continue
        if query:
            haystack = ' '.join([
                str(user.get('name', '')), str(user.get('login', '')),
                str(user.get('phone', '')), role,
            ]).lower()
            if query not in haystack:
                continue
        if role_filter and role != role_filter:
            continue
        if branch_filter and str(user.get('branchId') or '') != branch_filter:
            continue
        status = str(user.get('status') or 'active').strip().lower()
        if status_filter != 'all' and status != status_filter:
            continue
        view = staff_public_view(
            user,
            staff_metrics(scoped, user, all_staff,
                          branch_id=branch_filter, products_by_id=products_by_id),
            include_salary=is_boss_actor)
        view['branchName'] = str((branches.get(str(user.get('branchId') or '')) or {})
                                 .get('name', '') or '')[:80]
        view['lastSeen'] = last_seen_by_login(user.get('login')) or view['lastSeen']
        rows.append(view)

    sort_key = str(request.args.get('sort') or 'total').strip()
    reverse = str(request.args.get('order') or 'desc').strip().lower() != 'asc'
    if sort_key == 'sales':
        rows.sort(key=lambda r: (r['sales'], r['total'], r['id']), reverse=reverse)
    elif sort_key == 'units':
        rows.sort(key=lambda r: (r['units'], r['id']), reverse=reverse)
    elif sort_key == 'profit':
        rows.sort(key=lambda r: (r['profit'], r['id']), reverse=reverse)
    elif sort_key == 'avgCheck':
        rows.sort(key=lambda r: (r['avgCheck'], r['id']), reverse=reverse)
    elif sort_key == 'name':
        rows.sort(key=lambda r: (r['name'].lower(), r['id']), reverse=reverse)
    elif sort_key == 'role':
        rows.sort(key=lambda r: (r['roleRank'], r['name'].lower(), r['id']),
                  reverse=reverse)
    elif sort_key == 'status':
        order = {'active': 0, 'blocked': 1, 'inactive': 2}
        rows.sort(key=lambda r: (order.get(str(r['status']).lower(), 3), r['id']),
                  reverse=reverse)
    elif sort_key == 'id':
        rows.sort(key=lambda r: r['id'], reverse=reverse)
    else:
        rows.sort(key=lambda r: (r['total'], r['sales'], r['id']), reverse=reverse)
    # Reyting raqami — saralash natijasidan kelib chiqadi.
    for index, row in enumerate(rows, start=1):
        row['rank'] = index

    total = len(rows)
    try:
        limit = max(1, min(500, int(request.args.get('limit') or 100)))
        offset = max(0, int(request.args.get('offset') or 0))
    except (TypeError, ValueError):
        limit, offset = 100, 0

    return jsonify({
        'status': 'success',
        'period': period,
        'total': total,
        'totalAll': len(all_staff),
        'statusCounts': status_counts,
        'offset': offset,
        'limit': limit,
        'staff': rows[offset:offset + limit],
    })


# ============================================================
# OYLIK MAOSH REJASI VA TO'LOVLARI — YAGONA MANBA
# ============================================================
# Xodim va uning BELGILANGAN oyligi — `staff_users` (bitta manba).
# Haqiqiy to'lovlar `salaryHistory` kalitida saqlanadi va har bir yozuv
# `staffId` orqali xodimga QAT'IY bog'lanadi (ism/telefon bo'yicha emas).
# Bu bo'lim ilgari frontend'dagi `tp_salary_records` kalitidan o'qirdi —
# natijada xodimlar ro'yxati va maosh jadvali ikki xil manbadan olinardi.
SALARY_MONTHS_UZ = ('Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
                    'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr')
SALARY_PERIOD_RE = re.compile(r'^\d{4}-(?:0[1-9]|1[0-2])$')
SALARY_METHODS = ('cash', 'card', 'click', 'transfer')
SALARY_HISTORY_LIMIT = 20000
SALARY_FLOW_LIMIT = 20000


def salary_period_label(period):
    """'2026-10' → 'Oktabr 2026'. Noto'g'ri qiymat uchun '—'."""
    match = re.fullmatch(r'(\d{4})-(0[1-9]|1[0-2])', str(period or ''))
    if not match:
        return '—'
    return f'{SALARY_MONTHS_UZ[int(match.group(2)) - 1]} {match.group(1)}'


def salary_period_from_label(text):
    """'Noyabr 2026' → '2026-11' (faqat eski yozuvlarni o'qish uchun)."""
    parts = str(text or '').strip().split()
    if len(parts) != 2 or parts[0] not in SALARY_MONTHS_UZ:
        return ''
    if not re.fullmatch(r'\d{4}', parts[1]):
        return ''
    return f'{parts[1]}-{SALARY_MONTHS_UZ.index(parts[0]) + 1:02d}'


def _salary_payment_view(record):
    """`salaryHistory` yozuvini yagona (xavfsiz) ko'rinishga keltiradi."""
    if not isinstance(record, dict):
        return None
    amount = _num(record.get('amount'))
    staff_id = int(_num(record.get('staffId', record.get('empId')), 0))
    period = str(record.get('period') or '').strip()
    if not SALARY_PERIOD_RE.fullmatch(period):
        period = salary_period_from_label(record.get('month'))
    paid_at = str(record.get('paidAt') or record.get('date') or '').strip()[:10]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', paid_at):
        paid_at = ''
    else:
        try:
            paid_at = date.fromisoformat(paid_at).isoformat()
        except ValueError:
            paid_at = ''
    valid_paid_at = bool(paid_at)
    return {
        'id': str(record.get('id') or '')[:60],
        'staffId': staff_id if staff_id > 0 else None,
        'staffName': str(record.get('staffName') or record.get('empName') or '')[:120],
        'amount': round(amount, 2),
        'period': period,
        'periodLabel': (salary_period_label(period) if period
                        else str(record.get('month') or '')[:40]),
        'paidAt': paid_at,
        'validPaidAt': valid_paid_at,
        'method': str(record.get('method') or 'cash')[:20],
        'note': str(record.get('note') or '')[:180],
        'branchId': str(record.get('branchId') or '')[:40],
        'branchKnown': 'branchId' in record,
        'createdAt': str(record.get('createdAt') or '')[:30],
        'createdBy': str(record.get('createdBy') or '')[:120],
        'linked': staff_id > 0,
    }


def _salary_pay_day(user):
    """Xodim uchun oylik to'lov kuni (1..28). Berilmasa 1."""
    value = int(_num(user.get('salaryPayDay'), 1))
    if value < 1:
        return 1
    return min(28, value)


def _salary_method(user):
    method = str(user.get('salaryMethod') or 'cash').strip().lower()
    return method if method in SALARY_METHODS else 'cash'


def _salary_next_pay_date(day, today):
    """Bugundan boshlab `day`-kun keladigan eng yaqin to'lov sanasi."""
    year, month = today.year, today.month
    if day < today.day:
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return date(year, month, day)


def _salary_plan_data(store, month, branch_filter='', query=''):
    """Tanlangan oy bo'yicha maosh rejasi qatorlari va to'lovlar ro'yxati.

    Qaytaradi: (rows, payments). Har bir qatorda faqat HAQIQIY ma'lumot:
    oyligi belgilanmagan xodim ham qatorda qoladi (holat: 'unset').
    """
    staff = [u for u in unique_staff(load_staff())
             if isinstance(u, dict) and role_rank(u.get('role')) > 0]
    branches = branches_index(store)
    salary_history = store.get('staffSalaryHistory')
    if not isinstance(salary_history, list):
        salary_history = []
    payments = []
    for record in (store.get('salaryHistory') or []):
        view = _salary_payment_view(record)
        if view:
            payments.append(view)
    staff_ids = {int(_num(user.get('id'), 0)) for user in staff}
    for payment in payments:
        payment['linked'] = payment['staffId'] in staff_ids
    payments.sort(key=lambda p: (p['paidAt'], p['id']), reverse=True)
    by_staff = {}
    for pay in payments:
        if pay['linked'] and pay['validPaidAt']:
            by_staff.setdefault(pay['staffId'], []).append(pay)

    today = datetime.now().date()
    period_year, period_month = int(month[:4]), int(month[5:7])
    rows = []
    for user in staff:
        staff_id = int(_num(user.get('id'), 0))
        if staff_id <= 0:
            continue
        # Arxivlangan (o'chirilgan) xodim maosh rejasida ko'rinmaydi — u
        # ro'yxatdan olib tashlangan, faqat tarixiy yozuvlari saqlangan.
        if str(user.get('deletedAt') or '').strip():
            continue
        name = str(user.get('name') or '')
        role = str(user.get('role') or '')
        branch_id = str(user.get('branchId') or '')
        if branch_filter == '__unassigned__' and branch_id:
            continue
        if branch_filter and branch_filter != '__unassigned__' and branch_id != branch_filter:
            continue
        if query:
            haystack = ' '.join([name, role, str(user.get('login') or '')]).lower()
            if query not in haystack:
                continue
        salary = _staff_salary_for_period(user, salary_history, month)
        pay_day = _salary_pay_day(user)
        method = _salary_method(user)
        staff_payments = by_staff.get(staff_id, [])
        attached = [p for p in staff_payments if p['period'] == month]
        paid = round(sum(p['amount'] for p in attached), 2)
        active = str(user.get('status') or 'active').strip().lower() == 'active'
        due = salary if salary is not None and active else None
        remaining = round(max(0.0, due - paid), 2) if due is not None else None
        due_date = date(period_year, period_month, pay_day)
        if not active:
            status = 'inactive'
        elif salary is None:
            status = 'unset'
        elif due and paid >= due:
            status = 'paid'
        elif paid > 0:
            status = 'partial'
        elif due_date < today:
            status = 'overdue'
        elif due_date == today:
            status = 'today'
        else:
            status = 'pending'
        rows.append({
            'staffId': staff_id,
            'name': name[:120],
            'login': str(user.get('login') or '')[:120],
            'phone': str(user.get('phone') or '')[:40],
            'role': role[:30],
            'branchId': branch_id[:40],
            'branchName': str((branches.get(branch_id) or {}).get('name', '') or '')[:80],
            'staffStatus': str(user.get('status') or 'active')[:30],
            'salary': salary,
            'hasSalary': salary is not None,
            'active': active,
            'payDay': pay_day,
            'method': method,
            'period': month,
            'periodLabel': salary_period_label(month),
            'dueDate': due_date.isoformat(),
            'due': due,
            'paid': paid,
            'remaining': remaining,
            'nextPayDate': _salary_next_pay_date(pay_day, today).isoformat(),
            'status': status,
            'periodPayments': attached[:8],
            'history': staff_payments[:8],
        })
    rows.sort(key=lambda r: r['staffId'])
    return rows, payments


def _salary_stats(rows, payments, month):
    """Umumiy ko'rsatkichlar — bir-biridan ALOHIDA hisoblanadi."""
    planned = 0.0
    paid_for_period = 0.0
    remaining_total = 0.0
    unset_count = 0
    paid_count = 0
    partial_count = 0
    today_count = 0
    today_amount = 0.0
    overdue_count = 0
    overdue_amount = 0.0
    for row in rows:
        paid_for_period += row['paid']
        if not row['active']:
            continue
        if row['salary'] is None:
            unset_count += 1
            continue
        planned += row['salary']
        remaining_total += row['remaining'] or 0
        if row['status'] == 'paid':
            paid_count += 1
        elif row['status'] == 'partial':
            partial_count += 1
        elif row['status'] == 'today':
            today_count += 1
            today_amount += row['remaining'] or 0
        elif row['status'] == 'overdue':
            overdue_count += 1
            overdue_amount += row['remaining'] or 0
    # "Haqiqiy to'langan" — to'lov SANASI (paidAt) tanlangan oyga to'g'ri
    # keladigan pul. Bu hisoblash davri (period) yig'indisidan farq qiladi.
    paid_in_month = sum(
        p['amount'] for p in payments
        if p['paidAt'][:7] == month)
    active_count = sum(1 for row in rows if row['active'])
    inactive_count = len(rows) - active_count
    return {
        'plannedFund': round(planned, 2),
        'paidForPeriod': round(paid_for_period, 2),
        'paidInMonth': round(paid_in_month, 2),
        'remaining': round(remaining_total, 2),
        'todayCount': today_count,
        'todayAmount': round(today_amount, 2),
        'overdueCount': overdue_count,
        'overdueAmount': round(overdue_amount, 2),
        'paidCount': paid_count,
        'partialCount': partial_count,
        'unsetCount': unset_count,
        'staffCount': len(rows),
        'activeStaffCount': active_count,
        'inactiveStaffCount': inactive_count,
    }


@app.route('/api/boss/salary/plan', methods=['GET'])
@require_staff('boss')
def boss_salary_plan():
    """Oylik maosh rejasi, statistikasi va to'lovlar tarixi (yagona manba).

    Query: month (YYYY-MM, standart — joriy oy), branchId, q.
    """
    store = db_manager.get_all() or {}
    month = str(request.args.get('month') or '').strip()
    if not SALARY_PERIOD_RE.fullmatch(month):
        month = datetime.now().strftime('%Y-%m')
    branch_filter = str(request.args.get('branchId') or '').strip()[:40]
    query = str(request.args.get('q') or '').strip().lower()[:80]
    rows, payments = _salary_plan_data(store, month, branch_filter, query)
    visible_payments = [
        payment for payment in payments
        if (not branch_filter
            or (not payment['branchId'] and payment['branchKnown']
                if branch_filter == '__unassigned__'
                else payment['branchId'] == branch_filter))
    ]
    payment_totals_by_month = {}
    for payment in visible_payments:
        paid_month = payment['paidAt'][:7]
        if SALARY_PERIOD_RE.fullmatch(paid_month):
            payment_totals_by_month[paid_month] = (
                payment_totals_by_month.get(paid_month, 0) + payment['amount'])
    branch_options = [
        {'id': str(branch.get('id') or '')[:40],
         'name': str(branch.get('name') or branch.get('id') or '')[:80]}
        for branch in (store.get('branches') or [])
        if isinstance(branch, dict) and str(branch.get('id') or '').strip()
    ]
    branch_options.append({'id': '__unassigned__', 'name': 'Filialsiz'})
    branch_options.sort(key=lambda branch: branch['name'].lower())
    return jsonify({
        'status': 'success',
        'month': month,
        'monthLabel': salary_period_label(month),
        'rows': rows,
        'stats': _salary_stats(rows, visible_payments, month),
        'payments': visible_payments[:50],
        'totalPayments': len(visible_payments),
        'paymentTotalsByMonth': payment_totals_by_month,
        'branches': branch_options,
        'total': len(rows),
    })


@app.route('/api/boss/salary/pay', methods=['POST'])
@require_staff('boss')
def boss_salary_pay():
    """Haqiqiy maosh to'lovini qayd etadi (xodim ID si orqali).

    To'lov `salaryHistory`ga yoziladi va `Kirim-chiqim` (cashFlow) ga
    bog'langan `chiqim` yozuvi qo'shiladi — natijada bir xil to'lov ikki
    modulda ikki marta hisoblanmaydi. Belgilangan, lekin to'lanmagan
    maosh moliyaviy chiqim hisoblanmaydi.
    """
    body = request.get_json(silent=True) or {}
    staff_id = int(_num(body.get('staffId'), 0))
    if staff_id <= 0:
        return json_error('Xodim tanlanmagan')
    amount, error = parse_staff_salary(body.get('amount'), required=True)
    if error:
        return json_error(error)
    if not amount:
        return json_error('To\'lov summasi noldan katta bo\'lishi kerak')
    period = str(body.get('period') or '').strip()
    if not SALARY_PERIOD_RE.fullmatch(period):
        return json_error('Hisoblash davri noto\'g\'ri (YYYY-MM)')
    paid_at = str(body.get('paidAt') or '').strip()
    if not paid_at:
        paid_at = datetime.now().strftime('%Y-%m-%d')
    else:
        try:
            paid_at = date.fromisoformat(paid_at).isoformat()
        except ValueError:
            return json_error('To\'lov sanasi haqiqiy YYYY-MM-DD formatda bo\'lishi kerak')
    method = str(body.get('method') or '').strip().lower()
    if method not in SALARY_METHODS:
        method = 'cash'
    note = _clean_boss_text(body.get('note'), 180)

    actor = _actor_name()
    now = datetime.now()
    with _store_write_lock:
        store = db_manager.get_all() or {}
        staff = load_staff()
        target = next((u for u in staff
                       if isinstance(u, dict)
                       and int(_num(u.get('id'), 0)) == staff_id), None)
        if not target or role_rank(target.get('role')) <= 0:
            return json_error('Xodim topilmadi', 404)
        if str(target.get('status') or 'active').strip().lower() != 'active':
            return json_error('Nofaol xodim uchun yangi maosh to\'lovi qayd etilmaydi', 409)
        name = str(target.get('name') or '')
        branch_id = str(target.get('branchId') or '')
        history = [p for p in (store.get('salaryHistory') or [])
                   if isinstance(p, dict)]
        # Dublikat to'lovdan himoya: aynan bir xil yozuv ikki marta kirmasin.
        for existing in history:
            if (int(_num(existing.get('staffId', existing.get('empId')), 0)) == staff_id
                    and str(existing.get('period') or '') == period
                    and str(existing.get('paidAt') or '')[:10] == paid_at
                    and _num(existing.get('amount')) == amount):
                return json_error('Bu to\'lov allaqachon qayd etilgan', 409)
        payment_id = 'sp-' + uuid.uuid4().hex[:12]
        payment = {
            'id': payment_id,
            'staffId': staff_id,
            'staffName': name[:120],
            'amount': amount,
            'period': period,
            'paidAt': paid_at,
            'method': method,
            'note': note,
            'branchId': branch_id[:40],
            'createdAt': now.strftime('%d.%m.%Y %H:%M:%S'),
            'createdBy': actor[:120],
        }
        history.append(payment)
        flow_id = 'cf-' + str(int(now.timestamp() * 1000)) + '-' + uuid.uuid4().hex[:6]
        flow = {
            'id': flow_id,
            'type': 'chiqim',
            'amount': amount,
            'category': 'Oylik maosh',
            'note': f'{name} — {salary_period_label(period)}',
            'branchId': branch_id[:40],
            'date': paid_at,
            'createdAt': now.strftime('%Y-%m-%d %H:%M:%S'),
            'user': actor[:120],
            'salaryPaymentId': payment_id,
        }
        flows = [c for c in (store.get('cashFlow') or []) if isinstance(c, dict)]
        flows.append(flow)
        try:
            db_manager.save_keys({
                'salaryHistory': history[-SALARY_HISTORY_LIMIT:],
                'cashFlow': flows[-SALARY_FLOW_LIMIT:],
            })
        except Exception as exc:
            print(f'[SALARY] To\'lovni saqlab bo\'lmadi: {exc}')
            return json_error('Saqlab bo\'lmadi', 500)
        refreshed = db_manager.get_all() or {}

    audit_log('salary-pay', name,
              f'{amount} so\'m — {salary_period_label(period)}', actor)
    rows, payments = _salary_plan_data(refreshed, period, '', '')
    return jsonify({
        'status': 'success',
        'message': f'{name}: {amount} so\'m to\'lov qayd etildi',
        'payment': _salary_payment_view(payment),
        'cashFlow': flow,
        'month': period,
        'monthLabel': salary_period_label(period),
        'rows': rows,
        'stats': _salary_stats(rows, payments, period),
        'payments': payments[:50],
        'totalPayments': len(payments),
        'total': len(rows),
    })


@app.route('/api/boss/staff/<int:staff_id>/sales', methods=['GET'])
@require_staff('admin')
def boss_staff_sales(staff_id):
    """Xodim savdolari: har bir chek qatorlari mahsulot/qty/narx/jami bilan."""
    store = db_manager.get_all() or {}
    staff = unique_staff(load_staff())
    target = next((u for u in staff
                   if isinstance(u, dict) and _num(u.get('id'), -1) == staff_id), None)
    if not target:
        return jsonify({'status': 'error', 'message': 'Xodim topilmadi'}), 404
    actor_role = str((getattr(request, 'staff', {}) or {}).get('role') or '').lower()
    if actor_role == 'admin' and str(target.get('role') or '').lower() not in (
            'manager', 'cashier'):
        return json_error('Admin faqat Menejer va Kassa xodimlarining savdosini ko\'ra oladi', 403)

    name = str(target.get('name', '')).strip()
    period = normalize_period(request.args.get('period'))
    rng = custom_period_range(request.args)
    branches = branches_index(store)
    products_by_id = products_index(store)
    branch_filter = str(request.args.get('branchId') or '').strip()

    scoped = sales_in_period(store, period, rng)
    name_counts = staff_name_counts(staff)
    mine = []
    for sale in _dedupe_sales(scoped):
        if not sale_is_completed(sale):
            continue
        if branch_filter and str(sale_branch(sale, products_by_id)) != branch_filter:
            continue
        if sale_belongs_to_staff(sale, target, name_counts):
            mine.append(sale)
    mine.sort(key=lambda s: (parse_business_date(s.get('date')) or datetime.min,
                             str(s.get('time') or '')), reverse=True)

    receipts = []
    for sale in mine:
        branch_id = sale_branch(sale, products_by_id)
        lines = []
        for item in sale.get('items') or []:
            if not isinstance(item, dict):
                continue
            price = _num(item.get('price'))
            qty = _num(item.get('qty'))
            product = products_by_id.get(item.get('id')) or {}
            lines.append({
                'name': str(item.get('name') or product.get('name') or '')[:120],
                'qty': qty,
                'price': round(price, 2),
                'total': round(price * qty, 2),
                'cat': str(item.get('cat') or product.get('cat') or '')[:60],
            })
        receipts.append({
            'saleId': sale.get('id'),
            'date': str(sale.get('date') or '')[:30],
            'time': str(sale.get('time') or '')[:30],
            'total': round(_num(sale.get('total')), 2),
            'profit': sale_profit(sale),
            'pay': str(sale.get('pay') or '')[:40],
            'customer': str(sale.get('customer') or '')[:120],
            'branchId': branch_id,
            'branchName': str((branches.get(branch_id) or {}).get('name', '') or '')[:80],
            'items': lines,
        })

    try:
        limit = max(1, min(500, int(request.args.get('limit') or 100)))
        offset = max(0, int(request.args.get('offset') or 0))
    except (TypeError, ValueError):
        limit, offset = 100, 0

    return jsonify({
        'status': 'success',
        'period': period,
        'staff': staff_public_view(
            target,
            staff_metrics(scoped, target, staff,
                          branch_id=branch_filter, products_by_id=products_by_id),
            include_salary=str((getattr(request, 'staff', {}) or {}).get('role') or '').lower()
            == 'boss'),
        'total': len(receipts),
        'offset': offset,
        'limit': limit,
        'receipts': receipts[offset:offset + limit],
    })
def _actor_name():
    """Hozirgi Boshliq foydalanuvchisining ochiq ismi (jurnal uchun)."""
    return str(getattr(request, 'staff', {}).get('name', '—'))


# Boshliq orqali qo'shilishi mumkin bo'lgan rollar.
# BOSHLIQ ataylab yo'q: u faqat yuqori darajadagi migratsiya/CLI orqali
# yaratiladi, shu bilan biror xodim o'zini Boshliqga oshirib qeta olmaydi.
BOSS_ASSIGNABLE_ROLES = ('admin', 'manager', 'cashier')
STAFF_STATUSES = ('active', 'blocked', 'inactive')
# Xodim yozish amallari (qo'shish/tahrirlash) uchun qulf: bir vaqtda kelgan
# ikki so'rov bir xil telefon bilan dublikat akount yaratmasligi kafolatlanadi.
_STAFF_WRITE_LOCK = threading.RLock()


def _serialize_staff_write(handler):
    """Xodim yaratish/tahrirlashda tekshiruv va saqlashni birga atomar qiladi."""
    @functools.wraps(handler)
    def wrapper(*args, **kwargs):
        with _STAFF_WRITE_LOCK:
            return handler(*args, **kwargs)
    return wrapper
# Kiritiladigan maydonlardagi taqiqlangan belgilar (SQL/XSS himoyasi).
_BOSS_TEXT_FORBIDDEN = re.compile(r'[<>;\x00]|(--)|(/\*)')


def _clean_boss_text(value, limit=120):
    """Matn maydonini tozalaydi va uzunligini cheklaydi."""
    text = str(value or '').strip()
    text = _BOSS_TEXT_FORBIDDEN.sub('', text)
    return re.sub(r'\s+', ' ', text)[:limit].strip()


def _validate_password(raw, min_len=6):
    """Parolni tekshiradi; xato bo'lsa (xabar, None) qaytaradi."""
    password = str(raw or '')
    if len(password) < min_len:
        return None, f'Parol kamida {min_len} belgidan iborat bo\'lishi kerak'
    if len(password) > 200:
        return None, 'Parol juda uzun'
    return password, None


def _staff_id_exists(staff, staff_id):
    return any(isinstance(u, dict) and _num(u.get('id'), -1) == staff_id for u in staff)


def _branch_exists(branch_id):
    """Filial haqiqatan mavjudmi (bo'sh qiymat — filialsiz, ruxsat)."""
    key = str(branch_id or '').strip()
    if not key:
        return True
    try:
        store = db_manager.get_all() or {}
    except Exception:
        return False
    for branch in store.get('branches') or []:
        if isinstance(branch, dict) and str(branch.get('id') or '') == key:
            return True
    return False


def _unique_staff_login(staff, staff_id):
    """Band bo'lmagan `userN` login yaratadi (takroriy login bo'lmasin)."""
    prefix = (os.getenv('BOSS_STAFF_LOGIN_PREFIX') or 'user').strip() or 'user'
    prefix = re.sub(r'[^A-Za-z0-9_-]', '', prefix) or 'user'
    used = {str(u.get('login') or '').strip().lower()
            for u in staff if isinstance(u, dict)}
    base = f'{prefix}{staff_id}'
    candidate = base
    suffix = 2
    while candidate.lower() in used:
        candidate = f'{base}{suffix}'
        suffix += 1
    return candidate


@app.route('/api/boss/staff', methods=['POST'])
@require_staff('manager')
@_serialize_staff_write
def boss_staff_create():
    """Yangi xodim qo'shish.

    Rol variantlari FAQAT admin/manager/cashier — BOSHLIQ bu yo'l bilan
    yaratilmaydi. Parol FAQAT xesh ko'rinishida saqlanadi.
    """
    body = request.get_json(silent=True) or {}
    name = _clean_boss_text(body.get('name'), 120)
    phone = normalize_phone(body.get('phone'))
    role = str(body.get('role') or '').strip().lower()
    actor_role = str((getattr(request, 'staff', {}) or {}).get('role') or '').lower()
    is_boss_actor = actor_role == 'boss'
    is_admin_actor = actor_role == 'admin'
    is_manager_actor = actor_role == 'manager'
    branch_id = str(body.get('branchId') or '').strip()[:40]
    status = str(body.get('status') or 'active').strip().lower()

    if not name or len(name) < 2:
        return json_error('Xodim ismi kamida 2 belgidan iborat bo\'lsin')
    assignable_roles = (BOSS_ASSIGNABLE_ROLES if is_boss_actor
                        else ('manager', 'cashier') if is_admin_actor
                        else ('cashier',))
    if role not in assignable_roles:
        return json_error('Rol noto\'g\'ri. Ruxsat etilgan rollar: '
                          + ', '.join(r.upper() for r in assignable_roles), 403)
    if status not in STAFF_STATUSES:
        return json_error('Holat noto\'g\'ri (active, blocked yoki inactive)')
    if is_manager_actor:
        actor = getattr(request, 'staff', {}) or {}
        actor_user = next((u for u in load_staff()
                           if isinstance(u, dict)
                           and str(u.get('id')) == str(actor.get('id'))), None)
        manager_branch_id = str((actor_user or {}).get('branchId') or '').strip()
        if not manager_branch_id:
            return json_error('Xodim qo\'shish uchun menejerga filial biriktirilgan bo\'lishi kerak', 403)
        if branch_id != manager_branch_id:
            return json_error('Menejer faqat o\'z filialiga xodim qo\'sha oladi', 403)
        if status != 'active':
            return json_error('Menejer faqat faol kassir hisobini yaratishi mumkin', 403)
    if not _branch_exists(branch_id):
        return json_error('Tanlangan filial topilmadi', 404)
    password, error = _validate_password(body.get('password'))
    if error:
        return json_error(error)
    if not is_boss_actor and 'salary' in body:
        return json_error('Maosh ma\'lumotlarini faqat Boshliq boshqarishi mumkin', 403)
    # Admin maoshi belgilanmagan xodim yaratadi; maoshni faqat Boshliq belgilaydi.
    salary, salary_error = parse_staff_salary(
        body.get('salary'), required=is_boss_actor)
    if salary_error:
        return json_error(salary_error)
    # Telefon raqami MAJBURIY: xodim tizimga aynan shu raqam (login) bilan kiradi.
    # Raqamsiz akount yaratilsa, xodim veb-login orqali kira olmay qolardi.
    if not phone or not re.fullmatch(r'\+998\d{9}', phone):
        return json_error("Telefon raqami majburiy va +998XXXXXXXXX formatda bo'lishi "
                          "kerak — xodim tizimga shu raqam bilan kiradi")

    # Qulf: tekshiruv + yozish bir atomar amal bo'lsin (dublikat akount yo'q).
    restored = False
    restored_old_salary = None
    with _STAFF_WRITE_LOCK:
        staff = load_staff()
        # ── Arxivlangan yozuvni QAYTA FAOLLASHTIRISH ─────────────────
        # Ilgari o'chirilgan (arxivlangan) xodimni qayta qo'shish yangi
        # yozuv yaratardi — natijada bir xil ismli xodim ro'yxatda 2 marta
        # ko'rinardi va eski yozuv telefon raqamini "band" qilib turardi.
        # Endi aynan shu telefonli arxiv yozuvi tiklanadi: savdo/maosh
        # tarixi saqlanib qoladi, dublikat paydo bo'lmaydi.
        archived = next((u for u in sorted(
            (item for item in staff if isinstance(item, dict)),
            key=lambda item: str(item.get('updatedAt') or item.get('createdAt') or ''),
            reverse=True)
            if str(u.get('status') or 'active').strip().lower() == 'inactive'
            and canonical_role(u.get('role')) != 'boss'
            and (phones_match(u.get('phone'), phone)
                 or phones_match(u.get('login'), phone))), None)
        if archived is not None:
            stamp = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
            restored = True
            restored_old_salary = archived.get('salary')
            archived.update({
                'name': name,
                'phone': phone,
                'role': role,
                'status': status,
                'branchId': branch_id,
                'mustChange': False,
                'updatedAt': stamp,
                'updatedBy': _actor_name()[:120],
                'recreatedAt': stamp,
            })
            archived.pop('deletedAt', None)
            archived.pop('deletedBy', None)
            if salary is not None:
                archived['salary'] = salary
                archived['salaryChangedAt'] = stamp
                archived['salaryChangedBy'] = _actor_name()[:120]
            # Parol: faqat xesh (qayta tiklanadigan nusxa saqlanmaydi).
            apply_staff_password(archived, password, _actor_name())
            if not str(archived.get('login') or '').strip():
                archived['login'] = _unique_staff_login(
                    staff, int(_num(archived.get('id'), 0)))
            try:
                db_manager.save_keys({'staff_users': staff})
            except Exception as e:
                print(f'[BOSS] Xodimni qayta faollashtirib bo\'lmadi: {e}')
                return jsonify({'status': 'error',
                                'message': 'Xodimni saqlab bo\'lmadi'}), 500
            account = archived
        else:
            if _staff_phone_in_use(staff, phone):
                return json_error('Bu telefon raqami band', 409)

            new_id = _next_staff_id(staff)
            account = {
                'id': new_id,
                'login': _unique_staff_login(staff, new_id),
                'phone': phone,
                'name': name,
                'role': role,
                'status': status,
                'branchId': branch_id,
                'mustChange': False,
                'createdBy': _actor_name()[:120],
                'createdAt': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
                'updatedAt': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
            }
            if salary is not None:
                account['salary'] = salary
                account['salaryChangedAt'] = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
                account['salaryChangedBy'] = _actor_name()[:120]
            # Parol: faqat xesh (qayta tiklanadigan nusxa saqlanmaydi).
            apply_staff_password(account, password, _actor_name())
            staff.append(account)
            try:
                db_manager.save_keys({'staff_users': staff,
                                      'staffIdSeq': new_id})
            except Exception as e:
                print(f'[BOSS] Xodimni saqlab bo\'lmadi: {e}')
                return jsonify({'status': 'error', 'message': 'Xodimni saqlab bo\'lmadi'}), 500

    if salary is not None:
        record_staff_salary_change(account['id'], name,
                                   restored_old_salary if restored else None,
                                   salary, _actor_name())
    audit_log('staff-restore' if restored else 'staff-create', name,
              f'rol={role} status={status} maosh={salary}'
              + (f' filial={branch_id}' if branch_id else '')
              + (' · arxivdan qayta faollashtirildi' if restored else ''),
              _actor_name())
    return jsonify({'status': 'success',
                    'restored': restored,
                    'message': 'Xodim qayta faollashtirildi' if restored
                               else 'Xodim qo\'shildi',
                    'staff': staff_public_view(account,
                                               include_salary=is_boss_actor)}), (
                        200 if restored else 201)

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/api/boss/staff/<int:staff_id>/password', methods=['GET'])
@require_staff('boss')
def boss_staff_password(staff_id):
    """Parolni ko'rsatish ENDI MUMKIN EMAS (xavfsizlik siyosati).

    Parollar faqat bir tomonlama xesh ko'rinishida saqlanadi. Eski mijoz
    keshidan kelgan so'rovlar ham aniq javob oladi — hech qanday parol
    qaytarilmaydi. Yangi parol faqat PUT orqali O'RNATILADI.
    """
    server_security_log('password-reveal-denied', 'medium',
                        f'Parolni ko\'rish urinishi rad etildi (staff_id={staff_id})',
                        _actor_name())
    return jsonify({
        'status': 'error',
        'code': 'password_hidden',
        'message': 'Xavfsizlik siyosati: parollar ko\'rsatilmaydi. '
                   'Xodimga yangi parol o\'rnating.',
    }), 410


@app.route('/api/boss/staff/<int:staff_id>', methods=['PUT'])
@require_staff('admin')
@_serialize_staff_write
def boss_staff_update(staff_id):
    """Xodimni tahrirlash: ism, telefon, rol, filial, oylik maosh, holat va parol.

    Vaqtinchalik parol: `requirePasswordChange: true` bilan yuborilsa, parol
    kamida 12 belgi bo'lishi shart va xodim birinchi kirishda uni albatta
    almashtiradi (`mustChange`).

    Himoyalar:
      • Boshliq o'zini hech qachon bloklay olmaydi;
      • rol faqat admin/manager/cashier orasida o'zgartiriladi;
      • parol serverda xeshlanadi va jurnalga YOZILMAYDI.
    """
    body = request.get_json(silent=True) or {}
    staff = load_staff()
    target = next((u for u in staff
                   if isinstance(u, dict) and _num(u.get('id'), -1) == staff_id), None)
    if not target:
        return json_error('Xodim topilmadi', 404)

    actor = getattr(request, 'staff', {}) or {}
    actor_login = str(actor.get('sub', '') or '').strip().lower()
    actor_id = _num(actor.get('id'), -1)
    target_id = _num(target.get('id'), -1)
    target_login = str(target.get('login', '') or '').strip().lower()
    is_self = (actor_id > 0 and target_id == actor_id) \
        or (bool(actor_login) and target_login == actor_login)
    target_role = str(target.get('role', '') or '').strip().lower()
    actor_role = str((getattr(request, 'staff', {}) or {}).get('role') or '').lower()
    is_admin_actor = actor_role == 'admin'
    if is_admin_actor and role_rank(target_role) >= role_rank('admin'):
        return json_error('Admin faqat Menejer va Kassa xodimlarini boshqarishi mumkin', 403)
    if is_admin_actor and {'role', 'salary', 'salaryPayDay', 'salaryMethod'} & body.keys():
        return json_error('Rol va maosh ma\'lumotlarini faqat Boshliq o\'zgartirishi mumkin', 403)
    old_login = target_login
    old_phone = normalize_phone(target.get('phone'))
    changes = []
    revoke_logins = set()
    password_changed = False
    temporary_password = body.get('requirePasswordChange') is True

    # ── Boshliq akountini himoyalash ───────────────────────────────
    # Boshqa Boshliq akountini tahrirlash taqiqlanadi. O'zini tahrirlashda
    # faqat ism/telefon (va parol — alohida oyna orqali) ruxsat etiladi;
    # rol yoki holat hech qachon o'zgartirilmaydi.
    if target_role == 'boss' and not is_self:
        return json_error('Boshliq akountini boshqa hisobdan tahrirlash mumkin emas', 403)

    if 'name' in body:
        name = _clean_boss_text(body.get('name'), 120)
        if not name or len(name) < 2:
            return json_error('Ism kamida 2 belgidan iborat bo\'lsin')
        if name != str(target.get('name') or ''):
            changes.append('ism')
        target['name'] = name

    if 'phone' in body:
        phone = normalize_phone(body.get('phone'))
        if not phone:
            return json_error("Telefon raqami to'liq va +998XXXXXXXXX formatda "
                              "bo'lishi kerak")
        if _staff_phone_in_use(staff, phone, exclude_id=staff_id):
            return json_error('Bu telefon raqami band', 409)
        if phone != old_phone:
            apply_staff_phone(target, phone, _actor_name())
            if str(target.get('login') or '').strip().lower() != old_login:
                revoke_logins.add(old_login)
            changes.append('telefon')

    if 'branchId' in body:
        branch_id = str(body.get('branchId') or '').strip()[:40]
        if not _branch_exists(branch_id):
            return json_error('Tanlangan filial topilmadi', 404)
        if branch_id != str(target.get('branchId') or ''):
            target['branchId'] = branch_id
            changes.append('filial')

    # ── Oylik maosh ───────────────────────────────────────────────
    # Faqat sonli qiymat; bo'sh/null bilan maoshni o'chirib bo'lmaydi.
    old_salary = _staff_salary_value(target)
    new_salary = None
    salary_changed = False
    if 'salary' in body:
        new_salary, salary_error = parse_staff_salary(body.get('salary'),
                                                      required=True)
        if salary_error:
            return json_error(salary_error)
        if new_salary != old_salary:
            target['salary'] = new_salary
            target['salaryChangedAt'] = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
            target['salaryChangedBy'] = _actor_name()[:120]
            salary_changed = True
            changes.append('maosh')

    # To'lov kuni (1..28) — belgilangan oylik qaysi kuni to'lanishi kerak.
    if 'salaryPayDay' in body:
        raw_pay_day = body.get('salaryPayDay')
        if raw_pay_day in (None, ''):
            return json_error('To\'lov kuni bo\'sh bo\'lmasligi kerak')
        pay_day_value = int(_num(raw_pay_day, -1))
        if pay_day_value < 1 or pay_day_value > 28:
            return json_error('To\'lov kuni 1 va 28 orasida bo\'lishi kerak')
        if pay_day_value != _salary_pay_day(target):
            target['salaryPayDay'] = pay_day_value
            changes.append('to\'lov kuni')

    # To'lov usuli — naqd/karta/click/o'tkazma.
    if 'salaryMethod' in body:
        method = str(body.get('salaryMethod') or '').strip().lower()
        if method not in SALARY_METHODS:
            return json_error('To\'lov usuli noto\'g\'ri. Ruxsat etilgan: '
                              + ', '.join(SALARY_METHODS))
        if method != _salary_method(target):
            target['salaryMethod'] = method
            changes.append('to\'lov usuli')

    if 'role' in body:
        role = str(body.get('role') or '').strip().lower()
        if target_role == 'boss':
            if role != 'boss':
                return json_error('Boshliq rolini o\'zgartirish mumkin emas', 403)
        elif role != target_role:
            if is_self:
                return json_error('O\'z rolingizni o\'zgartira olmaysiz', 403)
            if role not in BOSS_ASSIGNABLE_ROLES:
                return json_error('Rol noto\'g\'ri. Ruxsat etilgan rollar: '
                                  + ', '.join(r.upper() for r in BOSS_ASSIGNABLE_ROLES))
            target['role'] = role
            changes.append('rol')
            revoke_logins.add(target_login)

    if 'status' in body:
        status = str(body.get('status') or 'active').strip().lower()
        if status not in STAFF_STATUSES:
            return json_error('Holat noto\'g\'ri (active, blocked yoki inactive)')
        if target_role == 'boss' and status != 'active':
            return json_error('Boshliq akountini bloklab yoki arxivlab bo\'lmaydi', 403)
        if status != str(target.get('status') or 'active').strip().lower():
            if is_self and status != 'active':
                return json_error('O\'z akountingizni bloklay olmaysiz', 403)
            target['status'] = status
            changes.append('holat')
            if status in ('blocked', 'inactive'):
                revoke_logins.add(target_login)
                revoke_logins.add(old_login)
            else:
                # Blokdan/arxivdan qaytarilganda eski arxiv belgilarini tozalaymiz.
                target.pop('deletedAt', None)
                target.pop('deletedBy', None)

    if temporary_password and not body.get('password'):
        return json_error('Vaqtinchalik parol uchun yangi parol talab qilinadi')

    if body.get('password'):
        if is_self:
            return json_error('O\'z parolingizni «Parolimni o\'zgartirish» '
                              'oynasi orqali yangilang', 403)
        if target_role == 'boss':
            return json_error('Boshliq parolini bu formadan o\'zgartirib bo\'lmaydi', 403)
        # Vaqtinchalik parol uchun kuchliroq minimal uzunlik (12 belgi).
        password, error = _validate_password(
            body.get('password'), min_len=12 if temporary_password else 6)
        if error:
            return json_error(error)
        apply_staff_password(target, password, _actor_name())
        if temporary_password:
            # Birinchi kirishda xodim o'zi yangi doimiy parol o'rnatadi.
            target['mustChange'] = True
            changes.append('majburiy almashtirish')
        changes.append('parol')
        password_changed = True
        revoke_logins.add(target_login)

    if not changes:
        return jsonify({'status': 'success', 'message': 'O\'zgarish yo\'q',
                        'staff': staff_public_view(
                            target, include_salary=actor_role == 'boss')})

    target['updatedAt'] = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    target['updatedBy'] = _actor_name()[:120]
    try:
        db_manager.save_keys({'staff_users': staff})
    except Exception as e:
        print(f'[BOSS] Xodimni saqlab bo\'lmadi: {e}')
        return json_error('Saqlab bo\'lmadi', 500)

    # Sessiyalar faqat MA'HUMOTLAR MUVAFFAQIYATLI saqlangandan keyin yopiladi.
    for login in {str(x or '').strip().lower() for x in revoke_logins if str(x or '').strip()}:
        revoke_login_sessions(login)

    if salary_changed:
        record_staff_salary_change(staff_id, target.get('name'), old_salary,
                                   new_salary, _actor_name())
    audit_log('staff-update', str(target.get('name', '')),
              'o\'zgarishlar: ' + ', '.join(changes), _actor_name())
    if password_changed:
        server_security_log(
            'staff-password-reset', 'high',
            f'{target.get("name")} uchun yangi parol o\'rnatildi'
            + (' (vaqtinchalik, majburiy almashtirish)' if temporary_password else ''),
            _actor_name())
    if 'holat' in changes:
        server_security_log('staff-status-change', 'medium',
                            f'{target.get("name")}: holat → {target.get("status")}',
                            _actor_name())
    if 'holat' in changes:
        message = ('Xodim bloklandi' if target.get('status') == 'blocked'
                   else 'Xodim holati yangilandi')
    elif temporary_password:
        message = 'Vaqtinchalik parol o\'rnatildi'
    elif password_changed:
        message = 'Parol yangilandi'
    else:
        message = 'Xodim yangilandi'
    return jsonify({'status': 'success', 'message': message,
                    'changed': changes,
                    'staff': staff_public_view(target, include_salary=not is_admin_actor)})
@app.route('/robots.txt')
def serve_robots():
    """Qidiruv botlari uchun: boshqaruv va API yo'llari indekslanmasin."""
    body = ('User-agent: *\n'
            'Allow: /\n'
            'Disallow: /api/\n'
            'Disallow: /uploads/\n'
            'Crawl-delay: 10\n')
    return body

def _record_references_staff(record, target, id_fields, login_fields, name_fields):
    """Tarix yozuvidagi ma'lum xodim identifikatorlarini rekursiv tekshiradi."""
    if isinstance(record, list):
        return any(_record_references_staff(item, target, id_fields, login_fields,
                                            name_fields) for item in record)
    if not isinstance(record, dict):
        return False

    staff_id = str(target.get('id') or '').strip()
    login = str(target.get('login') or '').strip().lower()
    name = str(target.get('name') or '').strip().lower()
    for field in id_fields:
        value = record.get(field)
        if value not in (None, '') and str(value).strip() == staff_id:
            return True
    for field in login_fields:
        value = str(record.get(field) or '').strip().lower()
        if login and value == login:
            return True
    for field in name_fields:
        value = str(record.get(field) or '').strip().lower()
        if name and value == name:
            return True
    return any(_record_references_staff(value, target, id_fields, login_fields,
                                        name_fields) for value in record.values())


def _staff_has_historical_records(store, target, staff):
    """Moliyaviy, savdo yoki audit tarixi bor xodimni jismonan o'chirmaydi."""
    history_fields = {
        'sales': (
            {'staffId', 'cashierId', 'employeeId', 'userId'},
            {'cashierLogin', 'staffLogin', 'employeeLogin'},
            {'cashier', 'staffName', 'employeeName'},
        ),
        'salaryHistory': (
            {'staffId', 'empId', 'employeeId', 'userId'},
            {'staffLogin', 'employeeLogin'},
            {'staffName', 'empName', 'employeeName'},
        ),
        'salaryRecords': (
            {'staffId', 'empId', 'employeeId', 'userId'},
            {'staffLogin', 'employeeLogin'},
            {'staffName', 'empName', 'employeeName'},
        ),
        # `staffSalaryHistory` ATAYLAB yo'q: bu faqat maosh o'zgarishi jurnali
        # (yangi xodimga oylik belgilash ham shu yerga yoziladi), moliyaviy
        # to'lov emas. Uni tarix deb hisoblash sababli yangi qo'shilgan xodimni
        # umuman o'chirib bo'lmay, faqat arxivlash mumkin edi — Boshliq esa
        # "o'chirish ishlamayapti" deb ko'rardi. Haqiqiy to'lovlar
        # `salaryHistory` da yoziladi va o'sha o'chirishni bloklaydi.
        'cashFlow': (
            {'staffId', 'cashierId', 'employeeId', 'userId'},
            {'staffLogin', 'cashierLogin', 'employeeLogin'},
            {'staffName', 'cashier', 'employeeName'},
        ),
        'expenses': (
            {'staffId', 'cashierId', 'employeeId', 'userId'},
            {'staffLogin', 'cashierLogin', 'employeeLogin'},
            {'staffName', 'cashier', 'employeeName'},
        ),
        'contracts': (
            {'staffId', 'employeeId', 'userId', 'createdByStaffId'},
            {'staffLogin', 'employeeLogin', 'createdByLogin'},
            {'staffName', 'employeeName', 'employee'},
        ),
    }
    name_counts = staff_name_counts(staff)
    for key, (id_fields, login_fields, name_fields) in history_fields.items():
        records = store.get(key)
        if not isinstance(records, list):
            continue
        for record in records:
            if key == 'sales' and isinstance(record, dict) \
                    and sale_belongs_to_staff(record, target, name_counts):
                return True
            if _record_references_staff(record, target, id_fields,
                                        login_fields, name_fields):
                return True
    return False


@app.route('/api/boss/staff/<int:staff_id>', methods=['DELETE'])
@require_staff('admin')
@_serialize_staff_write
def boss_staff_delete(staff_id):
    """Tarixi bo'lmagan xodimni o'chiradi, tarixlisini xavfsiz arxivlaydi."""
    if staff_id <= 0:
        return json_error('Xodim ID noto\'g\'ri', 400)
    staff = load_staff()
    target = next((u for u in staff
                   if isinstance(u, dict) and _num(u.get('id'), -1) == staff_id), None)
    if not target:
        return json_error('Xodim topilmadi yoki allaqachon o\'chirilgan', 404)

    actor = getattr(request, 'staff', {}) or {}
    actor_login = str(actor.get('sub', '') or '').strip().lower()
    actor_id = _num(actor.get('id'), -1)
    actor_role = canonical_role(actor.get('role'))
    target_login = str(target.get('login', '') or '').strip().lower()
    target_id = _num(target.get('id'), -1)
    target_role = canonical_role(target.get('role'))

    if (target_login and target_login == actor_login) or (
            actor_id > 0 and target_id == actor_id):
        return json_error('O\'z akountingizni o\'chira yoki arxivlay olmaysiz', 403)
    if target_role == 'boss':
        return json_error('Boshliq akountini o\'chirish yoki arxivlash mumkin emas', 403)
    if role_rank(target_role) <= 0:
        return json_error('Xodim roli noto\'g\'ri; akountni o\'chirish mumkin emas', 409)
    if role_rank(actor_role) <= role_rank(target_role):
        return json_error('Bu akountni boshqarish uchun yetarli huquq yo\'q', 403)
    if target_role == 'admin' and str(target.get('status') or 'active').lower() == 'active':
        active_admins = [user for user in staff if isinstance(user, dict)
                         and canonical_role(user.get('role')) == 'admin'
                         and str(user.get('status') or 'active').strip().lower() == 'active']
        if len(active_admins) <= 1:
            return json_error('Yagona faol administrator akountini o\'chirish yoki '
                              'nofaol qilish mumkin emas', 409)

    has_history = _staff_has_historical_records(db_manager.get_all() or {}, target, staff)
    # Tarixiy bog'lanishi bo'lmagan yozuv — holatidan qat'i nazar JISMONAN
    # o'chiriladi (avval arxivlangan, keyin qayta qo'shilgan "dublikat"
    # yozuvlarni Boshliq tozalab olishi uchun). Tarixi bor xodim esa
    # arxivlanadi — ikkinchi marta arxivlash so'rovi 409 qaytaradi.
    if has_history and str(target.get('status') or 'active').strip().lower() == 'inactive':
        return json_error('Xodim allaqachon nofaol yoki arxivlangan', 409)

    if has_history:
        stamp = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
        target['status'] = 'inactive'
        target['deletedAt'] = stamp
        target['deletedBy'] = _actor_name()[:120]
        target['updatedAt'] = stamp
        target['updatedBy'] = _actor_name()[:120]
        try:
            db_manager.save_keys({'staff_users': staff})
        except Exception as exc:
            print(f'[BOSS] Xodimni nofaol qilishda ma\'lumotlar bazasi xatosi '
                  f'({type(exc).__name__})')
            return json_error('Xodimni nofaol qilishda server yoki baza xatosi yuz berdi', 500)

        revoke_login_sessions(target_login)
        audit_log('staff-archive', str(target.get('name', '')),
                  f'rol={target_role} · tarix saqlangan holda nofaol qilindi', _actor_name())
        server_security_log('staff-archived', 'medium',
                            f'Akount nofaol qilindi, tarix saqlandi '
                            f'({target_role}; ID={staff_id})', _actor_name())
        return jsonify({
            'status': 'success',
            'action': 'archived',
            'message': f'"{target.get("name")}" tarixiy yozuvlari saqlangan holda '
                       f'nofaol qilindi.',
            'staff': staff_public_view(target, include_salary=actor_role == 'boss'),
        })

    remaining_staff = [user for user in staff
                       if not (isinstance(user, dict)
                               and _num(user.get('id'), -1) == staff_id)]
    # O'chirilgan id qayta ishlatilmaydi (yangi xodim eski tarixga
    # bog'lanib qolmasligi uchun) — hisoblagichga yozib qo'yamiz.
    used_seq = int(_num((db_manager.get_all() or {}).get('staffIdSeq'), 0))
    try:
        db_manager.save_keys({'staff_users': remaining_staff,
                              'staffIdSeq': max(used_seq, staff_id)})
    except Exception as exc:
        print(f'[BOSS] Xodimni o\'chirishda ma\'lumotlar bazasi xatosi '
              f'({type(exc).__name__})')
        return json_error('Xodimni o\'chirishda server yoki baza xatosi yuz berdi', 500)

    revoke_login_sessions(target_login)
    audit_log('staff-delete', str(target.get('name', '')),
              f'rol={target_role} · tarixiy bog\'lanishlar topilmadi', _actor_name())
    server_security_log('staff-deleted', 'medium',
                        f'Akount o\'chirildi (rol={target_role}; ID={staff_id})',
                        _actor_name())
    return jsonify({
        'status': 'success',
        'action': 'deleted',
        'message': f'"{target.get("name")}" xodimi o\'chirildi.',
    })


# ============================================================
# 4) MAHSULOTLAR NAZORATI + TOP MAHSULOTLAR + KAM QOLGANLAR
# ============================================================
def _product_sales_rollup(scoped, products_by_id):
    """Sotilganlik: mahsulot nomi → dona, tushum, filiallar, xodimlar."""
    units, amount, per_branch, per_staff = {}, {}, {}, {}
    for sale in scoped:
        branch_id = sale_branch(sale, products_by_id)
        cashier = str(sale.get('cashier') or '—').strip() or '—'
        for item in sale.get('items') or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get('name') or '').strip()
            qty = _num(item.get('qty'))
            units[name] = units.get(name, 0.0) + qty
            amount[name] = amount.get(name, 0.0) + _num(item.get('price')) * qty
            if branch_id:
                per_branch.setdefault(name, {})
                per_branch[name][branch_id] = per_branch[name].get(branch_id, 0.0) + qty
            per_staff.setdefault(name, {})
            per_staff[name][cashier] = per_staff[name].get(cashier, 0.0) + qty
    return units, amount, per_branch, per_staff


@app.route('/api/boss/products', methods=['GET'])
@require_staff('boss')
def boss_products():
    """Mahsulotlar tahlili: to'liq ma'lumot, top mahsulotlar, kam qoldi.

    Query: period, view ('all'|'top'|'low'), q, cat, branchId, limit, offset.
    """
    store = db_manager.get_all() or {}
    products = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    branches = branches_index(store)
    products_by_id = products_index(store)
    period = normalize_period(request.args.get('period'))
    rng = custom_period_range(request.args)
    scoped = sales_in_period(store, period, rng)
    sold_units, sold_amount, per_branch, per_staff = _product_sales_rollup(scoped, products_by_id)
    threshold = low_stock_threshold()

    rows = []
    for product in products:
        name = str(product.get('name', '')).strip()
        branch_id = str(product.get('branchId') or '')
        stock = _num(product.get('stock'))
        price = _num(product.get('price'))
        rows.append({
            'id': product.get('id'),
            'name': name,
            'cat': str(product.get('cat') or '')[:60],
            'brand': str(product.get('brand') or '')[:60],
            'barcode': str(product.get('barcode') or '')[:40],
            'price': round(price, 2),
            'cost': round(_num(product.get('cost')), 2),
            'stock': stock,
            'stockValue': round(price * stock, 2),
            'branchId': branch_id,
            'branchName': str((branches.get(branch_id) or {}).get('name', '') or '')[:80],
            'status': str(product.get('status') or ('active' if stock > 0 else 'out'))[:30],
            'soldUnits': sold_units.get(name, 0.0),
            'soldAmount': round(sold_amount.get(name, 0.0), 2),
            'soldBranches': [
                {'branchId': b, 'branchName': str((branches.get(b) or {}).get('name', '') or '')[:80],
                 'units': u}
                for b, u in (per_branch.get(name) or {}).items()
            ],
            'soldBy': [{'staff': s, 'units': u} for s, u in
                       sorted((per_staff.get(name) or {}).items(), key=lambda kv: -kv[1])],
        })

    view = str(request.args.get('view') or 'all').strip().lower()
    query = str(request.args.get('q') or '').strip().lower()
    cat_filter = str(request.args.get('cat') or '').strip().lower()
    branch_filter = str(request.args.get('branchId') or '').strip()

    if view == 'low':
        rows = [r for r in rows if r['stock'] < threshold]
    elif view == 'top':
        rows = [r for r in rows if r['soldUnits'] > 0]
    if query:
        rows = [r for r in rows
                if query in r['name'].lower() or query in r['cat'].lower()
                or query in r['brand'].lower() or query in r['barcode'].lower()]
    if cat_filter:
        rows = [r for r in rows if r['cat'].lower() == cat_filter]
    if branch_filter:
        rows = [r for r in rows if r['branchId'] == branch_filter]

    rows.sort(key=lambda r: (r['stock'] if view == 'low'
                             else (r['soldUnits'], r['soldAmount'])), reverse=(view != 'low'))

    try:
        limit = max(1, min(500, int(request.args.get('limit') or 100)))
        offset = max(0, int(request.args.get('offset') or 0))
    except (TypeError, ValueError):
        limit, offset = 100, 0

    return jsonify({
        'status': 'success',
        'period': period,
        'view': view,
        'lowStockThreshold': threshold,
        'total': len(rows),
        'offset': offset,
        'limit': limit,
        'categories': sorted({str(p.get('cat') or '')[:60] for p in products
                              if str(p.get('cat') or '').strip()}),
        'products': rows[offset:offset + limit],
    })


# ============================================================
# 5) FILIALLAR — umumiy holat va o'zaro solishtirish
# ============================================================
@app.route('/api/boss/branches', methods=['GET'])
@require_staff('boss')
def boss_branches():
    """Har bir filial: xodimlar, savdo, mahsulotlar, qoldiq va foyda.

    Savdo filiali chekdagi mahsulotlarning `branchId` sidan aniqlanadi
    (barcha mahsulot bitta filialda bo'lsa). Savdo yozuvida `branchId`
    maydoni bo'lsa — u ustunlik qiladi.
    """
    store = db_manager.get_all() or {}
    products = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    branches = [b for b in (store.get('branches') or []) if isinstance(b, dict)]
    staff = unique_staff(load_staff())
    period = normalize_period(request.args.get('period'))
    rng = custom_period_range(request.args)
    scoped = sales_in_period(store, period, rng)
    products_by_id = products_index(store)
    # Bugun va oy — tanlangan davrdan qat'iy nazar, haqiqiy barcha savdodan.
    today_sales = sales_in_period(store, 'day')
    month_sales = sales_in_period(store, 'month')

    rollup = {}
    today_rollup = {}
    month_rollup = {}
    for sale in scoped:
        bid = sale_branch(sale, products_by_id)
        if not bid:
            continue
        row = rollup.setdefault(bid, {'sales': 0, 'total': 0.0, 'units': 0.0, 'profit': 0.0})
        row['sales'] += 1
        row['total'] += _num(sale.get('total'))
        row['units'] += sale_units(sale)
        row['profit'] += sale_profit(sale)
    for sale in today_sales:
        bid = sale_branch(sale, products_by_id)
        if not bid:
            continue
        row = today_rollup.setdefault(bid, {'sales': 0, 'total': 0.0})
        row['sales'] += 1
        row['total'] += _num(sale.get('total'))
    for sale in month_sales:
        bid = sale_branch(sale, products_by_id)
        if not bid:
            continue
        row = month_rollup.setdefault(bid, {'sales': 0, 'total': 0.0})
        row['sales'] += 1
        row['total'] += _num(sale.get('total'))

    rows = []
    for branch in branches:
        bid = str(branch.get('id', ''))
        stats = rollup.get(bid, {'sales': 0, 'total': 0.0, 'units': 0.0, 'profit': 0.0})
        branch_products = [p for p in products if str(p.get('branchId') or '') == bid]
        branch_staff = [u for u in staff
                        if str(u.get('branchId') or '') == bid and role_rank(u.get('role')) > 0]
        stock_units = sum(_num(p.get('stock')) for p in branch_products)
        stock_value = sum(_num(p.get('price')) * _num(p.get('stock')) for p in branch_products)
        rows.append({
            'id': bid,
            'name': str(branch.get('name') or '')[:120],
            'address': str(branch.get('address') or branch.get('addr') or '')[:200],
            'status': str(branch.get('status') or 'active')[:30],
            'phone': str(branch.get('phone') or '')[:40],
            'staffCount': len(branch_staff),
            'staffActive': len([u for u in branch_staff
                                if str(u.get('status') or 'active').lower() in ('active', '')]),
            'productCount': len(branch_products),
            'stockUnits': stock_units,
            'stockValue': round(stock_value, 2),
            'sales': stats['sales'],
            'units': stats['units'],
            'revenue': round(stats['total'], 2),
            'profit': round(stats['profit'], 2),
            'todaySales': round(today_rollup.get(bid, {}).get('total', 0.0), 2),
            'todayOrders': today_rollup.get(bid, {}).get('sales', 0),
            'monthSales': round(month_rollup.get(bid, {}).get('total', 0.0), 2),
            'monthOrders': month_rollup.get(bid, {}).get('sales', 0),
            'avgCheck': round(stats['total'] / stats['sales'], 2) if stats['sales'] else 0.0,
        })

    # Savdo bo'yicha kamayib borish — "qaysi filial yaxshi ishlayapti?".
    rows.sort(key=lambda r: (r['revenue'], r['sales']), reverse=True)
    for index, row in enumerate(rows, start=1):
        row['rank'] = index

    # Savdosi bo'lmagan mahsulot/mahsulotga bog'liq bo'lmagan savdo — "Umumiy".
    unattributed = sum(_num(s.get('total')) for s in scoped if not sale_branch(s, products_by_id))

    return jsonify({
        'status': 'success',
        'period': period,
        'branches': rows,
        'unattributedRevenue': round(unattributed, 2),
    })


# ============================================================
# 6) MOLIYAVIY NAZORAT — savdo, kirim, chiqim, harajat, sof natija
# ============================================================
@app.route('/api/boss/finance', methods=['GET'])
@require_staff('boss')
def boss_finance():
    """Moliyaviy umumiy ko'rinish.

    Savdo va foyda — haqiqiy savdo yozuvlaridan; kirim/chiqim/harajat —
    mavjud `cashFlow` yozuvlaridan (yangi moliyaviy tizim yaratilmaydi).
    """
    store = db_manager.get_all() or {}
    period = normalize_period(request.args.get('period'))
    rng = custom_period_range(request.args)
    branch_filter = str(request.args.get('branchId') or '').strip()
    products_by_id = products_index(store)
    scoped = completed_sales_in_period(store, period, rng)
    if branch_filter:
        scoped = [s for s in scoped
                  if sale_branch(s, products_by_id) == branch_filter]

    # Ikkala moliya kolleksiyasini ham hisobga olamiz: ilgari faqat bittasi
    # olinardi va `expenses` yozuvlari butunlay yo'qolib ketardi.
    cash_flow = []
    for key in ('cashFlow', 'expenses'):
        cash_flow.extend(c for c in (store.get(key) or []) if isinstance(c, dict))
    scoped_flow = [c for c in cash_flow if in_period(c.get('date'), period, rng)]
    if branch_filter:
        scoped_flow = [c for c in scoped_flow
                       if str(c.get('branchId') or '') == branch_filter]

    buckets = {'kirim': 0.0, 'chiqim': 0.0, 'harajat': 0.0}
    for record in scoped_flow:
        key = str(record.get('type') or 'chiqim').strip().lower()
        if key in buckets:
            buckets[key] += _num(record.get('amount'))

    revenue = sum(_num(s.get('total')) for s in scoped)
    profit = sum(sale_profit(s) for s in scoped)
    # Sof natija: foyda − (chiqim + harajat). Kirim alohida hisoblanadi,
    # chunki u pul oqimining tarafi, foyda emas.
    net = profit - buckets['chiqim'] - buckets['harajat']

    return jsonify({
        'status': 'success',
        'period': period,
        'branchId': branch_filter,
        'finance': {
            'revenue': round(revenue, 2),
            'orders': len(scoped),
            'grossProfit': round(profit, 2),
            'kirim': round(buckets['kirim'], 2),
            'chiqim': round(buckets['chiqim'], 2),
            'harajat': round(buckets['harajat'], 2),
            'net': round(net, 2),
            'flowRecords': len(scoped_flow),
            # Foyda faqat mahsulotlarda `cost` (tan narx) mavjud bo'lsa
            # haqiqiy hisoblanadi — aks holda UI "ma'lumot yo'q" deb ko'rsatadi.
            'hasCostData': any(
                _num((item or {}).get('cost')) > 0
                for sale in scoped for item in (sale.get('items') or [])
                if isinstance(item, dict)
            ),
        },
    })


# ============================================================
# 6.1) MIJOZLAR — haridor bazasi va xarid statistikasi
# ============================================================
def _customer_phone_digits(value):
    """Mijoz telefonidan faqat raqamlarni qoldiradi (solishtirish uchun)."""
    return re.sub(r'\D', '', str(value or ''))[:20]


def _customer_match_index(customers):
    """Mijozni savdo yozuvi bilan bog'lash uchun indekslar.

    Savdoda `customerId`, `customerPhone` yoki faqat ism bo'lishi mumkin
    (eski yozuvlar). Ism bo'yicha faqat ISM YAGONA bo'lsa bog'lanadi —
    aks holda bir xil ismli ikki mijozning xaridlari aralashib ketardi.
    """
    by_id, by_phone, by_name = {}, {}, {}
    for customer in customers:
        cid = str(customer.get('id') or '').strip()
        if cid:
            by_id[cid] = customer
        phone = _customer_phone_digits(customer.get('phone'))
        if phone:
            by_phone.setdefault(phone, []).append(customer)
        name = str(customer.get('name') or '').strip().lower()
        if name:
            by_name.setdefault(name, []).append(customer)
    return by_id, by_phone, by_name


def _find_customer_for_sale(sale, by_id, by_phone, by_name):
    """Savdo yozuviga tegishli mijozni topadi (id → telefon → ism)."""
    cid = str(sale.get('customerId') or '').strip()
    if cid and cid in by_id:
        return by_id[cid]
    phone = _customer_phone_digits(sale.get('customerPhone'))
    if phone:
        matches = by_phone.get(phone) or []
        if len(matches) == 1:
            return matches[0]
    name = str(sale.get('customer') or '').strip().lower()
    matches = by_name.get(name) or []
    if len(matches) == 1:
        return matches[0]
    return None


@app.route('/api/boss/customers', methods=['GET'])
@require_staff('boss')
def boss_customers():
    """Haridorlar bazasi: kim, qancha xarid qilgan va oxirgi xarid qachon.

    Query: period, from, to, q (ism/telefon/email), limit, offset.
    Mijozlar soni va xarid statistikasi — haqiqiy `customers` va `sales`
    yozuvlaridan hisoblanadi (yangi jadval yaratilmaydi).
    """
    store = db_manager.get_all() or {}
    customers = [c for c in (store.get('customers') or []) if isinstance(c, dict)]
    period = normalize_period(request.args.get('period'))
    rng = custom_period_range(request.args)
    scoped = completed_sales_in_period(store, period, rng)
    by_id, by_phone, by_name = _customer_match_index(customers)

    stats = {}
    for sale in scoped:
        customer = _find_customer_for_sale(sale, by_id, by_phone, by_name)
        if customer is None:
            continue
        key = str(customer.get('id') or id(customer))
        bucket = stats.setdefault(key, {
            'orders': 0, 'total': 0.0, 'units': 0.0,
            'lastDate': '', 'lastSort': '',
        })
        bucket['orders'] += 1
        bucket['total'] += _num(sale.get('total'))
        bucket['units'] += sum(_num(item.get('qty'))
                               for item in (sale.get('items') or [])
                               if isinstance(item, dict))
        raw_date = str(sale.get('date') or '')
        raw_time = str(sale.get('time') or '')
        parsed = parse_business_date(raw_date)
        sort_key = (parsed.isoformat() if parsed else raw_date) + ' ' + raw_time
        if sort_key >= (bucket['lastSort'] or ''):
            bucket['lastSort'] = sort_key
            bucket['lastDate'] = (raw_date + (' ' + raw_time if raw_time else '')).strip()

    query = str(request.args.get('q') or '').strip().lower()
    rows = []
    for customer in customers:
        key = str(customer.get('id') or id(customer))
        bucket = stats.get(key) or {}
        name = str(customer.get('name') or '')
        phone = str(customer.get('phone') or '')
        email = str(customer.get('email') or '')
        if query:
            haystack = ' '.join([name, phone, email, str(customer.get('bdate') or '')]).lower()
            if query not in haystack:
                continue
        orders = int(bucket.get('orders') or 0)
        total = round(_num(bucket.get('total')), 2)
        rows.append({
            'id': customer.get('id'),
            'name': name[:120],
            'phone': phone[:40],
            'email': email[:120],
            'addr': str(customer.get('addr') or '')[:180],
            'bdate': str(customer.get('bdate') or '')[:10],
            'bonus': round(_num(customer.get('bonus')), 2),
            'status': str(customer.get('status') or 'active')[:20],
            'createdAt': str(customer.get('createdAt') or '')[:40],
            'orders': orders,
            'units': round(_num(bucket.get('units')), 2),
            'total': total,
            'avgCheck': round(total / orders, 2) if orders else 0.0,
            'lastPurchase': str(bucket.get('lastDate') or '')[:40],
        })

    rows.sort(key=lambda row: (-row['total'], row['name'].lower(), str(row['id'])))
    summary = {
        'count': len(rows),
        'active': sum(1 for row in rows if row['status'] == 'active'),
        'vip': sum(1 for row in rows if row['status'] == 'vip'),
        'inactive': sum(1 for row in rows if row['status'] == 'inactive'),
        'withOrders': sum(1 for row in rows if row['orders'] > 0),
        'orders': sum(row['orders'] for row in rows),
        'revenue': round(sum(row['total'] for row in rows), 2),
    }
    try:
        limit = max(1, min(500, int(request.args.get('limit') or 200)))
        offset = max(0, int(request.args.get('offset') or 0))
    except (TypeError, ValueError):
        limit, offset = 200, 0

    return jsonify({
        'status': 'success',
        'period': period,
        'total': len(rows),
        'summary': summary,
        'offset': offset,
        'limit': limit,
        'customers': rows[offset:offset + limit],
    })


# ============================================================
# 6.2) KASSA SVERKASI — kunlik naqd pul solishtiruvi
# ============================================================
CASH_SVERKA_LIMIT = 1000
CASH_SVERKA_PAYMENTS = ('cash', 'card', 'online', 'credit', 'transfer', 'other')


def _sale_payment_bucket(sale):
    """Savdo to'lov usulini sverka guruhiga ajratadi (naqd/karta/...)."""
    provider = str(sale.get('provider') or '').strip().lower()
    pay = str(sale.get('pay') or '').strip().lower()
    text = provider or pay
    if provider == 'cash' or 'naqd' in text or 'нақд' in text:
        return 'cash'
    if provider == 'card' or 'karta' in text or 'карта' in text:
        return 'card'
    if provider in ('click', 'payme', 'paynet', 'uzum', 'paylov') \
            or 'click' in text or 'payme' in text or 'uzum' in text \
            or 'paynet' in text or 'paylov' in text:
        return 'online'
    if provider == 'credit' or 'kredit' in text or 'кредит' in text:
        return 'credit'
    if provider == 'transfer' or 'o\'tkazma' in text or 'otkazma' in text:
        return 'transfer'
    return 'other'


def _flow_day(record):
    """Kirim/chiqim yozuvining sanasi (`date` ISO yoki eski format)."""
    parsed = parse_business_date(record.get('date'))
    return parsed.date() if parsed else None


def _cash_sverka_calc(store, day, branch_id=''):
    """Tanlangan kun va filial uchun sverka raqamlarini hisoblaydi.

    Naqd savdo = `provider/pay` naqd bo'lgan yakunlangan cheklar.
    Kutilgan naqd = naqd savdo + naqd kirim − chiqim − xarajat.
    """
    products_by_id = products_index(store)
    payments = {key: 0.0 for key in CASH_SVERKA_PAYMENTS}
    orders = 0
    units = 0.0
    revenue = 0.0
    for sale in completed_sales(store.get('sales') or []):
        sale_date = parse_business_date(sale.get('date'))
        if not sale_date or sale_date.date() != day:
            continue
        if branch_id and sale_branch(sale, products_by_id) != branch_id:
            continue
        total = _num(sale.get('total'))
        orders += 1
        revenue += total
        units += sum(_num(item.get('qty')) for item in (sale.get('items') or [])
                     if isinstance(item, dict))
        bucket = _sale_payment_bucket(sale)
        payments[bucket] = payments.get(bucket, 0.0) + total

    flow = {'kirim': 0.0, 'chiqim': 0.0, 'harajat': 0.0}
    flow_records = 0
    for key in ('cashFlow', 'expenses'):
        for record in (store.get(key) or []):
            if not isinstance(record, dict):
                continue
            if _flow_day(record) != day:
                continue
            if branch_id and str(record.get('branchId') or '') != branch_id:
                continue
            kind = str(record.get('type') or 'chiqim').strip().lower()
            if kind not in flow:
                continue
            flow[kind] += _num(record.get('amount'))
            flow_records += 1

    expected_cash = (payments['cash'] + flow['kirim']
                     - flow['chiqim'] - flow['harajat'])
    return {
        'sales': {
            'orders': orders,
            'units': round(units, 2),
            'revenue': round(revenue, 2),
            **{key: round(value, 2) for key, value in payments.items()},
        },
        'flow': {key: round(value, 2) for key, value in flow.items()},
        'flowRecords': flow_records,
        'expectedCash': round(expected_cash, 2),
    }


def _cash_sverka_view(store, record):
    """Sverka yozuvini xavfsiz (ko'rsatish uchun) ko'rinishga keltiradi."""
    branches = branches_index(store)
    expected = _num(record.get('expected'))
    counted = _num(record.get('counted'))
    return {
        'id': str(record.get('id') or '')[:40],
        'date': str(record.get('date') or '')[:10],
        'branchId': str(record.get('branchId') or '')[:40],
        'branchName': str((branches.get(str(record.get('branchId') or '')) or {})
                          .get('name', '') or ''),
        'expected': round(expected, 2),
        'counted': round(counted, 2),
        'difference': round(counted - expected, 2),
        'note': str(record.get('note') or '')[:200],
        'createdBy': str(record.get('createdBy') or '')[:120],
        'createdAt': str(record.get('createdAt') or '')[:30],
    }


@app.route('/api/boss/cash-sverka', methods=['GET'])
@require_staff('boss')
def boss_cash_sverka():
    """Kassa sverkasi: kunlik kutilgan naqd va sanab chiqilgan pul.

    Query: date (YYYY-MM-DD, standart — bugun), branchId.
    """
    store = db_manager.get_all() or {}
    raw_date = str(request.args.get('date') or '').strip()
    try:
        day = date.fromisoformat(raw_date) if raw_date else date.today()
    except ValueError:
        return json_error('Sana noto\'g\'ri (YYYY-MM-DD)', 400)
    branch_id = str(request.args.get('branchId') or '').strip()[:40]
    calc = _cash_sverka_calc(store, day, branch_id)
    records = [r for r in (store.get('cashSverka') or []) if isinstance(r, dict)]
    current = next((r for r in records
                    if str(r.get('date') or '') == day.isoformat()
                    and str(r.get('branchId') or '') == branch_id), None)
    recent = sorted(records, key=lambda r: str(r.get('createdAt') or ''),
                    reverse=True)[:30]
    branches = branches_index(store)
    return jsonify({
        'status': 'success',
        'date': day.isoformat(),
        'branchId': branch_id,
        'branchName': str((branches.get(branch_id) or {}).get('name', '') or ''),
        **calc,
        'record': _cash_sverka_view(store, current) if current else None,
        'recent': [_cash_sverka_view(store, r) for r in recent],
    })


@app.route('/api/boss/cash-sverka', methods=['POST'])
@require_staff('boss')
def boss_cash_sverka_save():
    """Sanalgan naqdni saqlaydi; farq SERVERDA qayta hisoblanadi."""
    body = request.get_json(silent=True) or {}
    raw_date = str(body.get('date') or '').strip()
    try:
        day = date.fromisoformat(raw_date) if raw_date else date.today()
    except ValueError:
        return json_error('Sana noto\'g\'ri (YYYY-MM-DD)', 400)
    branch_id = str(body.get('branchId') or '').strip()[:40]
    if branch_id and not _branch_exists(branch_id):
        return json_error('Tanlangan filial topilmadi', 404)
    counted = body.get('counted')
    if isinstance(counted, bool) or not isinstance(counted, (int, float, str)):
        return json_error('Sanalgan summani kiriting', 400)
    try:
        counted_value = float(str(counted).replace(' ', '').replace(',', '.'))
    except (TypeError, ValueError):
        return json_error('Sanalgan summa raqam bo\'lishi kerak', 400)
    if not math.isfinite(counted_value) or counted_value < 0:
        return json_error('Sanalgan summa manfiy bo\'lmaydi', 400)
    note = _clean_boss_text(body.get('note'), 200)

    with _store_write_lock:
        store = db_manager.get_all() or {}
        calc = _cash_sverka_calc(store, day, branch_id)
        records = [r for r in (store.get('cashSverka') or []) if isinstance(r, dict)]
        stamp = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
        existing = next((r for r in records
                         if str(r.get('date') or '') == day.isoformat()
                         and str(r.get('branchId') or '') == branch_id), None)
        record = {
            'id': str((existing or {}).get('id') or uuid.uuid4().hex[:12]),
            'date': day.isoformat(),
            'branchId': branch_id,
            'expected': calc['expectedCash'],
            'counted': round(counted_value, 2),
            'difference': round(counted_value - calc['expectedCash'], 2),
            'note': note,
            'createdBy': _actor_name()[:120],
            'createdAt': stamp,
        }
        if existing is not None:
            existing.clear()
            existing.update(record)
        else:
            records.insert(0, record)
        try:
            db_manager.save_keys({'cashSverka': records[:CASH_SVERKA_LIMIT]})
        except Exception as exc:
            print(f'[BOSS] Sverkani saqlab bo\'lmadi: {exc}')
            return json_error('Sverkani saqlashda server yoki baza xatosi yuz berdi', 500)

    difference = record['difference']
    audit_log('cash-sverka', day.isoformat(),
              f'kutilgan={calc["expectedCash"]} sanalgan={record["counted"]} '
              f'farq={difference}'
              + (f' filial={branch_id}' if branch_id else ''),
              _actor_name())
    if difference == 0:
        message = 'Sverka mos keldi — farq yo\'q'
    elif difference > 0:
        message = f'Kassada {_money_str(difference)} so\'m ortiqcha'
    else:
        message = f'Kassada {_money_str(abs(difference))} so\'m kam'
    return jsonify({'status': 'success', 'message': message, 'record': record}), 200


# ============================================================
# 7) HISOBOTLAR — filtrlar + CSV eksport
# ============================================================
def _csv_cell(value):
    """CSV uchun xavfsiz katak (formulaga aylantirilishiga qarshi himoya)."""
    text = str(value if value is not None else '')
    if text[:1] in ('=', '+', '-', '@', '\t', '\r'):
        text = "'" + text
    return '"' + text.replace('"', '""') + '"'


def _boss_report_rows(store, args):
    """Hisobot filtrlarini qo'llab, chek qatorlarini tayyorlaydi."""
    period = normalize_period(args.get('period'))
    rng = custom_period_range(args)
    branch_filter = str(args.get('branchId') or '').strip()
    staff_filter = str(args.get('staffName') or '').strip().lower()
    product_filter = str(args.get('productName') or '').strip().lower()
    cat_filter = str(args.get('cat') or '').strip().lower()
    products_by_id = products_index(store)
    branches = branches_index(store)

    rows = []
    for sale in completed_sales_in_period(store, period, rng):
        if staff_filter and str(sale.get('cashier', '')).strip().lower() != staff_filter:
            continue
        bid = sale_branch(sale, products_by_id)
        if branch_filter and bid != branch_filter:
            continue
        items = [i for i in (sale.get('items') or []) if isinstance(i, dict)]
        filtered = bool(product_filter or cat_filter)
        if filtered:
            matched = []
            for item in items:
                product = products_by_id.get(item.get('id')) or {}
                name = str(item.get('name') or product.get('name') or '').strip().lower()
                cat = str(item.get('cat') or product.get('cat') or '').strip().lower()
                if product_filter and product_filter not in name:
                    continue
                if cat_filter and cat != cat_filter:
                    continue
                matched.append(item)
            if not matched:
                continue
        else:
            matched = items

        if filtered:
            # Filtrlangan qatorda faqat mos mahsulot qatorlari va ularga
            # to'g'ri keladigan chegirma ulushi hisoblanadi (butun chek emas).
            subtotal = sum(_num(i.get('price')) * _num(i.get('qty')) for i in items)
            matched_total = sum(_num(i.get('price')) * _num(i.get('qty')) for i in matched)
            matched_discount = 0.0
            if subtotal > 0:
                matched_discount = _num(sale.get('discAmt')) * (matched_total / subtotal)
            line_profit = sum((_num(i.get('price')) - _num(i.get('cost'))) * _num(i.get('qty'))
                              for i in matched)
            total = max(0.0, matched_total - matched_discount)
            profit = line_profit - matched_discount
        else:
            total = _num(sale.get('total'))
            profit = sale_profit(sale)

        rows.append({
            'saleId': sale.get('id'),
            'date': str(sale.get('date') or ''),
            'time': str(sale.get('time') or ''),
            'staff': str(sale.get('cashier') or ''),
            'branchId': bid,
            'branchName': str((branches.get(bid) or {}).get('name', '') or ''),
            'customer': str(sale.get('customer') or ''),
            'items': sum(_num(i.get('qty')) for i in matched),
            'total': round(total, 2),
            'profit': round(profit, 2),
            'pay': str(sale.get('pay') or ''),
        })
    rows.sort(key=lambda r: (r['date'], str(r['time'])), reverse=True)
    return period, rows


@app.route('/api/boss/reports', methods=['GET'])
@require_staff('boss')
def boss_reports():
    """Boshliq hisobotlari: sana, filial, xodim, mahsulot va kategoriya filtrlari.

    Query: period, branchId, staffName, productName, cat,
           format ('json'|'csv'), limit, offset.
    """
    store = db_manager.get_all() or {}
    period, rows = _boss_report_rows(store, request.args)

    if str(request.args.get('format') or 'json').strip().lower() == 'csv':
        header = ['Chek', 'Sana', 'Vaqt', 'Xodim', 'Filial', 'Mijoz',
                  'Dona', "Savdo (so'm)", "Foyda (so'm)", "To'lov"]
        keys = ('saleId', 'date', 'time', 'staff', 'branchName',
                'customer', 'items', 'total', 'profit', 'pay')
        lines = [','.join(_csv_cell(h) for h in header)]
        lines += [','.join(_csv_cell(r.get(k)) for k in keys) for r in rows]
        stamp = datetime.now().strftime('%Y%m%d-%H%M')
        return app.response_class(
            '\ufeff' + '\n'.join(lines),  # BOM — Excel uchun UTF-8
            mimetype='text/csv; charset=utf-8',
            headers={'Content-Disposition':
                     f'attachment; filename="boss-report-{stamp}.csv"'})

    try:
        limit = max(1, min(1000, int(request.args.get('limit') or 100)))
        offset = max(0, int(request.args.get('offset') or 0))
    except (TypeError, ValueError):
        limit, offset = 100, 0

    return jsonify({
        'status': 'success',
        'period': period,
        'total': len(rows),
        'offset': offset,
        'limit': limit,
        'summary': {
            'revenue': round(sum(r['total'] for r in rows), 2),
            'profit': round(sum(r['profit'] for r in rows), 2),
            'units': round(sum(r['items'] for r in rows), 2),
            'orders': len(rows),
        },
        'rows': rows[offset:offset + limit],
    })


# ============================================================
# 8) AUDIT LOG — Boshliq amalari jurnali
# ============================================================
@app.route('/api/boss/audit', methods=['GET'])
@require_staff('boss')
def boss_audit():
    """Boshliq amallar jurnali — `audit_log` + `serverSecurityLog` birlashtirilgan.

    `audit_log` — Boshliqning muhim amallari (xodim CRUD, parol);
    `serverSecurityLog` — butun tizimdagi xavfsizlik hodisalari (login,
    kirish urinishlari, ruxsat tekshiruvlari). Parol/token hech qachon
    yozilmaydi. Query: q (qidiruv), source ('audit'|'security'|''), limit.
    """
    store = db_manager.get_all() or {}
    audit_events = store.get('audit_log')
    audit_events = audit_events if isinstance(audit_events, list) else []
    security_events = store.get('serverSecurityLog')
    security_events = security_events if isinstance(security_events, list) else []

    # Yagona shaklga keltirish (kim, qachon, modul, nima, holat).
    events = []
    for e in audit_events:
        if isinstance(e, dict):
            events.append({
                'time': str(e.get('time') or ''),
                'actor': str(e.get('actor') or '')[:120],
                'action': str(e.get('action') or '')[:60],
                'target': str(e.get('target') or '')[:120],
                'detail': str(e.get('detail') or '')[:240],
                'module': 'Boshliq',
                'level': 'info',
                'source': 'audit',
                'ip': str(e.get('ip') or '')[:60],
            })
    for e in security_events:
        if isinstance(e, dict):
            events.append({
                'time': str(e.get('time') or ''),
                'actor': str(e.get('user') or '')[:120],
                'action': str(e.get('type') or '')[:60],
                'target': '',
                'detail': str(e.get('message') or '')[:240],
                'module': _security_module_label(str(e.get('type') or '')),
                'level': str(e.get('level') or 'low')[:20],
                'source': 'security',
                'ip': str(e.get('ip') or '')[:60],
            })

    events.sort(reverse=True, key=lambda r: (r['time'] or '', r['ip'] or ''))

    query = str(request.args.get('q') or '').strip().lower()
    source = str(request.args.get('source') or '').strip().lower()
    if source in ('audit', 'security'):
        events = [e for e in events if e['source'] == source]
    if query:
        events = [e for e in events if query in (
            f"{e['actor']} {e['action']} {e['target']} {e['detail']} {e['module']}").lower()]

    try:
        limit = max(1, min(400, int(request.args.get('limit') or 150)))
    except (TypeError, ValueError):
        limit = 150

    return jsonify({'status': 'success', 'total': len(events),
                    'sources': {'audit': len(audit_events), 'security': len(security_events)},
                    'events': events[:limit]})


def _security_module_label(event_type):
    """Xavfsizlik hodisasi turidan modul nomini chiqaradi."""
    text = str(event_type or '')
    if 'login' in text or 'logout' in text or 'password' in text or 'session' in text:
        return 'Autentifikatsiya'
    if 'access' in text or 'denied' in text or 'required' in text:
        return 'Ruxsat'
    if 'sync' in text or 'data' in text:
        return 'Sinxronizatsiya'
    if 'fiscal' in text:
        return 'Fiskal chek'
    if 'payment' in text or 'pay' in text:
        return "To'lovlar"
    if 'captcha' in text:
        return 'Himoya (CAPTCHA)'
    if 'rate' in text:
        return 'Himoya (rate-limit)'
    return 'Xavfsizlik'


# ============================================================
# 9) BOSHLIQ — O'Z PAROLINI O'ZgartIRISH
# ============================================================
# Eski `/api/auth/change-password` endpoint'i Boshliq uchun ham ishlaydi,
# lekin bu — aniq "o'z parolim" oqimi: jihat yo'q, eski parol talab qilinadi.
@app.route('/api/boss/password', methods=['POST'])
@require_staff('boss')
def boss_change_password():
    """Boshliq o'z parolini o'zgartiradi (eski parol talab qilinadi)."""
    body = request.get_json(silent=True) or {}
    payload = getattr(request, 'staff', {}) or {}
    login = str(payload.get('sub', '')).strip()

    current = str(body.get('currentPassword') or '')[:200]
    new_password, error = _validate_password(body.get('newPassword'))
    if error:
        return json_error(error)
    confirm = str(body.get('confirmPassword') or '')[:200]
    if confirm and confirm != new_password:
        return json_error('Parollar mos kelmadi')
    if new_password == current:
        return json_error('Yangi parol joriy parol bilan bir xil bo\'lmasligi kerak')

    staff = load_staff()
    target = next((u for u in staff
                   if isinstance(u, dict)
                   and str(u.get('login', '')).lower() == login.lower()), None)
    if not target:
        return json_error('Akount topilmadi', 404)
    if not verify_password(current, str(target.get('salt', '')), target.get('passHash', '')):
        server_security_log('password-change-failed', 'medium',
                            'Joriy parol xato', payload.get('name', '—'))
        return json_error('Joriy parol xato', 401)

    # Parol: xesh + shifrlangan nusxa (boshliq panelida ko'rish uchun)
    apply_staff_password(target, new_password, "Boshliq (o'zi)")
    try:
        db_manager.save_keys({'staff_users': staff})
    except Exception:
        return json_error('Parolni saqlab bo\'lmadi', 500)

    # JURNALGA PAROL YOZILMAYDI — faqat amal nomi.
    audit_log('password-change-own', str(target.get('name', '')),
              'o\'z parolini yangiladi', _actor_name())
    server_security_log('password-changed', 'medium', 'Boshliq paroli yangilandi',
                        payload.get('name', '—'))
    # Parol o'zgargani uchun eski sessiyalar yopiladi.
    revoke_login_sessions(login)
    return jsonify({'status': 'success',
                    'message': 'Parolingiz yangilandi. Qayta kiring.'})


@app.route('/api/health', methods=['GET'])
def api_health():
    """Cloudflare uptime monitoring / health check uchun yengil javob.

    Hech qanday maxfiy ma'lumot qaytarmaydi — faqat holat bayroqlari.
    """
    db_ok = True
    try:
        db_manager.get_all()
    except Exception:
        db_ok = False
    return jsonify({
        'status': 'ok' if db_ok else 'degraded',
        'database': 'ok' if db_ok else 'error',
        'siteDomain': SITE_DOMAIN or '',
        'cloudflare': is_via_cloudflare(),
        'https': request_is_https(),
        'captcha': 'enforced' if (CF_TURNSTILE_ENABLED and CF_TURNSTILE_ENFORCE)
                   else ('optional' if CF_TURNSTILE_ENABLED else 'off'),
    })


# ── Statik fayllar: QAT'IY oq ro'yxat ─────────────────────────────────
# MUHIM (xavfsizlik): ilgari bu yerda `send_from_directory('.', path)`
# turgan edi — natijada loyiha ILDIZIDAGI har qanday fayl tashqi tarmoqqa
# chiqar edi: `.env` (barcha maxfiy kalitlar: to'lov, S3, CF_API_TOKEN,
# boshliq paroli), `.git/` (butun tarix va eski kalitlar), `app.py`,
# `fiscal.py`, `Data/database.db` (butun baza) va h.k.
# Endi faqat sayt ishlashi uchun ZARUR bo'lgan fayllar beriladi.
STATIC_FILES = frozenset({
    'index.html', 'style.css', 'boss.css', 'scripts.js', 'boss.js',
    'tour.js', 'qrcode.min.js', 'favicon.png',
})
STATIC_ASSET_DIRS = frozenset({'assets'})


@app.route('/<path:path>')
def serve_static(path):
    """Sayt statik fayllari (faqat oq ro'yxat bo'yicha).

    Boshqa har qanday yo'l — 404. Ikki qatlamli himoya:
      1) nuqta bilan boshlanadigan yoki `..` segment — rad etiladi
         (`.env`, `.git`, `.freebuff`, `.gitignore`);
      2) fayl nomi oq ro'yxatda yoki `assets/` papkasida bo'lishi shart.
    """
    clean = str(path or '').replace('\\', '/').strip('/')
    # API yo'llari statik fayl EMAS. Faqat POST'da mavjud endpointga GET
    # kelsa — 405 (Method Not Allowed) qaytishi kerak, ilgari esa catch-all
    # marshrut adashtirib HTML 404 berardi (chalg'ituvchi).
    if clean == 'api' or clean.startswith('api/'):
        target = '/' + clean
        # Yo'l boshqa metodda mavjudmi? (Werkzeug'ning rasmiy adapteri
        # konvertorlarni ham to'g'ri hisobga oladi.)
        bound = app.url_map.bind(request.host)
        for method in ('POST', 'PUT', 'DELETE', 'PATCH'):
            try:
                bound.match(target, method=method)
            except Exception:
                continue
            abort(405)
        abort(404)
    segments = [s for s in clean.split('/') if s not in ('', '.')]
    if not segments or any(s == '..' or s.startswith('.') for s in segments):
        abort(404)
    if len(segments) == 1 and segments[0] in STATIC_FILES:
        return send_from_directory('.', segments[0])
    if len(segments) == 2 and segments[0] in STATIC_ASSET_DIRS:
        return send_from_directory(segments[0], segments[1])
    abort(404)

@app.route('/api/config', methods=['GET'])
def get_config():
    """Frontend uchun xavfsiz (maxfiy bo'lmagan) konfiguratsiya."""
    return jsonify({
        # Click: faqat OCHIQ identifikatorlar (maxfiy kalit YO'Q)
        'clickMerchantId': os.getenv('CLICK_MERCHANT_ID', ''),
        'clickServiceId': os.getenv('CLICK_SERVICE_ID', ''),
        'clickMerchantUserId': os.getenv('CLICK_MERCHANT_USER_ID', ''),
        'clickPhone': os.getenv('CLICK_PHONE', ''),
        # Payme: kassa identifikatori ochiq, kalit maxfiy
        'paymeMerchantId': os.getenv('PAYME_MERCHANT_ID', ''),
        'defaultPaymentProvider': os.getenv('DEFAULT_PAYMENT_PROVIDER', 'cash'),
        'warrantyMonths': os.getenv('CONTRACT_WARRANTY_MONTHS', '12'),
        # Cloudflare Turnstile (CAPTCHA): ochiq sayt kaliti + majburiylik holati
        'turnstileSiteKey': CF_TURNSTILE_SITE_KEY,
        'turnstileEnabled': CF_TURNSTILE_ENABLED and bool(CF_TURNSTILE_SITE_KEY),
        'turnstileEnforced': CF_TURNSTILE_ENFORCE,
        'cloudflareProxy': TRUST_CLOUDFLARE,
        # Fiskal chek (QR-kodli): provider va sozlanganlik holati
        'fiscal': fiscal_state(),
    })

# Ommaviy (anonim) do'kon uchun ruxsat etilgan maydonlar — mijoz PII'si YO'Q
CATALOG_FIELDS = ('id', 'name', 'cat', 'price', 'stock', 'img', 'desc')
PUBLIC_DATA_KEYS = ('products', 'categories')
PRIVATE_DATA_KEYS = ('auth_secret', 'staff_users', 'staffSalaryHistory',
                     'active_sessions', 'serverSecurityLog', 'audit_log')

# Rol bo'yicha o'qish doirasi. Admin/boss to'liq (maxfiy kalitlarsiz) oladi;
# kassir/menejer faqat operatsion ma'lumotlarni oladi. Ish haqi, moliya,
# shartnomalar, xavfsizlik jurnallari va SMS tarixi ularga chiqmaydi.
DATA_SCOPE_BY_ROLE = {
    'cashier': {'products', 'customers', 'sales', 'branches', 'categories',
                'discounts', 'settings'},
    'manager': {'products', 'customers', 'sales', 'contracts', 'branches',
                'categories', 'discounts', 'cashFlow', 'expenses', 'settings'},
}

# Sinxronizatsiyada qabul qilinadigan kalitlar va ularning chegaralari
SYNC_ALLOWED_KEYS = {
    'products': 4000, 'customers': 20000, 'sales': 50000, 'logs': 500,
    'contracts': 20000, 'discounts': 500, 'smsHistory': 500,
    'securityLog': 1000,
    'branches': 500, 'employees': 2000,
    # DIQQAT: 'salaryRecords' va 'salaryHistory' ataylab yo'q —
    # oylik to'lovlarining YAGONA manbasi /api/boss/salary/* endpointlari
    # (backend) hisoblanadi. Frontend endi ularni to'g'ridan-to'g'ri
    # sinxronlay olmaydi (noma'lum kalit sifatida e'tiborsiz qoldiriladi).
    # Kirim / chiqim / harajat yozuvlari (filial bo'yicha moliyaviy nazorat)
    'cashFlow': 20000, 'expenses': 20000,
}
IMAGE_DATA_LIMIT = 900 * 1024          # bitta rasm (base64) uchun chegara
MAX_IMAGE_ITEMS = 400                  # bazada saqlanadigan rasm soni
ALLOWED_IMAGE_PREFIXES = ('data:image/jpeg;base64,', 'data:image/png;base64,',
                          'data:image/webp;base64,', 'data:image/gif;base64,')


def json_error(message, code=400, status='error'):
    """Ichki ma'lumot ochilmaydigan xato javobi."""
    return jsonify({'status': status, 'message': message}), code


def client_data_snapshot(role=''):
    """Brauzerga beriladigan baza nusxasi: rolga qarab filtrlanadi.

    Admin/boss — maxfiy server kalitlaridan tashqari to'liq baza.
    Kassir/menejer — faqat o'z ishiga kerakli operatsion kalitlar.
    """
    data = db_manager.get_all() or {}
    role_key = canonical_role(role)
    if role_key in ('boss', 'admin'):
        return {k: v for k, v in data.items() if k not in PRIVATE_DATA_KEYS}
    allowed = DATA_SCOPE_BY_ROLE.get(role_key, set())
    return {k: v for k, v in data.items()
            if k not in PRIVATE_DATA_KEYS and k in allowed}


def _contains_non_finite(value, depth=0):
    """JSON standartiga zid sonlarni (NaN / Infinity / -Infinity) topadi.

    Python'ning json moduli ularni qabul qiladi, lekin brauzerdagi
    `JSON.parse()` bunday javobni RAD ETADI — natijada /api/data ishlamay
    qolib butun ilova ko'rinmas holga tushardi. Shu sababli bunday qiymat
    bazaga umuman kirmasligi kerak.
    """
    if depth > 12:
        return False
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(_contains_non_finite(v, depth + 1) for v in value.values())
    if isinstance(value, (list, tuple, set)):
        return any(_contains_non_finite(v, depth + 1) for v in value)
    return False


# Savdo yozuvlaridagi son maydonlar va ularning eng kichik qiymati.
# `None` — manfiy qiymat ruxsat etiladi (masalan, foyda zarar bo'lishi mumkin).
SALE_NUMBER_FIELDS = (
    ('total', 0), ('subtotal', 0), ('subTotal', 0), ('discAmt', 0),
    ('discount', 0), ('paid', 0), ('debt', 0), ('profit', None), ('change', None),
)
SALE_ITEM_NUMBER_FIELDS = (
    ('price', 0), ('qty', 0), ('cost', 0), ('discount', None),
)
SALE_TEXT_FIELDS = (
    ('date', 32), ('time', 32), ('cashier', 120), ('cashierLogin', 80),
    ('cashierId', 40), ('staffId', 40),
    ('pay', 30), ('provider', 30),
    ('status', 30), ('customerId', 40), ('branchId', 40), ('orderId', 80),
    ('clickTransId', 40), ('clickPrepareId', 40), ('clickPaydocId', 40),
)


def _validate_sale_numbers(sale):
    """Savdo yozuvining son maydonlarini tekshiradi (xato matni yoki '')."""
    for field, minimum in SALE_NUMBER_FIELDS:
        if field not in sale:
            continue
        value = sale.get(field)
        if value is None or value == '':
            continue
        if isinstance(value, bool):
            return f'Savdo {field} maydoni son bo\'lishi kerak'
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return f'Savdo {field} maydoni son bo\'lishi kerak'
        if not math.isfinite(number):
            return f'Savdo {field} qiymati noto\'g\'ri (NaN/Infinity)'
        if minimum is not None and number < minimum:
            return f'Savdo {field} manfiy bo\'lishi mumkin emas'
        # Son bo'lib kelgan bo'lsa turini saqlaymiz (int → int)
        sale[field] = value if isinstance(value, (int, float)) else number

    items = sale.get('items')
    if items is None:
        return ''
    if not isinstance(items, list):
        return 'Savdo mahsulotlari ro\'yxat bo\'lishi kerak'
    if len(items) > 500:
        return 'Savdodagi mahsulotlar soni juda ko\'p'
    for item in items:
        if not isinstance(item, dict):
            return 'Savdo elementi obyekt bo\'lishi kerak'
        for field, minimum in SALE_ITEM_NUMBER_FIELDS:
            if field not in item:
                continue
            value = item.get(field)
            if value is None or value == '':
                continue
            if isinstance(value, bool):
                return f'Savdo elementi {field} son bo\'lishi kerak'
            try:
                number = float(value)
            except (TypeError, ValueError, OverflowError):
                return f'Savdo elementi {field} son bo\'lishi kerak'
            if not math.isfinite(number):
                return f'Savdo elementi {field} qiymati noto\'g\'ri (NaN/Infinity)'
            if minimum is not None and number < minimum:
                return f'Savdo elementi {field} manfiy bo\'lishi mumkin emas'
            item[field] = value if isinstance(value, (int, float)) else number
        for field in ('name', 'cat'):
            if field in item and item[field] is not None:
                item[field] = str(item[field])[:120]

    sale_id = sale.get('id')
    if sale_id is not None and sale_id != '':
        try:
            sale['id'] = int(float(sale_id))
        except (TypeError, ValueError, OverflowError):
            return 'Savdo ID qiymati noto\'g\'ri'
    for field, limit in SALE_TEXT_FIELDS:
        if field in sale and sale[field] is not None:
            sale[field] = str(sale[field])[:limit]
    return ''


def validate_sync_payload(payload):
    """Kelgan ma'lumotni serverda tekshiradi (type/length/range/format)."""
    if not isinstance(payload, dict):
        return False, 'Ma\'lumot formati noto\'g\'ri', None

    clean = {}
    for key, value in payload.items():
        if key == 'settings':
            if not isinstance(value, dict):
                return False, 'settings obyekt bo\'lishi kerak', None
            clean['settings'] = {str(k)[:60]: v for k, v in list(value.items())[:80]}
            continue
        if key == 'categories':
            if not isinstance(value, list):
                return False, 'categories ro\'yxat bo\'lishi kerak', None
            clean['categories'] = [str(c)[:60] for c in value[:100] if str(c).strip()]
            continue
        if key not in SYNC_ALLOWED_KEYS:
            # Noma'lum kalitlar e'tiborsiz qoldiriladi (least privilege)
            continue
        if not isinstance(value, list):
            return False, f'{key} ro\'yxat bo\'lishi kerak', None
        if len(value) > SYNC_ALLOWED_KEYS[key]:
            return False, f'{key} uchun yozuvlar soni juda ko\'p', None
        if not all(isinstance(item, dict) for item in value):
            return False, f'{key} elementlari obyekt bo\'lishi kerak', None
        clean[key] = value

    def product_number(product, field, default, minimum, integer=False):
        raw = product.get(field, default)
        if isinstance(raw, bool):
            raise ValueError(f'Mahsulot {field} son bo\'lishi kerak')
        try:
            number = float(raw)
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f'Mahsulot {field} son bo\'lishi kerak')
        if not math.isfinite(number) or number < minimum:
            raise ValueError(f'Mahsulot {field} qiymati noto\'g\'ri')
        if integer:
            if not number.is_integer():
                raise ValueError(f'Mahsulot {field} butun son bo\'lishi kerak')
            return int(number)
        return number

    product_ids = set()
    for product in clean.get('products', []):
        try:
            product['id'] = product_number(
                product, 'id', None, 1, integer=True)
            if product['id'] > 9007199254740991:
                raise ValueError('Mahsulot ID qiymati noto\'g\'ri')
            product['price'] = product_number(product, 'price', 0, 1)
            product['cost'] = product_number(product, 'cost', 0, 0)
            product['stock'] = product_number(
                product, 'stock', 0, 0, integer=True)
            product['markup'] = product_number(product, 'markup', 0, 0)
        except ValueError as error:
            return False, str(error), None

        if product['id'] in product_ids:
            return False, 'Mahsulot ID takrorlangan', None
        product_ids.add(product['id'])

        name = product.get('name')
        category = product.get('cat')
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            return False, 'Mahsulot nomi 1–120 belgi bo\'lishi kerak', None
        if not isinstance(category, str) or not category.strip() or len(category) > 80:
            return False, 'Mahsulot kategoriyasi 1–80 belgi bo\'lishi kerak', None
        product['name'] = name.strip()
        product['cat'] = category.strip()

        branch_id = product.get('branchId', '')
        if isinstance(branch_id, bool) or not isinstance(branch_id, (str, int)):
            return False, 'Mahsulot filiali noto\'g\'ri', None
        product['branchId'] = str(branch_id).strip()[:40]

    # Mahsulot rasmlari: faqat rasm data-URL yoki http(s) manzil
    images = 0
    for product in clean.get('products', []):
        img = product.get('img')
        if not img:
            continue
        img = str(img)[:IMAGE_DATA_LIMIT + 1000]
        if img.startswith('data:'):
            if not img.startswith(ALLOWED_IMAGE_PREFIXES):
                return False, 'Rasm formati ruxsat etilmagan (faqat jpeg/png/webp/gif)', None
            if len(img) > IMAGE_DATA_LIMIT:
                return False, 'Rasm hajmi juda katta (900 KB dan oshmasin)', None
            images += 1
        elif not (img.startswith('http://') or img.startswith('https://') or img.startswith('/uploads/')):
            return False, 'Rasm manzili xavfsiz formatda emas', None
        product['img'] = img
    if images > MAX_IMAGE_ITEMS:
        return False, 'Bazadagi rasm soni chegaradan oshib ketdi', None

    # Mahsulotning soliq maydonlari: IKPU (MXIK) 17 xonali, qadoq kodi, QQS stavkasi
    for product in clean.get('products', []):
        raw_ikpu = str(product.get('ikpu') or '').strip()
        ikpu = re.sub(r'\D', '', raw_ikpu)
        if ikpu and (len(ikpu) != 17 or len(ikpu) != len(raw_ikpu)):
            return False, 'IKPU (MXIK) kodi 17 xonali bo\'lishi kerak', None
        product['ikpu'] = ikpu
        product['packageCode'] = re.sub(r'[^A-Za-z0-9]', '', str(product.get('packageCode') or ''))[:20]
        try:
            vat = product_number(product, 'vatPercent', 12, 0)
        except (TypeError, ValueError):
            return False, 'Mahsulot QQS stavkasi son bo\'lishi kerak', None
        if vat > 100:
            return False, 'Mahsulot QQS stavkasi 0–100 oralig\'ida bo\'lishi kerak', None
        product['vatPercent'] = vat
        product['mtype'] = 'sum' if product.get('mtype') == 'sum' else 'pct'

    # ── Savdo yozuvlari (moliyaviy iz) ────────────────────────────────────
    # DIQQAT: ilgari `sales` UMUMAN tekshirilmasdi — shu sababli `NaN`
    # qiymati bazaga tushib, /api/data javobini JSON standartiga zid qilib
    # qo'yardi va brauzerda `JSON.parse()` yiqilardi (butun ilova ishlamasdi).
    for sale in clean.get('sales', []):
        if not isinstance(sale, dict):
            return False, 'Savdo yozuvi obyekt bo\'lishi kerak', None
        error = _validate_sale_numbers(sale)
        if error:
            return False, error, None
        # Fiskal maydonlar FAQAT server tomonidan yoziladi — brauzer ularni
        # yuborsa ham qabul qilinmaydi (soxta fiskal belgi yasab bo'lmasin).
        for field in ('fiscalStatus', 'fiscalProvider', 'fiscalUrl', 'fiscalSign',
                      'fiscalNumber', 'fiscalDeviceId', 'fiscalTime', 'fiscalTotal',
                      'fiscalError'):
            sale.pop(field, None)

    # Chuqur himoya: butun payload'da NaN/Infinity qolmaganiga ishonch hosil
    # qilamiz (noma'lum/nested maydonlar ham qamrab olinadi).
    if _contains_non_finite(clean):
        return False, "Ma'lumotda NaN/Infinity qiymati bor (ruxsat etilmaydi)", None

    return True, '', clean


def company_info():
    """Chek sarlavhasi uchun kompaniya ma'lumotlari (Sozlamalar → Kompaniya)."""
    settings = {}
    try:
        settings = (db_manager.get_all() or {}).get('settings') or {}
    except Exception:
        try:
            settings = (load_store() or {}).get('settings') or {}
        except Exception:
            settings = {}
    if not isinstance(settings, dict):
        settings = {}
    return {
        'name': str(settings.get('companyName') or '').strip()[:120],
        'phone': str(settings.get('companyPhone') or '').strip()[:40],
        'address': str(settings.get('companyAddress') or '').strip()[:200],
        'tin': str(settings.get('companyTin') or settings.get('companyInn') or '').strip()[:20],
    }


def fiscal_state():
    """Fiskal modul holati (maxfiy kalitlar ko'rsatilmaydi)."""
    if fiscal_service is None:
        return {'provider': 'unavailable', 'configured': False, 'required': True,
                'message': 'fiscal.py moduli topilmadi'}
    state = fiscal_service.fiscal_config_state()
    company = company_info()
    state['companyConfigured'] = bool(company.get('name') and company.get('tin'))
    return state


def fiscalize_sale(sale, staff_name='—', source='client'):
    """Savdo uchun fiskal chek yaratadi va natijani bazaga yozadi.

    DIQQAT: bu funksiya FAQAT `status == 'paid'` (to'lov tasdiqlangan)
    savdo uchun chaqiriladi. Tasdiqlanmagan savdoni bu yerga berib
    bo'lmaydi — tekshiruv chaqiruvchi tomonda ham, endpointda ham bor.
    """
    if fiscal_service is None:
        return {'ok': False, 'fiscalStatus': 'not_configured',
                'fiscalError': 'Fiskal modul (fiscal.py) yuklanmagan'}
    if not isinstance(sale, dict):
        return {'ok': False, 'fiscalStatus': 'failed', 'fiscalError': 'Savdo topilmadi'}
    if str(sale.get('status') or '') != 'paid':
        # Qoida: tasdiqlanmagan to'lov uchun chek chiqarilmaydi
        return {'ok': False, 'fiscalStatus': 'payment_not_confirmed',
                'fiscalError': 'To\'lov tasdiqlanmaguncha fiskal chek chiqarilmaydi'}

    result = fiscal_service.fiscalize(sale, company_info())
    fields = {
        'fiscalStatus': result.get('fiscalStatus'),
        'fiscalProvider': result.get('fiscalProvider'),
        'fiscalUrl': result.get('fiscalUrl', ''),
        'fiscalSign': result.get('fiscalSign', ''),
        'fiscalNumber': result.get('fiscalNumber', ''),
        'fiscalDeviceId': result.get('fiscalDeviceId', ''),
        'fiscalTime': result.get('fiscalTime', ''),
        'fiscalTotal': result.get('fiscalTotal', 0),
        'fiscalError': str(result.get('fiscalError') or '')[:300],
    }
    update_server_sale(sale.get('id'), **fields)
    level = 'low' if result.get('ok') else 'high'
    server_security_log(
        'fiscal-receipt' if result.get('ok') else 'fiscal-failed', level,
        (f"Fiskal chek #{sale.get('id')} tayyor ({result.get('fiscalNumber')})" if result.get('ok')
         else f"Fiskal chek #{sale.get('id')} chiqmadi: {fields['fiscalError']}"),
        staff_name)
    return result


def apply_image_keep(products):
    """`imgKeep: true` belgisi bo'lgan mahsulotlarga bazadagi rasmni qaytaradi.

    Og'ir base64 rasm har sinxronizatsiyada qayta yuborilmasligi uchun brauzer
    rasmni bir marta yuboradi, keyingi safar faqat `imgKeep` belgisini jo'natadi.
    Rasm faqat serverda saqlangan nusxadan olinadi (qayta tekshirish shart emas,
    chunki u avval shu funksiya orqali saqlangan).
    """
    try:
        stored = (db_manager.get_all() or {}).get('products') or []
    except Exception:
        stored = []
    known = {}
    for item in stored:
        if isinstance(item, dict):
            known[str(item.get('id'))] = item.get('img', '')
    for product in products:
        if product.pop('imgKeep', False):
            product['img'] = known.get(str(product.get('id')), '')


def apply_fiscal_keep(sales):
    """Bazadagi fiskal chek maydonlarini saqlab qoladi.

    Brauzer savdo ro'yxatini sinxronlaganda fiskal maydonlar yuborilmaydi.
    Agar ularni bazada saqlangan nusxadan tiklamasak, chek ma'lumotlari
    (QR havola, fiskal belgi) o'chib ketardi.
    """
    try:
        stored = (db_manager.get_all() or {}).get('sales') or []
    except Exception:
        stored = []
    fields = ('fiscalStatus', 'fiscalProvider', 'fiscalUrl', 'fiscalSign',
              'fiscalNumber', 'fiscalDeviceId', 'fiscalTime', 'fiscalTotal',
              'fiscalError')
    known = {}
    for item in stored:
        if isinstance(item, dict):
            known[str(item.get('id'))] = {f: item.get(f) for f in fields if item.get(f) not in (None, '')}
    for sale in sales:
        saved = known.get(str(sale.get('id')))
        if not saved:
            continue
        for field, value in saved.items():
            sale[field] = value


def find_sale(sale_id):
    """Bazadan savdoni ID bo'yicha topadi."""
    try:
        sid = int(sale_id)
    except (TypeError, ValueError):
        return None
    for item in (db_manager.get_all() or {}).get('sales') or []:
        if isinstance(item, dict) and str(item.get('id')) == str(sid):
            return item
    return None


@app.route('/api/fiscal/status', methods=['GET'])
@require_staff()
def fiscal_status():
    """Fiskal chek holati (provider, sozlangan-sozlanmagan, kompaniya)."""
    state = fiscal_state()
    company = company_info()
    state['companyName'] = company.get('name', '')
    state['companyTin'] = company.get('tin', '')
    return jsonify({'status': 'success', 'fiscal': state})


@app.route('/api/fiscal/receipt', methods=['POST'])
@require_staff()
def fiscal_receipt():
    """To'lov tasdiqlangandan KEYIN fiskal chek (QR-kodli) yaratadi.

    Qat'iy qoida: `status != 'paid'` bo'lgan savdo uchun chek chiqmaydi.
    Chekni faqat server yaratadi — brauzer fiskal belgini yasay olmaydi.
    """
    payload = request.get_json(silent=True) or {}
    sale = find_sale(payload.get('saleId'))
    if not sale:
        return json_error('Savdo topilmadi', 404)
    if str(sale.get('status') or '') != 'paid':
        server_security_log('fiscal-blocked', 'medium',
                            f"Tasdiqlanmagan savdo #{sale.get('id')} uchun chek so'raldi",
                            request.staff.get('name', '—'))  # type: ignore[attr-defined]
        return json_error('To\'lov tasdiqlanmagan — chek chiqarilmaydi', 409,
                          status='payment_not_confirmed')

    # Allaqachon chek chiqarilgan bo'lsa qayta urinmaymiz (dublikat chek bo'lmasin)
    if sale.get('fiscalSign') and sale.get('fiscalUrl') and not payload.get('force'):
        return jsonify({'status': 'success', 'message': 'Chek avval chiqarilgan',
                        'saleId': sale.get('id'), 'fiscal': {k: sale.get(k) for k in (
                            'fiscalStatus', 'fiscalProvider', 'fiscalUrl', 'fiscalSign',
                            'fiscalNumber', 'fiscalDeviceId', 'fiscalTime', 'fiscalTotal')}})

    result = fiscalize_sale(sale, request.staff.get('name', '—'), source='kassa')  # type: ignore[attr-defined]
    code = 200 if result.get('ok') else 502
    return jsonify({'status': 'success' if result.get('ok') else 'error',
                    'saleId': sale.get('id'),
                    'message': 'Fiskal chek tayyor' if result.get('ok') else result.get('fiscalError'),
                    'fiscal': {k: result.get(k) for k in (
                        'ok', 'fiscalStatus', 'fiscalProvider', 'fiscalUrl', 'fiscalSign',
                        'fiscalNumber', 'fiscalDeviceId', 'fiscalTime', 'fiscalTotal', 'fiscalError')}}), code


@app.route('/api/fiscal/receipt/<int:sale_id>', methods=['GET'])
@require_staff()
def fiscal_receipt_get(sale_id):
    """Saqlangan fiskal chek ma'lumotlari (QR havola va belgi)."""
    sale = find_sale(sale_id)
    if not sale:
        return json_error('Savdo topilmadi', 404)
    return jsonify({'status': 'success', 'saleId': sale_id,
                    'paid': str(sale.get('status') or '') == 'paid',
                    'fiscal': {k: sale.get(k) for k in (
                        'fiscalStatus', 'fiscalProvider', 'fiscalUrl', 'fiscalSign',
                        'fiscalNumber', 'fiscalDeviceId', 'fiscalTime', 'fiscalTotal',
                        'fiscalError')}})


@app.route('/api/fiscal/pending', methods=['GET'])
@require_staff('admin')
def fiscal_pending():
    """To'langan, lekin fiskal cheki chiqarilmagan savdolar ro'yxati."""
    items = []
    for sale in (db_manager.get_all() or {}).get('sales') or []:
        if not isinstance(sale, dict):
            continue
        if str(sale.get('status') or '') != 'paid':
            continue
        if sale.get('fiscalSign') and sale.get('fiscalUrl'):
            continue
        items.append({'id': sale.get('id'), 'total': sale.get('total'),
                      'date': sale.get('date') or sale.get('createdAt'),
                      'cashier': sale.get('cashier'), 'provider': sale.get('paymentProvider'),
                      'fiscalStatus': sale.get('fiscalStatus'), 'fiscalError': sale.get('fiscalError')})
    return jsonify({'status': 'success', 'count': len(items), 'sales': items[-100:]})


@app.route('/api/fiscal/pending/run', methods=['POST'])
@require_staff('admin')
def fiscal_pending_run():
    """To'langan savdolarga chek chiqarib beradi (qo'lda ishga tushiriladi)."""
    limit = 25
    done, failed = 0, 0
    for sale in (db_manager.get_all() or {}).get('sales') or []:
        if done + failed >= limit:
            break
        if not isinstance(sale, dict) or str(sale.get('status') or '') != 'paid':
            continue
        if sale.get('fiscalSign') and sale.get('fiscalUrl'):
            continue
        result = fiscalize_sale(sale, request.staff.get('name', '—'), source='bulk')  # type: ignore[attr-defined]
        if result.get('ok'):
            done += 1
        else:
            failed += 1
    return jsonify({'status': 'success', 'issued': done, 'failed': failed})


@app.route('/api/catalog', methods=['GET'])
def get_catalog():
    """Ommaviy katalog: faqat mahsulot va kategoriyalar (PII yo'q)."""
    try:
        data = db_manager.get_all() or {}
        products = []
        for item in (data.get('products') or []):
            if not isinstance(item, dict):
                continue
            products.append({k: item.get(k) for k in CATALOG_FIELDS if k in item})
        return jsonify({'products': products, 'categories': data.get('categories') or []})
    except Exception as e:
        print(f'[ERROR] /api/catalog: {e}')
        return json_error('Katalogni olishda xatolik', 500)


# ============================================================
# FILIALLAR (branches)
# Filial ma'lumotlari bazada 'branches' kaliti ostida saqlanadi.
# ============================================================
BRANCHES_KEY = 'branches'

# Ommaviy filial maydonlari (mijoz ko'radi — PII yo'q)
BRANCH_PUBLIC_FIELDS = ('id', 'name', 'code', 'city', 'address', 'phone', 'hours',
                        'lat', 'lng', 'markerIcon', 'markerColor', 'status', 'isMain')


def _safe_color(value, fallback='#ff6b35'):
    """Faqat hex rang qabul qilinadi (CSS/JS injection oldini oladi)."""
    raw = re.sub(r'[^#0-9A-Fa-f]', '', str(value or ''))
    if len(raw) == 7 and raw.startswith('#'):
        return raw.lower()
    if len(raw) == 6:
        return '#' + raw.lower()
    return fallback


def public_branches():
    """Filiallarni brauzerga xavfsiz ko'rinishda qaytaradi.

    MUHIM: koordinata (lat/lng) MAJBURIY EMAS. Ilgari koordinatasi yo'q
    filiallar ro'yxatdan tushib qolardi — natijada admin panelda qo'lda
    qo'shilgan filial (lat/lng kiritilmagan) saqlanmayotgandek ko'rinardi.
    Endi filial har doim qaytariladi, koordinata bo'lmasa `None` bo'ladi.
    """
    try:
        data = db_manager.get_all() or {}
    except Exception:
        data = {}
    result = []
    seen_ids = set()
    for item in (data.get(BRANCHES_KEY) or []):
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or '').strip()[:120]
        bid = str(item.get('id') or '').strip()[:40]
        if not name and not bid:
            continue
        if bid and bid in seen_ids:
            continue
        if bid:
            seen_ids.add(bid)

        lat = lng = None
        try:
            lat_val = float(item.get('lat'))
            lng_val = float(item.get('lng'))
            if -90 <= lat_val <= 90 and -180 <= lng_val <= 180:
                lat, lng = round(lat_val, 6), round(lng_val, 6)
            else:
                lat = lng = None
        except (TypeError, ValueError):
            lat = lng = None

        result.append({
            'id': bid or f'br-{len(result) + 1}',
            'name': name,
            'code': str(item.get('code') or '').strip()[:20],
            'city': str(item.get('city') or '').strip()[:80],
            'address': str(item.get('address') or '').strip()[:200],
            'phone': str(item.get('phone') or '').strip()[:40],
            'hours': str(item.get('hours') or '').strip()[:80],
            'lat': lat,
            'lng': lng,
            'markerIcon': str(item.get('markerIcon') or '🏬')[:8],
            'markerColor': _safe_color(item.get('markerColor')),
            'status': 'inactive' if str(item.get('status')) == 'inactive' else 'active',
            'isMain': bool(item.get('isMain')),
        })
    result.sort(key=lambda b: (not b['isMain'], b['name']))
    return result


@app.route('/api/branches', methods=['GET'])
def get_branches():
    """Filiallar ro'yxati (ochiq — mijoz filiallar bilan tanishadi)."""
    try:
        return jsonify({'status': 'success', 'branches': public_branches()})
    except Exception as e:
        print(f'[ERROR] /api/branches: {e}')
        return json_error('Filiallarni olishda xatolik', 500)


def _num_or_zero(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


@app.route('/api/branches/summary', methods=['GET'])
@require_staff('admin', 'manager')
def branches_summary():
    """Har bir filial bo'yicha real KPI.

    Ko'rsatkichlar: mahsulot soni, zaxira qiymati, savdo (tushum) hamda
    kirim / chiqim / harajat yozuvlari va sof natija. Admin shu jadval
    orqali BARCHA filiallarni bir vaqtda kuzatadi.
    Filiallar moduli faqat admin/menejer uchun — kassir uchun yopiq
    (BOSHLIQ rollar iyerarxiyasi orqali o'tadi).
    """
    data = db_manager.get_all() or {}
    products = [p for p in (data.get('products') or []) if isinstance(p, dict)]
    sales = [s for s in (data.get('sales') or [])
             if isinstance(s, dict) and str(s.get('status') or 'paid') == 'paid']
    flow = [c for c in (data.get('cashFlow') or []) if isinstance(c, dict)]
    legacy_expenses = [c for c in (data.get('expenses') or []) if isinstance(c, dict)]
    # Savdo filiali — butun tizimda qo'llanilgan `sale_branch()` yordamchisi
    # orqali aniqlanadi (chekdagi to'g'ridan-to'g'ri `branchId`, aks holda
    # mahsulotning `branchId` sidi) — boss/grafik endpointlari bilan bir xil.
    products_by_id = products_index(data)
    branches = public_branches()
    out = []
    totals = {'revenue': 0.0, 'income': 0.0, 'expense': 0.0, 'harajat': 0.0, 'profit': 0.0}
    for branch in branches:
        bid = branch['id']
        b_products = [p for p in products if str(p.get('branchId') or '') == bid]
        b_sales = [s for s in sales if sale_branch(s, products_by_id) == bid]
        paid = [s for s in b_sales if str(s.get('status')) == 'paid']
        b_flow = [c for c in flow + legacy_expenses if str(c.get('branchId') or '') == bid]
        revenue = sum(_num_or_zero(s.get('total')) for s in paid)
        income = sum(_num_or_zero(c.get('amount')) for c in b_flow
                     if str(c.get('type')) in ('kirim', 'income'))
        expense = sum(_num_or_zero(c.get('amount')) for c in b_flow
                      if str(c.get('type')) in ('chiqim', 'expense'))
        harajat = sum(_num_or_zero(c.get('amount')) for c in b_flow
                      if str(c.get('type')) == 'harajat')
        profit = revenue + income - expense - harajat
        item = {
            'branchId': bid,
            'name': branch['name'],
            'products': len(b_products),
            'stock': sum(int(_num_or_zero(p.get('stock'))) for p in b_products),
            'stockValue': sum(int(_num_or_zero(p.get('stock'))) * _num_or_zero(p.get('price'))
                              for p in b_products),
            'salesCount': len(paid),
            'revenue': revenue,
            'income': income,
            'expense': expense,
            'harajat': harajat,
            'profit': profit,
        }
        out.append(item)
        for key in totals:
            totals[key] += item[key]
    unassigned = [p for p in products if not str(p.get('branchId') or '')]
    unassigned_flow = [c for c in flow + legacy_expenses
                       if not str(c.get('branchId') or '')]
    return jsonify({'status': 'success', 'branches': out,
                    'totals': totals,
                    'unassignedProducts': len(unassigned),
                    'unassignedCashFlow': len(unassigned_flow),
                    'totalProducts': len(products),
                    'totalBranches': len(branches),
                    'serverTime': datetime.now().strftime('%d.%m.%Y %H:%M:%S')})


def _branch_store_items(store):
    """`branches` kalitidagi ro'yxat (har doim list, elementlar dict)."""
    items = store.get(BRANCHES_KEY)
    if not isinstance(items, list):
        return []
    return [i for i in items if isinstance(i, dict)]


def _find_branch_item(items, bid):
    key = str(bid or '').strip()[:40]
    for item in items:
        if str(item.get('id') or '') == key:
            return item
    return None


def _branch_related_counts(store, bid):
    """Filialga bog'liq ma'lumotlar soni — o'chirishdan oldin yaxlitlik tekshiruvi.

    O'chirish faqat bog'liq yozuv BO'LMAGANDA ruxsat etiladi: mahsulot,
    savdo, kirim/chiqim va xodimlar `branchId` orqali filialga ulangan,
    tarix yo'qolib ketmasligi kerak.
    """
    key = str(bid or '').strip()[:40]
    products = [p for p in (store.get('products') or []) if isinstance(p, dict)]
    sales = [s for s in (store.get('sales') or []) if isinstance(s, dict)]
    flow = [c for c in (store.get('cashFlow') or []) if isinstance(c, dict)]
    legacy = [c for c in (store.get('expenses') or []) if isinstance(c, dict)]
    staff = [u for u in (load_staff() or []) if isinstance(u, dict)]
    return {
        'products': len([p for p in products if str(p.get('branchId') or '') == key]),
        'sales': len([s for s in sales if str(s.get('branchId') or '') == key]),
        'cashFlow': len([c for c in flow + legacy if str(c.get('branchId') or '') == key]),
        'staff': len([u for u in staff if str(u.get('branchId') or '') == key]),
    }


@app.route('/api/branches/<bid>/status', methods=['POST'])
@require_staff('admin', 'manager')
def branch_set_status(bid):
    """Filial holatini yangilash (faol/nofaol) — database'da saqlanadi.

    `{"status": "active"|"inactive"}` yuboriladi. Saqlangandan keyin
    `/api/branches` (yangi sessiya) va KPI summary shu qiymatni ko'rsatadi.
    """
    body = request.get_json(silent=True) or {}
    status = 'inactive' if str(body.get('status') or '') == 'inactive' else 'active'
    store = db_manager.get_all() or {}
    items = _branch_store_items(store)
    target = _find_branch_item(items, bid)
    if target is None:
        return json_error('Filial topilmadi', 404)
    current = 'inactive' if str(target.get('status')) == 'inactive' else 'active'
    if current == status:
        return jsonify({'status': 'success', 'changed': False,
                        'branchId': str(target.get('id') or ''), 'branchStatus': status})
    target['status'] = status
    try:
        db_manager.save_keys({BRANCHES_KEY: items})
    except Exception as e:
        print(f'[ERROR] /api/branches/{bid}/status: {e}')
        return json_error('Holatni saqlashda xatolik', 500)
    server_security_log('branch-status', 'low',
                        f'Filial holati o\'zgardi: {target.get("name")} — {current} → {status}',
                        request.staff.get('name', '—'))  # type: ignore[attr-defined]
    return jsonify({'status': 'success', 'changed': True,
                    'branchId': str(target.get('id') or ''), 'branchStatus': status})


@app.route('/api/branches/<bid>', methods=['DELETE'])
@require_staff('admin', 'manager')
def branch_delete(bid):
    """Filialni bazadan o'chirish (bog'liq ma'lumotlar himoyalangan).

    Savdo/mahsulot/kirim-chiqim/xodim filialga bog'liq bo'lsa —409 va
    sabab bilan rad etiladi (yaxlitlik buzilmaydi). Bog'liq yozuv
    bo'lmasa — filial `branches` ro'yxatidan o'chiriladi va qayd etiladi.
    """
    store = db_manager.get_all() or {}
    items = _branch_store_items(store)
    target = _find_branch_item(items, bid)
    if target is None:
        return json_error('Filial topilmadi', 404)
    refs = _branch_related_counts(store, bid)
    total = sum(refs.values())
    if total:
        return jsonify({
            'status': 'error',
            'code': 'has_related_data',
            'message': ('Filialda bog\'liq ma\'lumotlar bor: '
                        f'{refs["products"]} mahsulot, {refs["sales"]} savdo, '
                        f'{refs["cashFlow"]} kirim/chiqim, {refs["staff"]} xodim. '
                        'Tarix yo\'qolmasligi uchun o\'chirish rad etildi — '
                        'filialni avval nofaol qiling.'),
            'related': refs,
        }), 409
    remaining = [i for i in items if i is not target]
    try:
        db_manager.save_keys({BRANCHES_KEY: remaining})
    except Exception as e:
        print(f'[ERROR] /api/branches/{bid} DELETE: {e}')
        return json_error('Filialni o\'chirishda xatolik', 500)
    server_security_log('branch-deleted', 'medium',
                        f'Filial o\'chirildi: {target.get("name")} ({bid})',
                        request.staff.get('name', '—'))  # type: ignore[attr-defined]
    return jsonify({'status': 'success', 'deleted': str(target.get('id') or ''),
                    'remaining': len(remaining)})


@app.route('/api/data', methods=['GET'])
@require_staff()
def get_data():
    """Rolga mos baza nusxasi (maxfiy server kalitlari hech qachon chiqmaydi)."""
    try:
        role = str(getattr(request, 'staff', {}).get('role') or '')
        return jsonify(client_data_snapshot(role))
    except Exception as e:
        print(f'[ERROR] /api/data: {e}')
        return json_error('Ma\'lumotni olishda xatolik', 500)


@app.route('/api/customers', methods=['POST'])
@require_staff('cashier')
def create_customer():
    """Mijoz yaratish: barcha ichki xodim rollari, takroriy telefonlar rad etiladi."""
    actor = getattr(request, 'staff', {}) or {}
    if canonical_role(actor.get('role')) not in ('boss', 'admin', 'manager', 'cashier'):
        return json_error('Bu amal uchun huquq yetarli emas', 403)

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return json_error('Mijoz ma\'lumotlari noto\'g\'ri', 400)

    name_raw = body.get('name')
    phone_raw = body.get('phone')
    if not isinstance(name_raw, str) or not isinstance(phone_raw, str):
        return json_error('Ism va telefon matn ko\'rinishida bo\'lishi kerak', 400)
    name = re.sub(r'[\x00-\x1f\x7f]', '', name_raw).strip()
    phone = re.sub(r'[\x00-\x1f\x7f]', '', phone_raw).strip()
    if not name or len(name) > 120:
        return json_error('Mijoz ismi 1–120 belgi bo\'lishi kerak', 400)
    if not phone or len(phone) > 40 or not re.fullmatch(r'\+?[\d\s().-]+', phone):
        return json_error('Telefon raqami noto\'g\'ri', 400)
    phone_digits = re.sub(r'\D', '', phone)
    if not 7 <= len(phone_digits) <= 15:
        return json_error('Telefon raqami 7–15 ta raqamdan iborat bo\'lishi kerak', 400)

    email_raw = body.get('email', '')
    addr_raw = body.get('addr', '')
    bdate_raw = body.get('bdate', '')
    if not all(isinstance(value, str) for value in (email_raw, addr_raw, bdate_raw)):
        return json_error('Email, manzil yoki tug\'ilgan sana formati noto\'g\'ri', 400)
    email = re.sub(r'[\x00-\x1f\x7f]', '', email_raw).strip()
    addr = re.sub(r'[\x00-\x1f\x7f]', '', addr_raw).strip()
    bdate = bdate_raw.strip()
    if len(email) > 120 or (email and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email)):
        return json_error('Email manzili noto\'g\'ri', 400)
    if len(addr) > 180:
        return json_error('Manzil 180 belgidan oshmasligi kerak', 400)
    if bdate:
        try:
            datetime.strptime(bdate, '%Y-%m-%d')
        except ValueError:
            return json_error('Tug\'ilgan sana noto\'g\'ri', 400)

    try:
        with _store_write_lock:
            store = db_manager.get_all() or {}
            existing = [item for item in (store.get('customers') or [])
                        if isinstance(item, dict)]
            if any(re.sub(r'\D', '', str(item.get('phone') or '')) == phone_digits
                   for item in existing):
                return json_error('Bu telefon raqami bilan mijoz allaqachon mavjud', 409)

            numeric_ids = []
            for item in existing:
                try:
                    item_id = int(item.get('id'))
                except (TypeError, ValueError, OverflowError):
                    continue
                if 0 < item_id <= 9007199254740991:
                    numeric_ids.append(item_id)
            customer_id = max(numeric_ids, default=0) + 1
            if customer_id > 9007199254740991:
                return json_error('Yangi mijoz ID yaratib bo\'lmadi', 500)

            customer = {
                'id': customer_id,
                'name': name,
                'phone': phone,
                'email': email,
                'addr': addr,
                'bdate': bdate,
                'orders': 0,
                'total': 0,
                'bonus': 0,
                'status': 'active',
                'createdAt': datetime.now().isoformat(timespec='seconds'),
            }
            db_manager.save_keys({'customers': existing + [customer]})
    except Exception as e:
        print(f'[ERROR] /api/customers POST: {e}')
        return json_error('Mijozni saqlashda kutilmagan xatolik yuz berdi', 500)

    audit_log('customer-create', name, 'Mijoz ro\'yxatga qo\'shildi',
              actor.get('name', '—'))
    return jsonify({'status': 'success', 'message': 'Mijoz muvaffaqiyatli saqlandi',
                    'customer': customer}), 201


@app.route('/api/sync', methods=['POST'])
@require_staff()
def sync_data():
    req_data = request.get_json(silent=True)
    if not req_data:
        return json_error('Ma\'lumot topilmadi')

    ok, message, clean = validate_sync_payload(req_data)
    if not ok:
        server_security_log('sync-validation', 'medium', f'Yaroqsiz sinxronizatsiya: {message}',
                            request.staff.get('name', '—'))  # type: ignore[attr-defined]
        return json_error(message)

    # Har bir YANGI savdoga kassirning loginini yozib qo'yamiz. Ilgari faqat
    # ism saqlanardi — bir xil ismli ikki xodim bo'lsa savdo ikki marta
    # hisoblanishi yoki noto'g'ri xodimga yozilishi mumkin edi. Bu yerda
    # faqat aynan shu sessiya egasining ismi bilan kelgan yozuvlarga
    # login qo'shiladi (boshqa xodim savdosiga tegmaymiz).
    actor = getattr(request, 'staff', {}) or {}
    actor_login = str(actor.get('sub') or '').strip()
    actor_name = str(actor.get('name') or '').strip().lower()
    if actor_login and isinstance(clean.get('sales'), list):
        backfilled = 0
        for sale in clean['sales']:
            if not isinstance(sale, dict):
                continue
            if str(sale.get('cashierLogin') or '').strip():
                continue
            if str(sale.get('cashier') or '').strip().lower() != actor_name:
                continue
            sale['cashierLogin'] = actor_login
            backfilled += 1
        if backfilled:
            server_security_log('sale-cashier-backfill', 'low',
                                f'{backfilled} ta savdoga kassir logini yozildi',
                                actor.get('name', '—'))

    # Xodimlar boshqaruvi kalitlarini faqat admin/menejer (yoki BOSHLIQ)
    # yoza oladi. Oylik to'lovlari (salaryRecords/salaryHistory) endi bu
    # ro'yxatda emas — ular butunlay backend tomonidan boshqariladi
    # (/api/boss/salary/pay) va SYNC_ALLOWED_KEYS'ga ham kirmaydi.
    EMPLOYEE_MANAGED_KEYS = ('employees',)
    if not role_contains(('admin', 'manager'), request.staff.get('role')):  # type: ignore[attr-defined]
        dropped = [k for k in EMPLOYEE_MANAGED_KEYS if k in clean]
        if dropped:
            for k in dropped:
                clean.pop(k, None)
            server_security_log('access-denied', 'high',
                                f'Xodimlar kalitlari rad etildi ({", ".join(dropped)})',
                                request.staff.get('name', '—'))  # type: ignore[attr-defined]

    # Global sozlamalarni (kompaniya, to'lov, chek) faqat admin/menejer yozadi.
    if not role_contains(('admin', 'manager'), request.staff.get('role')):  # type: ignore[attr-defined]
        if clean.pop('settings', None) is not None:
            server_security_log('access-denied', 'high',
                                'Kassir settings kalitini yozishga urindi',
                                request.staff.get('name', '—'))  # type: ignore[attr-defined]

    # ── Yo'q qilishdan himoya (ma'lumot yo'qolishiga qarshi) ──────────────
    # Sinxronizatsiya butun to'plamni ALMASHTIRADI — mijoz bazani to'liq
    # yuboradi. Shu sababli eski nusxaga ega past darajali xodim bitta
    # so'rov bilan butun savdo tarixini yoki mahsulotlarni o'chirib
    # tashlashi mumkin edi (auditda tasdiqlangan: {"sales": []} → bazada
    # 0 ta savdo). Endi yo'qolgan yozuvlar serverda SAQLANADI va hodisa
    # xavfsizlik jurnaliga yoziladi.
    # Kalit → o'chirishga haqli rollar (frontend'dagi requireRole siyosati
    # bilan bir xil). Boshqa kalitlar (logs, securityLog, smsHistory va h.k.)
    # atayin qo'shilmagan — frontend ularni o'zi qisqartiradi.
    SHRINK_ALLOWED_ROLES = {
        'sales': ('admin', 'manager'),
        'products': ('admin', 'manager'),
        'contracts': ('admin', 'manager'),
        'cashFlow': ('admin', 'manager'),
        'expenses': ('admin', 'manager'),
        'discounts': ('admin', 'manager'),
        'branches': ('admin', 'manager'),
        'customers': ('admin',),
        'logs': ('admin',),
        'securityLog': ('admin',),
        'smsHistory': ('admin',),
        'employees': ('admin',),
    }
    # Butun yozuv (o'qish → himoya → saqlash) bitta qulf ostida bajariladi.
    # Aks holda parallel POS savdosi (/api/sell) va sinxronizatsiya bir-birini
    # bosib ketishi mumkin.
    with _store_write_lock:
        old_store = db_manager.get_all() or {}
        staff_role = canonical_role(request.staff.get('role'))  # type: ignore[attr-defined]
        if staff_role == 'manager' and 'customers' in clean:
            # Menejer faqat /api/customers orqali yangi mijoz qo'shadi;
            # umumiy snapshot mavjud mijozlarni tahrirlash/o'chirish yo'li emas.
            clean['customers'] = old_store.get('customers') or []
        protected = {}
        for key, allowed_roles in SHRINK_ALLOWED_ROLES.items():
            incoming = clean.get(key)
            if not isinstance(incoming, list) or role_contains(allowed_roles, staff_role):
                continue
            existing = [row for row in (old_store.get(key) or []) if isinstance(row, dict)]
            if not existing:
                continue
            have = {str(row.get('id')) for row in existing if row.get('id') is not None}
            keep = {str(row.get('id')) for row in incoming if row.get('id') is not None}
            missing = have - keep
            if not missing:
                continue
            # Yo'qolgan yozuvlar o'chirilmaydi — ro'yxat oxiriga qaytariladi.
            clean[key] = incoming + [row for row in existing
                                     if str(row.get('id')) in missing]
            protected[key] = len(missing)
        if protected:
            summary = ', '.join(f'{k}: {v} ta' for k, v in protected.items())
            server_security_log(
                'sync-delete-blocked', 'high',
                f"Past darajali rol o'chirmoqchi bo'lgan yozuvlar saqlab qolindi ({summary})",
                request.staff.get('name', '—'))  # type: ignore[attr-defined]

        try:
            apply_image_keep(clean.get('products') or [])
            apply_fiscal_keep(clean.get('sales') or [])
            # ── Filial doirasi nazorati (menejer/kassir) ──
            # Xodim filialga biriktirilgan bo'lsa (staff_users.branchId), u faqat
            # O'Z filialiga yangi mahsulot qo'sha oladi va mahsulotni boshqa
            # filialga ko'chira olmaydi. Filiali bo'sh xodim yoki admin/boshliq
            # uchun cheklov yo'q. POS qoldiq/narx oqarimiga TA'SIR QILMAYDI:
            # mavjud mahsulotning qoldiq/narx o'zgarishlari filialga qarab
            # tekshirilmaydi (faqat yangi ID va filial qiymati o'zgarishi nazorat).
            staff_role = str(request.staff.get('role') or '').strip().lower()  # type: ignore[attr-defined]
            if staff_role in ('manager', 'cashier'):
                staff_rec = (find_staff(str(request.staff.get('sub') or ''))
                             or find_staff_by_phone(str(request.staff.get('sub') or '')))
                staff_branch = str((staff_rec or {}).get('branchId') or '').strip()
                if staff_branch:
                    old_by_id = {str(p.get('id')): p
                                 for p in (old_store.get('products') or []) if isinstance(p, dict)}
                    for product in (clean.get('products') or []):
                        if not isinstance(product, dict):
                            continue
                        new_branch = str(product.get('branchId') or '').strip()
                        if not new_branch or new_branch == staff_branch:
                            continue
                        old = old_by_id.get(str(product.get('id')))
                        # Yangi mahsulot yoki filialni boshqa filialga ko'chirish
                        if old is None or str(old.get('branchId') or '').strip() != new_branch:
                            server_security_log('access-denied', 'high',
                                                f'Filial doirasi: "{product.get("name")}" → {new_branch} '
                                                f'(xodim filiali: {staff_branch})',
                                                request.staff.get('name', '—'))  # type: ignore[attr-defined]
                            return json_error(
                                f'Faqat o\'z filialingizda ishlash mumkin — mahsulot '
                                f'{new_branch} filialiga bog\'lanmadi', 403)

            # ── Qoldiqni "resurrect" qilishdan himoya (kassir) ────────────
            # POS savdosi qoldiqni /api/sell orqali serverda kamaytiradi.
            # Kassir qurilmasi keyin butun to'plamni (eski, kattaroq qoldiq
            # bilan) sinxronlasa — serverdagi yangi qoldiqni qayta ko'paytirib
            # qo'yardi va boshqa kassirning savdosi "yo'qolardi". Shu sababli
            # kassir uchun mavjud mahsulot qoldig'i faqat KAMAYADI (o'sish rad
            # etiladi). Kassir interfeysda mavjud mahsulotni tahrirlamaydi,
            # shuning uchun bu qonuniy o'zgarishni to'smaydi.
            if staff_role == 'cashier' and isinstance(clean.get('products'), list):
                old_by_id = {str(p.get('id')): p
                             for p in (old_store.get('products') or []) if isinstance(p, dict)}
                kept = 0
                for product in clean['products']:
                    if not isinstance(product, dict):
                        continue
                    old = old_by_id.get(str(product.get('id')))
                    if old is None:
                        continue
                    old_stock = int(_num(old.get('stock')))
                    new_stock = int(_num(product.get('stock')))
                    if new_stock > old_stock:
                        product['stock'] = old_stock
                        kept += 1
                if kept:
                    server_security_log('sync-stock-guard', 'medium',
                                        f"{kept} ta mahsulot qoldig'i kassir tomonidan "
                                        f"ko'paytirilishi oldini olindi",
                                        request.staff.get('name', '—'))  # type: ignore[attr-defined]

            audit_sync_changes(old_store, clean,
                               str(getattr(request, 'staff', {}).get('name', '—')))
            db_manager.save_keys(clean)
            return jsonify({'status': 'success', 'message': 'Ma\'lumotlar muvaffaqiyatli saqlandi',
                            'savedKeys': sorted(clean.keys())})
        except Exception as e:
            print(f'[ERROR] /api/sync: {e}')
            return json_error('Ma\'lumotni saqlashda xatolik', 500)




# POS SELL ENDPOINT
# ─────────────────────────────────────────────────────────────────────────────
def _sale_day_str():
    return datetime.now().strftime('%d.%m.%Y')


def _sale_clock_str():
    return datetime.now().strftime('%H:%M:%S')


def _sale_stamp_str():
    return datetime.now().strftime('%d.%m.%Y %H:%M:%S')


def _next_server_sale_id(store):
    """Bazadagi eng katta ID dan keyingi savdo raqami (brauzer ID yubormasa)."""
    max_id = 0
    for item in (store.get('sales') or []):
        if not isinstance(item, dict):
            continue
        value = int(_num(item.get('id')))
        if value > max_id:
            max_id = value
    return max(max_id + 1, int(datetime.now().timestamp() * 1000))


def _money_str(value):
    """Jurnal uchun pul ko'rinishi: 11 106 so'm."""
    return f"{int(round(_num(value))):,}".replace(',', ' ')


@app.route('/api/sell', methods=['POST'])
@require_staff()
def api_sell():
    """POS savdosi: mahsulot, miqdor, narx va filialni SERVERDA tekshirib,
    savdoni saqlaydi va ombor qoldig'ini atomar (qulf ostida) kamaytiradi.

    Body:
    {
      "id": 1792749734000,          # savdo raqami (ixtiyoriy — bo'lmasa server beradi)
      "items": [{"id": 1, "qty": 3, "price": 50000, "name": "Telefon"}],
      "branchId": "b2", "cashier": "...", "customer": "...",
      "customerId": 123, "pay": "Naqd", "provider": "cash",
      "total": 150000, "disc": 0, "discAmt": 0, "subtotal": 150000,
      "date": "23.10.2026", "time": "15:30:00", "isOnline": false
    }

    • Qoldiq FAQAT savdo muvaffaqiyatli yakunlanganda kamayadi (savatga
      qo'shishning o'zi qoldiqqa ta'sir qilmaydi);
    • Yetarli qoldiq bo'lmasa savdo rad etiladi va HECH NARSA yozilmaydi;
    • Bir xil `id` bilan takroriy so'rov qoldiqni ikki marta kamaytirmaydi;
    • Natija: {status:'success', sale, productStocks[], deductions[]}
    """
    staff = getattr(request, 'staff', {}) or {}
    cashier_login = str(staff.get('sub') or '').strip()
    cashier_name = str(staff.get('name') or "Noma'lum").strip()

    body = request.get_json(silent=True) or {}
    items = body.get('items')
    if not isinstance(items, list) or len(items) == 0:
        return json_error("Savdo itemlari bo'sh.", 400)
    if len(items) > 500:
        return json_error('Savdo itemlari maksimal: 500 ta.', 400)

    branch_id = str(body.get('branchId') or '').strip()
    if not branch_id:
        return json_error("Filial tanlanmagan. POS da filial aniqlanishi shart.", 400)

    # Filialga biriktirilgan menejer/kassir faqat O'Z filialida savdo qiladi
    # (staff_users.branchId). Filiali bo'sh xodim yoki admin/boshliq uchun
    # cheklov yo'q — aks holda kassir boshqa filial qoldig'ini o'zgartira
    # olardi (filial doirasidan tashqari ta'sir).
    staff_role = str(staff.get('role') or '').strip().lower()
    if staff_role in ('manager', 'cashier'):
        staff_rec = (find_staff(str(staff.get('sub') or ''))
                     or find_staff_by_phone(str(staff.get('sub') or '')))
        staff_branch = str((staff_rec or {}).get('branchId') or '').strip()
        if staff_branch and staff_branch != branch_id:
            server_security_log('access-denied', 'high',
                                f"Filial doirasidan tashqari savdo: {branch_id} "
                                f"(xodim filiali: {staff_branch})", cashier_name)
            return json_error("Faqat o'z filialingizda savdo qilishingiz mumkin.", 403)

    is_online = bool(body.get('isOnline'))
    sale_id = body.get('id')

    # Barcha o'zgarishlar BITTA qulf ostida: o'qish → tekshirish → yozish
    # (ikki kassir bir vaqtda sotsa ham qoldiq ikki marta kamaymaydi).
    with _store_write_lock:
        store = db_manager.get_all() or {}
        store_products = store.get('products') or []
        products = [p for p in store_products if isinstance(p, dict)]

        # ── Idempotentlik ────────────────────────────────────────────────
        # Bu savdo allaqachon saqlangan bo'lsa (qayta urinish, ikki marta
        # bosish, tarmoq takrori) — qoldiq QAYTA kamaytirilmaydi.
        if sale_id not in (None, ''):
            existing = next((s for s in (store.get('sales') or [])
                             if isinstance(s, dict) and str(s.get('id')) == str(sale_id)), None)
            if existing is not None:
                return jsonify({
                    'status': 'success', 'sale': existing, 'duplicate': True,
                    'productStocks': [{'id': str(p.get('id')), 'name': str(p.get('name')),
                                       'stock': int(_num(p.get('stock')) or 0)}
                                      for p in products
                                      if any(str(i.get('id')) == str(p.get('id'))
                                             for i in items if isinstance(i, dict))],
                    'message': 'Bu savdo allaqachon saqlangan',
                })

        # ── Tekshiruv va qoldiq kamaytirish ──────────────────────────────
        stored_items = []
        deductions = []
        errors = []
        for item in items:
            if not isinstance(item, dict):
                return json_error("Savdo elementi formati noto'g'ri.", 400)
            pid = str(item.get('id'))
            product = next((x for x in products if str(x.get('id')) == pid), None)
            if product is None:
                errors.append(f"Mahsulot #{pid} ro'yxatdan o'chirilgan.")
                continue
            # Filialga bog'langan mahsulot faqat o'z filialida sotiladi.
            # "Umumiy ombor" (branchId bo'sh) mahsulot HAR QANDAY filialda
            # sotilishi mumkin — bu frontend `visibleProducts()` qoidasi bilan
            # bir xil (filial tanlanganda umumiy mahsulotlar ham ko'rinadi).
            product_branch = str(product.get('branchId') or '').strip()
            if product_branch and product_branch != branch_id:
                errors.append(f"Mahsulot #{pid} ({product.get('name')}) bu filialga tegishli emas.")
                continue
            qty = int(_num(item.get('qty')))
            if qty <= 0:
                errors.append(f"Mahsulot #{pid} uchun miqdor 0 dan katta bo'lishi kerak.")
                continue
            price = _num(item.get('price'))
            if price < 0:
                errors.append(f"Mahsulot #{pid} narxi manfiy bo'lmasligi kerak.")
                continue

            stored_items.append({
                'id': product.get('id'),
                'name': str(item.get('name') or product.get('name') or '')[:120],
                'price': price,
                'cost': _num(item.get('cost', product.get('cost'))),
                'qty': qty,
                'img': str(item.get('img') or '')[:2048],
                'barcode': str(item.get('barcode') or '')[:64],
                'branchId': branch_id,
                'ikpu': str(item.get('ikpu') or '')[:17],
                'packageCode': str(item.get('packageCode') or '')[:20],
                'vatPercent': _num(item.get('vatPercent'), 12.0),
            })

            # Qoldiq faqat darhol to'lanadigan savdoda kamayadi. Onlayn
            # to'lovlarda qoldiq to'lov tasdiqlanganda kamayadi.
            if not is_online:
                old_stock = int(_num(product.get('stock')) or 0)
                if old_stock < qty:
                    errors.append(f"{product.get('name')} — yetarli qoldiq yo'q. "
                                  f"Mavjud: {old_stock}, so'ralgan: {qty}.")
                    continue
                product['stock'] = old_stock - qty
                deductions.append({'id': pid, 'qty': qty,
                                   'oldStock': old_stock, 'stock': old_stock - qty})

        if errors:
            # Xatolik bo'lsa hech narsa yozilmaydi — qoldiq o'zgarmaydi.
            return json_error('Savdo rad etildi: ' + '; '.join(errors), 400)

        sale = {
            'id': sale_id if sale_id not in (None, '') else _next_server_sale_id(store),
            'items': stored_items,
            'cashier': cashier_name,
            'cashierLogin': cashier_login,
            'customer': str(body.get('customer') or "Noma'lum")[:120],
            'customerId': body.get('customerId') or None,
            'customerPhone': str(body.get('customerPhone') or '')[:40],
            'branchId': branch_id,
            'pay': str(body.get('pay') or 'cash')[:40],
            'provider': str(body.get('provider') or 'cash')[:30],
            'subtotal': _num(body.get('subtotal') or 0),
            'disc': _num(body.get('disc') or 0),
            'discAmt': _num(body.get('discAmt') or 0),
            'total': _num(body.get('total') or 0),
            'status': 'pending' if is_online else 'paid',
            'date': str(body.get('date') or _sale_day_str())[:20],
            'time': str(body.get('time') or _sale_clock_str())[:20],
            'createdAt': _sale_stamp_str(),
        }

        store.setdefault('sales', [])
        store['sales'].append(sale)
        audit_rows = store.get('audit_log')
        if not isinstance(audit_rows, list):
            audit_rows = []
        audit_rows.append({
            'action': 'sale-create', 'message': f"Chek #{sale['id']}",
            'detail': (f"{cashier_name} — {branch_id} filiali, "
                       f"{len(stored_items)} ta mahsulot, {_money_str(sale['total'])} so'm"),
            'username': cashier_name, 'date': sale['date'], 'time': sale['time'],
        })
        store['audit_log'] = audit_rows

        # Atomar saqlash: faqat tegishli kalitlar yoziladi (boshqa kalitlarni
        # eski nusxa bilan bosib ketmaymiz). save_keys — bitta tranzaksiya.
        try:
            db_manager.save_keys({
                'products': store_products,
                'sales': store['sales'],
                'audit_log': store['audit_log'],
            })
        except Exception as e:
            print(f'[ERROR] /api/sell db save: {e}')
            return json_error("Ma'lumotni saqlashda xatolik", 500)

        productStocks = [{'id': str(p.get('id')), 'name': str(p.get('name')),
                          'stock': int(_num(p.get('stock')) or 0)}
                         for p in products
                         if any(str(i.get('id')) == str(p.get('id'))
                                for i in stored_items)]

        return jsonify({
            'status': 'success', 'sale': sale,
            'productStocks': productStocks, 'deductions': deductions,
            'message': 'Savdo muvaffaqiyatli yakunlandi',
        })

def audit_sync_changes(old_store, clean, actor):
    """Sinxronizatsiyadagi muhim o'zgarishlarni amallar jurnaliga yozadi.

    • Yangi savdo   → `sale-create` (kassir real amali — bank/kassa cheki);
    • Mahsulot o'zgarganda (qoldiq/narx) → `product-update`.
    Parol, token yoki shaxsiy ma'lumotlar jurnalga YOZILMAYDI.
    """
    try:
        old_sales = [s for s in (old_store.get('sales') or []) if isinstance(s, dict)]
        old_ids = {str(s.get('id')) for s in old_sales}
        for sale in (clean.get('sales') or []):
            if not isinstance(sale, dict):
                continue
            sid = str(sale.get('id'))
            if sid in old_ids or _num(sale.get('total')) <= 0:
                continue
            cashier = str(sale.get('cashier') or actor or '—')[:120]
            pay = str(sale.get('pay') or sale.get('provider') or '')[:30]
            audit_log('sale-create', f"Chek #{sid}",
                      f"{_num(sale.get('total'))} so'm · {pay}", cashier)

        old_products = {str(p.get('id')): p
                        for p in (old_store.get('products') or []) if isinstance(p, dict)}
        for product in (clean.get('products') or []):
            if not isinstance(product, dict):
                continue
            pid = str(product.get('id'))
            old = old_products.get(pid)
            if not old:
                continue
            old_stock = _num(old.get('stock'))
            new_stock = _num(product.get('stock'))
            old_price = _num(old.get('price'))
            new_price = _num(product.get('price'))
            if old_stock != new_stock or old_price != new_price:
                from_stock = f"qoldiq: {old_stock}→{new_stock}" if old_stock != new_stock else ''
                from_price = f"narx: {old_price}→{new_price}" if old_price != new_price else ''
                audit_log('product-update', str(product.get('name') or pid)[:120],
                          ' '.join(x for x in (from_stock, from_price) if x),
                          str(actor or '—')[:120])

        # ── O'chirilgan yozuvlar jurnali ─────────────────────────────────
        # Savdo yoki mahsulot ro'yxatdan yo'qolsa, bu DOIM ko'rinadigan
        # bo'lishi kerak: ilgari faqat yangi savdo va narx o'zgarishi
        # yozilardi, o'chirish esa jurnalda umuman qolmasdi.
        if isinstance(clean.get('sales'), list):
            new_sale_ids = {str(s.get('id')) for s in (clean.get('sales') or [])
                            if isinstance(s, dict)}
            removed_sales = [s for s in old_sales if str(s.get('id')) not in new_sale_ids]
            for sale in removed_sales[:20]:
                audit_log('sale-delete', f"Chek #{sale.get('id')}",
                          f"{_num(sale.get('total'))} so'm · ro'yxatdan o'chirildi",
                          str(actor or '—')[:120])
            if len(removed_sales) > 20:
                audit_log('sale-delete', f'{len(removed_sales)} ta savdo',
                          "ro'yxatdan o'chirildi", str(actor or '—')[:120])

        if isinstance(clean.get('products'), list):
            new_product_ids = {str(p.get('id')) for p in (clean.get('products') or [])
                               if isinstance(p, dict)}
            removed_products = [p for p in (old_store.get('products') or [])
                                if isinstance(p, dict)
                                and str(p.get('id')) not in new_product_ids]
            for product in removed_products[:20]:
                audit_log('product-delete', str(product.get('name') or product.get('id'))[:120],
                          "ro'yxatdan o'chirildi", str(actor or '—')[:120])
            if len(removed_products) > 20:
                audit_log('product-delete', f'{len(removed_products)} ta mahsulot',
                          "ro'yxatdan o'chirildi", str(actor or '—')[:120])
    except Exception as e:
        print(f'[AUDIT-SYNC-ERROR] {e}')


# ============================================================
# TO'LOV TIZIMLARI (Click, Payme, Paynet, Uzum Bank, Paylov)
# Maxfiy kalitlar FAQAT .env'da saqlanadi va brauzerga yuborilmaydi.
# ============================================================
PAYMENT_ORDERS_KEY = 'payment_orders'
PAYMENT_ORDERS_LIMIT = 500

# Har bir provider uchun .env kalitlari va to'lov sahifasi manzili
PAYMENT_PROVIDERS = {
    'click': {
        'label': 'Click',
        'env': ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY'],
        'checkout': 'https://my.click.uz/services/pay',
    },
    'payme': {
        'label': 'Payme',
        'env': ['PAYME_MERCHANT_ID', 'PAYME_KEY'],
        'checkout': 'https://checkout.paycom.uz',
    },
    'paynet': {
        'label': 'Paynet',
        'env': ['PAYNET_MERCHANT_ID', 'PAYNET_SERVICE_ID', 'PAYNET_KEY'],
        'checkout': os.getenv('PAYNET_CHECKOUT_URL', ''),
    },
    'uzum': {
        'label': 'Uzum Bank',
        'env': ['UZUM_MERCHANT_ID', 'UZUM_KEY', 'UZUM_CHECKOUT_URL'],
        'checkout': os.getenv('UZUM_CHECKOUT_URL', ''),
    },
    'paylov': {
        'label': 'Paylov',
        'env': ['PAYLOV_MERCHANT_ID', 'PAYLOV_KEY', 'PAYLOV_CHECKOUT_URL'],
        'checkout': os.getenv('PAYLOV_CHECKOUT_URL', ''),
    },
}


def provider_settings(provider):
    """Provider uchun .env qiymatlarini yig'adi."""
    p = PAYMENT_PROVIDERS.get(provider)
    if not p:
        return {}
    values = {key: os.getenv(key, '') for key in p['env']}
    secret_keys = [k for k in p['env'] if k.endswith('_KEY') or k.endswith('_SECRET_KEY')]
    enabled = all(values.get(k) for k in secret_keys) and any(
        values.get(k) for k in p['env'] if k not in secret_keys)
    return {
        'enabled': bool(enabled),
        'checkout': p['checkout'],
        'env': p['env'],
        # Faqat OCHIQ identifikatorlar qaytariladi (maxfiy kalit YO'Q)
        'public': {k: v for k, v in values.items() if not (k.endswith('_KEY') or k.endswith('_SECRET_KEY'))},
        'secret': {k: values[k] for k in secret_keys if values.get(k)},
    }


def load_store():
    try:
        return db_manager.get_all()
    except Exception as e:
        print(f"Store o'qishda xato: {e}")
        return {}


def load_payment_orders():
    orders = load_store().get(PAYMENT_ORDERS_KEY) or {}
    return orders if isinstance(orders, dict) else {}


def save_payment_orders(orders):
    # Cheksiz o'sishni oldini olish: eng eski yozuvlarni kesib tashlaymiz
    if len(orders) > PAYMENT_ORDERS_LIMIT:
        ordered = sorted(orders.items(), key=lambda kv: kv[1].get('createdAt', ''), reverse=True)
        orders = dict(ordered[:PAYMENT_ORDERS_LIMIT])
    try:
        db_manager.save_keys({PAYMENT_ORDERS_KEY: orders})
    except Exception as e:
        print(f"To'lov yozuvlarini saqlashda xato: {e}")


def find_server_sale(sale_id):
    """Summani faqat serverdagi savdo yozuvidan oladi (mijoz yuborgan summaga ishonmaymiz)."""
    try:
        sid = int(sale_id)
    except (TypeError, ValueError):
        return None
    for s in (load_store().get('sales') or []):
        try:
            if int(s.get('id', -1)) == sid:
                return s
        except (TypeError, ValueError):
            continue
    return None


def update_server_sale(sale_id, **fields):
    """Savdo holatini serverda yangilaydi (callback tasdiqlaganda)."""
    data = load_store()
    sales = data.get('sales') or []
    target = None
    try:
        sid = int(sale_id)
    except (TypeError, ValueError):
        return None
    for s in sales:
        try:
            if int(s.get('id', -1)) == sid:
                target = s
                break
        except (TypeError, ValueError):
            continue
    if target is None:
        return None
    target.update(fields)
    try:
        db_manager.save_keys({'sales': sales})
    except Exception as e:
        print(f"Savdo holatini saqlashda xato: {e}")
        return None
    return target


def build_pay_url(provider, order_id, amount, return_url):
    """To'lov sahifasi havolasini quradi (maxfiy kalitlar havolaga qo'shilmaydi)."""
    from urllib.parse import urlencode, quote
    cfg = provider_settings(provider)
    pub = cfg.get('public', {})
    amount = int(round(float(amount)))

    if provider == 'click':
        service_id = pub.get('CLICK_SERVICE_ID', '')
        merchant_id = pub.get('CLICK_MERCHANT_ID', '')
        if not (service_id and merchant_id):
            return ''
        return 'https://my.click.uz/services/pay?' + urlencode({
            'service_id': service_id,
            'merchant_id': merchant_id,
            'amount': amount,
            'transaction_param': order_id,
            'return_url': return_url,
        })

    if provider == 'payme':
        merchant_id = pub.get('PAYME_MERCHANT_ID', '')
        if not merchant_id:
            return ''
        # Payme: summa tiyinda (so'm * 100)
        payload = f"m={merchant_id};ac.order_id={order_id};a={amount * 100};l=uz;c={return_url}"
        return 'https://checkout.paycom.uz/' + base64.b64encode(payload.encode('utf-8')).decode('ascii')

    # Paynet / Uzum / Paylov: .env'dagi shablon ishlatiladi
    template = cfg.get('checkout') or ''
    if not template:
        return ''
    merchant_id = (pub.get('PAYNET_MERCHANT_ID') or pub.get('UZUM_MERCHANT_ID')
                   or pub.get('PAYLOV_MERCHANT_ID') or '')
    return (template
            .replace('{order_id}', quote(order_id))
            .replace('{amount}', str(amount))
            .replace('{return_url}', quote(return_url, safe=''))
            .replace('{merchant_id}', quote(str(merchant_id), safe=''))
            .replace('{service_id}', quote(str(pub.get('PAYNET_SERVICE_ID', '')), safe='')))


def make_order_id(sale_id):
    """Bashorat qilib bo'lmaydigan buyurtma raqami."""
    return f"TP-{datetime.now():%Y%m%d}-{int(sale_id)}-{secrets.token_hex(4)}"


@app.route('/api/payments/config', methods=['GET'])
def payments_config():
    """Yoqilgan to'lov tizimlari ro'yxati. Maxfiy kalitlar QAYTARILMAYDI."""
    providers = {}
    for provider in PAYMENT_PROVIDERS:
        cfg = provider_settings(provider)
        providers[provider] = {
            'enabled': cfg.get('enabled', False),
            'label': PAYMENT_PROVIDERS[provider]['label'],
            'env': cfg.get('env', []),
        }
    enabled = [p for p, c in providers.items() if c['enabled']]
    default_provider = os.getenv('DEFAULT_PAYMENT_PROVIDER', '') or (enabled[0] if enabled else 'cash')
    if default_provider not in PAYMENT_PROVIDERS and default_provider != 'cash':
        default_provider = 'cash'
    return jsonify({
        'status': 'success',
        'providers': providers,
        'defaultProvider': default_provider,
        'webhookConfigured': bool(WEBHOOK_TOKEN),
        'serverTime': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
    })


# Ommaviy murojaat (feedback) — autentifikatsiya yo'q, shuning uchun IP
# bo'yicha qat'iy limit: ilgari bu endpoint orqali cheksiz yozuv yuborib
# `support_reports` jadvalini to'ldirish (va diskni to'ldirish) mumkin edi.
REPORT_RATE_MAX = 5
REPORT_RATE_WINDOW = 3600
REPORT_MESSAGE_LIMIT = 2000
_report_requests = {}
_report_lock = threading.Lock()


def report_allowed(ip):
    """Bitta IP uchun soatiga ruxsat etilgan murojaatlar soni."""
    now = time.time()
    with _report_lock:
        stamps = [t for t in _report_requests.get(ip, [])
                  if now - t < REPORT_RATE_WINDOW]
        _report_requests[ip] = stamps
        if len(stamps) >= REPORT_RATE_MAX:
            return False
        stamps.append(now)
        return True


@app.route('/api/reports', methods=['POST'])
def save_feedback_report():
    """Mijoz murojaati (shikoyat/taklif). Faqat cheklangan hajmda qabul qilinadi."""
    if not report_allowed(get_client_ip()):
        return jsonify({'status': 'error',
                        'message': "Juda ko'p murojaat yuborildi. Keyinroq urinib ko'ring."}), 429

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({'status': 'error', 'message': "Ma'lumot formati noto'g'ri"}), 400

    message = str(data.get('message') or '').strip()[:REPORT_MESSAGE_LIMIT]
    if not message:
        return jsonify({'status': 'error', 'message': 'Xabar kiritilmadi'}), 400

    try:
        db_manager.save_report(
            str(data.get('type') or 'complaint')[:40],
            message,
            str(data.get('contact') or '')[:120],
            str(data.get('date') or '')[:32],
            str(data.get('time') or '')[:32],
            str(data.get('user') or 'Mehmon')[:120],
        )
        return jsonify({'status': 'success', 'message': 'Murojaat muvaffaqiyatli yozildi'})
    except Exception as e:
        # Baza xatosi tafsilotlari mijozga chiqarilmaydi (faqat serverda)
        print(f'[ERROR] /api/reports: {e}')
        return jsonify({'status': 'error', 'message': 'Murojaatni saqlab bo\'lmadi'}), 500

@app.route('/api/payments/create', methods=['POST'])
@require_staff()
def payments_create():
    """
    Online to'lovni boshlaydi.
    Summa mijozdan EMAS, serverdagi savdo yozuvidan olinadi (firibgarlikka qarshi).
    """
    payload = request.get_json(silent=True) or {}
    provider = str(payload.get('provider', '')).strip().lower()
    sale_id = payload.get('saleId')
    return_url = str(payload.get('returnUrl') or request.host_url)[:500]

    if provider not in PAYMENT_PROVIDERS:
        return jsonify({'status': 'error', 'message': 'Noma\'lum to\'lov tizimi'}), 400
    cfg = provider_settings(provider)
    if not cfg.get('enabled'):
        return jsonify({
            'status': 'error',
            'message': f"{PAYMENT_PROVIDERS[provider]['label']} sozlanmagan. "
                       f"Kerakli .env kalitlari: {', '.join(cfg.get('env', []))}"
        }), 400

    sale = find_server_sale(sale_id)
    if not sale:
        return jsonify({'status': 'error',
                        'message': 'Savdo serverda topilmadi. Sinxronlab qayta urinib ko\'ring.'}), 404

    amount = float(sale.get('total') or 0)
    if amount <= 0:
        return jsonify({'status': 'error', 'message': 'To\'lov summasi noto\'g\'ri'}), 400

    order_id = make_order_id(sale_id)
    pay_url = build_pay_url(provider, order_id, amount, return_url)
    if not pay_url:
        return jsonify({
            'status': 'error',
            'message': f"{PAYMENT_PROVIDERS[provider]['label']} uchun havola qurilmadi. "
                       f".env sozlamalarini tekshiring."
        }), 400

    ttl = max(1, int(os.getenv('PAYMENT_ORDER_TTL_MINUTES', '15')))
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=ttl)
    orders = load_payment_orders()
    orders[order_id] = {
        'orderId': order_id,
        'saleId': int(sale['id']),
        'provider': provider,
        'amount': round(amount, 2),
        'status': 'pending',
        'createdAt': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'expiresAt': expires_at.isoformat(),
        'payUrl': pay_url,
        'txnId': None,
        'ip': get_client_ip(),
    }
    save_payment_orders(orders)
    update_server_sale(sale['id'], status='pending', provider=provider, paymentOrderId=order_id)

    return jsonify({
        'status': 'success',
        'orderId': order_id,
        'payUrl': pay_url,
        'amount': amount,
        'provider': provider,
        'expiresAt': expires_at.isoformat(),
    })


@app.route('/api/payments/status/<order_id>', methods=['GET'])
@require_staff()
def payments_status(order_id):
    """To'lov holatini qaytaradi (frontend polling uchun)."""
    order = load_payment_orders().get(str(order_id))
    if not order:
        return jsonify({'status': 'not_found', 'message': 'To\'lov yozuvi topilmadi'}), 404

    # Muddati o'tgan buyurtmani avtomatik bekor qilamiz
    if order.get('status') == 'pending' and order.get('expiresAt'):
        try:
            exp = datetime.fromisoformat(order['expiresAt'])
            if datetime.now(timezone.utc) > exp:
                orders = load_payment_orders()
                orders[str(order_id)]['status'] = 'expired'
                save_payment_orders(orders)
                order['status'] = 'expired'
        except (ValueError, TypeError):
            pass

    return jsonify({
        'status': order.get('status', 'pending'),
        'orderId': order.get('orderId'),
        'saleId': order.get('saleId'),
        'provider': order.get('provider'),
        'amount': order.get('amount'),
        'txnId': order.get('txnId'),
        'paidAt': order.get('paidAt'),
    })


def _confirm_payment_order(order, txn_id, source):
    """To'lovni tasdiqlaydi: buyurtma + savdo holati + log."""
    order_id = order.get('orderId')
    orders = load_payment_orders()
    if orders.get(order_id, {}).get('status') == 'paid':
        return orders.get(order_id)
    paid_at = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    orders.setdefault(order_id, {}).update({
        'status': 'paid', 'txnId': txn_id, 'paidAt': paid_at, 'source': source,
    })
    save_payment_orders(orders)
    update_server_sale(order.get('saleId'), status='paid', txnId=txn_id, paidAt=paid_at,
                       paymentOrderId=order_id)
    # To'lov tasdiqlandi → fiskal chek (QR-kodli) fon rejimida chiqariladi.
    # Webhook javobini kechiktirmaslik uchun alohida oqimda ishlaydi.
    _fiscalize_async(order.get('saleId'), source)
    return orders[order_id]


def _fiscalize_async(sale_id, source='payment'):
    """To'lov tasdiqlangach fiskal chekni fonda chiqaradi (best-effort)."""
    def worker():
        try:
            sale = find_sale(sale_id)
            if sale and str(sale.get('status') or '') == 'paid':
                fiscalize_sale(sale, 'webhook', source=source)
        except Exception as exc:
            print(f'[FISCAL] Fon rejimidagi chek xatosi: {exc}')
    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception as exc:
        print(f'[FISCAL] Oqim ochilmadi: {exc}')


@app.route('/api/payments/mark-paid', methods=['POST'])
def payments_mark_paid():
    """
    Faqat imzolangan webhook (umumiy token) orqali qo'lda tasdiqlash.
    Brauzerdan keladigan so'rovlarga ishonilmaydi.
    """
    payload = request.get_json(silent=True) or {}
    token = request.headers.get('X-Webhook-Token', '') or payload.get('token', '')
    if not WEBHOOK_TOKEN or not hmac.compare_digest(str(token), WEBHOOK_TOKEN):
        return jsonify({'status': 'error', 'message': 'Imzo tekshiruvidan o\'tmadi'}), 401

    order = load_payment_orders().get(str(payload.get('orderId', '')))
    if not order:
        return jsonify({'status': 'error', 'message': 'To\'lov yozuvi topilmadi'}), 404

    _confirm_payment_order(order, payload.get('txnId') or 'WEBHOOK', 'webhook-token')
    return jsonify({'status': 'success', 'message': 'To\'lov tasdiqlandi'})


# Click Webhook Endpoint
@app.route('/api/payment/click', methods=['POST'])
def click_webhook():
    click_trans_id = request.form.get('click_trans_id')
    service_id = request.form.get('service_id')
    click_paydoc_id = request.form.get('click_paydoc_id')
    merchant_trans_id = request.form.get('merchant_trans_id')
    amount = request.form.get('amount')
    action = request.form.get('action')
    error = request.form.get('error')
    error_note = request.form.get('error_note')
    sign_time = request.form.get('sign_time')
    sign_string = request.form.get('sign_string')
    merchant_prepare_id = request.form.get('merchant_prepare_id')

    click_secret_key = os.getenv('CLICK_SECRET_KEY', '')
    if not click_secret_key:
        return jsonify({
            'error': -1,
            'error_note': 'Secret key is not set on the merchant server'
        })

    try:
        action_int = int(action)
    except (TypeError, ValueError):
        action_int = -1

    # MD5 Signature Verification
    if action_int == 0:
        raw_sign = f"{click_trans_id}{service_id}{click_secret_key}{merchant_trans_id}{amount}{action}{sign_time}"
    elif action_int == 1:
        raw_sign = f"{click_trans_id}{service_id}{click_secret_key}{merchant_trans_id}{merchant_prepare_id}{amount}{action}{sign_time}"
    else:
        return jsonify({
            'error': -3,
            'error_note': 'Action is invalid'
        })

    my_sign = hashlib.md5(raw_sign.encode('utf-8')).hexdigest()
    # Doimiy vaqtli solishtirish (imzoni vaqt bo'yicha taxmin qilib bo'lmasin)
    if not hmac.compare_digest(my_sign, str(sign_string or '')):
        return jsonify({
            'error': -1,
            'error_note': 'Sign string mismatch'
        })

    try:
        req_amount = float(amount)
    except (TypeError, ValueError):
        req_amount = 0.0
    if not math.isfinite(req_amount) or req_amount <= 0:
        return jsonify({'error': -2, 'error_note': 'Incorrect amount'})

    # Click to'lovni BEKOR qilsa (error != 0) — buyurtmani "to'landi" deb
    # belgilash mumkin emas. Ilgari bu maydon o'qilardi-yu, umuman
    # ishlatilmasdi: muvaffaqiyatsiz to'lov ham savdoni "paid" qilib, omborni
    # kamaytirardi.
    try:
        click_error = int(error or 0)
    except (TypeError, ValueError):
        click_error = 0
    if click_error != 0 and action_int == 1:
        server_security_log(
            'payment-click-error', 'high',
            f"Click to'lovi muvaffaqiyatsiz (error={click_error}, "
            f"{str(error_note or '')[:80]}) — savdo to'langan deb belgilanmadi")
        return jsonify({
            'error': -9,
            'error_note': 'Transaction cancelled by Click'
        })

    try:
        store_data = db_manager.get_all()
    except Exception as e:
        return jsonify({
            'error': -7,
            'error_note': f'Database connection error: {str(e)}'
        })

    sales = store_data.get('sales', [])
    products = store_data.get('products', [])

    # Buyurtmani topamiz: avval to'lov yozuvidan (TP-... order_id),
    # keyin zaxira sifatida savdo ID'sidan (eski integratsiya bilan moslik).
    payment_order = load_payment_orders().get(str(merchant_trans_id))
    target_sale = None
    if payment_order:
        target_sale = next(
            (s for s in sales if str(s.get('id')) == str(payment_order.get('saleId'))), None)
    if target_sale is None:
        for sale in sales:
            if str(sale.get('id')) == str(merchant_trans_id):
                target_sale = sale
                break

    if not target_sale:
        return jsonify({
            'error': -5,
            'error_note': 'Order does not exist'
        })

    # Validate amount
    if abs(float(target_sale.get('total', 0.0)) - req_amount) > 0.01:
        return jsonify({
            'error': -2,
            'error_note': f"Incorrect amount. Expected {target_sale.get('total')}, got {req_amount}"
        })

    def _as_int(value, default=-1):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    if action_int == 0:
        if target_sale.get('status') == 'paid':
            return jsonify({
                'error': -4,
                'error_note': 'Order already paid'
            })

        prepare_id = _as_int(click_trans_id)
        if prepare_id <= 0:
            return jsonify({
                'error': -3,
                'error_note': 'Action is invalid'
            })

        # Prepare bosqichi eslab qolinadi: Complete bosqichida Click AYNI
        # qiymatni qaytarishi shart (quyida tekshiriladi).
        update_server_sale(target_sale.get('id'), clickPrepareId=prepare_id,
                           clickTransId=prepare_id,
                           clickPaydocId=str(click_paydoc_id or '')[:40])
        return jsonify({
            'click_trans_id': prepare_id,
            'merchant_trans_id': merchant_trans_id,
            'merchant_prepare_id': prepare_id,
            'error': 0,
            'error_note': 'Success'
        })

    elif action_int == 1:
        if target_sale.get('status') == 'paid':
            return jsonify({
                'click_trans_id': int(click_trans_id),
                'merchant_trans_id': merchant_trans_id,
                'merchant_confirm_id': int(click_trans_id),
                'error': 0,
                'error_note': 'Success (Already confirmed)'
            })

        # Prepare bosqichida berilgan ID mos kelishi shart (mavjud bo'lsa —
        # eski integratsiyalar uchun moslik saqlanadi: yo'q bo'lsa o'tkazamiz).
        remembered = target_sale.get('clickPrepareId') or target_sale.get('clickTransId')
        if remembered is not None and _as_int(merchant_prepare_id) != _as_int(remembered):
            server_security_log(
                'payment-click-mismatch', 'high',
                f"Click prepare_id mos emas (kutilgan {remembered}, kelgan {merchant_prepare_id})")
            return jsonify({
                'error': -1,
                'error_note': 'Prepare id mismatch'
            })

        # Confirm and set status to Paid
        target_sale['status'] = 'paid'
        target_sale['click_trans_id'] = click_trans_id
        
        # Deduct stock
        for item in target_sale.get('items', []):
            p = next((x for x in products if x.get('id') == item.get('id')), None)
            if p:
                p['stock'] = max(0, int(p.get('stock', 0)) - int(item.get('qty', 0)))

        # To'lov yozuvini ham tasdiqlangan deb belgilaymiz
        if payment_order:
            orders = load_payment_orders()
            if str(merchant_trans_id) in orders:
                orders[str(merchant_trans_id)].update({
                    'status': 'paid',
                    'txnId': str(click_trans_id),
                    'paidAt': target_sale.get('paidAt') or sign_time,
                    'source': 'click-webhook',
                })
                save_payment_orders(orders)
            target_sale['paymentOrderId'] = str(merchant_trans_id)

        # Update log
        logs = store_data.get('logs', [])
        amt_str = f"{int(req_amount):,}".replace(",", " ")
        logs.append({
            'type': 'Online buyurtma (Click Webhook)',
            'desc': (f"#{merchant_trans_id} buyurtmasi Click webhook orqali muvaffaqiyatli "
                     f"to'landi ({amt_str} so'm, paydoc #{click_paydoc_id or '—'})"),
            'time': sign_time or ''
        })

        try:
            db_manager.save_keys({
                'sales': sales,
                'products': products,
                'logs': logs
            })
        except Exception as e:
            return jsonify({
                'error': -7,
                'error_note': f'Failed to save order state: {str(e)}'
            })

        return jsonify({
            'click_trans_id': int(click_trans_id),
            'merchant_trans_id': merchant_trans_id,
            'merchant_confirm_id': int(click_trans_id),
            'error': 0,
            'error_note': 'Success'
        })

@app.route('/api/payment/status/<int:sale_id>', methods=['GET'])
@require_staff()
def get_payment_status(sale_id):
    try:
        store_data = db_manager.get_all()
        sales = store_data.get('sales', [])
        for s in sales:
            if s.get('id') == sale_id:
                return jsonify({'status': s.get('status', 'pending')})
    except Exception as e:
        print(f"Error checking payment status: {e}")
    return jsonify({'status': 'not_found'})

# ============================================================
# PAYME JSON-RPC WEBHOOK (Payme Merchant API)
# Hujjat: https://developer.help.paycom.uz/metody-merchant-api/
# ============================================================
PAYME_ERRORS = {
    'INVALID_AMOUNT': {'code': -31001, 'message': 'Invalid amount'},
    'ORDER_NOT_FOUND': {'code': -31050, 'message': 'Order not found'},
    'CANT_PERFORM': {'code': -31008, 'message': 'Unable to perform operation'},
    'TXN_NOT_FOUND': {'code': -31003, 'message': 'Transaction not found'},
    'AUTH': {'code': -32504, 'message': 'Authorization failed'},
    'METHOD': {'code': -32601, 'message': 'Method not found'},
}


def _payme_state(order):
    """Payme tranzaksiya holati: 1 = yaratilgan, 2 = bajarilgan, -2 = bekor qilingan."""
    if order.get('status') == 'paid':
        return 2
    if order.get('status') == 'cancelled':
        return -2
    return 1


def _payme_order_by_account(account):
    """Payme `account` maydonidan buyurtmani topadi (order_id yoki sale_id)."""
    account = account or {}
    for key in ('order_id', 'orderId', 'order', 'sale_id', 'saleId'):
        if key in account:
            order = load_payment_orders().get(str(account[key]))
            if order:
                return order
            sale = find_server_sale(account[key])
            if sale:
                orders = load_payment_orders()
                return next((o for o in orders.values()
                             if str(o.get('saleId')) == str(sale.get('id'))), None)
    return None


@app.route('/api/payment/payme', methods=['POST'])
def payme_webhook():
    """Payme Merchant API (JSON-RPC 2.0)."""
    payme_key = os.getenv('PAYME_KEY', '')
    req = request.get_json(silent=True) or {}
    req_id = req.get('id')
    method = req.get('method', '')
    params = req.get('params', {}) or {}

    def rpc_error(err):
        return jsonify({'jsonrpc': '2.0', 'id': req_id, 'error': err})

    def rpc_result(result):
        return jsonify({'jsonrpc': '2.0', 'id': req_id, 'result': result})

    # --- Autentifikatsiya: Basic base64("Paycom:<PAYME_KEY>") ---
    if not payme_key:
        return rpc_error({**PAYME_ERRORS['AUTH'], 'message': 'PAYME_KEY sozlanmagan'})

    auth_header = request.headers.get('Authorization', '')
    authorized = False
    if auth_header.startswith('Basic '):
        try:
            decoded = base64.b64decode(auth_header[6:]).decode('utf-8')
            _, _, provided = decoded.partition(':')
            authorized = hmac.compare_digest(provided, payme_key)
        except Exception:
            authorized = False
    if not authorized:
        return rpc_error(PAYME_ERRORS['AUTH'])

    order = _payme_order_by_account(params.get('account'))

    if method == 'CheckPerformTransaction':
        if not order:
            return rpc_error(PAYME_ERRORS['ORDER_NOT_FOUND'])
        amount_tiyin = int(round(float(params.get('amount', 0))))
        if abs(amount_tiyin - int(round(float(order.get('amount', 0)) * 100))) > 1:
            return rpc_error(PAYME_ERRORS['INVALID_AMOUNT'])
        return rpc_result({'allow': True})

    if method == 'CreateTransaction':
        if not order:
            return rpc_error(PAYME_ERRORS['ORDER_NOT_FOUND'])
        amount_tiyin = int(round(float(params.get('amount', 0))))
        if abs(amount_tiyin - int(round(float(order.get('amount', 0)) * 100))) > 1:
            return rpc_error(PAYME_ERRORS['INVALID_AMOUNT'])
        orders = load_payment_orders()
        orders[order['orderId']].update({
            'paymeTransactionId': params.get('id'),
            'paymeCreateTime': params.get('time'),
            'source': 'payme',
        })
        save_payment_orders(orders)
        return rpc_result({
            'create_time': params.get('time'),
            'transaction': params.get('id'),
            'state': _payme_state(order),
        })

    if method not in ('PerformTransaction', 'CancelTransaction', 'CheckTransaction', 'GetStatement'):
        return rpc_error(PAYME_ERRORS['METHOD'])
    if not order and method != 'GetStatement':
        return rpc_error(PAYME_ERRORS['TXN_NOT_FOUND'])

    if method == 'PerformTransaction':
        if order.get('status') != 'paid':
            _confirm_payment_order(order, params.get('id'), 'payme')
        return rpc_result({
            'perform_time': int(datetime.now().timestamp() * 1000),
            'transaction': params.get('id'),
            'state': 2,
        })

    if method == 'CancelTransaction':
        orders = load_payment_orders()
        orders[order['orderId']]['status'] = 'cancelled'
        save_payment_orders(orders)
        update_server_sale(order.get('saleId'), status='cancelled')
        return rpc_result({
            'cancel_time': int(datetime.now().timestamp() * 1000),
            'transaction': params.get('id'),
            'state': -2,
        })

    if method == 'CheckTransaction':
        return rpc_result({
            'create_time': order.get('paymeCreateTime') or 0,
            'perform_time': int(datetime.now().timestamp() * 1000) if order.get('status') == 'paid' else 0,
            'cancel_time': 0,
            'transaction': params.get('id'),
            'state': _payme_state(order),
            'reason': None,
        })

    # GetStatement
    return rpc_result({'transactions': []})


# ============================================================
# PAYNET / UZUM / PAYLOV — imzolangan umumiy callback
# Har bir provayder o'z imzosini yuboradi; tekshiruv:
#   sha256(orderId + amount + provider_secret)
# ============================================================
@app.route('/api/payment/callback/<provider>', methods=['POST'])
def generic_payment_callback(provider):
    provider = str(provider).lower()
    if provider not in ('paynet', 'uzum', 'paylov'):
        return jsonify({'status': 'error', 'message': 'Noma\'lum to\'lov tizimi'}), 404

    cfg = provider_settings(provider)
    secret = next(iter(cfg.get('secret', {}).values()), '')
    payload = request.get_json(silent=True) or {}
    token = (request.headers.get('X-Payment-Signature')
             or request.headers.get('X-Signature')
             or payload.get('signature') or payload.get('token') or '')

    valid = False
    if secret:
        expected = hashlib.sha256(
            f"{payload.get('orderId', '')}{payload.get('amount', '')}{secret}".encode('utf-8')
        ).hexdigest()
        valid = hmac.compare_digest(str(token), expected)
    if not valid and WEBHOOK_TOKEN:
        valid = hmac.compare_digest(str(token), WEBHOOK_TOKEN)
    if not valid:
        return jsonify({'status': 'error', 'message': 'Imzo tekshiruvidan o\'tmadi'}), 401

    order = load_payment_orders().get(str(payload.get('orderId', '')))
    if not order:
        return jsonify({'status': 'error', 'message': 'To\'lov yozuvi topilmadi'}), 404

    state = str(payload.get('status', payload.get('state', 'paid'))).lower()
    if state in ('paid', 'success', 'completed', '1'):
        _confirm_payment_order(order, payload.get('txnId') or payload.get('transactionId'), provider)
        return jsonify({'status': 'success', 'message': 'To\'lov tasdiqlandi'})

    if state in ('cancelled', 'canceled', 'failed', 'error'):
        orders = load_payment_orders()
        orders[order['orderId']]['status'] = 'cancelled'
        save_payment_orders(orders)
        update_server_sale(order.get('saleId'), status='cancelled')
        return jsonify({'status': 'success', 'message': 'To\'lov bekor qilindi'})

    return jsonify({'status': 'success', 'message': 'Holat qabul qilindi'})


@app.route('/api/payments/orders', methods=['GET'])
@require_staff('admin')
def payments_orders_list():
    """Admin uchun: oxirgi to'lov yozuvlari (maxfiy ma'lumotsiz)."""
    orders = list(load_payment_orders().values())
    orders.sort(key=lambda o: o.get('createdAt', ''), reverse=True)
    safe = [{
        'orderId': o.get('orderId'),
        'saleId': o.get('saleId'),
        'provider': o.get('provider'),
        'amount': o.get('amount'),
        'status': o.get('status'),
        'createdAt': o.get('createdAt'),
        'paidAt': o.get('paidAt'),
        'txnId': o.get('txnId'),
    } for o in orders[:100]]
    return jsonify({'status': 'success', 'count': len(safe), 'orders': safe})


@app.route('/api/security/status', methods=['GET'])
@require_staff('admin')
def security_status():
    """Server tomonidagi xavfsizlik holati — FAQAT admin/Boshliq.

    Ilgari autentifikatsiyasiz edi: CORS manbalari, ishonchli hostlar,
    Cloudflare/Turnstile holati va haqiqiy mijoz IP'si begona odamga
    ko'rinardi. Maxfiy kalit qiymatlari avvalgidek QAYTARILMAYDI.
    """
    return jsonify({
        'status': 'success',
        'securityHeaders': True,
        'httpsForced': FORCE_HTTPS,
        'rateLimit': {'max': RATE_LIMIT_MAX, 'windowSeconds': RATE_LIMIT_WINDOW},
        'webhookTokenConfigured': bool(WEBHOOK_TOKEN),
        'allowedOriginsConfigured': bool(ALLOWED_ORIGINS),
        'uploadWhitelist': sorted(ALLOWED_IMAGE_EXT),
        'maxUploadMb': round(app.config['MAX_CONTENT_LENGTH'] / (1024 * 1024), 1),
        'paymentsConfigured': [p for p in PAYMENT_PROVIDERS if provider_settings(p).get('enabled')],
        'database': db_manager.db_type,
        'serverTime': datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
        # Cloudflare holati (kalitlar oshkor qilinmaydi)
        'cloudflare': {
            'proxyTrusted': TRUST_CLOUDFLARE,
            'behindCloudflare': is_via_cloudflare(),
            'turnstileConfigured': CF_TURNSTILE_ENABLED,
            'turnstileSiteKeySet': bool(CF_TURNSTILE_SITE_KEY),
            'turnstileEnforced': CF_TURNSTILE_ENFORCE,
            'realClientIp': get_client_ip(),
            'autoAddDomain': CF_AUTO_ADD_DOMAIN,
            'widgetIdConfigured': bool(CF_TURNSTILE_WIDGET_ID),
            'apiTokenConfigured': bool(CF_API_TOKEN),
            'domainSync': CF_DOMAIN_SYNC,
        },
        'site': {
            'domain': SITE_DOMAIN or '(sozlanmagan)',
            'canonicalRedirect': CANONICAL_REDIRECT,
            'trustedHosts': TRUSTED_HOSTS,
            'corsOrigins': ALLOWED_ORIGINS,
        },
    })


# ============================================================
# S3 / OBYEKT SAQLASH — Railway Bucket (Tigris), AWS S3, MinIO
# ============================================================
# MUHIM (Railway Bucket): bucket'lar PRIVATE — "public access" yo'q, ya'ni
# to'g'ridan-to'g'ri ochiq havola (endpoint/bucket/key) HECH QACHON ishlamaydi
# (brauzer 403 oladi). Shu sababli:
#   1) Yuklash SERVER orqali (boto3) amalga oshiriladi;
#   2) Bazaga "ochiq" havola o'rniga `/media/<key>` yoziladi va fayl brauzerga
#      server tomonidan beriladi — vaqtinchalik imzolangan (presigned) havolaga
#      302 redirect qilinadi. Traffic bucket'dan ketadi (bucket egress bepul),
#      servis egress'i esa minimal bo'ladi.
#   3) S3_PUBLIC_URL faqat HAQIQIY ochiq bucket (AWS S3 public-read, R2 public
#      domen) uchun beriladi — o'shanda havola to'g'ridan-to'g'ri ishlatiladi.
#
# Boshqa muhim tuzatishlar:
#   • region_name MAJBURIY — Railway/Tigris uchun "auto" ishlatiladi
#     (Railway `REGION` o'zgaruvchisini ham beradi);
#   • URL uslubi: yangi Railway bucket'lari VIRTUAL-HOSTED uslubni talab qiladi
#     (eski bucket'lar path-style) — S3_ADDRESSING_STYLE orqali boshqariladi;
#   • Endpoint protokolsiz berilishi mumkin ("t3.storageapi.dev") →
#     avtomatik https:// qo'shiladi;
#   • Railway/Tigris ACL (public-read) ni qo'llab-quvvatlamaydi — ACL yuborilsa
#     "NotImplemented" xatosi qaytadi (standart: S3_USE_ACL=false).
S3_ENDPOINT = (os.getenv('S3_ENDPOINT') or os.getenv('ENDPOINT') or '').strip()
S3_ACCESS_KEY = (os.getenv('S3_ACCESS_KEY') or os.getenv('ACCESS_KEY_ID') or '').strip()
S3_SECRET_KEY = (os.getenv('S3_SECRET_KEY') or os.getenv('SECRET_ACCESS_KEY') or '').strip()
S3_BUCKET_NAME = (os.getenv('S3_BUCKET_NAME') or os.getenv('BUCKET') or '').strip()
S3_PUBLIC_URL = (os.getenv('S3_PUBLIC_URL') or '').strip().rstrip('/')
S3_REGION = (os.getenv('S3_REGION') or os.getenv('AWS_REGION')
             or os.getenv('REGION') or 'auto').strip()
S3_USE_ACL = (os.getenv('S3_USE_ACL', 'false') or '').strip().lower() == 'true'
# URL uslubi: 'auto' (boto3 o'zi tanlaydi — Railway uchun to'g'ri),
# 'virtual' (yangi Railway bucket'lari) yoki 'path' (eski bucket'lar).
S3_ADDRESSING_STYLE = (os.getenv('S3_ADDRESSING_STYLE') or 'auto').strip().lower()
if S3_ADDRESSING_STYLE not in ('auto', 'virtual', 'path'):
    S3_ADDRESSING_STYLE = 'auto'
# Presigned havola amal qilish muddati (sekund, 60s..7kun).
S3_MEDIA_TTL = max(60, min(7 * 24 * 3600,
                           int(os.getenv('S3_MEDIA_URL_TTL_SECONDS', '86400') or 86400)))


def _normalize_s3_endpoint(url):
    """Endpoint manzilini to'g'rilaydi: protokol qo'shadi, oxiridagi '/' ni oladi.

    Railway bucket endpointni protokolsiz ham beradi (masalan
    "t3.storageapi.dev") — bunday holatda boto3 "Invalid endpoint" xatosini
    bermasligi uchun https:// avtomatik qo'shiladi.
    """
    raw = str(url or '').strip().rstrip('/')
    if not raw:
        return ''
    if not raw.lower().startswith(('http://', 'https://')):
        raw = 'https://' + raw
    return raw


S3_ENDPOINT = _normalize_s3_endpoint(S3_ENDPOINT)


def s3_configured():
    """S3 (Railway Bucket) to'liq sozlanganligini bildiradi."""
    return bool(S3_ENDPOINT and S3_ACCESS_KEY and S3_SECRET_KEY and S3_BUCKET_NAME)


def s3_client():
    """boto3 S3 klienti (Railway/Tigris uchun mos sozlamalar bilan)."""
    if not _HAS_BOTO3:
        raise RuntimeError("boto3 moduli o'rnatilmagan — requirements.txt ni o'rnating")
    from botocore.config import Config as BotoConfig
    return boto3.client(
        's3',
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION or 'auto',
        config=BotoConfig(
            signature_version='s3v4',
            s3={'addressing_style': S3_ADDRESSING_STYLE},
            retries={'max_attempts': 3, 'mode': 'standard'},
            connect_timeout=10,
            read_timeout=30,
        ),
    )


def s3_public_url(key):
    """Bucket'dagi faylga TO'G'RIDAN-TO'G'RI havola (faqat diagnostika uchun).

    DIQQAT: Railway bucket'lari private — bu havola brauzerda 403 beradi.
    Brauzer uchun `media_url()` ishlatiladi.
    """
    return f'{S3_ENDPOINT}/{S3_BUCKET_NAME}/{key}'


def s3_presigned_url(key, expires=None):
    """Private bucket uchun vaqtinchalik imzolangan (presigned) GET havolasi."""
    client = s3_client()
    return client.generate_presigned_url(
        'get_object',
        Params={'Bucket': S3_BUCKET_NAME, 'Key': str(key)},
        ExpiresIn=int(expires or S3_MEDIA_TTL),
    )


def media_url(key):
    """Fayl uchun BRAUZERDA ishlaydigan havolani qaytaradi.

    Ustuvorlik:
      1) S3_PUBLIC_URL berilgan bo'lsa — haqiqiy ochiq bucket (AWS S3 public-read
         yoki Cloudflare R2 public domen) havolasi;
      2) S3 sozlangan bo'lsa — `/media/<key>`: fayl server orqali beriladi
         (Railway bucket private — bu yagona ishlaydigan yo'l);
      3) aks holda — lokal `/uploads/<key>`.

    Havola NISBIY: web va mobil (server origin'idan yuklangan) WebView uchun
    bir xil ishlaydi.
    """
    safe_key = str(key or '').replace('\\', '/').lstrip('/')
    if S3_PUBLIC_URL:
        return f'{S3_PUBLIC_URL}/{safe_key}'
    if s3_configured():
        return f'/media/{safe_key}'
    return f'/uploads/{safe_key}'


def s3_upload(file_obj, key, content_type='application/octet-stream'):
    """Faylni bucketga yuklaydi va ochiq havolani qaytaradi.

    Railway Bucket (Tigris) ACL'ni qo'llab-quvvatlamaydi, shuning uchun
    avval ACL'siz yuklanadi. `S3_USE_ACL=true` bo'lsa (AWS S3, MinIO kabi
    provayderlar uchun) ACL yuboriladi; ACL rad etilsa — avtomatik ACL'siz
    qayta uriniladi, ya'ni fayl baribir yuklanadi.
    """
    client = s3_client()
    extra = {
        'ContentType': content_type,
        'CacheControl': 'public, max-age=31536000',
        'ContentDisposition': 'inline',
    }

    def _put(with_acl):
        try:
            file_obj.seek(0)
        except Exception:
            pass
        args = dict(extra)
        if with_acl:
            args['ACL'] = 'public-read'
        client.upload_fileobj(file_obj, S3_BUCKET_NAME, key, ExtraArgs=args)

    if S3_USE_ACL:
        try:
            _put(True)
        except Exception as acl_error:
            print(f"[STORAGE] ACL bilan yuklab bo'lmadi, ACL'siz urinamiz: {acl_error}")
            _put(False)
    else:
        try:
            _put(False)
        except Exception as first_error:
            # Ba'zi S3 provayderlari ochiq o'qish uchun ACL talab qiladi
            text = str(first_error)
            if 'ACL' in text or 'AccessDenied' in text:
                _put(True)
            else:
                raise
    return media_url(key)


def s3_check():
    """Bucket bilan aloqani tekshiradi (diagnostika uchun).

    Tekshiriladi:
      1) bucket mavjudmi (head_bucket);
      2) test fayl yuklanadimi (boto3 → Railway);
      3) fayl QAYTA o'qiladimi (presigned GET) — Railway bucket'lari PRIVATE
         bo'lgani uchun "ochiq havola" tekshirilmaydi: brauzer uchun aynan
         presigned havola (`/media/<key>` orqali) ishlatiladi.
    """
    env_names = {'endpoint': bool(S3_ENDPOINT), 'accessKey': bool(S3_ACCESS_KEY),
                 'secretKey': bool(S3_SECRET_KEY), 'bucket': bool(S3_BUCKET_NAME),
                 'publicUrl': bool(S3_PUBLIC_URL)}
    if not s3_configured():
        return {'ok': False, 'configured': False, 'env': env_names,
                'message': "S3 sozlanmagan: Railway'da bucket → Variables orqali "
                           "BUCKET, ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY ni "
                           "servisga ulang (yoki .env da S3_ENDPOINT, S3_ACCESS_KEY, "
                           "S3_SECRET_KEY, S3_BUCKET_NAME to'ldirilsin)"}
    if not _HAS_BOTO3:
        return {'ok': False, 'configured': True, 'env': env_names,
                'message': "boto3 moduli o'rnatilmagan (requirements.txt)"}
    result = {'ok': False, 'configured': True, 'bucket': S3_BUCKET_NAME,
              'endpoint': S3_ENDPOINT, 'region': S3_REGION,
              'addressingStyle': S3_ADDRESSING_STYLE,
              'aclEnabled': S3_USE_ACL, 'publicUrl': S3_PUBLIC_URL,
              'env': env_names, 'private': not bool(S3_PUBLIC_URL)}
    try:
        client = s3_client()
        client.head_bucket(Bucket=S3_BUCKET_NAME)
        result['bucketReachable'] = True
    except Exception as e:
        result['bucketReachable'] = False
        result['message'] = f"Bucketga ulanib bo'lmadi: {e}"
        return result

    test_key = f"healthcheck/{uuid.uuid4().hex}.txt"
    try:
        import io
        payload = io.BytesIO(b'texno-park-storage-healthcheck')
        client.upload_fileobj(payload, S3_BUCKET_NAME, test_key,
                              ExtraArgs={'ContentType': 'text/plain'})
        result['uploaded'] = True
    except Exception as e:
        result['uploaded'] = False
        result['message'] = f"Test faylni yuklab bo'lmadi: {e}"
        return result

    # Presigned havola — brauzerga rasmlar AYNAN shu yo'l orqali beriladi
    try:
        url = s3_presigned_url(test_key, expires=300)
        result['presigned'] = True
        with urllib.request.urlopen(urllib.request.Request(url, method='GET'),
                                    timeout=10) as resp:  # nosec B310
            result['downloadOk'] = resp.status == 200
    except Exception as e:
        result['presigned'] = False
        result['downloadOk'] = False
        result['message'] = f"Presigned havola bilan o'qib bo'lmadi: {e}"
    finally:
        try:
            client.delete_object(Bucket=S3_BUCKET_NAME, Key=test_key)
        except Exception:
            pass

    if result.get('downloadOk'):
        result['ok'] = True
        result['mediaBase'] = '/media'
        result['message'] = ("Bucket ishlaydi — rasmlar `/media/<key>` orqali brauzerga "
                             "beriladi (private bucket uchun yagona to'g'ri yo'l)")
    elif 'message' not in result:
        result['message'] = "Yuklash ishladi, lekin faylni qayta o'qib bo'lmadi"
    return result


@app.route('/api/storage/check', methods=['GET', 'POST'])
@require_staff('admin')
def storage_check():
    """Admin uchun: Railway bucket (S3) aloqasini tekshirish."""
    return jsonify({'status': 'success', 'storage': s3_check()})




def get_uploads_dir():
    for vpath in ["/app/data", "/data", "/data/app", "/dara/app"]:
        try:
            if os.path.exists(vpath) or os.path.isdir(vpath):
                p = os.path.join(vpath, "uploads")
                os.makedirs(p, exist_ok=True)
                # Test write permission
                test_file = os.path.join(p, ".write_test")
                with open(test_file, 'w') as f:
                    f.write('test')
                os.remove(test_file)
                return p
        except Exception:
            pass
    p = os.path.join(app.root_path, 'uploads')
    os.makedirs(p, exist_ok=True)
    return p

def detect_image_magic(head):
    """Fayl mazmunidan rasm turini aniqlaydi (MIME spoofing himoyasi)."""
    if head.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if head.startswith(b'GIF87a') or head.startswith(b'GIF89a'):
        return 'image/gif'
    if head.startswith(b'BM'):
        return 'image/bmp'
    if len(head) >= 12 and head[0:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'image/webp'
    if len(head) >= 12 and head[4:12] == b'ftypavif':
        return 'image/avif'
    return ''


def validate_image_upload(file):
    """Rasm faylini xavfsizlik jihatidan tekshiradi. (ok, xabar) qaytaradi."""
    filename = secure_filename(file.filename or '')
    if not filename:
        return False, 'Fayl nomi bo\'sh yoki yaroqsiz'
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_IMAGE_EXT:
        return False, f"Ruxsat etilmagan kengaytma. Ruxsat etilgan: {', '.join(sorted(ALLOWED_IMAGE_EXT))}"

    claimed = (file.mimetype or '').lower()
    if claimed and claimed not in ALLOWED_IMAGE_MIME:
        return False, 'Ruxsat etilmagan fayl turi (MIME)'

    head = file.stream.read(16)
    file.stream.seek(0)
    detected = detect_image_magic(head)
    if not detected:
        return False, 'Fayl mazmuni rasm formatiga mos emas (yaroqsiz yoki buzilgan fayl)'
    return True, detected


@app.route('/api/upload', methods=['POST'])
@require_staff('admin', 'manager')
def upload_file():
    if 'file' not in request.files:
        return jsonify({'status': 'error', 'message': 'Fayl topilmadi'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'status': 'error', 'message': 'Fayl nomi bo\'sh'}), 400

    ok, info = validate_image_upload(file)
    if not ok:
        # Xavfsizlik hodisasi sifatida jurnalga yozamiz
        print(f"[SECURITY] Upload rad etildi ({get_client_ip()}): {info} | fayl={file.filename!r}")
        return jsonify({'status': 'error', 'message': info}), 400

    detected_mime = info
    filename = secure_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    if not ext:
        ext = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
               'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif'}.get(detected_mime, '.bin')
    # Papka (ixtiyoriy): bucket ichida tartibli saqlash — mahsulot rasmi,
    # logotip va filial belgisi alohida papkada turadi.
    folder = re.sub(r'[^a-z0-9_-]', '', (request.form.get('folder') or '').strip().lower())[:24]
    if folder not in ('products', 'logo', 'branches', 'contracts', 'receipts'):
        folder = 'products'
    unique_filename = f"{folder}/{uuid.uuid4().hex}{ext}"

    if s3_configured():
        if not _HAS_BOTO3:
            return jsonify({'status': 'error',
                            'message': "S3 sozlangan, lekin boto3 modulini o'rnatmadingiz"}), 500
        try:
            # Railway Bucket: ACL'siz yuklanadi (ACL qo'llab-quvvatlanmaydi).
            # Qaytgan havola brauzerda ishlaydigan `/media/<key>` (private bucket).
            media = s3_upload(file.stream or file, unique_filename, detected_mime)
            return jsonify({'status': 'success', 'url': media,
                            'key': unique_filename, 'storage': 's3'})
        except Exception as e:
            traceback.print_exc()
            detail = str(e)
            print(f"[STORAGE] S3 yuklash xatosi: {detail}")
            message = f"Bucket'ga yuklab bo'lmadi: {detail}"
            if 'NotImplemented' in detail or 'ACL' in detail:
                message = ("Bucket ACL (public-read) ni qo'llab-quvvatlamaydi. "
                           "S3_USE_ACL=false qilib qayta urinib ko'ring.")
            elif 'NoSuchBucket' in detail:
                message = f"Bucket topilmadi: {S3_BUCKET_NAME} (S3_BUCKET_NAME ni tekshiring)"
            elif 'InvalidAccessKeyId' in detail or 'SignatureDoesNotMatch' in detail:
                message = ("S3 kalitlari xato (S3_ACCESS_KEY / S3_SECRET_KEY). "
                           "Railway bucket kalitlarini qayta tekshiring.")
            return jsonify({'status': 'error', 'message': message}), 502
    else:
        # Lokal zaxira yo'l (Railway Volume yoki loyiha papkasi)
        try:
            uploads_dir = get_uploads_dir()
            file_path = os.path.join(uploads_dir, unique_filename)
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            file.stream.seek(0)
            file.save(file_path)
            return jsonify({'status': 'success', 'url': media_url(unique_filename),
                            'key': unique_filename, 'storage': 'local'})
        except Exception as e:
            return jsonify({'status': 'error', 'message': f"Lokal xotiraga yuklab bo'lmadi: {str(e)}"}), 500

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    return send_from_directory(get_uploads_dir(), filename)


# Faqat shu papkalar va xavfsiz kalit formati qabul qilinadi — bu bucket'dan
# ixtiyoriy obyektni o'qishga yo'l qo'ymaydi (key faqat yuklashda yaratiladi).
MEDIA_KEY_RE = re.compile(
    r'^(products|logo|branches|contracts|receipts)/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$')


@app.route('/media/<path:key>')
def serve_media(key):
    """Bucket'dagi (yoki lokal) faylni brauzerga beradi.

    NEGA KERAK: Railway bucket'lari PRIVATE — `https://<endpoint>/<bucket>/<key>`
    havolasi brauzerda 403 beradi. Shu sababli bazaga `/media/<key>` yoziladi va
    fayl shu endpoint orqali beriladi:
      1) lokal nusxa bo'lsa — to'g'ridan-to'g'ri (tez, bucketsiz rejim ham);
      2) S3 sozlangan bo'lsa — qisqa muddatli presigned havolaga 302 redirect.
         Traffic bucket'dan ketadi (bucket egress bepul), servis orqali
         og'ir fayl oqimi bo'lmaydi;
      3) hech biri bo'lmasa — 404.

    Havola tasodifiy UUID kalitdan iborat (capability URL) — shu sababli
    autentifikatsiya talab qilinmaydi (<img> token yubora olmaydi).
    """
    clean = str(key or '').replace('\\', '/').strip('/')
    if not clean or '..' in clean or not MEDIA_KEY_RE.match(clean):
        abort(404)

    # 1) Lokal nusxa — birinchi navbatda
    uploads_dir = get_uploads_dir()
    local_path = os.path.join(uploads_dir, *clean.split('/'))
    if os.path.isfile(local_path):
        resp = send_from_directory(uploads_dir, clean, conditional=True)
        resp.headers['Cache-Control'] = 'public, max-age=604800, immutable'
        return resp

    # 2) Bucket (private) — presigned havolaga yo'naltiramiz
    if not (s3_configured() and _HAS_BOTO3):
        abort(404)
    try:
        target = s3_presigned_url(clean)
    except Exception as e:
        print(f'[STORAGE] Rasm havolasini yaratib bo\'lmadi ({clean}): {e}')
        abort(502)
    resp = redirect(target, code=302)
    # Presigned havola muddatidan oldin keshlanmasin (redirect TTL qisqa)
    resp.headers['Cache-Control'] = f'public, max-age={min(S3_MEDIA_TTL, 3600)}'
    return resp


# ============================================================
# AI YORDAMCHI (faqat admin) — o'qish uchun mo'ljallangan kontekst
# ============================================================
# MUHIM XAVFSIZLIK QOIDASI: AI'ga hech qachon to'liq baza yuborilmaydi.
# Faqat agregat/hisoblangan ko'rsatkichlar (soni, summa, o'rtacha) ketadi.
# Mijoz ismi, telefoni, manzili, karta raqami kabi PII YUBORILMAYDI.
AI_API_KEY = os.getenv('AI_API_KEY', '').strip()
AI_API_URL = os.getenv('AI_API_URL', 'https://api.openai.com/v1/chat/completions').strip()
AI_MODEL = os.getenv('AI_MODEL', 'gpt-4o-mini').strip()
AI_TIMEOUT = int(os.getenv('AI_TIMEOUT_SECONDS', '25') or 25)
AI_MAX_MESSAGE = 1200          # bitta savol uzunligi chegarasi
AI_RATE_LIMIT_MAX = 20         # 1 daqiqada ruxsat etilgan AI savollari
AI_RATE_LIMIT_WINDOW = 60
_AI_REQUESTS = {}
_AI_LOCK = threading.Lock()


def ai_question_allowed(identity):
    """AI xarajatini suiiste'moldan himoya (foydalanuvchi/IP bo'yicha limit)."""
    now = time.time()
    with _AI_LOCK:
        stamps = [t for t in _AI_REQUESTS.get(identity, []) if now - t < AI_RATE_LIMIT_WINDOW]
        _AI_REQUESTS[identity] = stamps
        if len(stamps) >= AI_RATE_LIMIT_MAX:
            return False
        stamps.append(now)
        return True


def _safe_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _safe_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_date(value):
    """Turli formatdagi sanani YYYY-MM-DD ga keltiradi."""
    text = str(value or '').strip()[:19]
    for fmt in ('%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y', '%m/%d/%Y'):
        try:
            return datetime.strptime(text[:10], fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return ''


def build_ai_context():
    """Bazadan FAQAT agregat biznes ko'rsatkichlari (PII'siz, o'qish uchun)."""
    data = db_manager.get_all() or {}
    products = [p for p in (data.get('products') or []) if isinstance(p, dict)]
    customers = [c for c in (data.get('customers') or []) if isinstance(c, dict)]
    sales = [s for s in (data.get('sales') or []) if isinstance(s, dict)]
    logs = [l for l in (data.get('logs') or []) if isinstance(l, dict)]
    security = [e for e in (data.get('serverSecurityLog') or []) if isinstance(e, dict)]

    today = datetime.now().strftime('%Y-%m-%d')
    stock_total = sum(_safe_int(p.get('stock')) for p in products)
    stock_value = sum(_safe_int(p.get('stock')) * _safe_float(p.get('price')) for p in products)
    low_stock = [p for p in products if 0 < _safe_int(p.get('stock')) <= 5]
    out_stock = [p for p in products if _safe_int(p.get('stock')) <= 0]

    by_day = {}
    by_month = {}
    by_product = {}
    by_method = {}
    total_revenue = 0.0
    total_profit = 0.0
    today_revenue = 0.0
    today_count = 0
    for sale in sales:
        amount = _safe_float(sale.get('total')) or _safe_float(sale.get('amount'))
        profit = sale.get('profit')
        if profit in (None, ''):
            # Real foyda: (sotuv-tan narx)*dona - chegirma ulushi. Minus (zarar) ham saqlanadi.
            items = sale.get('items') or []
            sub = sum(_safe_float(i.get('price')) * _safe_int(i.get('qty')) for i in items if isinstance(i, dict))
            profit = 0.0
            for i in items:
                if not isinstance(i, dict):
                    continue
                line = _safe_float(i.get('price')) * _safe_int(i.get('qty'))
                share = (line / sub) if sub > 0 else 0
                profit += (_safe_float(i.get('price')) - _safe_float(i.get('cost'))) * _safe_int(i.get('qty')) - _safe_float(sale.get('discAmt')) * share
        else:
            profit = _safe_float(profit)
        day = _parse_date(sale.get('date') or sale.get('createdAt') or sale.get('time'))
        total_revenue += amount
        total_profit += profit
        if day:
            by_day[day] = by_day.get(day, 0) + amount
            by_month[day[:7]] = by_month.get(day[:7], 0) + amount
        if day == today:
            today_revenue += amount
            today_count += 1
        method = str(sale.get('provider') or sale.get('pay') or sale.get('method') or sale.get('payment') or 'naqd')[:20]
        by_method[method] = by_method.get(method, 0) + amount
        for item in (sale.get('items') or []):
            if isinstance(item, dict):
                name = str(item.get('name') or '—')[:60]
                qty = _safe_int(item.get('qty') or item.get('quantity'))
                by_product[name] = by_product.get(name, 0) + max(qty, 1)

    top_products = sorted(by_product.items(), key=lambda kv: kv[1], reverse=True)[:8]
    last_days = sorted(by_day.items())[-7:]
    staff = [{'name': str(u.get('name'))[:60], 'role': u.get('role')}
             for u in (db_manager.get_all() or {}).get('staff_users', []) if isinstance(u, dict)]

    security_high = sum(1 for e in security if e.get('level') in ('high', 'critical'))

    return {
        'sana': today,
        'mahsulot_soni': len(products),
        'ombor_jami_dona': stock_total,
        'ombor_qiymati_som': round(stock_value),
        'kam_qolgan_mahsulot_soni': len(low_stock),
        'tugagan_mahsulot_soni': len(out_stock),
        'mijoz_soni': len(customers),
        'savdo_soni': len(sales),
        'jami_daromad_som': round(total_revenue),
        'jami_foyda_som': round(total_profit),
        'bugungi_daromad_som': round(today_revenue),
        'bugungi_savdo_soni': today_count,
        'ortacha_chek_som': round(total_revenue / len(sales)) if sales else 0,
        'oxirgi_7_kun': {k: round(v) for k, v in last_days},
        'oylik_daromad': {k: round(v) for k, v in sorted(by_month.items())[-6:]},
        'eng_kop_sotilgan': [{'nomi': n, 'dona': q} for n, q in top_products],
        'tolov_usullari': {k: round(v) for k, v in by_method.items()},
        'xodimlar': staff,
        'amal_jurnali_soni': len(logs),
        'xavfsizlik_hodisalari': len(security),
        'yuqori_xavfli_hodisalar': security_high,
        'oxirgi_xavfsizlik_hodisalari': [
            {'turi': str(e.get('type'))[:40], 'daraja': e.get('level'),
             'vaqt': str(e.get('time'))[:20], 'izoh': str(e.get('message'))[:120]}
            for e in security[:5]
        ],
    }


def _fmt(number):
    try:
        return f"{int(round(float(number))):,}".replace(',', ' ')
    except (TypeError, ValueError):
        return '0'


def local_ai_answer(question, ctx):
    """Tashqi AI kaliti bo'lmasa — baza ko'rsatkichlari bo'yicha lokal javob."""
    q = (question or '').lower()

    def has(*words):
        return any(w in q for w in words)

    if has('savdo', 'daromad', 'tushum', 'pul', 'foyda', 'chek') and not has('qanday', 'qande'):
        return (f"📊 Savdo ko'rsatkichlari (real bazadan):\n"
                f"• Bugun: {ctx['bugungi_savdo_soni']} ta savdo — {_fmt(ctx['bugungi_daromad_som'])} so'm\n"
                f"• Jami: {ctx['savdo_soni']} ta savdo — {_fmt(ctx['jami_daromad_som'])} so'm\n"
                f"• O'rtacha chek: {_fmt(ctx['ortacha_chek_som'])} so'm\n"
                f"• Jami foyda (real, sotuv−tan narx): {_fmt(ctx['jami_foyda_som'])} so'm")
    if has('ombor', 'qoldiq', 'zaxira', 'stock'):
        return (f"📦 Ombor holati:\n"
                f"• Mahsulot turi: {ctx['mahsulot_soni']} ta\n"
                f"• Jami dona: {_fmt(ctx['ombor_jami_dona'])} dona\n"
                f"• Ombor qiymati: {_fmt(ctx['ombor_qiymati_som'])} so'm\n"
                f"• Kam qolgan (≤5 dona): {ctx['kam_qolgan_mahsulot_soni']} ta\n"
                f"• Tugagan: {ctx['tugagan_mahsulot_soni']} ta\n\n"
                f"Maslahat: tugagan va kam qolgan mahsulotlarni «Mahsulotlar» bo'limida filtrlab, yetkazib beruvchiga buyurtma bering.")
    if has('eng kop', 'eng ko\'p', 'top', 'reyting', 'ko\'p sotil'):
        rows = ctx.get('eng_kop_sotilgan') or []
        if not rows:
            return "📈 Hozircha savdo yo'q, shuning uchun eng ko'p sotilgan mahsulotni aniqlab bo'lmadi. Birinchi savdodan keyin bu ro'yxat to'ladi."
        body = '\n'.join(f"{i}. {r['nomi']} — {r['dona']} dona" for i, r in enumerate(rows, 1))
        return f"📈 Eng ko'p sotilgan mahsulotlar:\n{body}"
    if has('xavfsizlik', 'xavf', 'hujum', 'jinoyat', 'securit'):
        rows = ctx.get('oxirgi_xavfsizlik_hodisalari') or []
        body = '\n'.join(f"• [{r['daraja']}] {r['turi']} — {r['izoh']} ({r['vaqt']})" for r in rows) or '• Yozuvlar hozircha yo\'q'
        return (f"🛡 Xavfsizlik holati:\n"
                f"• Jami hodisa: {ctx['xavfsizlik_hodisalari']} ta\n"
                f"• Yuqori/xavfli daraja: {ctx['yuqori_xavfli_hodisalar']} ta\n"
                f"• Oxirgi hodisalar:\n{body}\n\n"
                f"Tavsiya: «Xavfsizlik» panelida yuqori darajali hodisalarni ko'rib chiqing va shubhali IP'ni bloklang.")
    if has('xodim', 'hodim', 'foydalanuvchi', 'kassir', 'menejer', 'admin'):
        rows = ctx.get('xodimlar') or []
        body = '\n'.join(f"• {r['name']} — {r['role']}" for r in rows) or '• Xodimlar yo\'q'
        return f"👥 Tizim xodimlari ({len(rows)} ta):\n{body}"
    if has('mijoz', 'xaridor', 'custom'):
        return (f"🧾 Mijozlar bazasi: {ctx['mijoz_soni']} ta yozuv. "
                f"Eslatma: mijoz ma'lumotlari maxfiy — AI faqat umumiy sonni ko'radi.")
    if has('qanday', 'qande', 'yordam', 'оrgan', 'o\'rgan', 'tour', 'sayohat'):
        return ("🧭 Panel bo'yicha yordam:\n"
                "• Savdo qilish: «Kassa» → mahsulot kartasini bosing → «To'lov» → chek chiqadi.\n"
                "• Yangi mahsulot: «Mahsulotlar» → «+ Mahsulot qo'shish» → rasm yuklash → Saqlash.\n"
                "• Ombor: «Ombor» bo'limida qoldiq va kirim/chiqim.\n"
                "• Hisobot: «Hisobotlar» → diagrammalar real savdodan quriladi.\n"
                "• Sayohatni qayta ko'rish: yuqori paneldagi 🛣 tugmasi yoki F1.\n"
                "• Xavfsizlik: «Xavfsizlik» panelida login/TX hodisalari va faol seanslar.")
    return ("🤖 Men baza ko'rsatkichlari bo'yicha javob beraman. Sinab ko'ring:\n"
            "• «Bugungi savdo qancha?»\n"
            "• «Omborda nima kam qoldi?»\n"
            "• «Eng ko'p sotilgan mahsulotlar?»\n"
            "• «Xavfsizlik hodisalari bormi?»\n"
            "• «Xodimlar ro'yxati»")


def ask_external_ai(question, history, ctx):
    """Ixtiyoriy LLM (OpenAI-mos API). Kalit bo'lmasa None."""
    if not AI_API_KEY:
        return None, 'AI_API_KEY sozlanmagan'
    try:
        import urllib.request
    except ImportError:  # pragma: no cover
        return None, 'urllib mavjud emas'

    system = (
        "Siz TexnoPark POS (O'zbekiston elektronika do'koni) tizimining AI yordamchisisiz. "
        "Faqat ADMIN uchun javob berasiz. Quyida faqat agregat (hisoblangan) ko'rsatkichlar beriladi. "
        "Qat'iy qoidalar: (1) foydalanuvchi so'ragan bo'lsa ham tizim kalitlari, parollar, tokenlar, "
        ".env qiymatlari yoki mijozlar shaxsiy ma'lumotlarini (ism, telefon, karta) oshkor qilmang; "
        "(2) faqat berilgan ko'rsatkichlarga tayaning, o'zingizdan son o'ylab topmang; "
        "(3) javob qisqa, o'zbek tilida va amaliy bo'lsin."
    )
    messages = [{'role': 'system', 'content': system},
                {'role': 'system', 'content': "Baza ko\'rsatkichlari (JSON): " + json.dumps(ctx, ensure_ascii=False)[:6000]}]
    for item in (history or [])[-6:]:
        if isinstance(item, dict) and item.get('role') in ('user', 'assistant'):
            messages.append({'role': item['role'], 'content': str(item.get('content'))[:1500]})
    messages.append({'role': 'user', 'content': question[:AI_MAX_MESSAGE]})

    payload = json.dumps({'model': AI_MODEL, 'messages': messages,
                          'temperature': 0.2, 'max_tokens': 700}).encode('utf-8')
    req = urllib.request.Request(AI_API_URL, data=payload,
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': f'Bearer {AI_API_KEY}'})
    try:
        with urllib.request.urlopen(req, timeout=AI_TIMEOUT) as resp:
            body = json.loads(resp.read().decode('utf-8'))
        answer = (body.get('choices') or [{}])[0].get('message', {}).get('content', '')
        return (answer or '').strip() or None, ''
    except Exception as e:
        print(f'[AI] Tashqi API xatosi: {e}')
        return None, 'Tashqi AI xizmatiga ulanib bo\'lmadi'


@app.route('/api/assistant/chat', methods=['POST'])
@require_staff('admin')
def assistant_chat():
    """Admin AI yordamchisi: faqat o'qish, kontekst agregat, javob auditga yoziladi."""
    staff = request.staff  # type: ignore[attr-defined]
    if not ai_question_allowed(str(staff.get('sub'))):
        server_security_log('ai-rate-limit', 'medium', 'AI savollari limiti oshib ketdi', staff.get('name'))
        return json_error('AI savollari juda ko\'p — birozdan so\'ng urinib ko\'ring', 429)

    body = request.get_json(silent=True) or {}
    question = str(body.get('message') or '').strip()
    question = ''.join(ch for ch in question if ch == '\n' or ch == '\t' or ord(ch) >= 32)[:AI_MAX_MESSAGE]
    if not question:
        return json_error('Savol bo\'sh')

    # Prompt-injection / sirlarni so'rashga qarshi nazorat
    lowered = question.lower()
    forbidden = ('password', 'parol', 'secret', '.env', 'api_key', 'token', 'private key',
                 'kalit', 'admin parol')
    if any(token in lowered for token in forbidden):
        server_security_log('ai-secret-attempt', 'high',
                            'AI orqali maxfiy ma\'lumot so\'raldi', staff.get('name'))
        return jsonify({'status': 'success', 'source': 'guard',
                        'answer': "🔒 Bu turdagi so'rov (parol, kalit, token, mijoz shaxsiy ma'lumoti) "
                                  "xavfsizlik siyosati bo'yicha bloklandi va jurnalga yozildi."})

    try:
        ctx = build_ai_context()
    except Exception as e:
        print(f'[AI] Kontekst xatosi: {e}')
        return json_error('Bazadan kontekst olishda xatolik', 500)

    history = body.get('history') if isinstance(body.get('history'), list) else []
    answer, note = ask_external_ai(question, history, ctx)
    source = 'llm'
    if not answer:
        answer = local_ai_answer(question, ctx)
        source = 'local'

    server_security_log('ai-assistant', 'low',
                        f'AI savol ({source}): {question[:80]}', staff.get('name'))

    return jsonify({'status': 'success', 'answer': answer, 'source': source,
                    'note': note, 'stats': {
                        'mahsulot_soni': ctx['mahsulot_soni'],
                        'savdo_soni': ctx['savdo_soni'],
                        'bugungi_daromad_som': ctx['bugungi_daromad_som'],
                        'mijoz_soni': ctx['mijoz_soni'],
                    }})


# Bir marta: ma'lum standart parolli akountlarni majburiy almashtirish rejimiga
# o'tkazamiz. Bu `flask run`/WSGI orqali ishga tushirilganda ham bajariladi.
try:
    audit_default_passwords()
except Exception as _audit_err:  # pragma: no cover
    print(f'[SECURITY] Standart parollar auditi xatosi: {_audit_err}')


if __name__ == '__main__':
    debug_mode = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'
    # Boshliq (rahbariyat) akountini idempotent yaratadi — parol FAQAT xesh
    # ko'rinishida saqlanadi, manba `.env` dagi BOSS_DEFAULT_PASSWORD dan olinadi.
    try:
        ensure_boss_account()
    except Exception as _boss_err:  # pragma: no cover
        print(f'[SECURITY] Boshliq akountini tekshirishda xato: {_boss_err}')
    # Sayt domeni (SITE_DOMAIN) bo'lsa — Turnstile widgetiga qo'shishni fonda boshlaymiz
    start_domain_sync()
    turnstile_mode = 'ochirilgan'
    if CF_TURNSTILE_ENABLED:
        turnstile_mode = 'majburiy' if CF_TURNSTILE_ENFORCE else 'ixtiyoriy'
    print(f"Sayt domeni: {SITE_DOMAIN or '(SITE_DOMAIN .env da yozilmagan)'}"
          f" | kanonik yonaltirish: {'ON' if CANONICAL_REDIRECT else 'OFF'}")
    print(f"Cloudflare: proxy ishonchi {'ON' if TRUST_CLOUDFLARE else 'OFF'}"
          f" | Turnstile: {turnstile_mode}"
          f" | avtomatik domen qoshish: {'ON' if (CF_AUTO_ADD_DOMAIN and CF_API_TOKEN) else 'OFF'}")
    print(f"Server {PORT}-portda ishlamoqda. Baza turi: {db_manager.db_type}"
          f" | DB: {db_manager.db_path or '(ulanish hali ochilmagan)'}")
    print(f"Debug rejimi: {'YOQILGAN (faqat lokal ishlab chiqish uchun!)' if debug_mode else 'o\'chirilgan (xavfsiz)'}")
    print(f"To'lov tizimlari: {[p for p in PAYMENT_PROVIDERS if provider_settings(p).get('enabled')] or 'faqat Naqd/Karta'}")
    # DIQQAT: debug=True ni productionda yoqmang — Werkzeug debugger orqali RCE xavfi bor.
    app.run(host='0.0.0.0', port=PORT, debug=debug_mode)
