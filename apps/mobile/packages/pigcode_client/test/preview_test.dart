import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

class _PreviewRpc implements HostRequests {
  final notificationsController =
      StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final calls = <(String, Map<String, Object?>)>[];
  Future<Object?> Function(String method, Map<String, Object?> params)? onCall;

  @override
  Stream<Map<String, dynamic>> get notifications =>
      notificationsController.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    calls.add((method, params));
    final handler = onCall;
    if (handler == null) {
      throw StateError('unhandled rpc: $method');
    }
    return handler(method, params);
  }
}

Uint8List _sampleBytes(int length) {
  final data = Uint8List(length);
  for (var i = 0; i < length; i++) {
    data[i] = (i * 41 + 7) & 0xff;
  }
  return data;
}

void main() {
  test(
    'declares preview.tunnel capability and strictly parses preview models including multiple Set-Cookie headers',
    () {
      expect(mobileClientFeatures, contains('preview.tunnel'));
      expect(MobilePreviewMethods.status, 'mobile.preview.status');
      expect(MobilePreviewMethods.fetch, 'mobile.preview.fetch');
      expect(MobilePreviewMethods.readBody, 'mobile.preview.readBody');
      expect(MobilePreviewMethods.closeBody, 'mobile.preview.closeBody');

      final statusJson = {
        'enabled': true,
        'desktopUrls': ['http://localhost:5173/', 'http://127.0.0.1:3000/'],
      };
      final status = MobilePreviewStatus.fromJson(statusJson);
      expect(status.enabled, isTrue);
      expect(status.desktopUrls, [
        'http://localhost:5173/',
        'http://127.0.0.1:3000/',
      ]);
      expect(status.toJson(), statusJson);
      expect(status, MobilePreviewStatus.fromJson(statusJson));

      expect(
        () => MobilePreviewStatus.fromJson({...statusJson, 'extra': 1}),
        throwsFormatException,
      );

      final fetchJson = {
        'status': 200,
        'statusText': 'OK',
        'headers': [
          {'name': 'content-type', 'value': 'text/html; charset=utf-8'},
          {'name': 'set-cookie', 'value': 'sid=abc; Path=/; HttpOnly'},
          {'name': 'set-cookie', 'value': 'theme=dark; Path=/'},
        ],
        'bodyBase64': base64Encode(utf8.encode('<h1>Hello</h1>')),
        'totalBytes': 14,
        'hasMore': false,
      };
      final fetch = MobilePreviewFetchResponse.fromJson(fetchJson);
      expect(fetch.status, 200);
      expect(fetch.statusText, 'OK');
      expect(fetch.headers, hasLength(3));
      expect(fetch.headerValues('Set-Cookie'), [
        'sid=abc; Path=/; HttpOnly',
        'theme=dark; Path=/',
      ]);
      expect(
        fetch.firstHeaderValue('Content-Type'),
        'text/html; charset=utf-8',
      );
      expect(utf8.decode(fetch.inlineBodyBytes!), '<h1>Hello</h1>');
      expect(fetch.toJson(), fetchJson);
      expect(fetch, MobilePreviewFetchResponse.fromJson(fetchJson));

      // Reject unknown fields, invalid status, or hasMore without bodyStreamId
      expect(
        () => MobilePreviewFetchResponse.fromJson({
          ...fetchJson,
          'unknown': true,
        }),
        throwsFormatException,
      );
      expect(
        () => MobilePreviewFetchResponse.fromJson({...fetchJson, 'status': 99}),
        throwsFormatException,
      );
      expect(
        () => MobilePreviewFetchResponse.fromJson({
          'status': 200,
          'statusText': 'OK',
          'headers': <Object>[],
          'totalBytes': 102400,
          'hasMore': true,
        }),
        throwsFormatException,
      );

      final chunkJson = {
        'bodyStreamId': 'stream-1',
        'dataBase64': base64Encode(utf8.encode('chunk-data')),
        'totalBytes': 20,
        'nextOffset': 10,
      };
      final chunk = MobilePreviewBodyChunk.fromJson(chunkJson);
      expect(utf8.decode(chunk.bytes), 'chunk-data');
      expect(chunk.toJson(), chunkJson);
      expect(chunk, MobilePreviewBodyChunk.fromJson(chunkJson));
      expect(
        () => MobilePreviewBodyChunk.fromJson({...chunkJson, 'extra': 1}),
        throwsFormatException,
      );
    },
  );

  test(
    'streamBody yields 32 KiB chunks in order and automatically closes on completion and cancellation',
    () async {
      final rpc = _PreviewRpc();
      final payload = _sampleBytes(3 * mobilePreviewChunkBytes + 777);
      final closedStreams = <String>[];

      rpc.onCall = (method, params) async {
        switch (method) {
          case MobilePreviewMethods.readBody:
            final offset = params['offset'] as int;
            final length =
                (params['length'] as int?) ?? mobilePreviewChunkBytes;
            final end = (offset + length).clamp(0, payload.length);
            final slice = Uint8List.sublistView(payload, offset, end);
            return {
              'bodyStreamId': params['bodyStreamId'],
              'dataBase64': base64Encode(slice),
              'totalBytes': payload.length,
              if (end < payload.length) 'nextOffset': end,
            };
          case MobilePreviewMethods.closeBody:
            closedStreams.add(params['bodyStreamId'] as String);
            return {'ok': true};
          default:
            throw StateError('unexpected method: $method');
        }
      };

      final preview = MobilePreviewCommands(rpc);

      // 1. Complete read reassembles identically and invokes closeBody on completion
      final builder = BytesBuilder(copy: false);
      final chunkSizes = <int>[];
      await for (final chunk in preview.streamBody('stream-full')) {
        chunkSizes.add(chunk.length);
        builder.add(chunk);
      }
      expect(chunkSizes, [32768, 32768, 32768, 777]);
      expect(builder.takeBytes(), payload);
      expect(closedStreams, ['stream-full']);

      // 2. Cancelling mid-stream stops reading and automatically calls closeBody
      closedStreams.clear();
      rpc.calls.clear();
      final received = <Uint8List>[];
      final done = Completer<void>();
      late final StreamSubscription<Uint8List> sub;
      sub = preview.streamBody('stream-cancel').listen((chunk) {
        received.add(chunk);
        unawaited(sub.cancel().then((_) => done.complete()));
      });
      await done.future;

      expect(received, hasLength(1));
      expect(received.single.length, 32768);
      expect(closedStreams, ['stream-cancel']);
      expect(
        rpc.calls.where((call) => call.$1 == MobilePreviewMethods.readBody),
        hasLength(1),
      );

      await rpc.notificationsController.close();
    },
  );

  test(
    'passes status, fetch, readBody, closeBody params and degrades cleanly on legacy desktop',
    () async {
      final rpc = _PreviewRpc();
      rpc.onCall = (method, params) async {
        switch (method) {
          case MobilePreviewMethods.status:
            return {
              'enabled': true,
              'desktopUrls': ['http://localhost:5173/'],
            };
          case MobilePreviewMethods.fetch:
            return {
              'status': 201,
              'statusText': 'Created',
              'headers': [
                {'name': 'content-type', 'value': 'application/json'},
              ],
              'bodyBase64': base64Encode(utf8.encode('{"ok":true}')),
              'totalBytes': 11,
              'hasMore': false,
            };
          case MobilePreviewMethods.closeBody:
            return {'ok': true};
          default:
            throw StateError('unexpected method: $method');
        }
      };

      final commands = MobilePreviewCommands(rpc);
      final status = await commands.getStatus(threadId: 'th_1');
      expect(status.enabled, isTrue);
      expect(rpc.calls.last.$2, {'threadId': 'th_1'});

      final body = Uint8List.fromList(utf8.encode('{"hello":"world"}'));
      final res = await commands.fetch(
        requestId: 'req-1',
        url: 'http://localhost:3000/api/echo',
        method: 'post',
        headers: {'content-type': 'application/json'},
        bodyBytes: body,
      );
      expect(res.status, 201);
      expect(rpc.calls.last.$1, MobilePreviewMethods.fetch);
      expect(rpc.calls.last.$2, {
        'requestId': 'req-1',
        'url': 'http://localhost:3000/api/echo',
        'method': 'POST',
        'headers': {'content-type': 'application/json'},
        'bodyBase64': base64Encode(body),
      });

      await commands.closeBody('stream-x');
      expect(rpc.calls.last.$1, MobilePreviewMethods.closeBody);
      expect(rpc.calls.last.$2, {'bodyStreamId': 'stream-x'});

      // Legacy desktop without preview.tunnel throws ConnectionFailure('update-desktop')
      rpc.calls.clear();
      final legacy = MobilePreviewCommands(rpc, supportsPreviewTunnel: false);
      for (final call in [
        () => legacy.getStatus(),
        () => legacy.fetch(url: 'http://localhost:3000/'),
        () => legacy.readBody(bodyStreamId: 's1', offset: 0),
        () => legacy.closeBody('s1'),
        () => legacy.streamBody('s1').toList(),
      ]) {
        await expectLater(
          Future<void>.sync(call),
          throwsA(
            isA<ConnectionFailure>().having(
              (e) => e.code,
              'code',
              'update-desktop',
            ),
          ),
        );
      }
      expect(rpc.calls, isEmpty);

      // Local argument validation
      await expectLater(
        commands.fetch(url: 'http://localhost:3000/', method: 'TRACE'),
        throwsArgumentError,
      );
      await expectLater(
        commands.fetch(
          url: 'http://localhost:3000/',
          method: 'POST',
          bodyBytes: Uint8List(mobilePreviewMaxRequestBodyBytes + 1),
        ),
        throwsRangeError,
      );
      await expectLater(
        commands.readBody(bodyStreamId: 's1', offset: 0, length: 32769),
        throwsRangeError,
      );

      await rpc.notificationsController.close();
    },
  );
}
