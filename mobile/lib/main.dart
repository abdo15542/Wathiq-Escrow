import 'package:flutter/material.dart';

void main() => runApp(const WathiqApp());

class WathiqApp extends StatelessWidget {
  const WathiqApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Wathiq Escrow', debugShowCheckedModeBanner: false,
    theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFE8BD6A), brightness: Brightness.dark), useMaterial3: true),
    home: const HomePage(),
  );
}

class HomePage extends StatelessWidget {
  const HomePage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('واثق | Wathiq Escrow'), centerTitle: true),
    body: ListView(padding: const EdgeInsets.all(20), children: [
      const SizedBox(height: 20),
      const Icon(Icons.verified_user_outlined, size: 76, color: Color(0xFFE8BD6A)),
      const SizedBox(height: 20),
      Text('اشترِ وبِع بثقة', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.bold)),
      const SizedBox(height: 8),
      const Text('الوسيط يحمي أموالك', textAlign: TextAlign.center, style: TextStyle(color: Color(0xFFE8BD6A), fontSize: 18)),
      const SizedBox(height: 24),
      const Card(child: Padding(padding: EdgeInsets.all(18), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('ضمان 2 من 3', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)), SizedBox(height: 8), Text('موافقتان متوافقتان من المشتري والبائع والمحكّم لتسوية الصفقة.'), SizedBox(height: 8), Text('نسخة أولية: لم يتم ربط التطبيق بعقد منشور.', style: TextStyle(color: Color(0xFFE8BD6A))) ]))),
      const SizedBox(height: 12),
      FilledButton.icon(onPressed: () => showDialog<void>(context: context, builder: (ctx) => AlertDialog(title: const Text('نسخة تطوير'), content: const Text('سيُفعّل إنشاء الصفقات بعد نشر عقد الاختبار وربط المحفظة ومراجعة التكامل.'), actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('حسنًا'))])), icon: const Icon(Icons.swap_horiz), label: const Text('استكشف الصفقات')),
      const SizedBox(height: 12),
      const Text('لا ترسل أموالًا حقيقية. يلزم اختبار ومراجعة أمنية قبل الإطلاق.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white60)),
    ]),
  );
}
