import 'product.dart';

class CartItem {
  final Product product;
  int qty;

  CartItem({required this.product, this.qty = 1});

  String get key => product.key;
  String get name => product.name;
  double get price => product.price;
  double get sum => price * qty;

  /// /api/sell uchun element (server narx, qoldiq va filialni qayta tekshiradi).
  Map<String, dynamic> toSellJson() => {
        'id': product.id,
        'name': product.name,
        'qty': qty,
        'price': product.price,
        'img': product.img,
        'barcode': product.barcode,
        if (product.raw['cost'] != null) 'cost': product.raw['cost'],
        if (product.raw['ikpu'] != null) 'ikpu': product.raw['ikpu'],
        if (product.raw['packageCode'] != null) 'packageCode': product.raw['packageCode'],
        if (product.raw['vatPercent'] != null) 'vatPercent': product.raw['vatPercent'],
      };
}

class SaleItem {
  final String name;
  final double price;
  final int qty;

  SaleItem({required this.name, required this.price, required this.qty});

  factory SaleItem.fromJson(Map<String, dynamic> json) => SaleItem(
        name: toStr(json['name']),
        price: toDouble(json['price']),
        qty: toInt(json['qty']) < 1 ? 1 : toInt(json['qty']),
      );
}

class Sale {
  final Object id;
  final List<SaleItem> items;
  final double subtotal;
  final double discAmt;
  final double total;
  final String pay;
  final String time;
  final String date;
  final String cashier;
  final String cashierLogin;
  final String customer;
  final String branchId;
  String status;

  Sale({
    required this.id,
    required this.items,
    required this.subtotal,
    required this.discAmt,
    required this.total,
    required this.pay,
    required this.time,
    required this.date,
    required this.cashier,
    required this.cashierLogin,
    required this.customer,
    required this.branchId,
    required this.status,
  });

  bool get isPaid => status == 'paid';

  factory Sale.fromJson(Map<String, dynamic> json) {
    final list = json['items'] is List ? json['items'] as List : const [];
    return Sale(
      id: json['id'] ?? 0,
      items: list.whereType<Map<String, dynamic>>().map(SaleItem.fromJson).toList(),
      subtotal: toDouble(json['subtotal']),
      discAmt: toDouble(json['discAmt']),
      total: toDouble(json['total']),
      pay: toStr(json['pay']).isEmpty ? 'Naqd' : toStr(json['pay']),
      time: toStr(json['time']),
      date: toStr(json['date']),
      cashier: toStr(json['cashier']),
      cashierLogin: toStr(json['cashierLogin']),
      customer: toStr(json['customer']),
      branchId: toStr(json['branchId']),
      status: toStr(json['status']).isEmpty ? 'paid' : toStr(json['status']),
    );
  }
}
