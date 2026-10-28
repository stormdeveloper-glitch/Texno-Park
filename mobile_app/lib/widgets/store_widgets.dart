import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/product.dart';
import '../services/api_service.dart';
import '../utils/format.dart';

/// Kategoriya nomidan mos ikonka (do'kon ilovalaridagi kategoriya doiralari uchun).
IconData categoryIcon(String name) {
  final n = name.toLowerCase();
  const map = <String, IconData>{
    'telefon': Icons.smartphone,
    'smartfon': Icons.smartphone,
    'planshet': Icons.tablet_android,
    'noutbuk': Icons.laptop_mac,
    'laptop': Icons.laptop_mac,
    'kompyuter': Icons.desktop_windows_outlined,
    'televizor': Icons.tv,
    'tv': Icons.tv,
    'muzlatgich': Icons.kitchen,
    'kir yuv': Icons.local_laundry_service_outlined,
    'konditsioner': Icons.ac_unit,
    'changyutgich': Icons.cleaning_services_outlined,
    'quloqchin': Icons.headphones,
    'aksessuar': Icons.headphones,
    'soat': Icons.watch_outlined,
    'oshxona': Icons.blender_outlined,
    'gaz': Icons.local_fire_department_outlined,
    'audio': Icons.speaker,
    'kamera': Icons.photo_camera_outlined,
  };
  for (final e in map.entries) {
    if (n.contains(e.key)) return e.value;
  }
  return Icons.category_outlined;
}

/// Mahsulot rasmi: tarmoqdan keshlangan, bo'lmasa kategoriya ikonkasi.
class ProductImage extends StatelessWidget {
  final Product product;
  final double iconSize;

  const ProductImage({super.key, required this.product, this.iconSize = 44});

  @override
  Widget build(BuildContext context) {
    final url = ApiService.absoluteUrl(product.img);
    final placeholder = Container(
      color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
      alignment: Alignment.center,
      child: Icon(categoryIcon(product.cat), size: iconSize, color: Colors.grey.shade400),
    );
    if (url.isEmpty) return placeholder;
    return CachedNetworkImage(
      imageUrl: url,
      fit: BoxFit.cover,
      width: double.infinity,
      height: double.infinity,
      placeholder: (_, __) => placeholder,
      errorWidget: (_, __, ___) => placeholder,
    );
  }
}

/// Do'kon uslubidagi mahsulot kartasi: rasm, narx, nom, «+» tugmasi.
class ProductCard extends StatelessWidget {
  final Product product;
  final int inCart;
  final VoidCallback onTap;
  final VoidCallback? onAdd;

  const ProductCard({
    super.key,
    required this.product,
    required this.inCart,
    required this.onTap,
    this.onAdd,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final out = product.stock <= 0;
    final few = !out && product.stock <= 3;

    return GestureDetector(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ProductImage(product: product),
                  if (out)
                    Container(
                      color: Colors.white.withValues(alpha: 0.6),
                      alignment: Alignment.center,
                      child: const _Pill(text: 'Sotuvda yo\'q', color: Colors.black87),
                    ),
                  if (few)
                    Positioned(left: 8, top: 8, child: _Pill(text: 'Oxirgi ${product.stock} ta', color: Colors.redAccent)),
                  Positioned(
                    right: 6,
                    bottom: 6,
                    child: Material(
                      color: inCart > 0 ? scheme.primary : Colors.white,
                      shape: const CircleBorder(),
                      elevation: 2,
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: out ? null : onAdd,
                        child: SizedBox(
                          width: 36,
                          height: 36,
                          child: inCart > 0
                              ? Center(
                                  child: Text('$inCart',
                                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)))
                              : Icon(Icons.add_shopping_cart_rounded, size: 19, color: out ? Colors.grey : scheme.primary),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(formatSum(product.price),
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15), maxLines: 1, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 2),
          Text(product.name,
              style: TextStyle(fontSize: 13, height: 1.3, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.8)),
              maxLines: 2,
              overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  final String text;
  final Color color;

  const _Pill({required this.text, required this.color});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(8)),
        child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
      );
}

/// Mahsulotlar to'ri (kengligiga qarab 2–5 ustun).
SliverGrid productGrid({
  required List<Product> products,
  required Widget Function(Product) builder,
  required double width,
}) {
  return SliverGrid(
    gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: width > 900 ? 5 : width > 600 ? 3 : 2,
      mainAxisSpacing: 18,
      crossAxisSpacing: 12,
      childAspectRatio: 0.62,
    ),
    delegate: SliverChildBuilderDelegate((context, i) => builder(products[i]), childCount: products.length),
  );
}

/// Bo'sh holat (savat bo'sh, topilmadi va h.k.).
class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? action;

  const EmptyState({super.key, required this.icon, required this.title, this.subtitle = '', this.action});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 96,
            height: 96,
            decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.1), shape: BoxShape.circle),
            child: Icon(icon, size: 46, color: scheme.primary),
          ),
          const SizedBox(height: 18),
          Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          if (subtitle.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(subtitle, textAlign: TextAlign.center, style: const TextStyle(color: Colors.grey, fontSize: 14)),
          ],
          if (action != null) ...[const SizedBox(height: 20), action!],
        ],
      ),
    );
  }
}
