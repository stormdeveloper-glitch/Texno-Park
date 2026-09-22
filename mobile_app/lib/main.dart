import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'providers/app_state.dart';
import 'screens/login_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    ChangeNotifierProvider(
      create: (context) => AppState(),
      child: const TexnoParkApp(),
    ),
  );
}

class TexnoParkApp extends StatelessWidget {
  const TexnoParkApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Texno Park POS',
      debugShowCheckedModeBanner: false,
      
      // Material 3 Och rangli premium mavzu
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFF97316), // Premium Orange
          brightness: Brightness.light,
          primary: const Color(0xFFF97316),
          onPrimary: Colors.white,
          secondary: const Color(0xFF10B981), // Emerald/Green accent
          background: const Color(0xFFFAF9F6),
          surface: Colors.white,
        ),
        cardTheme: CardTheme(
          elevation: 1,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        ),
      ),
      
      // Material 3 To'q rangli premium mavzu
      darkTheme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFF97316),
          brightness: Brightness.dark,
          primary: const Color(0xFFF97316),
          onPrimary: Colors.white,
          secondary: const Color(0xFF10B981),
          background: const Color(0xFF121212),
          surface: const Color(0xFF1E1E1E),
        ),
        cardTheme: CardTheme(
          elevation: 2,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        ),
      ),
      
      themeMode: ThemeMode.system, // System preference theme mode
      home: const LoginScreen(),
    );
  }
}
