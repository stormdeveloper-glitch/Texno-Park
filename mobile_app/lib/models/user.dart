import 'product.dart';

/// Kirgan xodim — ma'lumot faqat serverning login/session javobidan olinadi
/// (parol yoki uning xeshi ilovada hech qachon saqlanmaydi).
class User {
  final String login;
  final String name;
  final String role;
  final String phone;
  final String branchId;

  User({
    required this.login,
    required this.name,
    required this.role,
    this.phone = '',
    this.branchId = '',
  });

  factory User.fromJson(Map<String, dynamic> json) => User(
        login: toStr(json['login']),
        name: toStr(json['name']).isEmpty ? toStr(json['login']) : toStr(json['name']),
        role: toStr(json['role']),
        phone: toStr(json['phone']),
        branchId: toStr(json['branchId']).trim(),
      );

  String get roleLabel => const {
        'boss': 'Boshliq',
        'admin': 'Administrator',
        'manager': 'Menejer',
        'cashier': 'Kassir',
      }[role] ??
      role;
}

class Branch {
  final String id;
  final String name;

  Branch({required this.id, required this.name});

  factory Branch.fromJson(Map<String, dynamic> json) => Branch(
        id: toStr(json['id']).trim(),
        name: toStr(json['name']).isEmpty ? toStr(json['id']) : toStr(json['name']),
      );
}
