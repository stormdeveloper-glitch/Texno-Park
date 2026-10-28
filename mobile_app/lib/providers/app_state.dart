import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/product.dart';
import '../models/sale.dart';
import '../models/user.dart';
import '../services/api_service.dart';

/// To'lov usuli: naqd/karta darhol yakunlanadi, onlayn (click/payme...)
/// esa server yaratgan havola orqali to'lanadi.
class PayMethod {
  final String provider;
  final String label;
  final bool online;

  const PayMethod(this.provider, this.label, {this.online = false});
}

class CheckoutResult {
  final Sale sale;
  final String? payUrl;
  final String? orderId;

  CheckoutResult(this.sale, {this.payUrl, this.orderId});
}

class AppState extends ChangeNotifier {
  static const _tokenKey = 'tp_token';
  static const _branchKey = 'tp_branch';

  User? currentUser;
  List<Product> products = [];
  List<Sale> sales = [];
  List<Branch> branches = [];
  Map<String, dynamic> settings = {};
  List<PayMethod> payMethods = const [PayMethod('cash', 'Naqd'), PayMethod('card', 'Karta')];
  final List<CartItem> cart = [];

  String branchId = '';
  bool isLoading = false;
  bool isRestoring = true;
  String? loadError;

  AppState() {
    _restoreSession();
  }

  // ── Sessiya ────────────────────────────────────────────────

  Future<void> _restoreSession() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_tokenKey);
      branchId = prefs.getString(_branchKey) ?? branchId;
      if (saved != null && saved.isNotEmpty) {
        ApiService.token = saved;
        final res = await ApiService.session();
        currentUser = User.fromJson(Map<String, dynamic>.from(res['user'] ?? {}));
        await loadData();
      }
    } on ApiException catch (e) {
      // Token eskirgan yoki bekor qilingan — qayta login so'raladi
      if (e.isUnauthorized) await _clearSession();
    } catch (_) {
      // Tarmoq yo'q — login ekrani ko'rsatiladi
    } finally {
      isRestoring = false;
      notifyListeners();
    }
  }

  /// Muvaffaqiyatsiz bo'lsa [ApiException] (server xabari bilan) tashlanadi.
  Future<void> login(String login, String password) async {
    final res = await ApiService.login(login, password);
    final token = toStr(res['token']);
    if (token.isEmpty) throw ApiException("Server token qaytarmadi");
    ApiService.token = token;
    currentUser = User.fromJson(Map<String, dynamic>.from(res['user'] ?? {}));
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    notifyListeners();
    await loadData();
  }

  Future<void> logout() async {
    await ApiService.logout();
    await _clearSession();
    notifyListeners();
  }

  Future<void> _clearSession() async {
    ApiService.token = null;
    currentUser = null;
    products = [];
    sales = [];
    cart.clear();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_tokenKey);
    } catch (_) {}
  }

  // ── Ma'lumotlar ────────────────────────────────────────────

  Future<void> loadData() async {
    isLoading = true;
    loadError = null;
    notifyListeners();
    try {
      final data = await ApiService.fetchData();
      products = _list(data['products']).map(Product.fromJson).toList();
      sales = _list(data['sales']).map(Sale.fromJson).toList();
      branches = _list(data['branches'])
          .map(Branch.fromJson)
          .where((b) => b.id.isNotEmpty)
          .toList();
      settings = data['settings'] is Map ? Map<String, dynamic>.from(data['settings']) : {};
      _pickBranch();
      await _loadPayMethods();
    } on ApiException catch (e) {
      loadError = e.message;
      if (e.isUnauthorized) await _clearSession();
    } catch (_) {
      loadError = "Server ma'lumotlarini o'qib bo'lmadi";
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }

  static List<Map<String, dynamic>> _list(dynamic v) =>
      v is List ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : [];

  /// Filialga biriktirilgan xodim faqat o'z filialida sotadi (server ham
  /// tekshiradi); biriktirilmagan bo'lsa — oxirgi tanlangan yoki birinchi filial.
  void _pickBranch() {
    final own = currentUser?.branchId ?? '';
    if (own.isNotEmpty) {
      branchId = own;
    } else if (!branches.any((b) => b.id == branchId)) {
      branchId = branches.isNotEmpty ? branches.first.id : '';
    }
  }

  bool get canChangeBranch => (currentUser?.branchId ?? '').isEmpty && branches.length > 1;

  String get branchName =>
      branches.firstWhere((b) => b.id == branchId, orElse: () => Branch(id: branchId, name: branchId)).name;

  Future<void> setBranch(String id) async {
    if (!canChangeBranch || id == branchId) return;
    branchId = id;
    cart.clear();   // boshqa filial mahsulotlari savatda qolmasin
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_branchKey, id);
    } catch (_) {}
  }

  Future<void> _loadPayMethods() async {
    final methods = <PayMethod>[const PayMethod('cash', 'Naqd'), const PayMethod('card', 'Karta')];
    try {
      final cfg = await ApiService.paymentsConfig();
      final providers =
          cfg['providers'] is Map ? Map<String, dynamic>.from(cfg['providers']) : <String, dynamic>{};
      providers.forEach((key, value) {
        if (value is Map && value['enabled'] == true) {
          methods.add(PayMethod(key, toStr(value['label']).isEmpty ? key : toStr(value['label']), online: true));
        }
      });
    } catch (_) {
      // Onlayn to'lov sozlanmagan bo'lsa faqat naqd/karta qoladi
    }
    payMethods = methods;
  }

  /// Tanlangan filialda sotiladigan mahsulotlar (umumiy ombor ham kiradi).
  List<Product> get visibleProducts =>
      products.where((p) => p.branchId.isEmpty || branchId.isEmpty || p.branchId == branchId).toList();

  List<String> get categories {
    final set = <String>{};
    for (final p in visibleProducts) {
      if (p.cat.isNotEmpty) set.add(p.cat);
    }
    return set.toList()..sort();
  }

  /// «Ommabop» bo'limi: eng ko'p sotilgan (cheklardagi miqdor bo'yicha) va sotuvda bor mahsulotlar.
  List<Product> get popularProducts {
    final sold = <String, int>{};
    for (final s in sales) {
      for (final i in s.items) {
        sold[i.name] = (sold[i.name] ?? 0) + i.qty;
      }
    }
    final list = visibleProducts.where((p) => p.stock > 0 && (sold[p.name] ?? 0) > 0).toList()
      ..sort((a, b) => (sold[b.name] ?? 0).compareTo(sold[a.name] ?? 0));
    return list.take(10).toList();
  }

  String get companyName {
    final name = toStr(settings['companyName']);
    return name.isEmpty ? 'Texno Park N1' : name;
  }

  // ── Bugungi ko'rsatkichlar (kirgan xodim bo'yicha) ─────────

  static String todayStr() {
    final d = DateTime.now();
    return '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';
  }

  List<Sale> get todaySales {
    final today = todayStr();
    final login = currentUser?.login ?? '';
    final all = currentUser?.role == 'boss' || currentUser?.role == 'admin';
    return sales
        .where((s) => s.isPaid && s.date == today && (all || s.cashierLogin.isEmpty || s.cashierLogin == login))
        .toList()
      ..sort((a, b) => b.time.compareTo(a.time));
  }

  double get todayTotal => todaySales.fold(0.0, (sum, s) => sum + s.total);

  // ── Savat ──────────────────────────────────────────────────

  int qtyInCart(Product p) {
    final i = cart.indexWhere((c) => c.key == p.key);
    return i >= 0 ? cart[i].qty : 0;
  }

  /// Qoldiqdan ortiq qo'shilmaydi. Qaytaradi: qo'shildimi.
  bool addToCart(Product product) {
    final index = cart.indexWhere((item) => item.key == product.key);
    final current = index >= 0 ? cart[index].qty : 0;
    if (current >= product.stock) return false;
    if (index >= 0) {
      cart[index].qty++;
    } else {
      cart.add(CartItem(product: product));
    }
    notifyListeners();
    return true;
  }

  void updateCartQty(String key, int delta) {
    final index = cart.indexWhere((item) => item.key == key);
    if (index < 0) return;
    final item = cart[index];
    final next = item.qty + delta;
    if (next <= 0) {
      cart.removeAt(index);
    } else if (next <= item.product.stock) {
      item.qty = next;
    }
    notifyListeners();
  }

  void clearCart() {
    cart.clear();
    notifyListeners();
  }

  int get cartCount => cart.fold(0, (sum, item) => sum + item.qty);
  double get total => cart.fold(0.0, (sum, item) => sum + item.sum);

  // ── Savdo ──────────────────────────────────────────────────

  /// Savdoni serverga yuboradi. Server qoldiqni tekshiradi va kamaytiradi;
  /// onlayn to'lovda havola yaratiladi. Xato bo'lsa [ApiException].
  Future<CheckoutResult> checkout(PayMethod method, {String customerName = '', String customerPhone = ''}) async {
    if (cart.isEmpty) throw ApiException("Savat bo'sh");
    if (branchId.isEmpty) throw ApiException('Filial tanlanmagan');

    final now = DateTime.now();
    final saleId = now.millisecondsSinceEpoch;   // takroriy yuborishda ham bir xil — qoldiq ikki marta kamaymaydi
    final customer = [customerName.trim(), customerPhone.trim()].where((s) => s.isNotEmpty).join(' ');
    final body = {
      'id': saleId,
      'items': cart.map((c) => c.toSellJson()).toList(),
      'branchId': branchId,
      'customer': customer.isEmpty ? "Noma'lum" : customer,
      'customerPhone': customerPhone.trim(),
      'pay': method.label,
      'provider': method.provider,
      'subtotal': total,
      'disc': 0,
      'discAmt': 0,
      'total': total,
      'date': todayStr(),
      'time': '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}:'
          '${now.second.toString().padLeft(2, '0')}',
      'isOnline': method.online,
    };

    final res = await ApiService.sell(body);
    final sale = Sale.fromJson(Map<String, dynamic>.from(res['sale'] ?? body));
    _applyStocks(res['productStocks']);
    sales.add(sale);
    cart.clear();
    notifyListeners();

    if (!method.online) return CheckoutResult(sale);
    try {
      final pay = await ApiService.createPayment(method.provider, sale.id);
      return CheckoutResult(sale, payUrl: toStr(pay['payUrl']), orderId: toStr(pay['orderId']));
    } on ApiException catch (e) {
      // Savdo serverda «kutilmoqda» holatida qoldi — kassir buni bilishi kerak
      throw ApiException("Chek #${sale.id} saqlandi, lekin to'lov havolasi yaratilmadi: ${e.message}");
    }
  }

  void _applyStocks(dynamic stocks) {
    for (final s in _list(stocks)) {
      final i = products.indexWhere((p) => p.key == toStr(s['id']));
      if (i >= 0) products[i].stock = toInt(s['stock']);
    }
  }

  /// Onlayn to'lov tasdiqlanganda chaqiriladi — qoldiq serverda kamaygan,
  /// shuning uchun ma'lumotlar qayta yuklanadi.
  Future<void> markSalePaid(Object saleId) async {
    final i = sales.indexWhere((s) => '${s.id}' == '$saleId');
    if (i >= 0) sales[i].status = 'paid';
    notifyListeners();
    try {
      await loadData();
    } catch (_) {}
  }
}
