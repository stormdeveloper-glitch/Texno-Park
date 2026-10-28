import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/app_state.dart';
import '../services/api_service.dart';

/// Kirish ekrani — onlayn do'kon ilovalari uslubida: yuqorida brend bloki,
/// pastda yumaloq «varaq» ichida forma.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _obscureText = true;
  bool _busy = false;
  String? _errorMessage;

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _handleLogin() async {
    final username = _usernameController.text.trim();
    final password = _passwordController.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _errorMessage = 'Login va parolni kiriting');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _errorMessage = null;
    });
    try {
      // Muvaffaqiyatda AppState o'zgaradi va asosiy ekran avtomatik ochiladi
      await context.read<AppState>().login(username, password);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errorMessage = e.message);
    } catch (_) {
      if (mounted) setState(() => _errorMessage = "Kirishda kutilmagan xatolik");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final media = MediaQuery.of(context);

    return Scaffold(
      // Brend gradientining pastki rangi — varaq burchaklari ortida ko'rinadi
      backgroundColor: const Color(0xFFF46A16),
      body: SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: media.size.height),
          // Varaq (Expanded) ekran oxirigacha cho'ziladi, uzun bo'lsa sahifa aylanadi
          child: IntrinsicHeight(
            child: Column(
              children: [
                // ── Brend bloki ──
                Container(
                  width: double.infinity,
                  padding: EdgeInsets.fromLTRB(24, media.padding.top + 36, 24, 40),
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [Color(0xFFFF8A3D), Color(0xFFF2600C)],
                    ),
                  ),
                  child: Column(
                    children: [
                      Container(
                        width: 76,
                        height: 76,
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(24),
                          boxShadow: [
                            BoxShadow(
                                color: Colors.black.withValues(alpha: 0.12), blurRadius: 20, offset: const Offset(0, 8))
                          ],
                        ),
                        child: Icon(Icons.shopping_bag_rounded, color: scheme.primary, size: 40),
                      ),
                      const SizedBox(height: 16),
                      const Text('Texno Park N1',
                          style: TextStyle(
                              color: Colors.white, fontSize: 28, fontWeight: FontWeight.w900, letterSpacing: -0.5)),
                      const SizedBox(height: 4),
                      Text('Maishiy texnika va elektronika do\'koni',
                          style: TextStyle(color: Colors.white.withValues(alpha: 0.9), fontSize: 14)),
                      const SizedBox(height: 22),
                      const Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        alignment: WrapAlignment.center,
                        children: [
                          _Perk(icon: Icons.verified_outlined, text: 'Kafolat'),
                          _Perk(icon: Icons.calendar_month_outlined, text: "Muddatli to'lov"),
                          _Perk(icon: Icons.local_shipping_outlined, text: 'Yetkazib berish'),
                        ],
                      ),
                    ],
                  ),
                ),
                // ── Forma varag'i ──
                Expanded(
                  child: Container(
                    width: double.infinity,
                    decoration: BoxDecoration(
                      color: Theme.of(context).scaffoldBackgroundColor,
                      borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
                    ),
                    padding: EdgeInsets.fromLTRB(24, 28, 24, 24 + media.padding.bottom),
                    alignment: Alignment.topCenter,
                    child: Center(
                      heightFactor: 1,
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 440),
                        child: AutofillGroup(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              const Text('Xush kelibsiz!', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w900)),
                              const SizedBox(height: 4),
                              const Text('Hisobingizga kiring', style: TextStyle(color: Colors.grey, fontSize: 14)),
                              const SizedBox(height: 24),
                              TextField(
                                controller: _usernameController,
                                enabled: !_busy,
                                textInputAction: TextInputAction.next,
                                autofillHints: const [AutofillHints.username, AutofillHints.telephoneNumber],
                                decoration: const InputDecoration(
                                  labelText: 'Telefon raqam yoki login',
                                  hintText: '+998 90 123 45 67',
                                  prefixIcon: Icon(Icons.phone_iphone),
                                ),
                              ),
                              const SizedBox(height: 14),
                              TextField(
                                controller: _passwordController,
                                enabled: !_busy,
                                obscureText: _obscureText,
                                textInputAction: TextInputAction.done,
                                autofillHints: const [AutofillHints.password],
                                onSubmitted: (_) => _handleLogin(),
                                decoration: InputDecoration(
                                  labelText: 'Parol',
                                  prefixIcon: const Icon(Icons.lock_outline),
                                  suffixIcon: IconButton(
                                    tooltip: _obscureText ? "Parolni ko'rsatish" : 'Parolni yashirish',
                                    icon:
                                        Icon(_obscureText ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                                    onPressed: () => setState(() => _obscureText = !_obscureText),
                                  ),
                                ),
                              ),
                              AnimatedSize(
                                duration: const Duration(milliseconds: 200),
                                child: _errorMessage == null
                                    ? const SizedBox(width: double.infinity)
                                    : Container(
                                        margin: const EdgeInsets.only(top: 14),
                                        padding: const EdgeInsets.all(12),
                                        decoration: BoxDecoration(
                                          color: Colors.red.withValues(alpha: 0.08),
                                          borderRadius: BorderRadius.circular(12),
                                        ),
                                        child: Row(
                                          children: [
                                            const Icon(Icons.error_outline, color: Colors.redAccent, size: 20),
                                            const SizedBox(width: 10),
                                            Expanded(
                                              child: Text(_errorMessage!,
                                                  style: const TextStyle(
                                                      color: Colors.redAccent, fontWeight: FontWeight.w600)),
                                            ),
                                          ],
                                        ),
                                      ),
                              ),
                              const SizedBox(height: 22),
                              FilledButton(
                                onPressed: _busy ? null : _handleLogin,
                                child: _busy
                                    ? const SizedBox(
                                        width: 22,
                                        height: 22,
                                        child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                                    : const Text('Kirish'),
                              ),
                              const SizedBox(height: 16),
                              const Text(
                                "Parolni unutdingizmi? Do'kon administratoriga murojaat qiling.",
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 12.5, color: Colors.grey, height: 1.4),
                              ),
                              const SizedBox(height: 6),
                              Text(
                                Uri.parse(ApiService.baseUrl).host,
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 11, color: Colors.grey.shade400),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Perk extends StatelessWidget {
  final IconData icon;
  final String text;

  const _Perk({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(20),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: Colors.white),
            const SizedBox(width: 6),
            Text(text, style: const TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w600)),
          ],
        ),
      );
}
