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

class DBManager:
    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', '')
        self.db_type = 'sqlite'
        
        if self.db_url.startswith(('postgresql://', 'postgres://')):
            self.db_type = 'postgres'
        elif self.db_url.startswith('mysql://'):
            self.db_type = 'mysql'
            
    def get_connection(self):
        if self.db_type == 'postgres':
            import pg8000
            # Safely parse postgresql://username:password@host:port/database
            url = self.db_url.replace('postgresql://', 'postgres://')
            url = url[11:] # remove postgres://
            auth, rest = url.split('@')
            user, password = auth.split(':')
            host_port, db = rest.split('/')
            if ':' in host_port:
                host, port = host_port.split(':')
                port = int(port)
            else:
                host = host_port
                port = 5432
            if '?' in db:
                db = db.split('?')[0]
            return pg8000.connect(user=user, password=password, host=host, port=port, database=db)
            
        elif self.db_type == 'mysql':
            import pymysql
            url = self.db_url[8:] # remove mysql://
            auth, rest = url.split('@')
            user, password = auth.split(':')
            host_port, db = rest.split('/')
            if ':' in host_port:
                host, port = host_port.split(':')
                port = int(port)
            else:
                host = host_port
                port = 3306
            if '?' in db:
                db = db.split('?')[0]
            return pymysql.connect(host=host, user=user, password=password, database=db, port=port)
            
        else:
            db_path = os.getenv('DB_PATH', os.path.join('Data', 'database.db'))
            db_dir = os.path.dirname(db_path)
            if db_dir:
                os.makedirs(db_dir, exist_ok=True)
            return sqlite3.connect(db_path)

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

# S3 configurations for Railway Bucket
S3_ENDPOINT = os.getenv('S3_ENDPOINT')
S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY')
S3_SECRET_KEY = os.getenv('S3_SECRET_KEY')
S3_BUCKET_NAME = os.getenv('S3_BUCKET_NAME', 'collected-drawer')
S3_PUBLIC_URL = os.getenv('S3_PUBLIC_URL')

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
        # Local fallback
        try:
            uploads_dir = os.path.join(app.root_path, 'uploads')
            os.makedirs(uploads_dir, exist_ok=True)
            file_path = os.path.join(uploads_dir, unique_filename)
            file.save(file_path)
            return jsonify({'status': 'success', 'url': f"/uploads/{unique_filename}"})
        except Exception as e:
            return jsonify({'status': 'error', 'message': f"Lokal xotiraga yuklab bo'lmadi: {str(e)}"}), 500

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    return send_from_directory('uploads', filename)

if __name__ == '__main__':
    print(f"Server {PORT}-portda ishlamoqda. Baza turi: {db_manager.db_type}")
    app.run(host='0.0.0.0', port=PORT, debug=True)
