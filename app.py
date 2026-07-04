import os
import sqlite3
import json
import uuid
import boto3
from flask import Flask, request, jsonify, send_from_directory
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

load_dotenv()

app = Flask(__name__, static_folder='.')

PORT = int(os.getenv('PORT', 5000))

from urllib.parse import urlparse

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
            
    def get_connection(self):
        if self.db_type == 'postgres':
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
        elif self.db_type == 'mysql':
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS store_data (
                    `key` VARCHAR(255) PRIMARY KEY,
                    `value` LONGTEXT
                )
            ''')
        else:
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS store_data (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            ''')
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

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'googleClientId': os.getenv('GOOGLE_CLIENT_ID', ''),
        'clickMerchantId': os.getenv('CLICK_MERCHANT_ID', ''),
        'clickServiceId': os.getenv('CLICK_SERVICE_ID', ''),
        'clickMerchantUserId': os.getenv('CLICK_MERCHANT_USER_ID', ''),
        'clickPhone': os.getenv('CLICK_PHONE', '')
    })

@app.route('/api/data', methods=['GET'])
def get_data():
    try:
        data = db_manager.get_all()
        return jsonify(data)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/sync', methods=['POST'])
def sync_data():
    req_data = request.json
    if not req_data:
        return jsonify({'status': 'error', 'message': 'Ma\'lumot topilmadi'}), 400
    
    try:
        db_manager.save_keys(req_data)
        return jsonify({'status': 'success', 'message': 'Ma\'lumotlar muvaffaqiyatli saqlandi'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

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

    # Find matching order
    target_sale = None
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

@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'status': 'error', 'message': 'Fayl topilmadi'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'status': 'error', 'message': 'Fayl nomi bo\'sh'}), 400
        
    filename = secure_filename(file.filename)
    ext = os.path.splitext(filename)[1]
    unique_filename = f"{uuid.uuid4().hex}{ext}"
    
    if S3_ENDPOINT and S3_ACCESS_KEY and S3_SECRET_KEY:
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
                ExtraArgs={'ACL': 'public-read', 'ContentType': file.content_type}
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

if __name__ == '__main__':
    print(f"Server {PORT}-portda ishlamoqda. Baza turi: {db_manager.db_type}")
    app.run(host='0.0.0.0', port=PORT, debug=True)
