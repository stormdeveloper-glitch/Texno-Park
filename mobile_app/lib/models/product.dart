class Product {
  final int id;
  final String name;
  final double price;
  final String cat;
  final String img;
  int stock;
  final String? barcode;

  Product({
    required this.id,
    required this.name,
    required this.price,
    required this.cat,
    required this.img,
    required this.stock,
    this.barcode,
  });

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] ?? 0,
      name: json['name'] ?? '',
      price: (json['price'] ?? 0.0).toDouble(),
      cat: json['cat'] ?? '',
      img: json['img'] ?? '',
      stock: json['stock'] ?? 0,
      barcode: json['barcode'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'price': price,
      'cat': cat,
      'img': img,
      'stock': stock,
      'barcode': barcode,
    };
  }
}
