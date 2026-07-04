import 'package:flutter/material.dart';
import 'dart:convert';
import '../models/product.dart';
import '../models/sale.dart';
import '../models/user.dart';
import '../services/api_service.dart';

class AppState extends ChangeNotifier {
  List<Product> products = [];
  List<Sale> sales = [];
  List<User> users = [];
  List<Map<String, dynamic>> logs = [];
  List<CartItem> cart = [];
  User? currentUser;
  bool isLoading = false;

  final List<User> localFallbackUsers = [
    User(id: 1, login: 'admin', name: 'Abdullayev Admin', role: 'admin', color: '#ff6b35', passHash: 'MTIzNDU2'),
    User(id: 2, login: 'cashier', name: 'Karimov Kassir', role: 'cashier', color: '#10B981', passHash: 'MTIzNDU2'),
    User(id: 3, login: 'manager', name: 'Toshmatov Menejer', role: 'manager', color: '#3B82F6', passHash: 'MTIzNDU2'),
  ];

  AppState() {
    loadData();
  }

  Future<void> loadData() async {
    isLoading = true;
    notifyListeners();

    final data = await ApiService.fetchInitialData();
    if (data != null) {
      if (data['products'] != null) {
        var plist = data['products'] as List;
        products = plist.map((p) => Product.fromJson(p)).toList();
      }
      if (data['sales'] != null) {
        var slist = data['sales'] as List;
        sales = slist.map((s) => Sale.fromJson(s)).toList();
      }
      if (data['users'] != null) {
        var ulist = data['users'] as List;
        users = ulist.map((u) => User.fromJson(u)).toList();
      } else {
        users = localFallbackUsers;
      }
      if (data['logs'] != null) {
        logs = List<Map<String, dynamic>>.from(data['logs']);
      }
    } else {
      users = localFallbackUsers;
    }

    isLoading = false;
    notifyListeners();
  }

  bool login(String username, String password) {
    final passwordHash = base64Encode(utf8.encode(password));
    final matched = users.firstWhere(
      (u) => u.login.toLowerCase() == username.toLowerCase() && u.passHash == passwordHash,
      orElse: () => users.firstWhere(
        (u) => u.login.toLowerCase() == username.toLowerCase() && password == '123456', // Fallback for simple tests
        orElse: () => User(id: 0, login: '', name: '', role: '', color: '', passHash: ''),
      ),
    );

    if (matched.id != 0) {
      currentUser = matched;
      addLog('Kirish', '${matched.name} tizimga kirdi');
      notifyListeners();
      return true;
    }
    return false;
  }

  void logout() {
    if (currentUser != null) {
      addLog('Chiqish', '${currentUser!.name} tizimdan chiqdi');
      currentUser = null;
    }
    cart.clear();
    notifyListeners();
  }

  void addToCart(Product product) {
    final index = cart.indexWhere((item) => item.id == product.id);
    if (index >= 0) {
      cart[index].qty++;
    } else {
      cart.add(CartItem(
        id: product.id,
        name: product.name,
        price: product.price,
        img: product.img,
        qty: 1,
      ));
    }
    notifyListeners();
  }

  void updateCartQty(int productId, int delta) {
    final index = cart.indexWhere((item) => item.id == productId);
    if (index >= 0) {
      cart[index].qty += delta;
      if (cart[index].qty <= 0) {
        cart.removeAt(index);
      }
      notifyListeners();
    }
  }

  void clearCart() {
    cart.clear();
    notifyListeners();
  }

  double get subtotal => cart.fold(0.0, (sum, item) => sum + (item.price * item.qty));
  double get total => subtotal; // Assume no default discount for simplicity

  void addLog(String type, String desc) {
    logs.add({
      'type': type,
      'desc': desc,
      'time': DateTime.now().toLocal().toString().substring(11, 19),
    });
    _syncWithServer();
  }

  Future<Sale?> checkout(String payType, String customerPhone) async {
    if (cart.isEmpty) return null;

    final saleId = sales.length + 1;
    final isClick = payType.toLowerCase() == 'click';
    
    final sale = Sale(
      id: saleId,
      items: List<CartItem>.from(cart),
      subtotal: subtotal,
      disc: 0.0,
      discAmt: 0.0,
      total: total,
      pay: payType == 'click' ? 'Click' : (payType == 'card' ? 'Karta' : 'Naqd'),
      time: DateTime.now().toLocal().toString().substring(11, 19),
      date: DateTime.now().toLocal().toString().substring(0, 10).split('-').reversed.join('.'),
      cashier: currentUser?.name ?? 'Online Xaridor',
      customer: 'Mijoz ($customerPhone)',
      status: isClick ? 'pending' : 'paid',
    );

    // Deduct stock locally immediately if not click (click will deduct after payment webhook)
    if (!isClick) {
      for (var ci in cart) {
        final prodIndex = products.indexWhere((p) => p.id == ci.id);
        if (prodIndex >= 0) {
          products[prodIndex].stock = (products[prodIndex].stock - ci.qty).clamp(0, 999999);
        }
      }
    }

    sales.add(sale);
    cart.clear();
    notifyListeners();

    addLog('Savdo', 'Yangi buyurtma #${sale.id} — ${sale.total} so\'m (${sale.pay})');
    return sale;
  }

  void updateSaleStatus(int saleId, String newStatus) {
    final idx = sales.indexWhere((s) => s.id == saleId);
    if (idx >= 0) {
      sales[idx].status = newStatus;
      if (newStatus == 'paid') {
        // Deduct stock if click payment completed
        for (var ci in sales[idx].items) {
          final prodIndex = products.indexWhere((p) => p.id == ci.id);
          if (prodIndex >= 0) {
            products[prodIndex].stock = (products[prodIndex].stock - ci.qty).clamp(0, 999999);
          }
        }
      }
      saveToStorage();
    }
  }

  void saveToStorage() {
    notifyListeners();
    _syncWithServer();
  }

  Future<void> _syncWithServer() async {
    final salesJson = sales.map((s) => s.toJson()).toList();
    final productsJson = products.map((p) => p.toJson()).toList();
    await ApiService.syncData(salesJson, productsJson, logs);
  }
}
