/// Serverdan kelgan qiymatlarni xavfsiz o'qish (son matn ko'rinishida yoki
/// butun/kasr ko'rinishida kelishi mumkin — `as int` kabi to'g'ridan-to'g'ri
/// o'girish ilovani yiqitadi).
double toDouble(dynamic v) {
  if (v is num) return v.isFinite ? v.toDouble() : 0.0;
  return double.tryParse('${v ?? ''}'.replaceAll(' ', '')) ?? 0.0;
}

int toInt(dynamic v) => toDouble(v).round();

String toStr(dynamic v) => v == null ? '' : '$v';

class Product {
  /// Server id ni o'z ko'rinishida qaytaradi (son yoki matn) — so'rovlarda
  /// aynan shu qiymat yuboriladi, solishtirish esa [key] orqali.
  final Object id;
  final String name;
  final double price;
  final String cat;
  final String img;
  final String barcode;
  final String branchId;
  final String desc;
  int stock;

  /// Savdoda serverga qaytariladigan qo'shimcha maydonlar (ikpu, cost, ...).
  final Map<String, dynamic> raw;

  Product({
    required this.id,
    required this.name,
    required this.price,
    required this.cat,
    required this.img,
    required this.stock,
    this.barcode = '',
    this.branchId = '',
    this.desc = '',
    this.raw = const {},
  });

  String get key => '$id';

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] ?? 0,
      name: toStr(json['name']),
      price: toDouble(json['price']),
      cat: toStr(json['cat']),
      img: toStr(json['img']),
      stock: toInt(json['stock']),
      barcode: toStr(json['barcode']),
      branchId: toStr(json['branchId']).trim(),
      desc: toStr(json['desc']),
      raw: json,
    );
  }
}
