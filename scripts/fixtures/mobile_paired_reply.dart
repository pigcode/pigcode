import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pigcode_mobile/computers.dart';
import 'package:pigcode_mobile/main.dart' show PigcodeApp;
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  FlutterSecureStorage.setMockInitialValues({});
  WidgetController.hitTestWarningShouldBeFatal = true;

  testWidgets('opens a paired thread, sends a message, and shows the reply', (
    tester,
  ) async {
    final encoded = const String.fromEnvironment('PIGCODE_SIMULATOR_SMOKE');
    if (encoded.isEmpty) {
      throw StateError(
        'Start the local Host fixture before running this test.',
      );
    }
    final fixture =
        jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(encoded))))
            as Map<String, dynamic>;
    final profile = ComputerProfile.fromJson(
      fixture['computer'] as Map<String, dynamic>,
    );
    final phone = await NoiseIdentity.create(
      base64Url.decode(base64Url.normalize(fixture['phoneSeed'] as String)),
    );
    final trust = SecurityContext(withTrustedRoots: true)
      ..setTrustedCertificatesBytes(base64.decode(fixture['ca'] as String));
    final directory = await Directory.systemTemp.createTemp(
      'pigcode-paired-smoke-',
    );
    final cache = OfflineCacheStore(directory: () async => directory);
    addTearDown(() => directory.delete(recursive: true));
    tester.testTextInput.register();
    addTearDown(tester.testTextInput.unregister);

    await HttpOverrides.runZoned(() async {
      try {
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              computersProvider.overrideWith(
                () => _PairedComputer(profile, phone),
              ),
              offlineCacheProvider.overrideWithValue(cache),
            ],
            child: const PigcodeApp(),
          ),
        );
        final computer = find.text(profile.name).hitTestable();
        await _waitFor(tester, computer);
        await tester.tap(computer);
        await _waitFor(tester, find.text(fixture['title'] as String));
        final composer = find
            .descendant(
              of: find.byType(RunComposer),
              matching: find.byKey(const ValueKey('run-composer-input')),
            )
            .hitTestable();
        await _waitFor(tester, composer);
        final prompt = fixture['prompt'] as String;
        await tester.enterText(composer, prompt);
        expect(tester.widget<TextField>(composer).controller?.text, prompt);
        final send = find
            .byWidgetPredicate(
              (widget) =>
                  widget is IconButton &&
                  widget.tooltip == '发送消息' &&
                  widget.onPressed != null,
              description: '可发送消息的按钮',
            )
            .hitTestable();
        await _waitFor(tester, send);
        await tester.tap(send);
        final answer = RegExp.escape(fixture['reply'] as String);
        final reply = find.textContaining(
          RegExp(r'^\s*' + answer + r'\s*$'),
          findRichText: true,
        );
        await _waitFor(tester, reply, timeout: const Duration(seconds: 120));
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
      }
    }, createHttpClient: _FixtureTrust(trust).createHttpClient);
  });
}

Future<void> _waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final elapsed = Stopwatch()..start();
  while (finder.evaluate().isEmpty && elapsed.elapsed < timeout) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  expect(finder, findsWidgets);
}

class _FixtureTrust extends HttpOverrides {
  _FixtureTrust(this.trust);

  final SecurityContext trust;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context ?? trust);
}

class _PairedComputer extends Computers {
  _PairedComputer(this.profile, this.phone);

  final ComputerProfile profile;
  final NoiseIdentity phone;

  @override
  Future<List<ComputerProfile>> build() async {
    identity = phone;
    deviceId = await publicKeyFingerprint(phone.publicKey);
    deviceNumber = deviceId.substring(0, 8).toUpperCase();
    return [profile];
  }
}
