import 'dart:convert';
import 'dart:io';

import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

void main() {
  test('reads the shared admission outcomes from the Go relay', () {
    final file = File(
      '../../../../packages/contracts/fixtures/relay-route-v1.json',
    );
    final fixture = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    expect(relayAdmission(jsonEncode(fixture['admitted'])), 'ok');
    expect(relayAdmission(jsonEncode(fixture['offline'])), 'offline');
  });
}
