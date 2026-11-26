import 'dart:async';
import 'dart:convert';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

class _FakeHost implements HostRequests {
  final calls = <(String, Map<String, Object?>)>[];
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  Object? Function(String method, Map<String, Object?> params)? onCall;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method, Map<String, Object?>.from(params)));
    return onCall?.call(method, params);
  }

  void push(String method, Map<String, dynamic> params) {
    _notifications.add({'jsonrpc': '2.0', 'method': method, 'params': params});
  }

  Future<void> dispose() => _notifications.close();
}

void main() {
  test('includes terminal feature and guards unsupported desktop', () async {
    expect(mobileClientFeatures, contains('terminal'));
    final host = _FakeHost();
    addTearDown(host.dispose);
    final client = MobileTerminalClient(host, supportsTerminal: false);

    await expectLater(
      client.list(threadId: 'th_1'),
      throwsA(
        isA<ConnectionFailure>().having(
          (e) => e.code,
          'code',
          'update-desktop',
        ),
      ),
    );
    expect(host.calls, isEmpty);
  });

  test(
    'splits large UTF-8 writes with emoji safely within 16 KiB per RPC',
    () async {
      final host = _FakeHost()..onCall = (_, _) => {'ok': true};
      addTearDown(host.dispose);
      final client = MobileTerminalClient(host);

      final bigInput = '你好🚀abc\n' * 3000; // > 36 KiB UTF-8
      await client.write(terminalId: 'term_1', data: bigInput);

      expect(host.calls.length, greaterThanOrEqualTo(3));
      final rebuilt = StringBuffer();
      for (final (method, params) in host.calls) {
        expect(method, MobileTerminalMethods.write);
        final raw = base64Decode(params['dataBase64'] as String);
        expect(raw.length, lessThanOrEqualTo(mobileTerminalWriteMaxBytes));
        rebuilt.write(utf8.decode(raw));
      }
      expect(rebuilt.toString(), bigInput);
    },
  );

  test(
    'parses list, open, attach, resize, and streams output/exit notifications',
    () async {
      final host = _FakeHost();
      addTearDown(host.dispose);
      final summary = {
        'id': 'term_1',
        'threadId': 'th_1',
        'shell': 'zsh',
        'cwdLabel': 'pigcode',
        'cols': 48,
        'rows': 24,
        'cursor': 10,
        'origin': 'mobile',
        'writable': true,
        'createdAt': '2026-11-26T00:00:00.000Z',
      };
      host.onCall = (method, params) {
        return switch (method) {
          MobileTerminalMethods.list => {
            'terminals': [summary],
          },
          MobileTerminalMethods.open => {'terminal': summary},
          MobileTerminalMethods.attach => {
            'terminal': summary,
            'cursor': 10,
            'replayChunks': 1,
            'truncated': false,
          },
          MobileTerminalMethods.resize => {'cols': 60, 'rows': 30},
          MobileTerminalMethods.detach => {'ok': true},
          MobileTerminalMethods.close => {'closed': true},
          _ => throw StateError('unexpected $method'),
        };
      };

      final client = MobileTerminalClient(host);
      final outputs = <MobileTerminalOutputEvent>[];
      final exits = <MobileTerminalExitEvent>[];
      final subOut = client.outputs.listen(outputs.add);
      final subExit = client.exits.listen(exits.add);
      addTearDown(() async {
        await subOut.cancel();
        await subExit.cancel();
      });

      final list = await client.list(threadId: 'th_1');
      expect(list, hasLength(1));
      expect(list.first.origin, MobileTerminalOrigin.mobile);
      expect(list.first.writable, isTrue);

      final opened = await client.open(threadId: 'th_1', cols: 10, rows: 999);
      expect(opened.id, 'term_1');
      expect(host.calls.last.$2['cols'], mobileTerminalColsMin);
      expect(host.calls.last.$2['rows'], mobileTerminalRowsMax);

      final attached = await client.attach(
        threadId: 'th_1',
        terminalId: 'term_1',
        afterCursor: 4,
        cols: 60,
        rows: 30,
      );
      expect(attached.replayChunks, 1);

      host.push(MobileTerminalNotifications.output, {
        'terminalId': 'term_1',
        'dataBase64': base64Encode(utf8.encode('hello 世界\n')),
        'cursor': 19,
        'replay': true,
      });
      host.push(MobileTerminalNotifications.exit, {
        'terminalId': 'term_1',
        'exitCode': 0,
      });
      await Future<void>.delayed(Duration.zero);

      expect(outputs, hasLength(1));
      expect(outputs.first.data, 'hello 世界\n');
      expect(outputs.first.replay, isTrue);
      expect(exits, hasLength(1));
      expect(exits.first.exitCode, 0);

      final resized = await client.resize(
        terminalId: 'term_1',
        cols: 60,
        rows: 30,
      );
      expect(resized.cols, 60);
      await client.detach(terminalId: 'term_1');
      await client.close(terminalId: 'term_1');
    },
  );
}
