import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/product.dart';
import '../models/sale.dart';
import '../providers/app_state.dart';
import '../services/api_service.dart';
import '../utils/format.dart';
import '../widgets/store_widgets.dart';
import 'product_screen.dart';
import 'receipt_screen.dart';

/// Asosiy ekran — onlayn do'kon ilovalari tuzilishida:
/// Bosh sahifa · Katalog · Savat · Profil.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;
  String _query = '';
  String _category = '';
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode();

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  void _toast(String text, {bool error = false}) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(text),
        backgroundColor: error ? Colors.red.shade700 : null,
        duration: const Duration(milliseconds: 1400),
      ));
  }

  void _add(AppState app, Product p) {
    if (app.addToCart(p)) {
      _toast("${p.name} savatga qo'shildi");
    } else {
      _toast('Omborda faqat ${p.stock} ta bor', error: true);
    }
  }

  void _openProduct(Product p) {
    Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => ProductScreen(product: p, onOpenCart: () => setState(() => _tab = 2))),
    );
  }

  void _openCategory(String cat) {
    setState(() {
      _category = cat;
      _tab = 1;
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();

    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          _homeTab(app),
          _catalogTab(app),
          _CartTab(onGoShopping: () => setState(() => _tab = 0), toast: _toast),
          _ProfileTab(toast: _toast),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home_rounded), label: 'Bosh sahifa'),
          const NavigationDestination(
              icon: Icon(Icons.manage_search_outlined), selectedIcon: Icon(Icons.manage_search), label: 'Katalog'),
          NavigationDestination(
            icon: Badge(
                isLabelVisible: app.cartCount > 0, label: Text('${app.cartCount}'), child: const Icon(Icons.shopping_bag_outlined)),
            selectedIcon: Badge(
                isLabelVisible: app.cartCount > 0, label: Text('${app.cartCount}'), child: const Icon(Icons.shopping_bag)),
            label: 'Savat',
          ),
          const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profil'),
        ],
      ),
    );
  }

  // ── Qidiruv maydoni (bosh sahifa va katalogda bir xil) ─────
  Widget _searchField({bool autofocus = false, VoidCallback? onTap, bool readOnly = false}) {
    return TextField(
      controller: _searchController,
      focusNode: readOnly ? null : _searchFocus,
      readOnly: readOnly,
      autofocus: autofocus,
      onTap: onTap,
      textInputAction: TextInputAction.search,
      onChanged: (v) => setState(() => _query = v.trim()),
      decoration: InputDecoration(
        hintText: 'Mahsulot yoki kategoriya qidirish',
        prefixIcon: const Icon(Icons.search),
        suffixIcon: _query.isEmpty || readOnly
            ? null
            : IconButton(
                tooltip: 'Tozalash',
                icon: const Icon(Icons.close),
                onPressed: () => setState(() {
                  _searchController.clear();
                  _query = '';
                }),
              ),
        contentPadding: const EdgeInsets.symmetric(vertical: 12),
      ),
    );
  }

  // ── 1. BOSH SAHIFA ─────────────────────────────────────────
  Widget _homeTab(AppState app) {
    final scheme = Theme.of(context).colorScheme;
    final cats = app.categories;
    final popular = app.popularProducts;
    final all = app.visibleProducts.where((p) => p.stock > 0).toList();

    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: app.loadData,
        child: LayoutBuilder(
          builder: (context, c) => CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(app.companyName, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, letterSpacing: -0.4)),
                            Row(
                              children: [
                                Icon(Icons.location_on_outlined, size: 15, color: scheme.primary),
                                const SizedBox(width: 2),
                                Flexible(
                                  child: Text(app.branchId.isEmpty ? 'Filial tanlanmagan' : app.branchName,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(fontSize: 13, color: Colors.grey)),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                      if (app.isLoading)
                        const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))
                      else
                        IconButton(tooltip: 'Yangilash', onPressed: app.loadData, icon: const Icon(Icons.refresh)),
                    ],
                  ),
                ),
              ),
              SliverPersistentHeader(
                pinned: true,
                delegate: _SearchHeader(
                  color: Theme.of(context).scaffoldBackgroundColor,
                  child: _searchField(
                    readOnly: true,
                    onTap: () {
                      setState(() => _tab = 1);
                      Future.delayed(const Duration(milliseconds: 50), () => _searchFocus.requestFocus());
                    },
                  ),
                ),
              ),
              if (app.loadError != null) SliverToBoxAdapter(child: _ErrorBanner(text: app.loadError!, onRetry: app.loadData)),
              SliverToBoxAdapter(child: _PromoCarousel(app: app, onCategory: _openCategory)),
              if (cats.isNotEmpty) ...[
                _sectionTitle('Kategoriyalar', action: 'Barchasi', onAction: () => _openCategory('')),
                SliverToBoxAdapter(
                  child: SizedBox(
                    height: 104,
                    child: ListView.separated(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      scrollDirection: Axis.horizontal,
                      itemCount: cats.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 14),
                      itemBuilder: (context, i) => _CategoryBubble(name: cats[i], onTap: () => _openCategory(cats[i])),
                    ),
                  ),
                ),
              ],
              if (popular.isNotEmpty) ...[
                _sectionTitle('Ommabop', icon: Icons.local_fire_department_rounded),
                SliverToBoxAdapter(
                  child: SizedBox(
                    height: 262,
                    child: ListView.separated(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      scrollDirection: Axis.horizontal,
                      itemCount: popular.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 12),
                      itemBuilder: (context, i) => SizedBox(
                        width: 156,
                        child: ProductCard(
                          product: popular[i],
                          inCart: app.qtyInCart(popular[i]),
                          onTap: () => _openProduct(popular[i]),
                          onAdd: () => _add(app, popular[i]),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
              _sectionTitle('Barcha mahsulotlar'),
              if (all.isEmpty)
                SliverToBoxAdapter(
                  child: EmptyState(
                    icon: Icons.inventory_2_outlined,
                    title: app.isLoading ? 'Yuklanmoqda...' : "Hozircha mahsulot yo'q",
                    subtitle: app.isLoading ? '' : "Yangilash uchun ekranni pastga torting",
                  ),
                )
              else
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  sliver: productGrid(
                    products: all,
                    width: c.maxWidth,
                    builder: (p) => ProductCard(
                      product: p,
                      inCart: app.qtyInCart(p),
                      onTap: () => _openProduct(p),
                      onAdd: () => _add(app, p),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _sectionTitle(String title, {IconData? icon, String? action, VoidCallback? onAction}) {
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 20, 8, 10),
        child: Row(
          children: [
            Text(title, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
            if (icon != null) ...[const SizedBox(width: 6), Icon(icon, color: Colors.deepOrange, size: 20)],
            const Spacer(),
            if (action != null) TextButton(onPressed: onAction, child: Text(action)),
          ],
        ),
      ),
    );
  }

  // ── 2. KATALOG ─────────────────────────────────────────────
  Widget _catalogTab(AppState app) {
    final q = _query.toLowerCase();
    final cats = app.categories;
    final filtered = app.visibleProducts.where((p) {
      if (_category.isNotEmpty && p.cat != _category) return false;
      if (q.isEmpty) return true;
      return p.name.toLowerCase().contains(q) || p.barcode.contains(q) || p.cat.toLowerCase().contains(q);
    }).toList();
    // Tugagan mahsulotlar oxirida (List.sort barqaror emas — tartib buzilmasligi uchun ajratamiz)
    final list = [...filtered.where((p) => p.stock > 0), ...filtered.where((p) => p.stock <= 0)];

    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 6), child: _searchField()),
          if (cats.isNotEmpty)
            SizedBox(
              height: 46,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                children: [
                  _filterChip('Barchasi', ''),
                  ...cats.map((cat) => _filterChip(cat, cat)),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
            child: Row(
              children: [
                Text('${list.length} ta mahsulot', style: const TextStyle(color: Colors.grey, fontSize: 13)),
                const Spacer(),
                if (_category.isNotEmpty || _query.isNotEmpty)
                  TextButton(
                    onPressed: () => setState(() {
                      _category = '';
                      _query = '';
                      _searchController.clear();
                    }),
                    child: const Text('Filtrni tozalash'),
                  ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: app.loadData,
              child: LayoutBuilder(
                builder: (context, c) => CustomScrollView(
                  slivers: [
                    if (list.isEmpty)
                      const SliverToBoxAdapter(
                        child: EmptyState(
                          icon: Icons.search_off_rounded,
                          title: 'Hech narsa topilmadi',
                          subtitle: "Boshqa so'z bilan qidirib ko'ring",
                        ),
                      )
                    else
                      SliverPadding(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                        sliver: productGrid(
                          products: list,
                          width: c.maxWidth,
                          builder: (p) => ProductCard(
                            product: p,
                            inCart: app.qtyInCart(p),
                            onTap: () => _openProduct(p),
                            onAdd: () => _add(app, p),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _filterChip(String label, String value) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          label: Text(label),
          selected: _category == value,
          showCheckmark: false,
          onSelected: (_) => setState(() => _category = value),
        ),
      );
}

// ── Qidiruv qatori (bosh sahifada tepada qotib turadi) ──────
class _SearchHeader extends SliverPersistentHeaderDelegate {
  final Widget child;
  final Color color;

  _SearchHeader({required this.child, required this.color});

  @override
  double get minExtent => 68;

  @override
  double get maxExtent => 68;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) => Container(
        color: color,
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        child: child,
      );

  @override
  bool shouldRebuild(covariant _SearchHeader old) => old.child != child || old.color != color;
}

class _ErrorBanner extends StatelessWidget {
  final String text;
  final Future<void> Function() onRetry;

  const _ErrorBanner({required this.text, required this.onRetry});

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
        decoration: BoxDecoration(color: Colors.red.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(14)),
        child: Row(
          children: [
            const Icon(Icons.cloud_off, color: Colors.redAccent, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 13))),
            TextButton(onPressed: onRetry, child: const Text('Qayta')),
          ],
        ),
      );
}

// ── Reklama bannerlari (real ma'lumotdan: kategoriyalar, muddatli to'lov) ──
class _PromoCarousel extends StatefulWidget {
  final AppState app;
  final void Function(String) onCategory;

  const _PromoCarousel({required this.app, required this.onCategory});

  @override
  State<_PromoCarousel> createState() => _PromoCarouselState();
}

class _PromoCarouselState extends State<_PromoCarousel> {
  final _controller = PageController(viewportFraction: 0.92);
  Timer? _timer;
  int _page = 0;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!_controller.hasClients) return;
      final count = _banners().length;
      if (count < 2) return;
      _controller.animateToPage((_page + 1) % count, duration: const Duration(milliseconds: 450), curve: Curves.easeOut);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  List<_Banner> _banners() {
    final cats = widget.app.categories;
    final count = widget.app.visibleProducts.where((p) => p.stock > 0).length;
    return [
      const _Banner("Muddatli to'lov", "Texnikani bo'lib to'lab oling — shartnoma do'konda rasmiylashtiriladi",
          Icons.calendar_month_rounded, [Color(0xFFFF8A3D), Color(0xFFF2600C)], ''),
      if (cats.isNotEmpty)
        _Banner(cats.first, '${widget.app.visibleProducts.where((p) => p.cat == cats.first).length} ta mahsulot sotuvda',
            categoryIcon(cats.first), const [Color(0xFF6366F1), Color(0xFF4338CA)], cats.first),
      _Banner('Hammasi omborda', '$count ta mahsulot hozir sotuvda — rasmiy kafolat bilan', Icons.verified_rounded,
          const [Color(0xFF10B981), Color(0xFF047857)], ''),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final banners = _banners();
    return Column(
      children: [
        SizedBox(
          height: 150,
          child: PageView.builder(
            controller: _controller,
            itemCount: banners.length,
            onPageChanged: (i) => setState(() => _page = i),
            itemBuilder: (context, i) {
              final b = banners[i];
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: InkWell(
                  borderRadius: BorderRadius.circular(20),
                  onTap: () => widget.onCategory(b.category),
                  child: Ink(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(colors: b.colors, begin: Alignment.topLeft, end: Alignment.bottomRight),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Stack(
                      children: [
                        Positioned(
                          right: -10,
                          bottom: -14,
                          child: Icon(b.icon, size: 130, color: Colors.white.withValues(alpha: 0.18)),
                        ),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 18, 110, 18),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(b.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(color: Colors.white, fontSize: 21, fontWeight: FontWeight.w900)),
                              const SizedBox(height: 6),
                              Text(b.text,
                                  maxLines: 3,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(color: Colors.white.withValues(alpha: 0.92), fontSize: 13, height: 1.35)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List.generate(
            banners.length,
            (i) => AnimatedContainer(
              duration: const Duration(milliseconds: 250),
              margin: const EdgeInsets.symmetric(horizontal: 3),
              width: i == _page ? 18 : 6,
              height: 6,
              decoration: BoxDecoration(
                color: i == _page ? Theme.of(context).colorScheme.primary : Colors.grey.shade300,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Banner {
  final String title;
  final String text;
  final IconData icon;
  final List<Color> colors;
  final String category;

  const _Banner(this.title, this.text, this.icon, this.colors, this.category);
}

class _CategoryBubble extends StatelessWidget {
  final String name;
  final VoidCallback onTap;

  const _CategoryBubble({required this.name, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: SizedBox(
        width: 72,
        child: Column(
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
              child: Icon(categoryIcon(name), color: scheme.primary, size: 30),
            ),
            const SizedBox(height: 6),
            // Bitta uzun so'z (masalan «Changyutgichlar») bo'linib ketmasin — kichraytiriladi
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(name, maxLines: 1, style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      ),
    );
  }
}

// ── 3. SAVAT ──────────────────────────────────────────────────
class _CartTab extends StatefulWidget {
  final VoidCallback onGoShopping;
  final void Function(String, {bool error}) toast;

  const _CartTab({required this.onGoShopping, required this.toast});

  @override
  State<_CartTab> createState() => _CartTabState();
}

class _CartTabState extends State<_CartTab> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final scheme = Theme.of(context).colorScheme;

    if (app.cart.isEmpty) {
      return SafeArea(
        child: Center(
          child: EmptyState(
            icon: Icons.shopping_bag_outlined,
            title: "Savatingiz hozircha bo'sh",
            subtitle: "Bosh sahifadan kerakli mahsulotlarni tanlang",
            action: FilledButton(onPressed: widget.onGoShopping, child: const Text('Xaridni boshlash')),
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text('Savat · ${app.cartCount} ta', style: const TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          TextButton(onPressed: _busy ? null : app.clearCart, child: const Text('Tozalash')),
        ],
      ),
      body: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        itemCount: app.cart.length,
        separatorBuilder: (_, __) => const Divider(height: 24),
        itemBuilder: (context, i) => _cartItem(app, app.cart[i]),
      ),
      bottomNavigationBar: Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        decoration: BoxDecoration(
          color: Theme.of(context).scaffoldBackgroundColor,
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 12, offset: const Offset(0, -2))],
        ),
        child: Row(
          children: [
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Jami', style: TextStyle(color: Colors.grey, fontSize: 13)),
                Text(formatSum(app.total), style: TextStyle(fontWeight: FontWeight.w900, fontSize: 19, color: scheme.onSurface)),
              ],
            ),
            const SizedBox(width: 16),
            Expanded(
              child: FilledButton(
                onPressed: _busy ? null : () => _openCheckout(app),
                child: const Text('Rasmiylashtirish'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _cartItem(AppState app, CartItem item) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: SizedBox(width: 84, height: 84, child: ProductImage(product: item.product, iconSize: 32)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(item.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, height: 1.3)),
              const SizedBox(height: 4),
              Text(formatSum(item.sum), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              const SizedBox(height: 8),
              Row(
                children: [
                  Container(
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.grey.withValues(alpha: 0.3)),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _stepBtn(Icons.remove, _busy ? null : () => app.updateCartQty(item.key, -1)),
                        SizedBox(
                          width: 30,
                          child: Text('${item.qty}', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w800)),
                        ),
                        _stepBtn(Icons.add, _busy || item.qty >= item.product.stock ? null : () => app.updateCartQty(item.key, 1)),
                      ],
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    tooltip: "O'chirish",
                    icon: Icon(Icons.delete_outline, color: scheme.error),
                    onPressed: _busy ? null : () => app.updateCartQty(item.key, -item.qty),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _stepBtn(IconData icon, VoidCallback? onTap) => InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: SizedBox(width: 36, height: 36, child: Icon(icon, size: 18, color: onTap == null ? Colors.grey : null)),
      );

  Future<void> _openCheckout(AppState app) async {
    final data = await showModalBottomSheet<_CheckoutData>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _CheckoutSheet(app: app),
    );
    if (data == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final result = await app.checkout(data.method, customerName: data.name, customerPhone: data.phone);
      if (!mounted) return;
      await Navigator.push(context, MaterialPageRoute(builder: (_) => ReceiptScreen(result: result)));
    } on ApiException catch (e) {
      widget.toast(e.message, error: true);
    } catch (_) {
      widget.toast("Buyurtmani rasmiylashtirib bo'lmadi", error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

class _CheckoutData {
  final PayMethod method;
  final String name;
  final String phone;

  _CheckoutData(this.method, this.name, this.phone);
}

/// Rasmiylashtirish varag'i: mijoz, to'lov usuli va yakuniy summa.
class _CheckoutSheet extends StatefulWidget {
  final AppState app;

  const _CheckoutSheet({required this.app});

  @override
  State<_CheckoutSheet> createState() => _CheckoutSheetState();
}

class _CheckoutSheetState extends State<_CheckoutSheet> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  late PayMethod _method = widget.app.payMethods.first;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  IconData _icon(PayMethod m) =>
      m.online ? Icons.qr_code_2 : m.provider == 'card' ? Icons.credit_card : Icons.payments_outlined;

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Rasmiylashtirish', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
            const SizedBox(height: 16),
            const Text('Xaridor (ixtiyoriy)', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Ism familiya', prefixIcon: Icon(Icons.person_outline)),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                  labelText: 'Telefon', hintText: '+998 90 123 45 67', prefixIcon: Icon(Icons.phone_iphone)),
            ),
            const SizedBox(height: 18),
            const Text("To'lov usuli", style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            ...app.payMethods.map((m) {
              final selected = m.provider == _method.provider;
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => setState(() => _method = m),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: selected ? scheme.primary : Colors.grey.withValues(alpha: 0.3), width: selected ? 2 : 1),
                      color: selected ? scheme.primary.withValues(alpha: 0.06) : null,
                    ),
                    child: Row(
                      children: [
                        Icon(_icon(m), color: selected ? scheme.primary : Colors.grey),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(m.label, style: const TextStyle(fontWeight: FontWeight.w700)),
                              Text(m.online ? "Onlayn — havola orqali to'lanadi" : "Kassada to'lanadi",
                                  style: const TextStyle(fontSize: 12, color: Colors.grey)),
                            ],
                          ),
                        ),
                        Icon(selected ? Icons.radio_button_checked : Icons.radio_button_off,
                            color: selected ? scheme.primary : Colors.grey),
                      ],
                    ),
                  ),
                ),
              );
            }),
            const Divider(height: 28),
            Row(
              children: [
                Text('${app.cartCount} ta mahsulot', style: const TextStyle(color: Colors.grey)),
                const Spacer(),
                Text(formatSum(app.total), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900)),
              ],
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () => Navigator.pop(context, _CheckoutData(_method, _name.text, _phone.text)),
              child: Text(_method.online ? "To'lovga o'tish" : 'Buyurtmani tasdiqlash'),
            ),
          ],
        ),
      ),
    );
  }
}

// ── 4. PROFIL ─────────────────────────────────────────────────
class _ProfileTab extends StatelessWidget {
  final void Function(String, {bool error}) toast;

  const _ProfileTab({required this.toast});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final user = app.currentUser;
    if (user == null) return const SizedBox.shrink();   // chiqish paytida bir lahza
    final scheme = Theme.of(context).colorScheme;
    final today = app.todaySales;

    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 32,
                backgroundColor: scheme.primary,
                child: Text(user.name.isNotEmpty ? user.name[0].toUpperCase() : '?',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 24)),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(user.name, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text([user.roleLabel, if (user.phone.isNotEmpty) user.phone].join(' · '),
                        style: const TextStyle(color: Colors.grey)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Expanded(child: _stat(context, formatSum(app.todayTotal, currency: false), "Bugun, so'm", Icons.payments_outlined)),
              const SizedBox(width: 12),
              Expanded(child: _stat(context, '${today.length}', 'Buyurtmalar', Icons.receipt_long_outlined)),
            ],
          ),
          const SizedBox(height: 20),
          _group(context, [
            _tile(
              Icons.receipt_long_outlined,
              'Buyurtmalarim',
              'Bugungi buyurtmalar: ${today.length} ta',
              () => Navigator.push(context, MaterialPageRoute(builder: (_) => const _OrdersScreen())),
            ),
            _tile(
              Icons.storefront_outlined,
              'Filial',
              app.branchId.isEmpty ? 'Tanlanmagan' : app.branchName,
              app.canChangeBranch ? () => _pickBranch(context, app) : null,
              trailing: app.canChangeBranch ? null : const Icon(Icons.lock_outline, size: 18, color: Colors.grey),
            ),
          ]),
          const SizedBox(height: 12),
          _group(context, [
            _tile(Icons.sync, "Ma'lumotlarni yangilash", 'Mahsulotlar, narx va qoldiq', () async {
              await app.loadData();
              if (app.loadError == null) toast('Yangilandi');
            }),
            _tile(Icons.dns_outlined, 'Server', Uri.parse(ApiService.baseUrl).host, null, trailing: const SizedBox.shrink()),
          ]),
          const SizedBox(height: 12),
          _group(context, [
            _tile(Icons.logout, 'Chiqish', '', () => _logout(context, app), color: scheme.error, trailing: const SizedBox.shrink()),
          ]),
          const SizedBox(height: 18),
          const Center(child: Text('Texno Park N1 · v1.2.0', style: TextStyle(fontSize: 12, color: Colors.grey))),
        ],
      ),
    );
  }

  Widget _stat(BuildContext context, String value, String label, IconData icon) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(16)),
      child: Row(
        children: [
          Icon(icon, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
                Text(label, style: const TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _group(BuildContext context, List<Widget> tiles) => Container(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(18),
        ),
        child: Column(
          children: [
            for (var i = 0; i < tiles.length; i++) ...[
              if (i > 0) const Divider(height: 1, indent: 56),
              tiles[i],
            ],
          ],
        ),
      );

  Widget _tile(IconData icon, String title, String subtitle, VoidCallback? onTap, {Widget? trailing, Color? color}) =>
      ListTile(
        leading: Icon(icon, color: color),
        title: Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: color)),
        subtitle: subtitle.isEmpty ? null : Text(subtitle),
        trailing: trailing ?? const Icon(Icons.chevron_right),
        onTap: onTap,
      );

  Future<void> _pickBranch(BuildContext context, AppState app) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text('Filialni tanlang', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            ),
            ...app.branches.map((b) => ListTile(
                  leading: Icon(b.id == app.branchId ? Icons.radio_button_checked : Icons.radio_button_off),
                  title: Text(b.name),
                  onTap: () => Navigator.pop(ctx, b.id),
                )),
          ],
        ),
      ),
    );
    if (picked == null || picked == app.branchId) return;
    if (app.cart.isNotEmpty) toast('Filial almashdi — savat tozalandi');
    await app.setBranch(picked);
  }

  Future<void> _logout(BuildContext context, AppState app) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Chiqish'),
        content: Text(app.cart.isEmpty ? 'Hisobdan chiqasizmi?' : "Savatdagi mahsulotlar o'chadi. Chiqasizmi?"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Bekor')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Chiqish')),
        ],
      ),
    );
    if (ok == true) await app.logout();
  }
}

/// «Buyurtmalarim» — bugungi to'langan cheklar.
class _OrdersScreen extends StatelessWidget {
  const _OrdersScreen();

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final list = app.todaySales;
    return Scaffold(
      appBar: AppBar(title: Text('Buyurtmalar · ${AppState.todayStr()}')),
      body: RefreshIndicator(
        onRefresh: app.loadData,
        child: list.isEmpty
            ? ListView(children: const [
                EmptyState(icon: Icons.receipt_long_outlined, title: "Bugun hali buyurtma yo'q"),
              ])
            : ListView.separated(
                padding: const EdgeInsets.all(16),
                itemCount: list.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (context, i) => _OrderCard(sale: list[i]),
              ),
      ),
    );
  }
}

class _OrderCard extends StatelessWidget {
  final Sale sale;

  const _OrderCard({required this.sale});

  @override
  Widget build(BuildContext context) {
    final names = sale.items.map((i) => '${i.name} × ${i.qty}').join(', ');
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.grey.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('#${sale.id}', style: const TextStyle(fontWeight: FontWeight.w800)),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: Colors.green.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(8)),
                child: const Text("To'langan", style: TextStyle(color: Colors.green, fontSize: 12, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(names, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
          const SizedBox(height: 8),
          Row(
            children: [
              Text('${sale.time} · ${sale.pay}', style: const TextStyle(color: Colors.grey, fontSize: 12.5)),
              const Spacer(),
              Text(formatSum(sale.total), style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
            ],
          ),
        ],
      ),
    );
  }
}
