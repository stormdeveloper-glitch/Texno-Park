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
          children: [
            CircleAvatar(
              backgroundColor: _parseColor(user.color),
              radius: 16,
              child: Text(user.name.isNotEmpty ? user.name[0] : 'U', style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(user.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                Text(user.role.toUpperCase(), style: const TextStyle(fontSize: 10, color: Colors.grey)),
              ],
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout_outlined),
            onPressed: () {
              appState.logout();
              Navigator.pushReplacement(
                context,
                MaterialPageRoute(builder: (context) => const LoginScreen()),
              );
            },
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
          padding: const EdgeInsets.all(12.0),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Qidirish...',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              contentPadding: const EdgeInsets.symmetric(vertical: 0),
            ),
            onChanged: (val) {
              // Local search logic if needed
            },
          ),
        ),
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              childAspectRatio: 0.8,
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
            ),
            itemCount: appState.products.length,
            itemBuilder: (context, idx) {
              final prod = appState.products[idx];
              return Card(
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                child: Padding(
                  padding: const EdgeInsets.all(10.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        child: Container(
                          decoration: BoxDecoration(
                            color: Colors.grey.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: const Center(
                            child: Icon(Icons.devices_other, size: 40, color: Colors.grey),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(prod.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13), maxLines: 1),
                      Text('${prod.price.toStringAsFixed(0)} so\'m', style: const TextStyle(color: Colors.deepOrange, fontSize: 12, fontWeight: FontWeight.bold)),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Qoldiq: ${prod.stock}', style: const TextStyle(fontSize: 10, color: Colors.grey)),
                          IconButton(
                            icon: const Icon(Icons.add_shopping_cart, size: 18),
                            onPressed: () {
                              appState.addToCart(prod);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('${prod.name} savatga qo\'shildi'), duration: const Duration(seconds: 1)),
                              );
                            },
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
            Icon(Icons.shopping_cart_outlined, size: 64, color: Colors.grey),
            SizedBox(height: 16),
            Text('Savat bo\'sh', style: TextStyle(color: Colors.grey, fontSize: 16)),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.all(16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView.builder(
              itemCount: appState.cart.length,
              itemBuilder: (context, idx) {
                final item = appState.cart[idx];
                return Card(
                  margin: const EdgeInsets.only(bottom: 10),
                  child: ListTile(
                    title: Text(item.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                    subtitle: Text('${item.price.toStringAsFixed(0)} so\'m', style: const TextStyle(color: Colors.deepOrange)),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: const Icon(Icons.remove_circle_outline, size: 20),
                          onPressed: () => appState.updateCartQty(item.id, -1),
                        ),
                        Text('${item.qty}', style: const TextStyle(fontWeight: FontWeight.bold)),
                        IconButton(
                          icon: const Icon(Icons.add_circle_outline, size: 20),
                          onPressed: () => appState.updateCartQty(item.id, 1),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
          const Divider(),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8.0),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Jami Summa:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                Text('${appState.total.toStringAsFixed(0)} so\'m', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: Colors.deepOrange)),
              ],
            ),
          ),
          const SizedBox(height: 8),
          
          // Customer Phone
          TextField(
            controller: _phoneController,
            decoration: InputDecoration(
              labelText: 'Mijoz telefon raqami',
              prefixIcon: const Icon(Icons.phone),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
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
            ),
            child: const Text('To\'lovni rasmiylashtirish', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          ),
        ],
      ),
    );
  }

  // 3. DASHBOARD TAB
  Widget _buildDashboardTab(AppState appState) {
    final todaySales = appState.sales.fold(0.0, (sum, s) => sum + (s.status == 'paid' ? s.total : 0.0));
    final todayOrders = appState.sales.where((s) => s.status == 'paid').length;

    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        Row(
          children: [
            Expanded(
              child: Card(
                color: Colors.deepOrange.withOpacity(0.06),
                child: Padding(
                  padding: const EdgeInsets.all(16.0),
                  child: Column(
                    children: [
                      const Icon(Icons.monetization_on_outlined, color: Colors.deepOrange),
                      const SizedBox(height: 8),
                      Text('${todaySales.toStringAsFixed(0)}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                      const Text('Bugungi Savdo', style: TextStyle(fontSize: 11, color: Colors.grey)),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Card(
                color: Colors.green.withOpacity(0.06),
                child: Padding(
                  padding: const EdgeInsets.all(16.0),
                  child: Column(
                    children: [
                      const Icon(Icons.shopping_bag_outlined, color: Colors.green),
                      const SizedBox(height: 8),
                      Text('$todayOrders', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                      const Text('Buyurtmalar soni', style: TextStyle(fontSize: 11, color: Colors.grey)),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        const Text('Oxirgi sotuvlar logi', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        const SizedBox(height: 8),
        ...appState.logs.reversed.take(10).map((log) => ListTile(
              leading: const Icon(Icons.history_toggle_off, size: 20),
              title: Text(log['desc'] ?? '', style: const TextStyle(fontSize: 13)),
              subtitle: Text(log['time'] ?? '', style: const TextStyle(fontSize: 11)),
            )),
      ],
    );
  }

  // 4. SETTINGS TAB
  Widget _buildSettingsTab(AppState appState) {
    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        const ListTile(
          title: Text('Xizmat Sozlamalari', style: TextStyle(fontWeight: FontWeight.bold)),
          leading: Icon(Icons.settings),
        ),
        const Divider(),
        ListTile(
          title: const Text('Ma\'lumotlarni server bilan sinxronlash'),
          subtitle: const Text('Serverdan yangi tovarlar va hisobotlarni olish'),
          trailing: const Icon(Icons.sync),
          onTap: () async {
            await appState.loadData();
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Ma\'lumotlar muvaffaqiyatli sinxronlandi!')),
              );
            }
          },
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
