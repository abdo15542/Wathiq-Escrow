import 'package:flutter_test/flutter_test.dart';
import 'package:wathiq_mobile/main.dart';

void main() {
  testWidgets('shows Wathiq brand and test warning', (tester) async {
    await tester.pumpWidget(const WathiqApp());
    expect(find.text('واثق | Wathiq Escrow'), findsOneWidget);
    expect(find.text('اشترِ وبِع بثقة'), findsOneWidget);
    expect(find.textContaining('لا ترسل أموالًا حقيقية'), findsOneWidget);
  });
}
