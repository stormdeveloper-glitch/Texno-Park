import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:mobile_app/main.dart';
import 'package:mobile_app/models/product.dart';
import 'package:mobile_app/models/sale.dart';
import 'package:mobile_app/providers/app_state.dart';
import 'package:mobile_app/utils/format.dart';

void main() {
  group('JSON parsing', () {
    test('Product serverdagi har xil son ko\'rinishlarini o\'qiydi', () {
      final p = Product.fromJson({'id': '17', 'name': 'Telefon', 'price': '1500000', 'stock': 3.0, 'branchId': ' b1 '});
      expect(p.key, '17');
      expect(p.price, 1500000);
      expect(p.stock, 3);
      expect(p.branchId, 'b1');
    });

    test('Sale buzilgan elementlarni tashlab yuboradi', () {
      final s = Sale.fromJson({
        'id': 1790000000000,
        'items': [
          {'name': 'A', 'price': 1000, 'qty': 2},
          'buzilgan',
        ],
        'total': 2000,
      });
      expect(s.items.length, 1);
      expect(s.isPaid, isTrue);
      expect(s.pay, 'Naqd');
    });
  });

  test('formatSum bo\'sh joy bilan ajratadi', () {
    expect(formatSum(1500000), "1 500 000 so'm");
    expect(formatSum(999.6, currency: false), '1 000');
  });

  test('Savatga qoldiqdan ortiq qo\'shilmaydi', () async {
    SharedPreferences.setMockInitialValues({});
    final app = AppState();
    final p = Product(id: 1, name: 'X', price: 10, cat: '', img: '', stock: 2);
    expect(app.addToCart(p), isTrue);
    expect(app.addToCart(p), isTrue);
    expect(app.addToCart(p), isFalse);
    expect(app.cartCount, 2);
    expect(app.total, 20);
    app.updateCartQty(p.key, -2);
    expect(app.cart, isEmpty);
  });

  testWidgets('Saqlangan sessiya bo\'lmasa login ekrani ochiladi', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(ChangeNotifierProvider(create: (_) => AppState(), child: const TexnoParkApp()));
    await tester.pumpAndSettle();
    expect(find.text('Kirish'), findsOneWidget);
    expect(find.text('Telefon raqam yoki login'), findsOneWidget);

    // Bo'sh forma yuborilsa serverga so'rov ketmaydi, xato ko'rsatiladi
    await tester.tap(find.text('Kirish'));
    await tester.pump();
    expect(find.text('Login va parolni kiriting'), findsOneWidget);
  });
}
