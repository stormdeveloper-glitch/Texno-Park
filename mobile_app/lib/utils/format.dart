import 'package:intl/intl.dart';

final _sum = NumberFormat('#,##0', 'en_US');

/// 1500000 -> "1 500 000 so'm"
String formatSum(num value, {bool currency = true}) {
  final text = _sum.format(value.round()).replaceAll(',', ' ');
  return currency ? "$text so'm" : text;
}
