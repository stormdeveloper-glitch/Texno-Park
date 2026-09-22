import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiService {
  // Replace with your production Railway URL or local testing URL
  // Local emulator address for localhost is usually 10.0.2.2 on Android
  static const String baseUrl = 'https://texno-park-production.up.railway.app'; 

  // Fetch initial products, sales, and settings from Flask
  static Future<Map<String, dynamic>?> fetchInitialData() async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/data'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (e) {
      print('Error fetching data from API: $e');
    }
    return null;
  }

  // Save/sync sales, products, and logs back to SQLite/Postgres on Flask
  static Future<bool> syncData(List<dynamic> sales, List<dynamic> products, List<dynamic> logs) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/save'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'sales': sales,
          'products': products,
          'logs': logs,
        }),
      );
      if (response.statusCode == 200) {
        final resData = jsonDecode(response.body);
        return resData['status'] == 'success';
      }
    } catch (e) {
      print('Error syncing data to API: $e');
    }
    return false;
  }

  // Check the status of a Click payment order
  static Future<String> checkPaymentStatus(int saleId) async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/payment/status/$saleId'));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return data['status'] ?? 'pending';
      }
    } catch (e) {
      print('Error checking payment status: $e');
    }
    return 'pending';
  }

  // Upload product image to S3 bucket / Local fallback storage via Flask
  static Future<String?> uploadImage(String filePath) async {
    try {
      var request = http.MultipartRequest('POST', Uri.parse('$baseUrl/api/upload'));
      request.files.add(await http.MultipartFile.fromPath('file', filePath));
      var streamedResponse = await request.send();
      var response = await http.Response.fromStream(streamedResponse);
      
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          return data['url'];
        }
      }
    } catch (e) {
      print('Error uploading image to API: $e');
    }
    return null;
  }
}
