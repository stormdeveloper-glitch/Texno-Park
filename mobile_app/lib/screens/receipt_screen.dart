import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/product.dart';
import '../models/sale.dart';
import '../providers/app_state.dart';
import '../services/api_service.dart';
import '../utils/format.dart';

class ReceiptScreen extends StatefulWidget {
  final CheckoutResult result;

  const ReceiptScreen({super.key, required this.result});

  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> {
  Timer? _pollingTimer;
  bool _polling = false;
  late String _status;

  Sale get sale => widget.result.sale;
  String get _payUrl => widget.result.payUrl ?? '';
  String get _orderId => widget.result.orderId ?? '';

  @override
  void initState() {
    super.initState();
    _status = sale.status;
    if (_status == 'pending' && _orderId.isNotEmpty) {
      _pollingTimer = Timer.periodic(const Duration(seconds: 3), (_) => _checkStatus());
      WidgetsBinding.instance.addPostFrameCallback((_) => _openPayment());
    }
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    super.dispose();
  }

  Future<void> _openPayment() async {
    if (_payUrl.isEmpty) return;
    final ok = await launchUrl(Uri.parse(_payUrl), mode: LaunchMode.externalApplication).catchError((_) => false);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("To'lov havolasini ochib bo'lmadi")));
    }
  }

  /// Holat serverdan so'raladi — to'lov tizimi webhook orqali tasdiqlaydi.
  Future<void> _checkStatus() async {
    if (_polling) return;   // oldingi so'rov hali tugamagan
    _polling = true;
    try {
      final res = await ApiService.paymentStatus(_orderId);
      final status = toStr(res['status']);
      if (!mounted || status == _status) return;
      if (status == 'paid' || status == 'expired' || status == 'cancelled') {
        _pollingTimer?.cancel();
        setState(() => _status = status);
        if (status == 'paid') {
          await context.read<AppState>().markSalePaid(sale.id);
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text("To'lov qabul qilindi!"), backgroundColor: Colors.green),
            );
          }
        }
      }
    } catch (_) {
      // Vaqtinchalik tarmoq xatosi — keyingi urinishda qayta so'raladi
    } finally {
      _polling = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final pending = _status == 'pending';
    final failed = _status == 'expired' || _status == 'cancelled';

    return Scaffold(
      appBar: AppBar(title: Text(pending ? "To'lov kutilmoqda" : failed ? "To'lov bekor qilindi" : 'Xarid cheki')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16.0),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _statusCard(pending, failed),
                  const SizedBox(height: 16),
                  if (pending && _payUrl.isNotEmpty) ...[
                    FilledButton.icon(
                      onPressed: _openPayment,
                      icon: const Icon(Icons.open_in_new),
                      label: Text("${sale.pay} orqali to'lash"),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      "To'lov tasdiqlangach ushbu oyna avtomatik yangilanadi.",
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (!pending && !failed) _receipt(app),
                  const SizedBox(height: 20),
                  OutlinedButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Yangi savdo'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _statusCard(bool pending, bool failed) {
    final color = pending ? Colors.amber.shade700 : failed ? Colors.redAccent : Colors.green;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Column(
        children: [
          if (pending)
            SizedBox(width: 44, height: 44, child: CircularProgressIndicator(strokeWidth: 4, color: color))
          else
            Icon(failed ? Icons.cancel : Icons.check_circle, size: 48, color: color),
          const SizedBox(height: 12),
          Text(
            pending ? "TO'LOV KUTILMOQDA" : failed ? "TO'LOV AMALGA OSHMADI" : 'SAVDO YAKUNLANDI',
            style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 16),
          ),
          const SizedBox(height: 6),
          Text(formatSum(sale.total), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
          if (failed) ...[
            const SizedBox(height: 6),
            const Text("Savdo saqlangan, lekin to'lanmagan. Administratorga xabar bering.",
                textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ],
      ),
    );
  }

  Widget _receipt(AppState app) {
    final address = toStr(app.settings['companyAddress']);
    final phone = toStr(app.settings['companyPhone']);
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: Colors.grey.withValues(alpha: 0.2)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(app.companyName,
                textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            if (address.isNotEmpty || phone.isNotEmpty)
              Text([address, phone].where((s) => s.isNotEmpty).join('\n'),
                  textAlign: TextAlign.center, style: const TextStyle(fontSize: 11, color: Colors.grey)),
            const Divider(height: 28),
            _row('Chek #', '${sale.id}'),
            _row('Sana', '${sale.date} ${sale.time}'),
            _row('Kassir', sale.cashier),
            if (sale.customer.isNotEmpty && sale.customer != "Noma'lum") _row('Mijoz', sale.customer),
            const Divider(height: 28),
            ...sale.items.map((item) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: Text('${item.name} × ${item.qty}', style: const TextStyle(fontSize: 13))),
                      const SizedBox(width: 12),
                      Text(formatSum(item.price * item.qty, currency: false), style: const TextStyle(fontSize: 13)),
                    ],
                  ),
                )),
            const Divider(height: 28),
            _row('Jami', formatSum(sale.total), bold: true),
            _row("To'lov turi", sale.pay),
            const SizedBox(height: 14),
            const Text('Xaridingiz uchun rahmat!', textAlign: TextAlign.center, style: TextStyle(fontStyle: FontStyle.italic)),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Text(label, style: const TextStyle(color: Colors.grey, fontSize: 13)),
          const SizedBox(width: 12),
          Expanded(
            child: Text(value,
                textAlign: TextAlign.right,
                style: TextStyle(fontSize: bold ? 15 : 13, fontWeight: bold ? FontWeight.w800 : FontWeight.normal)),
          ),
        ],
      ),
    );
  }
}
