
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const String apiBaseUrl = String.fromEnvironment(
  'WATHIQ_API_BASE_URL',
  defaultValue: '',
);

// Release builds must never send bearer tokens over clear-text HTTP.
bool isApiUriAllowed(Uri uri, {required bool releaseMode}) {
  if (uri.host.isEmpty || uri.userInfo.isNotEmpty) return false;
  if (releaseMode) return uri.scheme == 'https';
  if (uri.scheme == 'https') return true;
  return uri.scheme == 'http' &&
      const {'localhost', '127.0.0.1', '10.0.2.2'}.contains(uri.host);
}

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


class DealParticipant {
  final int id;
  final String email;
  final String displayName;

  const DealParticipant({required this.id, required this.email, required this.displayName});

  factory DealParticipant.fromJson(Map<String, dynamic> json) {
    return DealParticipant(
      id: (json['id'] as num).toInt(),
      email: json['email'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
    );
  }
}

class Deal {
  final int id;
  final int? offerId;
  final String title;
  final String asset;
  final double amount;
  final String status;
  final bool dispute;
  final String? disputeReason;
  final DealParticipant buyer;
  final DealParticipant seller;
  final DealParticipant arbiter;
  final String? buyerVote;
  final String? sellerVote;
  final String? arbiterVote;
  final String? myRole;
  final String? fundedAt;
  final String? deliveredAt;
  final String? settledAt;
  final String createdAt;
  final String? timeoutRefundAt;
  final int? chainDealId;
  final String? fundingTxHash;
  final bool fundingVerified;

  const Deal({
    required this.id,
    required this.offerId,
    required this.title,
    required this.asset,
    required this.amount,
    required this.status,
    required this.dispute,
    required this.disputeReason,
    required this.buyer,
    required this.seller,
    required this.arbiter,
    required this.buyerVote,
    required this.sellerVote,
    required this.arbiterVote,
    required this.myRole,
    required this.fundedAt,
    required this.deliveredAt,
    required this.settledAt,
    required this.createdAt,
    required this.timeoutRefundAt,
    required this.chainDealId,
    required this.fundingTxHash,
    required this.fundingVerified,
  });

  factory Deal.fromJson(Map<String, dynamic> json) {
    final participants = Map<String, dynamic>.from(json['participants'] as Map);
    final votes = Map<String, dynamic>.from(json['votes'] as Map? ?? {});
    return Deal(
      id: (json['id'] as num).toInt(),
      offerId: (json['offerId'] as num?)?.toInt(),
      title: json['title'] as String,
      asset: json['asset'] as String,
      amount: (json['amount'] as num).toDouble(),
      status: json['status'] as String,
      dispute: json['dispute'] as bool? ?? false,
      disputeReason: json['disputeReason'] as String?,
      buyer: DealParticipant.fromJson(Map<String, dynamic>.from(participants['buyer'] as Map)),
      seller: DealParticipant.fromJson(Map<String, dynamic>.from(participants['seller'] as Map)),
      arbiter: DealParticipant.fromJson(Map<String, dynamic>.from(participants['arbiter'] as Map)),
      buyerVote: votes['buyer'] as String?,
      sellerVote: votes['seller'] as String?,
      arbiterVote: votes['arbiter'] as String?,
      myRole: json['myRole'] as String?,
      fundedAt: json['fundedAt'] as String?,
      deliveredAt: json['deliveredAt'] as String?,
      settledAt: json['settledAt'] as String?,
      createdAt: json['createdAt'] as String? ?? '',
      timeoutRefundAt: json['timeoutRefundAt'] as String?,
      chainDealId: (json['chainDealId'] as num?)?.toInt(),
      fundingTxHash: json['fundingTxHash'] as String?,
      fundingVerified: json['fundingVerified'] as bool? ?? false,
    );
  }

  String? get myVote {
    switch (myRole) {
      case 'buyer':
        return buyerVote;
      case 'seller':
        return sellerVote;
      case 'arbiter':
        return arbiterVote;
    }
    return null;
  }
}

String dealStatusLabel(String status) {
  switch (status) {
    case 'awaiting_funding':
      return 'بانتظار التمويل';
    case 'funded':
      return 'مموّلة — الضمان محتجز';
    case 'delivered':
      return 'تم التسليم — بانتظار التسوية';
    case 'released':
      return 'مُسوّاة — حُرّر للبائع';
    case 'refunded':
      return 'مُسوّاة — رُدّ للمشتري';
    case 'cancelled':
      return 'ملغاة';
  }
  return status;
}

String dealRoleLabel(String? role) {
  switch (role) {
    case 'buyer':
      return 'مشترٍ';
    case 'seller':
      return 'بائع';
    case 'arbiter':
      return 'مُحكِّم';
  }
  return '';
}

/// Action identifiers the signed-in user may perform on [deal] right now.
/// Mirrors the API rules exactly: role-gated funding/delivery, one vote per
/// participant while funded or delivered, a single dispute, and the 30-day
/// timeout refund after funding.
List<String> dealActionsFor(Deal deal, {DateTime? now}) {
  final role = deal.myRole;
  if (role == null) return const [];
  if (deal.status == 'released' || deal.status == 'refunded' || deal.status == 'cancelled') {
    return const [];
  }
  final actions = <String>[];
  if (deal.status == 'awaiting_funding') {
    if (role == 'buyer') {
      if (deal.asset == 'USDT') actions.add('linkChain');
      actions.add('fund');
    }
    if (role == 'buyer' || role == 'seller') actions.add('cancel');
    return actions;
  }
  if (deal.status == 'funded' || deal.status == 'delivered') {
    if (role == 'seller' && deal.status == 'funded') actions.add('deliver');
    if (deal.myVote == null) {
      actions.add('voteRelease');
      actions.add('voteRefund');
    }
    if (!deal.dispute) actions.add('dispute');
    final timeoutAt = deal.timeoutRefundAt == null ? null : DateTime.tryParse(deal.timeoutRefundAt!);
    if (timeoutAt != null && !(now ?? DateTime.now()).isBefore(timeoutAt)) {
      actions.add('timeoutRefund');
    }
    if (deal.fundingVerified) actions.add('syncChain');
  }
  return actions;
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
      if (!isApiUriAllowed(uri, releaseMode: kReleaseMode)) {
        throw Exception(
          'عنوان API غير آمن. استخدم HTTPS في نسخة الإصدار، أو عنوانًا محليًا أثناء التطوير.',
        );
      }

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

  static Future<List<Offer>> getMyOffers() async {
    final data = await request('GET', '/api/my/offers?limit=50&offset=0');
    final items = data['items'];
    if (items is! List) throw Exception('صيغة عروضك غير صحيحة.');
    return items.map((item) => Offer.fromJson(Map<String, dynamic>.from(item as Map))).toList();
  }

  static Future<void> closeOffer(int id) async {
    await request('PATCH', '/api/offers/$id/close');
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

  static Future<List<Deal>> getMyDeals() async {
    final data = await request('GET', '/api/my/deals?limit=50&offset=0');
    final items = data['items'];
    if (items is! List) throw Exception('صيغة صفقات الضمان غير صحيحة.');
    return items.map((item) => Deal.fromJson(Map<String, dynamic>.from(item as Map))).toList();
  }

  static Future<Deal> createDeal({
    required String title,
    String asset = 'BNB',
    required double amount,
    required String myRole,
    required String counterpartyEmail,
    required String arbiterEmail,
    int? offerId,
  }) async {
    final data = await request('POST', '/api/deals', body: {
      'title': title,
      'asset': asset,
      'amount': amount,
      'myRole': myRole,
      'counterpartyEmail': counterpartyEmail.trim(),
      'arbiterEmail': arbiterEmail.trim(),
      if (offerId != null) 'offerId': offerId,
    });
    return Deal.fromJson(Map<String, dynamic>.from(data['item'] as Map));
  }

  static Future<Deal> dealAction(int id, String action, {String? decision, String? reason}) async {
    final data = await request('POST', '/api/deals/$id/$action', body: {
      if (decision != null) 'decision': decision,
      if (reason != null) 'reason': reason,
    });
    return Deal.fromJson(Map<String, dynamic>.from(data['item'] as Map));
  }

  static Future<Deal> linkChain(int id, String txHash) async {
    final data = await request('POST', '/api/deals/$id/link-chain', body: {'txHash': txHash.trim()});
    return Deal.fromJson(Map<String, dynamic>.from(data['item'] as Map));
  }

  static Future<Map<String, dynamic>> fetchMe() async {
    final data = await request('GET', '/api/auth/me');
    return Map<String, dynamic>.from(data['user'] as Map);
  }

  static Future<Map<String, dynamic>> updateWallet(String? walletAddress) async {
    final data = await request('PATCH', '/api/auth/me', body: {'walletAddress': walletAddress});
    return Map<String, dynamic>.from(data['user'] as Map);
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  List<Offer> offers = [];
  List<Offer> myOffers = [];
  bool loadingMyOffers = false;
  List<Deal> myDeals = [];
  bool loadingDeals = false;
  bool loading = false;
  String? error;
  String info = 'سجّل الدخول لإنشاء عرض؛ تصفح العروض متاح للجميع.';
  String? signedInEmail;
  String? myWallet;

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
        if (mounted) setState(() { final user = me['user'] as Map; signedInEmail = user['email'] as String?; myWallet = user['walletAddress'] as String?; });
      } catch (_) {}
    }
    if (mounted) await loadOffers();
    if (mounted && WathiqApi.token != null) await loadMyDeals();
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
                if (mounted) setState(() { signedInEmail = user['email'] as String?; myWallet = user['walletAddress'] as String?; });
              } catch (e) {
                setDialogState(() { saving = false; authError = e.toString().replaceFirst('Exception: ', ''); });
              }
            }, child: Text(saving ? 'جارٍ التحقق...' : register ? 'إنشاء الحساب' : 'دخول')),
          ],
        ),
      ),
    );
    nameController.dispose(); emailController.dispose(); passwordController.dispose();
    if (success == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم تسجيل الدخول.')));
      await loadMyOffers();
      await loadMyDeals();
    }
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

  Future<void> loadMyOffers() async {
    if (WathiqApi.token == null) return;
    setState(() => loadingMyOffers = true);
    try {
      final result = await WathiqApi.getMyOffers();
      if (!mounted) return;
      setState(() => myOffers = result);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => loadingMyOffers = false);
    }
  }

  Future<void> closeMyOffer(Offer offer) async {
    if (offer.status != 'open') return;
    try {
      await WathiqApi.closeOffer(offer.id);
      await loadMyOffers();
      await loadOffers();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تم إغلاق العرض رقم ${offer.id}.')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
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


  Future<void> loadMyDeals() async {
    if (WathiqApi.token == null) return;
    setState(() => loadingDeals = true);
    try {
      final result = await WathiqApi.getMyDeals();
      if (!mounted) return;
      setState(() => myDeals = result);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => loadingDeals = false);
    }
  }

  Future<void> runDealAction(Deal deal, String action) async {
    if (action == 'linkChain') {
      final controller = TextEditingController();
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('ربط تمويل على السلسلة'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('نفّذ أولًا معاملة إنشاء الصفقة في عقد ضمان USDT من محفظتك (بنفس المحافظ والمبلغ المتفق عليها)، ثم الصق تجزئة المعاملة هنا. سيتحقق الخادم من المعاملة على السلسلة قبل اعتماد التمويل.'),
              const SizedBox(height: 10),
              TextField(
                controller: controller,
                decoration: const InputDecoration(labelText: 'تجزئة المعاملة (Tx Hash)', hintText: '0x…'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('تراجع')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('تحقق وربط')),
          ],
        ),
      );
      final txHash = controller.text.trim();
      controller.dispose();
      if (confirmed != true || !mounted) return;
      try {
        await WathiqApi.linkChain(deal.id, txHash);
        await loadMyDeals();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم التحقق من التمويل على السلسلة واعتماده.')));
      } catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))));
      }
      return;
    }
    String? decision;
    String? reason;
    String apiAction = action;
    if (action == 'voteRelease' || action == 'voteRefund') {
      apiAction = 'vote';
      decision = action == 'voteRelease' ? 'release' : 'refund';
    }
    if (action == 'syncChain') apiAction = 'sync-chain';
    if (action == 'dispute') {
      final controller = TextEditingController();
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('فتح نزاع'),
          content: TextField(
            controller: controller,
            maxLength: 300,
            decoration: const InputDecoration(labelText: 'سبب النزاع (اختياري)'),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('تراجع')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('فتح النزاع')),
          ],
        ),
      );
      reason = controller.text.trim();
      controller.dispose();
      if (confirmed != true || !mounted) return;
    } else {
      const confirmLabels = {
        'fund': 'تأكيد أنك أودعت مبلغ الضمان؟ ستُعلَّم الصفقة كمموّلة.',
        'deliver': 'تأكيد أنك سلّمت السلعة أو الخدمة للمشتري؟',
        'cancel': 'إلغاء هذه الصفقة نهائيًا قبل التمويل؟',
        'vote': 'صوتك نهائي ولا يمكن تغييره بعد التسجيل.',
        'timeoutRefund': 'ردّ المبلغ للمشتري لانقضاء 30 يومًا دون تسوية؟',
        'sync-chain': 'مزامنة حالة الصفقة مع العقد على السلسلة؟ إن كانت الصفقة مُسوّاة هناك ستنعكس التسوية هنا.',
      };
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('تأكيد الإجراء'),
          content: Text(confirmLabels[apiAction] ?? 'متابعة؟'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('تراجع')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('تأكيد')),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    try {
      final updated = await WathiqApi.dealAction(deal.id, apiAction, decision: decision, reason: reason);
      await loadMyDeals();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('صفقة ${deal.id}: ${dealStatusLabel(updated.status)}')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    }
  }

  Future<void> showWalletDialog() async {
    final controller = TextEditingController(text: myWallet ?? '');
    String? dialogError;
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('عنوان محفظة السلسلة'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('عنوان محفظتك على شبكة BNB. يُستخدم للتحقق من تمويل صفقات USDT على السلسلة: يجب أن تطابق محافظ الأطراف الثلاثة المعاملة المنفذة في العقد.'),
              const SizedBox(height: 10),
              TextField(
                controller: controller,
                decoration: const InputDecoration(labelText: 'عنوان المحفظة', hintText: '0x…'),
              ),
              if (dialogError != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(dialogError!, style: const TextStyle(color: Colors.redAccent))),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('إلغاء')),
            TextButton(
              onPressed: () async {
                try {
                  final user = await WathiqApi.updateWallet(null);
                  if (dialogContext.mounted) Navigator.pop(dialogContext, true);
                  if (mounted) setState(() => myWallet = user['walletAddress'] as String?);
                } catch (e) {
                  setDialogState(() => dialogError = e.toString().replaceFirst('Exception: ', ''));
                }
              },
              child: const Text('مسح العنوان'),
            ),
            FilledButton(
              onPressed: () async {
                final value = controller.text.trim();
                if (!RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(value)) {
                  setDialogState(() => dialogError = 'أدخل عنوانًا صحيحًا يبدأ بـ 0x ومكوّنًا من 42 حرفًا.');
                  return;
                }
                try {
                  final user = await WathiqApi.updateWallet(value);
                  if (dialogContext.mounted) Navigator.pop(dialogContext, true);
                  if (mounted) setState(() => myWallet = user['walletAddress'] as String?);
                } catch (e) {
                  setDialogState(() => dialogError = e.toString().replaceFirst('Exception: ', ''));
                }
              },
              child: const Text('حفظ'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    if (saved == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم تحديث عنوان المحفظة.')));
    }
  }

  Future<void> showCreateDealDialog() async {
    final formKey = GlobalKey<FormState>();
    final titleController = TextEditingController();
    final amountController = TextEditingController();
    final counterpartyController = TextEditingController();
    final arbiterController = TextEditingController();
    final offerIdController = TextEditingController();
    String myRole = 'buyer';
    String asset = 'BNB';
    bool saving = false;
    String? formError;
    final created = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('صفقة ضمان جديدة'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                TextFormField(
                  controller: titleController,
                  maxLength: 100,
                  decoration: const InputDecoration(labelText: 'عنوان الصفقة'),
                  validator: (v) => (v?.trim().length ?? 0) < 3 ? 'اكتب 3 أحرف على الأقل' : null,
                ),
                TextFormField(
                  controller: amountController,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(labelText: 'مبلغ الضمان', suffixText: asset),
                  validator: (v) {
                    final amount = double.tryParse(v?.trim() ?? '');
                    return (amount == null || !amount.isFinite || amount <= 0 || amount > 1000000000) ? 'أدخل مبلغًا موجبًا صالحًا' : null;
                  },
                ),
                DropdownButtonFormField<String>(
                  value: asset,
                  decoration: const InputDecoration(labelText: 'أصل الضمان'),
                  items: const [
                    DropdownMenuItem(value: 'BNB', child: Text('BNB')),
                    DropdownMenuItem(value: 'USDT', child: Text('USDT — يدعم إثبات التمويل على السلسلة')),
                  ],
                  onChanged: saving ? null : (v) { if (v != null) setDialogState(() => asset = v); },
                ),
                DropdownButtonFormField<String>(
                  value: myRole,
                  decoration: const InputDecoration(labelText: 'دوري في الصفقة'),
                  items: const [
                    DropdownMenuItem(value: 'buyer', child: Text('أنا المشتري')),
                    DropdownMenuItem(value: 'seller', child: Text('أنا البائع')),
                  ],
                  onChanged: saving ? null : (v) { if (v != null) setDialogState(() => myRole = v); },
                ),
                TextFormField(
                  controller: counterpartyController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'بريد الطرف الآخر (المسجّل في واثق)'),
                  validator: (v) => !(v ?? '').contains('@') ? 'أدخل بريدًا صحيحًا' : null,
                ),
                TextFormField(
                  controller: arbiterController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'بريد المُحكِّم (طرف ثالث مسجّل)'),
                  validator: (v) => !(v ?? '').contains('@') ? 'أدخل بريدًا صحيحًا' : null,
                ),
                TextFormField(
                  controller: offerIdController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'رقم عرض مرتبط (اختياري)'),
                  validator: (v) {
                    final text = v?.trim() ?? '';
                    if (text.isEmpty) return null;
                    final parsed = int.tryParse(text);
                    return (parsed == null || parsed <= 0) ? 'رقم عرض غير صالح' : null;
                  },
                ),
                if (formError != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(formError!, style: const TextStyle(color: Colors.redAccent))),
                const SizedBox(height: 8),
                const Text(
                  'دورة الضمان: تمويل من المشتري ← تسليم من البائع ← تسوية بتصويت 2 من 3 (أنت والطرف الآخر والمُحكِّم). بعد 30 يومًا دون تسوية يُردّ المبلغ للمشتري.',
                  style: TextStyle(color: Colors.white60, fontSize: 12),
                ),
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: saving ? null : () => Navigator.pop(dialogContext, false), child: const Text('إلغاء')),
            FilledButton(
              onPressed: saving ? null : () async {
                if (!formKey.currentState!.validate()) return;
                setDialogState(() { saving = true; formError = null; });
                try {
                  await WathiqApi.createDeal(
                    title: titleController.text.trim(),
                    asset: asset,
                    amount: double.parse(amountController.text.trim()),
                    myRole: myRole,
                    counterpartyEmail: counterpartyController.text,
                    arbiterEmail: arbiterController.text,
                    offerId: offerIdController.text.trim().isEmpty ? null : int.parse(offerIdController.text.trim()),
                  );
                  if (dialogContext.mounted) Navigator.pop(dialogContext, true);
                } catch (e) {
                  setDialogState(() { saving = false; formError = e.toString().replaceFirst('Exception: ', ''); });
                }
              },
              child: Text(saving ? 'جارٍ الإنشاء...' : 'إنشاء الصفقة'),
            ),
          ],
        ),
      ),
    );
    titleController.dispose();
    amountController.dispose();
    counterpartyController.dispose();
    arbiterController.dispose();
    offerIdController.dispose();
    if (created == true && mounted) {
      await loadMyDeals();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم إنشاء صفقة الضمان.')));
    }
  }

  Widget buildDealCard(Deal deal) {
    const actionLabels = {
      'fund': 'تأكيد التمويل',
      'linkChain': 'ربط تمويل على السلسلة',
      'syncChain': 'مزامنة حالة السلسلة',
      'deliver': 'تأكيد التسليم',
      'cancel': 'إلغاء الصفقة',
      'dispute': 'فتح نزاع',
      'voteRelease': 'صوّت: تحرير للبائع',
      'voteRefund': 'صوّت: ردّ للمشتري',
      'timeoutRefund': 'ردّ انقضاء المهلة (30 يومًا)',
    };
    String voteText(String? vote) => vote == null ? 'لم يصوّت' : (vote == 'release' ? 'تحرير' : 'ردّ');
    final actions = dealActionsFor(deal);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(deal.title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16))),
                Text('${deal.amount} ${deal.asset}', style: const TextStyle(color: Color(0xFFE8BD6A), fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 6),
            Text('الحالة: ${dealStatusLabel(deal.status)} • دوري: ${dealRoleLabel(deal.myRole)}'),
            Text('المشتري: ${deal.buyer.email} • البائع: ${deal.seller.email}', style: const TextStyle(color: Colors.white70, fontSize: 12)),
            Text('المُحكِّم: ${deal.arbiter.email}', style: const TextStyle(color: Colors.white70, fontSize: 12)),
            Text(
              'الأصوات — المشتري: ${voteText(deal.buyerVote)} • البائع: ${voteText(deal.sellerVote)} • المُحكِّم: ${voteText(deal.arbiterVote)}',
              style: const TextStyle(color: Colors.white70, fontSize: 12),
            ),
            if (deal.fundingVerified)
              Text('✓ تمويل مُثبت على السلسلة${deal.chainDealId != null ? ' — صفقة العقد رقم ${deal.chainDealId}' : ''}', style: const TextStyle(color: Colors.greenAccent, fontSize: 12)),
            if (deal.dispute)
              Text('⚠ نزاع مفتوح${deal.disputeReason != null ? ': ${deal.disputeReason}' : ''}', style: const TextStyle(color: Colors.orangeAccent, fontSize: 12)),
            if (deal.timeoutRefundAt != null && (deal.status == 'funded' || deal.status == 'delivered'))
              Text('يُتاح ردّ المهلة بعد: ${deal.timeoutRefundAt!.split('T').first}', style: const TextStyle(color: Colors.white54, fontSize: 12)),
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: actions.map((action) => FilledButton.tonal(
                  onPressed: () => runDealAction(deal, action),
                  child: Text(actionLabels[action] ?? action),
                )).toList(),
              ),
            ],
          ],
        ),
      ),
    );
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
            'إدارة عروض الصفقات بشفافية',
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
                    'صفقات ضمان كاملة داخل التطبيق',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 18,
                    ),
                  ),
                  SizedBox(height: 8),
                  Text(
                    'أنشئ صفقة ضمان مع طرف آخر ومُحكِّم مسجّلين: تمويل من المشتري، تسليم من البائع، ثم تسوية بتصويت 2 من 3 — وردّ تلقائي للمشتري بعد 30 يومًا دون تسوية. تُدار الدورة عبر خادم واثق وتعكس قواعد عقد الضمان.',
                  ),
                  SizedBox(height: 8),
                  Text(
                    'تنبيه: التسوية على السلسلة (شبكة اختبار BNB) تُفعَّل بعد نشر العقود من مالك المشروع. لا تستخدم أموالًا حقيقية أبدًا.',
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
            OutlinedButton.icon(onPressed: loadingMyOffers ? null : loadMyOffers, icon: const Icon(Icons.inventory_2_outlined), label: Text(loadingMyOffers ? 'جارٍ تحميل عروضي...' : 'عروضي')),
            OutlinedButton.icon(onPressed: loading ? null : showCreateDealDialog, icon: const Icon(Icons.gavel_outlined), label: const Text('صفقة ضمان جديدة')),
            OutlinedButton.icon(onPressed: loadingDeals ? null : loadMyDeals, icon: const Icon(Icons.handshake_outlined), label: Text(loadingDeals ? 'جارٍ تحميل الصفقات...' : 'صفقات الضمان')),
            OutlinedButton.icon(onPressed: showWalletDialog, icon: const Icon(Icons.account_balance_wallet_outlined), label: Text(myWallet == null ? 'ضبط عنوان محفظتي (للسلسلة)' : 'محفظتي: ${myWallet!.substring(0, 6)}…${myWallet!.substring(myWallet!.length - 4)}')),
            TextButton.icon(onPressed: () async { await WathiqApi.logout(); if (mounted) setState(() { signedInEmail = null; myWallet = null; info = 'تم تسجيل الخروج.'; myDeals = []; myOffers = []; }); }, icon: const Icon(Icons.logout), label: const Text('تسجيل الخروج')),
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
          if (myOffers.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text('عروضي (${myOffers.length})', style: Theme.of(context).textTheme.titleLarge),
            ...myOffers.map((offer) => Card(
              child: ListTile(
                title: Text(offer.title),
                subtitle: Text('رقم ${offer.id} • ${offer.price} ${offer.asset}\nالحالة: ${offer.status}'),
                isThreeLine: true,
                trailing: offer.status == 'open'
                    ? IconButton(
                        tooltip: 'إغلاق العرض',
                        icon: const Icon(Icons.close, color: Colors.orangeAccent),
                        onPressed: () => closeMyOffer(offer),
                      )
                    : const Icon(Icons.check_circle_outline),
              ),
            )),
          ],
          if (signedInEmail != null) ...[
            const SizedBox(height: 18),
            Text('صفقات الضمان (${myDeals.length})', style: Theme.of(context).textTheme.titleLarge),
            if (myDeals.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('لا صفقات ضمان بعد — أنشئ أول صفقة لك.', style: TextStyle(color: Colors.white60))),
            ...myDeals.map(buildDealCard),
          ],
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

