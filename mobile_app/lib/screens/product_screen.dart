import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/product.dart';
import '../providers/app_state.dart';
import '../utils/format.dart';
import '../widgets/store_widgets.dart';

/// Mahsulot sahifasi: katta rasm, narx, qoldiq, tavsif va pastda
/// «Savatga qo'shish» paneli (do'kon ilovalaridagi kabi).
class ProductScreen extends StatelessWidget {
  final Product product;
  final VoidCallback onOpenCart;

  const ProductScreen({super.key, required this.product, required this.onOpenCart});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final scheme = Theme.of(context).colorScheme;
    final inCart = app.qtyInCart(product);
    final out = product.stock <= 0;
    final similar = app.visibleProducts
        .where((p) => p.cat == product.cat && p.key != product.key && p.stock > 0)
        .take(8)
        .toList();

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          SliverAppBar(
            pinned: true,
            expandedHeight: MediaQuery.of(context).size.width.clamp(280, 460).toDouble(),
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            leading: const Padding(padding: EdgeInsets.all(6), child: _RoundBack()),
            flexibleSpace: FlexibleSpaceBar(
              background: ProductImage(product: product, iconSize: 96),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(formatSum(product.price),
                      style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900, color: scheme.onSurface)),
                  const SizedBox(height: 8),
                  Text(product.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, height: 1.3)),
                  const SizedBox(height: 14),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _Chip(
                        icon: out ? Icons.remove_shopping_cart_outlined : Icons.inventory_2_outlined,
                        text: out ? "Sotuvda yo'q" : 'Omborda: ${product.stock} ta',
                        color: out ? Colors.redAccent : Colors.green,
                      ),
                      if (product.cat.isNotEmpty)
                        _Chip(icon: categoryIcon(product.cat), text: product.cat, color: scheme.primary),
                      if (product.barcode.isNotEmpty)
                        _Chip(icon: Icons.qr_code_2, text: product.barcode, color: Colors.blueGrey),
                    ],
                  ),
                  const SizedBox(height: 18),
                  const _InfoTile(icon: Icons.verified_user_outlined, title: 'Rasmiy kafolat', subtitle: "Do'kon kafolati va servis xizmati"),
                  const _InfoTile(
                      icon: Icons.calendar_month_outlined, title: "Muddatli to'lov", subtitle: "Bo'lib to'lash shartnomasi bilan"),
                  if (product.desc.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    const Text('Tavsif', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 6),
                    Text(product.desc, style: const TextStyle(fontSize: 14, height: 1.5)),
                  ],
                  if (similar.isNotEmpty) ...[
                    const SizedBox(height: 22),
                    const Text("O'xshash mahsulotlar", style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 10),
                    SizedBox(
                      height: 250,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: similar.length,
                        separatorBuilder: (_, __) => const SizedBox(width: 12),
                        itemBuilder: (context, i) {
                          final p = similar[i];
                          return SizedBox(
                            width: 150,
                            child: ProductCard(
                              product: p,
                              inCart: app.qtyInCart(p),
                              onTap: () => Navigator.pushReplacement(
                                context,
                                MaterialPageRoute(builder: (_) => ProductScreen(product: p, onOpenCart: onOpenCart)),
                              ),
                              onAdd: () => app.addToCart(p),
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
                ],
              ),
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          decoration: BoxDecoration(
            color: Theme.of(context).scaffoldBackgroundColor,
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 12, offset: const Offset(0, -2))],
          ),
          child: inCart == 0
              ? FilledButton.icon(
                  onPressed: out ? null : () => app.addToCart(product),
                  icon: const Icon(Icons.add_shopping_cart_rounded),
                  label: Text(out ? "Sotuvda yo'q" : "Savatga qo'shish"),
                )
              : Row(
                  children: [
                    Container(
                      height: 52,
                      decoration: BoxDecoration(
                        color: scheme.primary.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Row(
                        children: [
                          IconButton(
                            tooltip: 'Kamaytirish',
                            icon: Icon(Icons.remove, color: scheme.primary),
                            onPressed: () => app.updateCartQty(product.key, -1),
                          ),
                          Text('$inCart', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                          IconButton(
                            tooltip: "Ko'paytirish",
                            icon: Icon(Icons.add, color: scheme.primary),
                            onPressed: inCart >= product.stock ? null : () => app.updateCartQty(product.key, 1),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: () {
                          Navigator.pop(context);
                          onOpenCart();
                        },
                        child: const Text("Savatga o'tish"),
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _RoundBack extends StatelessWidget {
  const _RoundBack();

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.white,
        shape: const CircleBorder(),
        elevation: 1,
        child: IconButton(
          tooltip: 'Orqaga',
          icon: const Icon(Icons.arrow_back, color: Colors.black87),
          onPressed: () => Navigator.pop(context),
        ),
      );
}

class _Chip extends StatelessWidget {
  final IconData icon;
  final String text;
  final Color color;

  const _Chip({required this.icon, required this.text, required this.color});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 6),
            Text(text, style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 13)),
          ],
        ),
      );
}

class _InfoTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;

  const _InfoTile({required this.icon, required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text(subtitle, style: const TextStyle(color: Colors.grey, fontSize: 12.5)),
                ],
              ),
            ),
          ],
        ),
      );
}
