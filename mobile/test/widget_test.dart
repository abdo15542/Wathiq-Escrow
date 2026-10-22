import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wathiq_mobile/main.dart';

void main() {
  testWidgets('shows Wathiq brand and test warning', (tester) async {
    await tester.pumpWidget(const WathiqApp());

    expect(find.text('واثق | Wathiq Escrow'), findsOneWidget);
    expect(find.text('اشترِ وبِع بثقة'), findsOneWidget);

    final warning = find.textContaining('لا ترسل أموالًا حقيقية');

    await tester.scrollUntilVisible(
      warning,
      300,
      scrollable: find.byType(Scrollable).first,
    );

    expect(warning, findsOneWidget);
  });


  test('API URL policy permits HTTPS and local development only', () {
    expect(
      isApiUriAllowed(Uri.parse('https://api.example.com/api/health'), releaseMode: true),
      isTrue,
    );
    expect(
      isApiUriAllowed(Uri.parse('http://api.example.com/api/health'), releaseMode: true),
      isFalse,
    );
    expect(
      isApiUriAllowed(Uri.parse('http://10.0.2.2:4000/health'), releaseMode: false),
      isTrue,
    );
    expect(
      isApiUriAllowed(Uri.parse('http://api.example.com/health'), releaseMode: false),
      isFalse,
    );
    expect(
      isApiUriAllowed(Uri.parse('https://user:secret@api.example.com/health'), releaseMode: false),
      isFalse,
    );
  });

  test('fails clearly when release API URL is not configured', () async {
    await expectLater(
      WathiqApi.request('GET', '/health'),
      throwsA(
        isA<Exception>().having(
          (error) => error.toString(),
          'message',
          contains('لم يتم ضبط عنوان خادم واثق'),
        ),
      ),
    );
  });
}
