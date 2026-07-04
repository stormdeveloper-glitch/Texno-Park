class User {
  final int id;
  final String login;
  final String name;
  final String role;
  final String color;
  final String passHash;

  User({
    required this.id,
    required this.login,
    required this.name,
    required this.role,
    required this.color,
    required this.passHash,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] ?? 0,
      login: json['login'] ?? '',
      name: json['name'] ?? '',
      role: json['role'] ?? 'customer',
      color: json['color'] ?? '#ff6b35',
      passHash: json['passHash'] ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'login': login,
      'name': name,
      'role': role,
      'color': color,
      'passHash': passHash,
    };
  }
}
