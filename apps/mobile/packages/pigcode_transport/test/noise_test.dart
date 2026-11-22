import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pigcode_transport/noise.dart';
import 'package:test/test.dart';

void main() {
  test(
    'matches the shared Noise IK reference and transport ciphertext',
    () async {
      final path = '../../../../packages/contracts/fixtures/noise-ik-v1.json';
      final vector =
          jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
      Uint8List bytes(String key) {
        final hex = vector[key] as String;
        return Uint8List.fromList([
          for (var i = 0; i < hex.length; i += 2)
            int.parse(hex.substring(i, i + 2), radix: 16),
        ]);
      }

      final host = await NoiseIdentity.create(bytes('resp_static'));
      final phone = await NoiseIdentity.create(bytes('init_static'));
      final ephemeral = await NoiseIdentity.create(bytes('gen_init_ephemeral'));
      final initiation = await NoiseInitiation.start(
        phone,
        host.publicKey,
        bytes('msg_0_payload'),
        prologue: const [],
        ephemeral: ephemeral,
      );
      expect(initiation.message, bytes('msg_0_ciphertext'));
      final result = await initiation.finish(bytes('msg_1_ciphertext'));
      expect(result.payload, bytes('msg_1_payload'));
      expect(
        await result.session.encrypt(bytes('msg_2_payload')),
        bytes('msg_2_ciphertext'),
      );
      expect(
        await result.session.decrypt(bytes('msg_3_ciphertext')),
        bytes('msg_3_payload'),
      );
    },
  );
}
