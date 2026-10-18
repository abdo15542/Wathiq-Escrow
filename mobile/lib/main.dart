
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const String apiBaseUrl = String.fromEnvironment(
  'WATHIQ_API_BASE_URL',
  defaultValue: '',
);

void main() => runApp(const WathiqApp());

class WathiqApp extends StatelessWidget {
  const WathiqApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Wathiq Escrow',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFE8BD6A),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

class Offer {
  final int id;
  final String title;
  final String asset;
  final double price;
  final String paymentMethod;
  final String status;
  final String createdAt;

  const Offer({
    required this.id,
    required this.title,
    required this.asset,
    required this.price,
    required this.paymentMethod,
    required this.status,
    required this.createdAt,
  });

  factory Offer.fromJson(Map<String, dynamic> json) {
    return Offer(
      id: (json['id'] as num).toInt(),
      title: json['title'] as String,
      asset: json['asset'] as String,
      price: (json['price'] as num).toDouble(),
      paymentMethod: json['paymentMethod'] as String,
      status: json['status'] as String? ?? 'draft',
      createdAt: json['createdAt'] as String? ?? '',
    );
  }
}

class WathiqApi {
  static const FlutterSecureStorage _secureStorage = FlutterSecureStorage();
  static String? token;

  static Future<void> restoreSession() async {
    try {
      token = await _secureStorage.read(key: 'wathiq_access_token');
      if (token != null) await request('GET', '/api/auth/me');
    } catch (_) {
      token = null;
      try { await _secureStorage.delete(key: 'wathiq_access_token'); } catch (_) {}
    }
  }

  static Future<Map<String, dynamic>> authenticate({required String email, required String password, String? displayName}) async {
    final isRegister = displayName != null;
    final data = await request('POST', isRegister ? '/api/auth/register' : '/api/auth/login', body: {
      'email': email.trim(), 'password': password,
      if (isRegister) 'displayName': displayName.trim(),
    });
    final newToken = data['token'];
    if (newToken is! String || newToken.isEmpty) throw Exception('لم يُرجع الخادم رمز جلسة صالحًا.');
    token = newToken;
    await _secureStorage.write(key: 'wathiq_access_token', value: newToken);
    return Map<String, dynamic>.from(data['user'] as Map);
  }

  static Future<void> logout() async {
    token = null;
    await _secureStorage.delete(key: 'wathiq_access_token');
  }

  static Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (apiBaseUrl.trim().isEmpty) {
      throw Exception(
        'لم يتم ضبط عنوان خادم واثق لهذا الإصدار. يلزم نشر الخادم أولًا ثم بناء التطبيق بعنوان API الصحيح.',
      );
    }

    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 8);

    try {
      final uri = Uri.parse(apiBaseUrl).resolve(path);

      final request = await client
          .openUrl(method, uri)
          .timeout(const Duration(seconds: 10));

      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (token != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');

      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }

      final response = await request.close().timeout(
        const Duration(seconds: 15),
      );

      final text = await response.transform(utf8.decoder).join();

      Map<String, dynamic> data = {};
      if (text.isNotEmpty) {
        final decoded = jsonDecode(text);
        if (decoded is Map<String, dynamic>) {
          data = decoded;
        }
      }

      if (response.statusCode < 200 ||
          response.statusCode >= 300) {
        throw Exception(
          data['error']?.toString() ??
              'فشل الطلب. رمز HTTP: ${response.statusCode}',
        );
      }

      return data;
    } on SocketException {
      throw Exception(
        'تعذر الاتصال بالخادم. تأكد من تشغيل API وصحة عنوانه.',
      );
    } on TimeoutException {
      throw Exception('انتهت مهلة الاتصال بالخادم.');
    } on FormatException {
      throw Exception('استجابة الخادم ليست بصيغة JSON صحيحة.');
    } finally {
      client.close(force: true);
    }
  }

  static Future<List<Offer>> getOffers() async {
    final data = await request(
      'GET',
      '/api/offers?limit=30&offset=0',
    );

    final items = data['items'];
    if (items is! List) {
      throw Exception('صيغة قائمة الصفقات غير صحيحة.');
    }

    return items
        .map((item) => Offer.fromJson(
              Map<String, dynamic>.from(item as Map),
            ))
        .toList();
  }

  static Future<Offer> createOffer({
    required String title,
    required double price,
    required String paymentMethod,
  }) async {
    final data = await request(
      'POST',
      '/api/offers',
      body: {
        'title': title,
        'asset': 'BNB',
        'price': price,
        'paymentMethod': paymentMethod,
      },
    );

    return Offer.fromJson(
      Map<String, dynamic>.from(data['item'] as Map),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  List<Offer> offers = [];
  bool loading = false;
  String? error;
  String info = 'سجّل الدخول لإنشاء عرض؛ تصفح العروض متاح للجميع.';
  String? signedInEmail;

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    await WathiqApi.restoreSession();
    if (!mounted) return;
    if (WathiqApi.token != null) {
      try {
        final me = await WathiqApi.request('GET', '/api/auth/me');
        if (mounted) setState(() => signedInEmail = (me['user'] as Map)['email'] as String?);
      } catch (_) {}
    }
    if (mounted) await loadOffers();
  }

  Future<void> showAuthDialog() async {
    final formKey = GlobalKey<FormState>();
    final nameController = TextEditingController();
    final emailController = TextEditingController();
    final passwordController = TextEditingController();
    bool register = true;
    bool saving = false;
    String? authError;
    final success = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(register ? 'إنشاء حساب واثق' : 'تسجيل الدخول'),
          content: SingleChildScrollView(
            child: Form(key: formKey, child: Column(mainAxisSize: MainAxisSize.min, children: [
              if (register) TextFormField(controller: nameController, decoration: const InputDecoration(labelText: 'الاسم'), validator: (v) => register && (v?.trim().length ?? 0) < 2 ? 'اكتب اسمًا من حرفين على الأقل' : null),
              TextFormField(controller: emailController, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'البريد الإلكتروني'), validator: (v) => !(v ?? '').contains('@') ? 'أدخل بريدًا صحيحًا' : null),
              TextFormField(controller: passwordController, obscureText: true, decoration: const InputDecoration(labelText: 'كلمة المرور'), validator: (v) => (v?.length ?? 0) < 10 ? 'استخدم 10 أحرف على الأقل' : null),
              if (authError != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(authError!, style: const TextStyle(color: Colors.redAccent))),
              TextButton(onPressed: saving ? null : () => setDialogState(() { register = !register; authError = null; }), child: Text(register ? 'لديك حساب؟ سجّل الدخول' : 'مستخدم جديد؟ أنشئ حسابًا')),
            ])),
          ),
          actions: [
            TextButton(onPressed: saving ? null : () => Navigator.pop(dialogContext, false), child: const Text('إلغاء')),
            FilledButton(onPressed: saving ? null : () async {
              if (!formKey.currentState!.validate()) return;
              setDialogState(() { saving = true; authError = null; });
              try {
                final user = await WathiqApi.authenticate(email: emailController.text, password: passwordController.text, displayName: register ? nameController.text : null);
                if (dialogContext.mounted) Navigator.pop(dialogContext, true);
                if (mounted) setState(() => signedInEmail = user['email'] as String?);
              } catch (e) {
                setDialogState(() { saving = false; authError = e.toString().replaceFirst('Exception: ', ''); });
              }
            }, child: Text(saving ? 'جارٍ التحقق...' : register ? 'إنشاء الحساب' : 'دخول')),
          ],
        ),
      ),
    );
    nameController.dispose(); emailController.dispose(); passwordController.dispose();
    if (success == true && mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم تسجيل الدخول.')));
  }

  Future<void> loadOffers() async {
    setState(() {
      loading = true;
      error = null;
      info = 'جارٍ تحميل الصفقات...';
    });

    try {
      final result = await WathiqApi.getOffers();
      if (!mounted) return;

      setState(() {
        offers = result;
        info = 'تم الاتصال بالخادم. عدد الصفقات: ${result.length}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString().replaceFirst('Exception: ', '');
        info = 'تعذر تحميل الصفقات.';
      });
    } finally {
      if (mounted) {
        setState(() => loading = false);
      }
    }
  }

  Future<void> showCreateOfferDialog() async {
    final formKey = GlobalKey<FormState>();
    final titleController = TextEditingController();
    final priceController = TextEditingController();
    String paymentMethod = 'bank_transfer';

    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        bool saving = false;

        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: const Text('إنشاء عرض جديد'),
              content: SingleChildScrollView(
                child: Form(
                  key: formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextFormField(
                        controller: titleController,
                        maxLength: 100,
                        decoration: const InputDecoration(
                          labelText: 'عنوان الصفقة',
                          hintText: 'مثال: عرض تجريبي',
                        ),
                        validator: (value) {
                          final title = value?.trim() ?? '';
                          if (title.length < 3) {
                            return 'اكتب 3 أحرف على الأقل';
                          }
                          if (title.length > 100) {
                            return 'الحد الأقصى 100 حرف';
                          }
                          return null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: priceController,
                        keyboardType:
                            const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: 'السعر التجريبي',
                          suffixText: 'BNB',
                        ),
                        validator: (value) {
                          final price = double.tryParse(
                            value?.trim() ?? '',
                          );
                          if (price == null ||
                              !price.isFinite ||
                              price <= 0 ||
                              price > 1000000000) {
                            return 'أدخل سعرًا موجبًا صالحًا';
                          }
                          return null;
                        },
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        value: paymentMethod,
                        decoration: const InputDecoration(
                          labelText: 'طريقة الدفع',
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'bank_transfer',
                            child: Text('تحويل مصرفي'),
                          ),
                          DropdownMenuItem(
                            value: 'cash',
                            child: Text('نقدًا'),
                          ),
                          DropdownMenuItem(
                            value: 'crypto',
                            child: Text('عملة رقمية'),
                          ),
                          DropdownMenuItem(
                            value: 'digital_service',
                            child: Text('خدمة رقمية'),
                          ),
                          DropdownMenuItem(
                            value: 'gift_card',
                            child: Text('بطاقة هدايا'),
                          ),
                        ],
                        onChanged: saving
                            ? null
                            : (value) {
                                if (value != null) {
                                  setDialogState(
                                    () => paymentMethod = value,
                                  );
                                }
                              },
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'هذا عرض سوق فقط، وليس إيداع ضمان أو معاملة مالية.',
                        style: TextStyle(color: Colors.amber),
                      ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving
                      ? null
                      : () => Navigator.pop(dialogContext, false),
                  child: const Text('إلغاء'),
                ),
                FilledButton(
                  onPressed: saving
                      ? null
                      : () async {
                          if (!formKey.currentState!.validate()) {
                            return;
                          }

                          setDialogState(() => saving = true);

                          try {
                            await WathiqApi.createOffer(
                              title: titleController.text.trim(),
                              price: double.parse(
                                priceController.text.trim(),
                              ),
                              paymentMethod: paymentMethod,
                            );

                            if (dialogContext.mounted) {
                              Navigator.pop(dialogContext, true);
                            }
                          } catch (e) {
                            setDialogState(() => saving = false);

                            if (dialogContext.mounted) {
                              ScaffoldMessenger.of(dialogContext)
                                ..hideCurrentSnackBar()
                                ..showSnackBar(
                                  SnackBar(
                                    content: Text(
                                      e.toString().replaceFirst(
                                            'Exception: ',
                                            '',
                                          ),
                                    ),
                                  ),
                                );
                            }
                          }
                        },
                  child: Text(saving ? 'جارٍ الحفظ...' : 'إرسال للخادم'),
                ),
              ],
            );
          },
        );
      },
    );

    titleController.dispose();
    priceController.dispose();

    if (result == true && mounted) {
      await loadOffers();
      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم إنشاء العرض التجريبي.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('واثق | Wathiq Escrow'),
        centerTitle: true,
        actions: [
          IconButton(
            tooltip: 'تحديث الصفقات',
            onPressed: loading ? null : loadOffers,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const SizedBox(height: 12),
          const Icon(
            Icons.verified_user_outlined,
            size: 76,
            color: Color(0xFFE8BD6A),
          ),
          const SizedBox(height: 20),
          Text(
            'اشترِ وبِع بثقة',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
          ),
          const SizedBox(height: 8),
          const Text(
            'الوسيط يحمي أموالك',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Color(0xFFE8BD6A),
              fontSize: 18,
            ),
          ),
          const SizedBox(height: 24),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'ضمان 2 من 3',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 18,
                    ),
                  ),
                  SizedBox(height: 8),
                  Text(
                    'موافقتان متوافقتان من المشتري والبائع والمحكّم '
                    'لتسوية الصفقة.',
                  ),
                  SizedBox(height: 8),
                  Text(
                    'السوق والخادم لا ينفذان ضمانًا على السلسلة حتى الآن.',
                    style: TextStyle(color: Color(0xFFE8BD6A)),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: loading ? null : loadOffers,
            icon: const Icon(Icons.swap_horiz),
            label: const Text('استكشف الصفقات'),
          ),
          const SizedBox(height: 10),
          if (signedInEmail == null)
            OutlinedButton.icon(onPressed: showAuthDialog, icon: const Icon(Icons.login), label: const Text('تسجيل الدخول / إنشاء حساب'))
          else ...[
            Text('مسجّل الدخول: $signedInEmail', textAlign: TextAlign.center),
            OutlinedButton.icon(onPressed: loading ? null : showCreateOfferDialog, icon: const Icon(Icons.add), label: const Text('إنشاء عرض جديد')),
            TextButton.icon(onPressed: () async { await WathiqApi.logout(); if (mounted) setState(() { signedInEmail = null; info = 'تم تسجيل الخروج.'; }); }, icon: const Icon(Icons.logout), label: const Text('تسجيل الخروج')),
          ],
          const SizedBox(height: 16),
          if (loading) const LinearProgressIndicator(),
          Text(
            info,
            textAlign: TextAlign.center,
          ),
          if (error != null) ...[
            const SizedBox(height: 8),
            Text(
              error!,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.redAccent),
            ),
          ],
          const SizedBox(height: 16),
          if (offers.isNotEmpty)
            Text(
              'الصفقات (${offers.length})',
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ...offers.map(
            (offer) => Card(
              child: ListTile(
                leading: const CircleAvatar(
                  child: Icon(Icons.swap_horiz),
                ),
                title: Text(offer.title),
                subtitle: Text(
                  'رقم ${offer.id} • ${offer.paymentMethod}\n'
                  'الحالة: ${offer.status}',
                ),
                isThreeLine: true,
                trailing: Text(
                  '${offer.price} ${offer.asset}',
                  style: const TextStyle(
                    color: Color(0xFFE8BD6A),
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          const Text(
            'لا ترسل أموالًا حقيقية. يلزم اختبار ومراجعة أمنية قبل الإطلاق.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white60),
          ),
          const SizedBox(height: 8),
          const Text(
            'عنوان API: $apiBaseUrl',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.white38,
              fontSize: 11,
            ),
          ),
        ],
      ),
    );
  }
}

