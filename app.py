import os
import re
import functools
import threading
import sqlite3
import json
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
from datetime import datetime, timedelta, timezone
from flask import Flask, request, jsonify, send_from_directory, redirect
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

load_dotenv()

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
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGINS or "*"}})

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
import threading

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

    Ustuvorlik: CF-Connecting-IP (faqat TRUST_CLOUDFLARE=true bo'lsa) →
    X-Forwarded-For (birinchi qiymat) → bevosita ulanish IP'si.
    Fake sarlavhalar orqali IP limitlarini chetlab o'tishning oldi olinadi.
    """
    if TRUST_CLOUDFLARE:
        cf_ip = (request.headers.get('CF-Connecting-IP') or '').strip()
        if cf_ip:
            return cf_ip[:60]
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

    body = {'name': result.get('name') or 'Texno Park POS',
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
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://challenges.cloudflare.com https://accounts.google.com https://*.google.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; "
        "img-src 'self' data: blob: https:; "
        "connect-src 'self' https:; "
        "frame-src https://challenges.cloudflare.com https://accounts.google.com https://*.click.uz https://checkout.paycom.uz https://*.uzumbank.uz; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    ))
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('X-XSS-Protection', '1; mode=block')
    response.headers.setdefault('Permissions-Policy',
                                'geolocation=(), microphone=(), camera=(), payment=(self)')
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
            except:
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
            
        self._pg_pool = None
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
            db_path = os.getenv('DB_PATH')
            if not db_path:
                for vpath in ["/app/data", "/data", "/data/app", "/dara/app"]:
                    try:
                        if os.path.exists(vpath) or os.path.isdir(vpath):
                            # Test if directory is writeable
                            test_file = os.path.join(vpath, ".write_test")
                            with open(test_file, 'w') as f:
                                f.write('test')
                            os.remove(test_file)
                            
                            db_path = os.path.join(vpath, "database.db")
                            break
                    except:
                        pass
                if not db_path:
                    db_path = os.path.join('Data', 'database.db')
            
            try:
                db_dir = os.path.dirname(db_path)
                if db_dir:
                    os.makedirs(db_dir, exist_ok=True)
                return sqlite3.connect(db_path)
            except Exception as e:
                print(f"Failed to connect to SQLite at {db_path}: {str(e)}. Falling back to local project database.")
                fallback_path = os.path.join('Data', 'database.db')
                fallback_dir = os.path.dirname(fallback_path)
                if fallback_dir:
                    os.makedirs(fallback_dir, exist_ok=True)
                return sqlite3.connect(fallback_path)

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
        conn.commit()
        conn.close()

    def get_all(self):
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT key, value FROM store_data')
        rows = cursor.fetchall()
        conn.close()
        
        data = {}
        for row in rows:
            data[row[0]] = json.loads(row[1])
        return data

    def save_keys(self, data_dict):
        conn = self.get_connection()
        cursor = conn.cursor()
        
        for key, val in data_dict.items():
            val_str = json.dumps(val, ensure_ascii=False)
            
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
        conn.close()

db_manager = DBManager()
db_manager.init_db()


# ============================================================
# 1) AUTENTIFIKATSIYA VA AVTORIZATSIYA (server tomonida)
# ============================================================
# Xavfsizlik qoidasi (darsliklardan): autentifikatsiya va avtorizatsiya faqat
# serverda hal qilinadi. Shuning uchun muhim API'lar endi imzolangan token
# talab qiladi: baza sinxronizatsiyasi, AI yordamchi va fayl yuklash.
STAFF_ROLES = ('admin', 'cashier', 'manager')
TOKEN_TTL_HOURS = max(1, min(72, int(os.getenv('API_TOKEN_TTL_HOURS', '12') or 12)))
LOGIN_MAX_ATTEMPTS = max(3, min(30, int(os.getenv('LOGIN_MAX_ATTEMPTS', '8') or 8)))
LOGIN_WINDOW_SECONDS = 300

_AUTH_SECRET = ''
_login_attempts = {}
_login_lock = threading.Lock()


def hash_password(password, salt):
    """Frontend bilan bir xil sxema: sha256(salt + '::' + parol)."""
    return hashlib.sha256(f'{salt}::{password}'.encode('utf-8')).hexdigest()


def make_salt(prefix='tp'):
    return f'{prefix}-{secrets.token_hex(6)}'


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


# Standart xodimlar (frontend'dagi bilan bir xil parol sxemasi).
# Productionda STAFF_DEFAULT_PASSWORD orqali almashtiring yoki
# /api/auth/change-password orqali parolni yangilang.
_DEFAULT_STAFF = [
    {'login': 'admin', 'salt': 'tp-adm-9x2', 'name': 'Abdullayev Admin', 'role': 'admin'},
    {'login': 'cashier', 'salt': 'tp-csh-4k7', 'name': 'Karimov Kassir', 'role': 'cashier'},
    {'login': 'manager', 'salt': 'tp-mng-3z8', 'name': 'Toshmatov Menejer', 'role': 'manager'},
    {'login': 'customer', 'salt': 'tp-usr-6q1', 'name': 'Online Xaridor', 'role': 'customer'},
    {'login': 'admin@texnopark.uz', 'salt': 'tp-adm-9x2', 'name': 'Abdullayev Admin', 'role': 'admin'},
    {'login': 'cashier@texnopark.uz', 'salt': 'tp-csh-4k7', 'name': 'Karimov Kassir', 'role': 'cashier'},
    {'login': 'manager@texnopark.uz', 'salt': 'tp-mng-3z8', 'name': 'Toshmatov Menejer', 'role': 'manager'},
]
_DEFAULT_PASSWORD = '123456'


def load_staff():
    """Xodimlar ro'yxatini qaytaradi; bo'lmasa .env asosida seed qiladi."""
    try:
        data = db_manager.get_all() or {}
        staff = data.get('staff_users')
    except Exception:
        staff = None
    if isinstance(staff, list) and staff:
        return staff

    password = (os.getenv('STAFF_DEFAULT_PASSWORD') or '').strip() or _DEFAULT_PASSWORD
    seeded = []
    for item in _DEFAULT_STAFF:
        salt = item['salt'] if password == _DEFAULT_PASSWORD else make_salt('tp-' + item['role'][:3] + '-')
        seeded.append({
            'login': item['login'],
            'salt': salt,
            'passHash': hash_password(password, salt),
            'name': item['name'],
            'role': item['role'],
            'mustChange': password == _DEFAULT_PASSWORD,
        })
    try:
        db_manager.save_keys({'staff_users': seeded})
    except Exception as e:
        print(f'[SECURITY] Xodimlarni saqlab bo\'lmadi: {e}')
    if password == _DEFAULT_PASSWORD:
        print("[SECURITY] Standart parol (123456) ishlatilmoqda! "
              "Iltimos, STAFF_DEFAULT_PASSWORD o'rnating yoki parollarni o'zgartiring.")
    return seeded


def find_staff(login):
    key = str(login or '').strip().lower()
    for user in load_staff():
        if str(user.get('login', '')).lower() == key:
            return user
    return None


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
        'role': user.get('role'),
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
    """So'rovdagi tokendan foydalanuvchini oladi."""
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
            allowed = roles or STAFF_ROLES
            if payload.get('role') not in allowed:
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


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    """Xodim login: parol bazadagi xesh bilan tekshiriladi, token qaytariladi."""
    ip = get_client_ip()
    if not login_allowed(ip):
        server_security_log('login-rate-limit', 'high', 'Juda ko\'p login urinishi (brute-force)', '—')
        return jsonify({'status': 'error', 'code': 'rate_limited',
                        'message': 'Juda ko\'p urinish. Bir necha daqiqadan so\'ng qayta urinib ko\'ring'}), 429

    payload = request.get_json(silent=True) or {}
    login = str(payload.get('login') or '').strip()[:120]
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

    user = find_staff(login)
    ok = bool(user) and hmac.compare_digest(
        hash_password(password, user.get('salt', '')), str(user.get('passHash', '')))
    if not ok:
        register_login_attempt(ip)
        server_security_log('login-failed', 'medium', f'Muvaffaqiyatsiz login: {login}', login)
        return jsonify({'status': 'error', 'code': 'bad_credentials',
                        'message': 'Login yoki parol xato'}), 401

    token, payload = create_token(user)
    session = register_session(payload)
    server_security_log('login-success', 'low',
                        f'Kirish: {user.get("role")} · {session.get("device")}', user.get('name'))
    return jsonify({
        'status': 'success',
        'token': token,
        'expiresIn': TOKEN_TTL_HOURS * 3600,
        'mustChangePassword': bool(user.get('mustChange')),
        'user': {'login': user.get('login'), 'name': user.get('name'), 'role': user.get('role')},
    })


@app.route('/api/auth/session', methods=['GET'])
def auth_session():
    payload = current_staff()
    if not payload:
        return jsonify({'status': 'error', 'code': 'unauthorized'}), 401
    return jsonify({'status': 'success', 'user': {
        'login': payload.get('sub'), 'name': payload.get('name'), 'role': payload.get('role'),
    }, 'exp': payload.get('exp')})


@app.route('/api/auth/change-password', methods=['POST'])
def auth_change_password():
    """Parolni almashtirish: o'zi yoki admin boshqa xodim uchun."""
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
    if not is_self and payload.get('role') != 'admin':
        server_security_log('password-change-denied', 'high',
                            f'Boshqa xodim parolini o\'zgartirishga urinish: {target_login}',
                            payload.get('name', '—'))
        return jsonify({'status': 'error', 'code': 'forbidden',
                        'message': 'Faqat administrator boshqa xodim parolini o\'zgartira oladi'}), 403

    staff = load_staff()
    target = None
    for item in staff:
        if str(item.get('login', '')).lower() == target_login.lower():
            target = item
            break
    if not target:
        return jsonify({'status': 'error', 'message': 'Xodim topilmadi'}), 404

    if is_self:
        if not hmac.compare_digest(hash_password(current_password, target.get('salt', '')),
                                   str(target.get('passHash', ''))):
            server_security_log('password-change-failed', 'medium',
                                'Joriy parol xato', target_login)
            return jsonify({'status': 'error', 'message': 'Joriy parol xato'}), 401

    salt = make_salt('tp-' + str(target.get('role', 'usr'))[:3] + '-')
    target['salt'] = salt
    target['passHash'] = hash_password(new_password, salt)
    target['mustChange'] = False
    target['updatedAt'] = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    try:
        db_manager.save_keys({'staff_users': staff})
    except Exception:
        return jsonify({'status': 'error', 'message': 'Parolni saqlab bo\'lmadi'}), 500

    server_security_log('password-changed', 'medium', f'Parol yangilandi: {target_login}',
                        payload.get('name', '—'))
    # Parol o'zgargani uchun shu xodimning barcha eski sessiyalari yopiladi
    new_token, new_payload = create_token(target)
    revoke_login_sessions(target_login, keep_jti=new_payload.get('jti'))
    register_session(new_payload)
    return jsonify({'status': 'success', 'message': 'Parol yangilandi. Qayta kiring.',
                    'token': new_token})


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


@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/robots.txt')
def serve_robots():
    """Qidiruv botlari uchun: boshqaruv va API yo'llari indekslanmasin."""
    body = ('User-agent: *\n'
            'Allow: /\n'
            'Disallow: /api/\n'
            'Disallow: /uploads/\n'
            'Crawl-delay: 10\n')
    return app.response_class(body, mimetype='text/plain')


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


@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

@app.route('/api/config', methods=['GET'])
def get_config():
    """Frontend uchun xavfsiz (maxfiy bo'lmagan) konfiguratsiya."""
    return jsonify({
        'googleClientId': os.getenv('GOOGLE_CLIENT_ID', ''),
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

# Sinxronizatsiyada qabul qilinadigan kalitlar va ularning chegaralari
SYNC_ALLOWED_KEYS = {
    'products': 4000, 'customers': 20000, 'sales': 50000, 'logs': 500,
    'contracts': 20000, 'discounts': 500, 'smsHistory': 500,
    'salaryRecords': 5000, 'salaryHistory': 20000, 'securityLog': 1000,
}
IMAGE_DATA_LIMIT = 900 * 1024          # bitta rasm (base64) uchun chegara
MAX_IMAGE_ITEMS = 400                  # bazada saqlanadigan rasm soni
ALLOWED_IMAGE_PREFIXES = ('data:image/jpeg;base64,', 'data:image/png;base64,',
                          'data:image/webp;base64,', 'data:image/gif;base64,')


def json_error(message, code=400, status='error'):
    """Ichki ma'lumot ochilmaydigan xato javobi."""
    return jsonify({'status': status, 'message': message}), code


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
        ikpu = re.sub(r'\D', '', str(product.get('ikpu') or ''))[:17]
        if ikpu and len(ikpu) != 17:
            return False, 'IKPU (MXIK) kodi 17 xonali bo\'lishi kerak', None
        product['ikpu'] = ikpu
        product['packageCode'] = re.sub(r'[^A-Za-z0-9]', '', str(product.get('packageCode') or ''))[:20]
        try:
            vat = float(product.get('vatPercent', 12) or 0)
        except (TypeError, ValueError):
            vat = 0.0
        product['vatPercent'] = min(max(vat, 0.0), 100.0)

    # Fiskal maydonlar FAQAT server tomonidan yoziladi — brauzer ularni
    # yuborsa ham qabul qilinmaydi (soxta fiskal belgi yasab bo'lmasin).
    for sale in clean.get('sales', []):
        for field in ('fiscalStatus', 'fiscalProvider', 'fiscalUrl', 'fiscalSign',
                      'fiscalNumber', 'fiscalDeviceId', 'fiscalTime', 'fiscalTotal',
                      'fiscalError'):
            sale.pop(field, None)

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


@app.route('/api/data', methods=['GET'])
@require_staff()
def get_data():
    """To'liq baza (mijoz PII, savdo, loglar) — faqat xodimlar uchun."""
    try:
        return jsonify(db_manager.get_all() or {})
    except Exception as e:
        print(f'[ERROR] /api/data: {e}')
        return json_error('Ma\'lumotni olishda xatolik', 500)


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

    try:
        apply_image_keep(clean.get('products') or [])
        apply_fiscal_keep(clean.get('sales') or [])
        db_manager.save_keys(clean)
        return jsonify({'status': 'success', 'message': 'Ma\'lumotlar muvaffaqiyatli saqlandi',
                        'savedKeys': sorted(clean.keys())})
    except Exception as e:
        print(f'[ERROR] /api/sync: {e}')
        return json_error('Ma\'lumotni saqlashda xatolik', 500)


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


@app.route('/api/reports', methods=['POST'])
def save_feedback_report():
    data = request.json
    if not data or not data.get('message'):
        return jsonify({'status': 'error', 'message': 'Xabar kiritilmadi'}), 400
        
    try:
        db_manager.save_report(
            data.get('type', 'complaint'),
            data.get('message'),
            data.get('contact', ''),
            data.get('date', ''),
            data.get('time', ''),
            data.get('user', 'Mehmon')
        )
        return jsonify({'status': 'success', 'message': 'Murojaat muvaffaqiyatli yozildi'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/payments/create', methods=['POST'])
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
    except:
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
    if my_sign != sign_string:
        return jsonify({
            'error': -1,
            'error_note': 'Sign string mismatch'
        })

    try:
        req_amount = float(amount)
    except:
        req_amount = 0.0

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

    if action_int == 0:
        if target_sale.get('status') == 'paid':
            return jsonify({
                'error': -4,
                'error_note': 'Order already paid'
            })
            
        return jsonify({
            'click_trans_id': int(click_trans_id),
            'merchant_trans_id': merchant_trans_id,
            'merchant_prepare_id': int(click_trans_id),
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
            'desc': f"#{merchant_trans_id} buyurtmasi Click webhook orqali muvaffaqiyatli to'landi ({amt_str} so'm)",
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
def security_status():
    """Server tomonidagi xavfsizlik holati (parol/kalit qiymatlari oshkor qilinmaydi)."""
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


# S3 configurations for Railway Bucket
S3_ENDPOINT = os.getenv('S3_ENDPOINT') or os.getenv('ENDPOINT')
S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY') or os.getenv('ACCESS_KEY_ID')
S3_SECRET_KEY = os.getenv('S3_SECRET_KEY') or os.getenv('SECRET_ACCESS_KEY')
S3_BUCKET_NAME = os.getenv('S3_BUCKET_NAME') or os.getenv('BUCKET') or 'collected-drawer'
S3_PUBLIC_URL = os.getenv('S3_PUBLIC_URL')

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
        except:
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
    unique_filename = f"{uuid.uuid4().hex}{ext}"

    if S3_ENDPOINT and S3_ACCESS_KEY and S3_SECRET_KEY:
        if not _HAS_BOTO3:
            return jsonify({'status': 'error',
                            'message': "S3 sozlangan, lekin boto3 modulini o'rnatmadingiz"}), 500
        try:
            s3_client = boto3.client(
                's3',
                endpoint_url=S3_ENDPOINT,
                aws_access_key_id=S3_ACCESS_KEY,
                aws_secret_access_key=S3_SECRET_KEY
            )
            s3_client.upload_fileobj(
                file,
                S3_BUCKET_NAME,
                unique_filename,
                ExtraArgs={'ACL': 'public-read', 'ContentType': detected_mime}
            )
            if S3_PUBLIC_URL:
                public_url = f"{S3_PUBLIC_URL.rstrip('/')}/{unique_filename}"
            else:
                public_url = f"{S3_ENDPOINT.rstrip('/')}/{S3_BUCKET_NAME}/{unique_filename}"
            return jsonify({'status': 'success', 'url': public_url})
        except Exception as e:
            return jsonify({'status': 'error', 'message': f"S3 ga yuklab bo'lmadi: {str(e)}"}), 500
    else:
        # Local fallback using Railway Volume if available
        try:
            uploads_dir = get_uploads_dir()
            file_path = os.path.join(uploads_dir, unique_filename)
            file.save(file_path)
            return jsonify({'status': 'success', 'url': f"/uploads/{unique_filename}"})
        except Exception as e:
            return jsonify({'status': 'error', 'message': f"Lokal xotiraga yuklab bo'lmadi: {str(e)}"}), 500

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    return send_from_directory(get_uploads_dir(), filename)


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
        profit = _safe_float(sale.get('profit'))
        if not profit:
            profit = amount * 0.20
        day = _parse_date(sale.get('date') or sale.get('createdAt') or sale.get('time'))
        total_revenue += amount
        total_profit += profit
        if day:
            by_day[day] = by_day.get(day, 0) + amount
            by_month[day[:7]] = by_month.get(day[:7], 0) + amount
        if day == today:
            today_revenue += amount
            today_count += 1
        method = str(sale.get('method') or sale.get('payment') or 'naqd')[:20]
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
                f"• Jami foyda (20% marja): {_fmt(ctx['jami_foyda_som'])} so'm")
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


if __name__ == '__main__':
    debug_mode = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'
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
    print(f"Server {PORT}-portda ishlamoqda. Baza turi: {db_manager.db_type}")
    print(f"Debug rejimi: {'YOQILGAN (faqat lokal ishlab chiqish uchun!)' if debug_mode else 'o\'chirilgan (xavfsiz)'}")
    print(f"To'lov tizimlari: {[p for p in PAYMENT_PROVIDERS if provider_settings(p).get('enabled')] or 'faqat Naqd/Karta'}")
    # DIQQAT: debug=True ni productionda yoqmang — Werkzeug debugger orqali RCE xavfi bor.
    app.run(host='0.0.0.0', port=PORT, debug=debug_mode)
