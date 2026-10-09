import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/app_state.dart';
import '../models/product.dart';
import '../models/sale.dart';
import 'login_screen.dart';
import 'receipt_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _currentIndex = 0;
  final _phoneController = TextEditingController();
  String _payType = 'click';

  @override
  Widget build(BuildContext context) {
    final appState = Provider.of<AppState>(context);
    final user = appState.currentUser;

    if (user == null) {
      return const LoginScreen();
    }

    final tabs = [
      _buildCatalogTab(appState),
      _buildCartTab(appState),
      _buildDashboardTab(appState),
      _buildSettingsTab(appState),
    ];

    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircleAvatar(
              backgroundColor: _parseColor(user.color),
              radius: 16,
              child: Text(user.name.isNotEmpty ? user.name[0] : 'U', style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    user.name,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    user.role.toUpperCase(),
                    style: const TextStyle(fontSize: 10, color: Colors.grey),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          SizedBox(
            width: 48,
            height: 48,
            child: IconButton(
              icon: const Icon(Icons.logout_outlined, size: 22),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              onPressed: () {
                appState.logout();
                Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(builder: (context) => const LoginScreen()),
                );
              },
            ),
          )
        ],
      ),
      body: appState.isLoading
          ? const Center(child: CircularProgressIndicator())
          : tabs[_currentIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (idx) => setState(() => _currentIndex = idx),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.grid_view_outlined), label: 'Katalog'),
          NavigationDestination(icon: Icon(Icons.shopping_cart_outlined), label: 'Savat'),
          NavigationDestination(icon: Icon(Icons.analytics_outlined), label: 'Dashboard'),
          NavigationDestination(icon: Icon(Icons.settings_outlined), label: 'Sozlamalar'),
        ],
      ),
    );
  }

  // 1. CATALOG TAB
  Widget _buildCatalogTab(AppState appState) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12.0, 12.0, 12.0, 8.0),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Qidirish...',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 12),
            ),
            onChanged: (val) {
              // Local search logic if needed
            },
          ),
        ),
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              childAspectRatio: 0.75,
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
            ),
            itemCount: appState.products.length,
            itemBuilder: (context, idx) {
              final prod = appState.products[idx];
              return Card(
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                elevation: 1,
                child: Padding(
                  padding: const EdgeInsets.all(8.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(
                        height: 80,
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.grey.withOpacity(0.08),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Center(
                            child: Icon(Icons.devices_other, size: 36, color: Colors.grey),
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        prod.name,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12, height: 1.3),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${prod.price.toStringAsFixed(0)} so\'m',
                        style: const TextStyle(color: Colors.deepOrange, fontSize: 13, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Flexible(
                            child: Text(
                              'Qoldiq: ${prod.stock}',
                              style: const TextStyle(fontSize: 10, color: Colors.grey),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          SizedBox(
                            width: 44,
                            height: 44,
                            child: IconButton(
                              icon: const Icon(Icons.add_shopping_cart, size: 20),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(),
                              onPressed: () {
                                appState.addToCart(prod);
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(content: Text('${prod.name} savatga qo\'shildi'), duration: const Duration(seconds: 1)),
                                );
                              },
                            ),
                          )
                        ],
                      )
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  // 2. CART TAB
  Widget _buildCartTab(AppState appState) {
    if (appState.cart.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.shopping_cart_outlined, size: 72, color: Colors.grey),
            SizedBox(height: 16),
            Text('Savat bo\'sh', style: TextStyle(color: Colors.grey, fontSize: 16, fontWeight: FontWeight.w500)),
            SizedBox(height: 4),
            Text('Mahsulotlarni katalogdan qo\'shing', style: TextStyle(color: Colors.grey, fontSize: 13)),
          ],
        ),
      );
    }

    return Column(
      children: [
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            itemCount: appState.cart.length,
            itemBuilder: (context, idx) {
              final item = appState.cart[idx];
              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                elevation: 1,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                child: Padding(
                  padding: const EdgeInsets.all(12.0),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              item.name,
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '${item.price.toStringAsFixed(0)} so\'m',
                              style: const TextStyle(color: Colors.deepOrange, fontSize: 13, fontWeight: FontWeight.bold),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SizedBox(
                            width: 40,
                            height: 40,
                            child: IconButton(
                              icon: const Icon(Icons.remove_circle_outline, size: 22),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(),
                              onPressed: () => appState.updateCartQty(item.id, -1),
                            ),
                          ),
                          SizedBox(
                            width: 36,
                            child: Center(
                              child: Text('${item.qty}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                            ),
                          ),
                          SizedBox(
                            width: 40,
                            height: 40,
                            child: IconButton(
                              icon: const Icon(Icons.add_circle_outline, size: 22),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(),
                              onPressed: () => appState.updateCartQty(item.id, 1),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: Theme.of(context).cardColor,
            boxShadow: [
              BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 12, offset: const Offset(0, -4)),
            ],
          ),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Jami Summa:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  Text('${appState.total.toStringAsFixed(0)} so\'m', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: Colors.deepOrange)),
                ],
              ),
              const SizedBox(height: 14),

              // Customer Phone
              TextField(
                controller: _phoneController,
                decoration: InputDecoration(
                  labelText: 'Mijoz telefon raqami',
                  prefixIcon: const Icon(Icons.phone),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                ),
                keyboardType: TextInputType.phone,
              ),
              const SizedBox(height: 12),

              // Pay Type
              DropdownButtonFormField<String>(
                value: _payType,
                decoration: InputDecoration(
                  labelText: 'To\'lov turi',
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                ),
                items: const [
                  DropdownMenuItem(value: 'click', child: Text('Click (Onlayn)')),
                  DropdownMenuItem(value: 'card', child: Text('Plastik Karta')),
                  DropdownMenuItem(value: 'cash', child: Text('Naqd Pul')),
                ],
                onChanged: (val) => setState(() => _payType = val ?? 'click'),
              ),
              const SizedBox(height: 16),

              ElevatedButton(
                onPressed: () async {
                  final phone = _phoneController.text.trim();
                  if (phone.isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Iltimos, mijoz telefon raqamini kiriting')),
                    );
                    return;
                  }

                  final sale = await appState.checkout(_payType, phone);
                  if (sale != null) {
                    _phoneController.clear();
                    if (mounted) {
                      Navigator.push(
                        context,
                        MaterialPageRoute(builder: (context) => ReceiptScreen(sale: sale)),
                      );
                    }
                  }
                },
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  minimumSize: const Size(0, 52),
                ),
                child: const Text('To\'lovni rasmiylashtirish', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  // 3. DASHBOARD TAB
  Widget _buildDashboardTab(AppState appState) {
    final todaySales = appState.sales.fold(0.0, (sum, s) => sum + (s.status == 'paid' ? s.total : 0.0));
    final todayOrders = appState.sales.where((s) => s.status == 'paid').length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
      children: [
        Row(
          children: [
            Expanded(
              child: Card(
                elevation: 1,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                color: Colors.deepOrange.withOpacity(0.06),
                child: Padding(
                  padding: const EdgeInsets.all(14.0),
                  child: Column(
                    children: [
                      const Icon(Icons.monetization_on_outlined, size: 28, color: Colors.deepOrange),
                      const SizedBox(height: 8),
                      Text(
                        '${todaySales.toStringAsFixed(0)}',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      const Text('Bugungi Savdo', style: TextStyle(fontSize: 11, color: Colors.grey)),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Card(
                elevation: 1,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                color: Colors.green.withOpacity(0.06),
                child: Padding(
                  padding: const EdgeInsets.all(14.0),
                  child: Column(
                    children: [
                      const Icon(Icons.shopping_bag_outlined, size: 28, color: Colors.green),
                      const SizedBox(height: 8),
                      Text('$todayOrders', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                      const SizedBox(height: 2),
                      const Text('Buyurtmalar soni', style: TextStyle(fontSize: 11, color: Colors.grey)),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        const Text('Oxirgi sotuvlar logi', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
        const SizedBox(height: 8),
        if (appState.logs.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 32.0),
            child: Center(
              child: Column(
                children: [
                  Icon(Icons.receipt_long, size: 48, color: Colors.grey),
                  SizedBox(height: 12),
                  Text('Hali sotuvlar yo\'q', style: TextStyle(color: Colors.grey, fontSize: 14)),
                ],
              ),
            ),
          )
        else
          ...appState.logs.reversed.take(10).map((log) => Card(
                margin: const EdgeInsets.only(bottom: 8),
                elevation: 0,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(
                    children: [
                      const Icon(Icons.history_toggle_off, size: 18, color: Colors.grey),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              log['desc'] ?? '',
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 2),
                            Text(log['time'] ?? '', style: const TextStyle(fontSize: 11, color: Colors.grey)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              )),
      ],
    );
  }

  // 4. SETTINGS TAB
  Widget _buildSettingsTab(AppState appState) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
      children: [
        Card(
          elevation: 1,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.settings, size: 22, color: Colors.grey),
                    const SizedBox(width: 12),
                    const Text('Xizmat Sozlamalari', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                  ],
                ),
                const Divider(height: 24),
                InkWell(
                  onTap: () async {
                    await appState.loadData();
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Ma\'lumotlar muvaffaqiyatli sinxronlandi!')),
                      );
                    }
                  },
                  borderRadius: BorderRadius.circular(10),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                    child: Row(
                      children: [
                        const Icon(Icons.sync, size: 22),
                        const SizedBox(width: 14),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Ma\'lumotlarni sinxronlash', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                              SizedBox(height: 2),
                              Text('Serverdan yangi tovarlar va hisobotlarni olish', style: TextStyle(fontSize: 12, color: Colors.grey)),
                            ],
                          ),
                        ),
                        Icon(Icons.chevron_right, color: Colors.grey.withOpacity(0.5)),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        Card(
          elevation: 1,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Ilova haqida', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                const SizedBox(height: 8),
                const Text('Texno Park N1 POS', style: TextStyle(fontSize: 13, color: Colors.grey)),
                const Text('Versiya: 1.0.0', style: TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Color _parseColor(String hexColor) {
    try {
      final hex = hexColor.replaceAll('#', '');
      return Color(int.parse('FF$hex', radix: 16));
    } catch (_) {
      return Colors.deepOrange;
    }
  }
}
