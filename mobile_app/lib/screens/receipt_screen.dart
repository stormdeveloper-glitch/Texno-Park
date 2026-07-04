import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/sale.dart';
import '../providers/app_state.dart';
import '../services/api_service.dart';

class ReceiptScreen extends StatefulWidget {
  final Sale sale;

  const ReceiptScreen({super.key, required this.sale});

  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> {
  Timer? _pollingTimer;
  late String _status;
  bool _isPolling = false;

  @override
  void initState() {
    super.initState();
    _status = widget.sale.status;
    if (_status == 'pending') {
      _startPolling();
      _launchClickUrl();
    }
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    super.dispose();
  }

  String _getClickUrl() {
    const serviceId = '33303';
    const merchantId = '24564';
    final returnUrl = Uri.encodeComponent('https://texnopark.uz');
    return 'https://my.click.uz/services/pay?service_id=$serviceId&merchant_id=$merchantId&amount=${widget.sale.total}&transaction_param=${widget.sale.id}&return_url=$returnUrl';
  }

  Future<void> _launchClickUrl() async {
    final clickUrl = Uri.parse(_getClickUrl());
    try {
      if (await launchUrl(clickUrl, mode: LaunchMode.externalApplication)) {
        print('Opened click payment link successfully');
      }
    } catch (e) {
      print('Could not launch click url: $e');
    }
  }

  void _startPolling() {
    _isPolling = true;
    _pollingTimer = Timer.periodic(const Duration(seconds: 3), (timer) async {
      final serverStatus = await ApiService.checkPaymentStatus(widget.sale.id);
      if (serverStatus == 'paid') {
        timer.cancel();
        if (mounted) {
          setState(() {
            _status = 'paid';
            _isPolling = false;
          });
          Provider.of<AppState>(context, listen: false).updateSaleStatus(widget.sale.id, 'paid');
          
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('To\'lov muvaffaqiyatli qabul qilindi!'),
              backgroundColor: Colors.green,
            ),
          );
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final isPending = _status == 'pending';
    final clickUrlString = _getClickUrl();
    final ussdCode = '*880*1*33303*${widget.sale.total.toInt()}#';

    return Scaffold(
      appBar: AppBar(
        title: Text(isPending ? 'To\'lov kutilmoqda' : 'Xarid Cheki'),
        centerTitle: true,
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16.0),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 500),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Top status card
                Card(
                  color: isPending ? Colors.amber.shade50.withOpacity(0.1) : Colors.green.shade50.withOpacity(0.1),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(
                      color: isPending ? Colors.amber.withOpacity(0.3) : Colors.green.withOpacity(0.3),
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(20.0),
                    child: Column(
                      children: [
                        if (isPending) ...[
                          const SizedBox(
                            width: 48,
                            height: 48,
                            child: CircularProgressIndicator(
                              strokeWidth: 4,
                              valueColor: AlwaysStoppedAnimation<Color>(Colors.amber),
                            ),
                          ),
                          const SizedBox(height: 16),
                          const Text(
                            'CLICK TO\'LOVI KUTILMOQDA',
                            style: TextStyle(color: Colors.amber, fontWeight: FontWeight.bold, fontSize: 16),
                          ),
                        ] else ...[
                          const Icon(Icons.check_circle, size: 48, color: Colors.green),
                          const SizedBox(height: 16),
                          const Text(
                            'TO\'LOV TASDIQLANDI!',
                            style: TextStyle(color: Colors.green, fontWeight: FontWeight.bold, fontSize: 18),
                          ),
                        ],
                        const SizedBox(height: 8),
                        Text(
                          'Mablag\': ${widget.sale.total.toStringAsFixed(0)} so\'m',
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.bold,
                            color: isPending ? Colors.amber.shade800 : Colors.green.shade800,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),

                // Click Payment Details (shown only if pending click)
                if (isPending) ...[
                  Card(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    child: Padding(
                      padding: const EdgeInsets.all(20.0),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          const Text(
                            'Click orqali to\'lash',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                          ),
                          const SizedBox(height: 12),
                          ElevatedButton.icon(
                            onPressed: _launchClickUrl,
                            icon: const Icon(Icons.open_in_new),
                            label: const Text('To\'lov oynasini ochish'),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.blueAccent,
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                          ),
                          const SizedBox(height: 16),
                          const Divider(),
                          const SizedBox(height: 8),
                          const Text(
                            'Click Lite (USSD) orqali to\'lash:',
                            style: TextStyle(fontSize: 12, color: Colors.grey),
                          ),
                          const SizedBox(height: 4),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                            decoration: BoxDecoration(
                              color: Colors.grey.withOpacity(0.1),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: SelectableText(
                              ussdCode,
                              style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.deepOrange, fontSize: 14),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],

                // Actual Receipt Paper (hidden if pending, shown if paid)
                if (!isPending) ...[
                  Card(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    child: Padding(
                      padding: const EdgeInsets.all(24.0),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text(
                            'Texno PARK',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontWeight: FontWeight.extrabold, fontSize: 20),
                          ),
                          const Text(
                            'Chilonzor 12, Toshkent\n+998 90 123 45 67\nwww.Texnopark.uz',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontSize: 11, color: Colors.grey),
                          ),
                          const Divider(height: 32),
                          _buildReceiptRow('Chek #:', widget.sale.id.toString().padLeft(5, '0')),
                          _buildReceiptRow('Sana:', widget.sale.date),
                          _buildReceiptRow('Vaqt:', widget.sale.time),
                          _buildReceiptRow('Kassir:', widget.sale.cashier),
                          _buildReceiptRow('Mijoz:', widget.sale.customer),
                          const Divider(height: 32),
                          
                          // Items
                          ...widget.sale.items.map((item) => Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4.0),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text('${item.name} x${item.qty}', style: const TextStyle(fontSize: 13)),
                                Text((item.price * item.qty).toStringAsFixed(0), style: const TextStyle(fontSize: 13)),
                              ],
                            ),
                          )),
                          
                          const Divider(height: 32),
                          _buildReceiptRow('Jami:', widget.sale.subtotal.toStringAsFixed(0)),
                          _buildReceiptRow('To\'lov turi:', widget.sale.pay, isBold: true),
                          const Divider(height: 32),
                          const Text(
                            'Rahmat xarid uchun! 🙏',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontStyle: FontStyle.italic),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 24),

                // Back to home button
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  ),
                  child: const Text('Orqaga qaytish'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildReceiptRow(String label, String value, {bool isBold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4.0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.grey, fontSize: 13)),
          Text(
            value,
            style: TextStyle(
              fontWeight: isBold ? FontWeight.bold : FontWeight.normal,
              fontSize: 13,
            ),
          ),
        ],
      ),
    );
  }
}
