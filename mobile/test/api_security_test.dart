import 'package:flutter_test/flutter_test.dart';
import 'package:wathiq_mobile/main.dart';

void main() {
  group('isApiUriAllowed', () {
    test('release builds require HTTPS', () {
      expect(
        isApiUriAllowed(Uri.parse('https://api.example.com'), releaseMode: true),
        isTrue,
      );
      expect(
        isApiUriAllowed(Uri.parse('http://api.example.com'), releaseMode: true),
        isFalse,
      );
      expect(
        isApiUriAllowed(Uri.parse('http://10.0.2.2:4000'), releaseMode: true),
        isFalse,
      );
    });

    test('debug builds allow HTTPS and known local development hosts only', () {
      expect(
        isApiUriAllowed(Uri.parse('https://api.example.com'), releaseMode: false),
        isTrue,
      );
      for (final host in ['localhost', '127.0.0.1', '10.0.2.2']) {
        expect(
          isApiUriAllowed(Uri.parse('http://$host:4000'), releaseMode: false),
          isTrue,
        );
      }
      expect(
        isApiUriAllowed(Uri.parse('http://api.example.com'), releaseMode: false),
        isFalse,
      );
    });

    test('rejects missing hosts and URLs containing embedded credentials', () {
      expect(isApiUriAllowed(Uri.parse('https:'), releaseMode: false), isFalse);
      expect(
        isApiUriAllowed(
          Uri.parse('https://attacker:secret@api.example.com'),
          releaseMode: true,
        ),
        isFalse,
      );
    });
  });
}
