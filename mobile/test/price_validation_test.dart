import 'package:flutter_test/flutter_test.dart';
import 'package:wathiq_mobile/main.dart';

void main() {
  group('validateOfferPrice', () {
    test('accepts positive decimal prices with up to ten fractional digits', () {
      expect(validateOfferPrice('1'), isNull);
      expect(validateOfferPrice('0.0000000001'), isNull);
      expect(validateOfferPrice('1.1234567891'), isNull);
      expect(validateOfferPrice('1000000000'), isNull);
      expect(validateOfferPrice(' 2.50 '), isNull);
    });

    test('rejects values with more than ten fractional digits', () {
      expect(validateOfferPrice('1.12345678901'), isNotNull);
      expect(validateOfferPrice('0.00000000001'), isNotNull);
    });

    test('rejects exponent and comma notation before sending to API', () {
      expect(validateOfferPrice('1e3'), isNotNull);
      expect(validateOfferPrice('1,25'), isNotNull);
    });

    test('rejects non-positive, non-numeric, and excessive prices', () {
      expect(validateOfferPrice('0'), isNotNull);
      expect(validateOfferPrice('-1'), isNotNull);
      expect(validateOfferPrice('abc'), isNotNull);
      expect(validateOfferPrice('1000000000.01'), isNotNull);
      expect(validateOfferPrice(''), isNotNull);
    });
  });
}
