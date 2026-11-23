import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/mobile_reminders.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'decodes an APNs registration from the native settings channel',
    () async {
      const channel = MethodChannel('pigcode/mobile-reminders');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        channel,
        (_) async => <Object?, Object?>{
          'enabled': true,
          'permission': 'granted',
          'apns': <Object?, Object?>{
            'environment': 'production',
            'token': 'ab' * 32,
            'observationId': '055fd267-e1d3-4379-8677-448df3fa1fee',
          },
        },
      );
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      final settings = await const MobileReminderBridge().settings();
      expect(settings.apns?.environment, ApnsEnvironment.production);
      expect(settings.apns?.token, 'ab' * 32);
    },
  );
}
