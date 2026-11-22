import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

void report(String stage, [Map<String, Object?> details = const {}]) {
  stdout.writeln(jsonEncode({'stage': stage, ...details}));
}

Future<void> main() async {
  final context = SecurityContext(withTrustedRoots: true);
  final ca = Platform.environment['PIGCODE_RELAY_TEST_CA'];
  if (ca != null) context.setTrustedCertificates(ca);
  final client = HttpClient(context: context);
  final identities = <String, NoiseIdentity>{};
  final saved = <String, ComputerProfile>{};
  final active = <String, MobileConnection>{};

  try {
    await for (final line
        in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
      final command = jsonDecode(line) as Map<String, dynamic>;
      final phone = command['phone'] as String;
      final identity = identities[phone] ??= await NoiseIdentity.create();
      try {
        switch (command['action']) {
          case 'pair' || 'update':
            final invite = PairingInvite.parse(command['qr'] as String);
            await active.remove(phone)?.close();
            void showCode(String code) => report('code', {'code': code});
            final link = command['action'] == 'update'
                ? await MobileConnection.updateRelay(
                    computer: saved[phone]!,
                    invite: invite,
                    identity: identity,
                    showVerificationCode: showCode,
                    client: client,
                  )
                : await MobileConnection.pair(
                    invite: invite,
                    identity: identity,
                    deviceName: phone,
                    platform: phone == '个人 iPhone' ? 'ios' : 'android',
                    showVerificationCode: showCode,
                    client: client,
                  );
            active[phone] = link;
            report('ready');
          case 'save' || 'saveWithoutReceipt':
            final link = active[phone]!;
            saved[phone] = ComputerProfile.fromJson(link.computer.toJson());
            if (command['action'] == 'save') await link.announceRelaySaved();
            report('saved');
          case 'reconnect':
            await active.remove(phone)?.close();
            active[phone] = await MobileConnection.resume(
              saved[phone]!,
              identity,
              client: client,
            );
            report('ready');
          case 'closed':
            await active[phone]!.done.timeout(const Duration(seconds: 8));
            report('closed');
          case 'saved':
            report('saved', {'address': saved[phone]!.address.toString()});
          default:
            throw StateError('Unknown verification step');
        }
      } on ConnectionFailure catch (failure) {
        report('failed', {'code': failure.code});
      }
    }
  } finally {
    for (final connection in active.values) {
      await connection.close();
    }
    client.close(force: true);
  }
}
