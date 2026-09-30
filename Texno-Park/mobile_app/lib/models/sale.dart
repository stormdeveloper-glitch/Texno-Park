class CartItem {
  final int id;
  final String name;
  final double price;
  final String img;
  int qty;

  CartItem({
    required this.id,
    required this.name,
    required this.price,
    required this.img,
    required this.qty,
  });

  factory CartItem.fromJson(Map<String, dynamic> json) {
    return CartItem(
      id: json['id'] ?? 0,
      name: json['name'] ?? '',
      price: (json['price'] ?? 0.0).toDouble(),
      img: json['img'] ?? '',
      qty: json['qty'] ?? 1,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'price': price,
      'img': img,
      'qty': qty,
    };
  }
}

class Sale {
  final int id;
  final List<CartItem> items;
  final double subtotal;
  final double disc;
  final double discAmt;
  final double total;
  final String pay;
  final String time;
  final String date;
  final String cashier;
  final String customer;
  final int? customerId;
  String status;

  Sale({
    required this.id,
    required this.items,
    required this.subtotal,
    required this.disc,
    required this.discAmt,
    required this.total,
    required this.pay,
    required this.time,
    required this.date,
    required this.cashier,
    required this.customer,
    this.customerId,
    required this.status,
  });

  factory Sale.fromJson(Map<String, dynamic> json) {
    var itemsList = json['items'] as List? ?? [];
    List<CartItem> itemsMapped = itemsList.map((i) => CartItem.fromJson(i)).toList();

    return Sale(
      id: json['id'] ?? 0,
      items: itemsMapped,
      subtotal: (json['subtotal'] ?? 0.0).toDouble(),
      disc: (json['disc'] ?? 0.0).toDouble(),
      discAmt: (json['discAmt'] ?? 0.0).toDouble(),
      total: (json['total'] ?? 0.0).toDouble(),
      pay: json['pay'] ?? 'Cash',
      time: json['time'] ?? '',
      date: json['date'] ?? '',
      cashier: json['cashier'] ?? '',
      customer: json['customer'] ?? '',
      customerId: json['customerId'],
      status: json['status'] ?? 'paid',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'items': items.map((i) => i.toJson()).toList(),
      'subtotal': subtotal,
      'disc': disc,
      'discAmt': discAmt,
      'total': total,
      'pay': pay,
      'time': time,
      'date': date,
      'cashier': cashier,
      'customer': customer,
      'customerId': customerId,
      'status': status,
    };
  }
}
