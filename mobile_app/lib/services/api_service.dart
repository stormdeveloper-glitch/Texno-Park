import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Server javobidagi xato (xabar foydalanuvchiga ko'rsatiladi).
class ApiException implements Exception {
  final String message;
  final int statusCode;
  final String code;

  ApiException(this.message, {this.statusCode = 0, this.code = ''});

  bool get isUnauthorized => statusCode == 401;

  @override
  String toString() => message;
}

/// Flask backend bilan aloqa. Barcha himoyalangan so'rovlar
/// `Authorization: Bearer <token>` sarlavhasi bilan yuboriladi.
class ApiService {
  /// Server manzili build paytida o'zgartiriladi:
  ///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5000
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://texno-park-production.up.railway.app',
  );

  static const Duration _timeout = Duration(seconds: 20);

  static String? token;

  /// Nisbiy rasm manzilini (/uploads/...) to'liq URL ga aylantiradi.
  static String absoluteUrl(String path) {
    if (path.isEmpty || path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('data:')) return '';
    return '$baseUrl${path.startsWith('/') ? '' : '/'}$path';
  }

  static Map<String, String> _headers({bool json = false}) => {
        if (json) 'Content-Type': 'application/json',
        'Accept': 'application/json',
        if (token != null && token!.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  static Future<Map<String, dynamic>> _send(Future<http.Response> request) async {
    http.Response response;
    try {
      response = await request.timeout(_timeout);
    } on TimeoutException {
      throw ApiException("Server javob bermadi — internetni tekshiring");
    } catch (_) {
      throw ApiException("Serverga ulanib bo'lmadi — internetni tekshiring");
    }

    Map<String, dynamic> body = {};
    try {
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is Map<String, dynamic>) body = decoded;
    } catch (_) {
      // JSON bo'lmagan javob (masalan, proxy xato sahifasi)
    }

    if (response.statusCode >= 200 && response.statusCode < 300) return body;
    throw ApiException(
      (body['message'] ?? '').toString().isNotEmpty
          ? body['message'].toString()
          : response.statusCode == 401
              ? 'Sessiya tugagan — qayta kiring'
              : 'Server xatosi (${response.statusCode})',
      statusCode: response.statusCode,
      code: (body['code'] ?? '').toString(),
    );
  }

  static Uri _uri(String path) => Uri.parse('$baseUrl$path');

  static Future<Map<String, dynamic>> _get(String path) =>
      _send(http.get(_uri(path), headers: _headers()));

  static Future<Map<String, dynamic>> _post(String path, [Map<String, dynamic>? body]) =>
      _send(http.post(_uri(path), headers: _headers(json: true), body: jsonEncode(body ?? {})));

  // ── Avtorizatsiya ──────────────────────────────────────────

  /// Login (yoki telefon) va parol bilan kirish. Natija: {token, user, ...}
  static Future<Map<String, dynamic>> login(String login, String password) =>
      _post('/api/auth/login', {'login': login, 'password': password});

  /// Saqlangan token hali amal qiladimi — joriy foydalanuvchini qaytaradi.
  static Future<Map<String, dynamic>> session() => _get('/api/auth/session');

  static Future<void> logout() async {
    try {
      await _post('/api/auth/logout');
    } catch (_) {
      // Chiqishda tarmoq xatosi muhim emas — token baribir o'chiriladi
    }
  }

  // ── Ma'lumotlar ────────────────────────────────────────────

  /// Rolga mos baza nusxasi: products, sales, branches, settings ...
  static Future<Map<String, dynamic>> fetchData() => _get('/api/data');

  /// Savdo: qoldiq serverda tekshiriladi va atomar kamaytiriladi.
  /// Bir xil `id` qayta yuborilsa qoldiq ikki marta kamaymaydi.
  static Future<Map<String, dynamic>> sell(Map<String, dynamic> sale) => _post('/api/sell', sale);

  // ── Onlayn to'lov ──────────────────────────────────────────

  /// Yoqilgan to'lov tizimlari (click, payme, ...).
  static Future<Map<String, dynamic>> paymentsConfig() => _get('/api/payments/config');

  /// To'lov havolasini yaratadi — summa serverdagi savdodan olinadi.
  static Future<Map<String, dynamic>> createPayment(String provider, Object saleId) =>
      _post('/api/payments/create', {'provider': provider, 'saleId': saleId});

  static Future<Map<String, dynamic>> paymentStatus(String orderId) =>
      _get('/api/payments/status/${Uri.encodeComponent(orderId)}');
}
