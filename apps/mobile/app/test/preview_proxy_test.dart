import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/preview/local_preview_proxy.dart';
import 'package:pigcode_mobile/preview/preview_url_extractor.dart';

class _FakePreviewHost implements HostRequests {
  _FakePreviewHost({this.onFetch, this.onReadBody});

  Future<MobilePreviewFetchResponse> Function(Map<String, Object?> params)?
  onFetch;
  Future<MobilePreviewBodyChunk> Function(Map<String, Object?> params)?
  onReadBody;

  final List<({String method, Map<String, Object?> params})> calls = [];
  final List<String> closedStreams = [];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobilePreviewMethods.fetch:
        return (await onFetch!(params)).toJson();
      case MobilePreviewMethods.readBody:
        return (await onReadBody!(params)).toJson();
      case MobilePreviewMethods.closeBody:
        final streamId = params['bodyStreamId'] as String;
        closedStreams.add(streamId);
        return {'ok': true};
      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

Future<Uint8List> _readAllBytes(HttpClientResponse response) async {
  final builder = BytesBuilder(copy: false);
  await for (final chunk in response) {
    builder.add(chunk);
  }
  return builder.takeBytes();
}

void main() {
  group('pure helpers', () {
    test(
      'proxyUriToDisplayUri restores target origin and preserves path/query',
      () {
        final targetOrigin = Uri.parse('http://localhost:5173');
        final proxyUri = Uri.parse('http://127.0.0.1:54321/login?tab=1#form');
        final display = proxyUriToDisplayUri(proxyUri, targetOrigin);

        expect(display.toString(), 'http://localhost:5173/login?tab=1#form');
        expect(
          formatPreviewDisplayAddress(display),
          'localhost:5173/login?tab=1#form',
        );
        expect(
          formatPreviewDisplayAddress(
            proxyUriToDisplayUri(
              Uri.parse('http://127.0.0.1:54321/'),
              targetOrigin,
            ),
          ),
          'localhost:5173',
        );

        final external = Uri.parse('https://example.com/docs');
        expect(proxyUriToDisplayUri(external, targetOrigin), external);
      },
    );

    test('rewriteSetCookieForLocalProxy strips Secure and loopback Domain', () {
      expect(
        rewriteSetCookieForLocalProxy(
          'sid=abc123; Path=/; HttpOnly; Secure; Domain=localhost; SameSite=Lax',
        ),
        'sid=abc123; Path=/; HttpOnly; SameSite=Lax',
      );
      expect(
        rewriteSetCookieForLocalProxy(
          'token=xyz; DOMAIN=.LocalHost; SECURE; Max-Age=3600',
        ),
        'token=xyz; Max-Age=3600',
      );
      expect(
        rewriteSetCookieForLocalProxy('a=1; Domain=127.0.0.1; Path=/app'),
        'a=1; Path=/app',
      );
    });
  });

  group('LocalPreviewProxy HTTP integration', () {
    test(
      'forwards inline HTML response and strips encoding/hop-by-hop headers',
      () async {
        Map<String, Object?>? capturedParams;
        final host = _FakePreviewHost(
          onFetch: (params) async {
            capturedParams = params;
            final html = utf8.encode(
              '<html><body><h1>你好 Pigcode</h1></body></html>',
            );
            return MobilePreviewFetchResponse(
              status: 200,
              statusText: 'OK',
              headers: const [
                MobilePreviewHeader(
                  name: 'content-type',
                  value: 'text/html; charset=utf-8',
                ),
                MobilePreviewHeader(name: 'content-encoding', value: 'gzip'),
                MobilePreviewHeader(
                  name: 'transfer-encoding',
                  value: 'chunked',
                ),
                MobilePreviewHeader(name: 'x-app', value: 'vite-dev'),
              ],
              bodyBase64: base64Encode(html),
              totalBytes: html.length,
              hasMore: false,
            );
          },
        );
        final proxy = LocalPreviewProxy(
          previewCommands: MobilePreviewCommands(host),
        );
        addTearDown(proxy.close);

        final entryUri = await proxy.start(
          Uri.parse('http://localhost:5173/app?v=1'),
        );
        expect(entryUri.host, '127.0.0.1');
        expect(entryUri.port, greaterThan(0));
        expect(entryUri.path, '/app');
        expect(entryUri.query, 'v=1');

        final client = HttpClient();
        addTearDown(() => client.close(force: true));
        final req = await client.getUrl(entryUri);
        req.headers.set('x-custom', 'mobile');
        req.headers.set('connection', 'keep-alive, x-drop-me');
        req.headers.set('x-drop-me', 'should-not-forward');
        final res = await req.close();
        final body = utf8.decode(await _readAllBytes(res));

        expect(res.statusCode, 200);
        expect(body, contains('你好 Pigcode'));
        expect(res.headers.value('x-app'), 'vite-dev');
        expect(res.headers.value('content-encoding'), isNull);
        expect(capturedParams?['url'], 'http://localhost:5173/app?v=1');
        expect(capturedParams?['method'], 'GET');
        final forwardedHeaders =
            capturedParams?['headers'] as Map<String, Object?>?;
        expect(forwardedHeaders?['x-custom'], 'mobile');
        expect(forwardedHeaders?.containsKey('host'), isFalse);
        expect(forwardedHeaders?.containsKey('x-drop-me'), isFalse);
      },
    );

    test(
      'streams >100 KiB response across multiple chunks and closes stream',
      () async {
        final largePayload = Uint8List.fromList(
          List<int>.generate(120 * 1024 + 333, (i) => (i * 31 + 7) & 0xff),
        );
        final host = _FakePreviewHost(
          onFetch: (_) async => MobilePreviewFetchResponse(
            status: 200,
            statusText: 'OK',
            headers: const [
              MobilePreviewHeader(
                name: 'content-type',
                value: 'application/octet-stream',
              ),
            ],
            bodyStreamId: 'stream-large-1',
            totalBytes: largePayload.length,
            hasMore: true,
          ),
          onReadBody: (params) async {
            final offset = params['offset'] as int;
            final length =
                (params['length'] as int?) ?? mobilePreviewChunkBytes;
            final end = (offset + length).clamp(0, largePayload.length);
            final slice = largePayload.sublist(offset, end);
            return MobilePreviewBodyChunk(
              bodyStreamId: 'stream-large-1',
              dataBase64: base64Encode(slice),
              totalBytes: largePayload.length,
              nextOffset: end < largePayload.length ? end : null,
            );
          },
        );
        final proxy = LocalPreviewProxy(
          previewCommands: MobilePreviewCommands(host),
        );
        addTearDown(proxy.close);

        final entryUri = await proxy.start(
          Uri.parse('http://localhost:5173/bundle.js'),
        );
        final client = HttpClient();
        addTearDown(() => client.close(force: true));
        final req = await client.getUrl(entryUri);
        final res = await req.close();
        final received = await _readAllBytes(res);

        expect(res.statusCode, 200);
        expect(received.length, largePayload.length);
        expect(received, orderedEquals(largePayload));
        expect(host.closedStreams, contains('stream-large-1'));
        final readCalls = host.calls
            .where((c) => c.method == MobilePreviewMethods.readBody)
            .length;
        expect(readCalls, greaterThanOrEqualTo(4));
      },
    );

    test(
      'forwards POST body and rejects request bodies > 32 KiB with 413',
      () async {
        String? receivedBodyText;
        Map<String, Object?>? receivedHeaders;
        final host = _FakePreviewHost(
          onFetch: (params) async {
            final b64 = params['bodyBase64'] as String?;
            receivedBodyText = b64 == null
                ? null
                : utf8.decode(base64Decode(b64));
            receivedHeaders = params['headers'] as Map<String, Object?>?;
            final reply = utf8.encode('{"ok":true}');
            return MobilePreviewFetchResponse(
              status: 201,
              statusText: 'Created',
              headers: const [
                MobilePreviewHeader(
                  name: 'content-type',
                  value: 'application/json',
                ),
              ],
              bodyBase64: base64Encode(reply),
              totalBytes: reply.length,
              hasMore: false,
            );
          },
        );
        final proxy = LocalPreviewProxy(
          previewCommands: MobilePreviewCommands(host),
        );
        addTearDown(proxy.close);

        final entryUri = await proxy.start(
          Uri.parse('http://localhost:3000/api/login'),
        );
        final client = HttpClient();
        addTearDown(() => client.close(force: true));

        // Normal POST
        final postReq = await client.postUrl(entryUri);
        postReq.headers.contentType = ContentType.json;
        postReq.headers.set('origin', 'http://127.0.0.1:${proxy.port}');
        postReq.add(utf8.encode('{"user":"pigcode"}'));
        final postRes = await postReq.close();
        final postReply = utf8.decode(await _readAllBytes(postRes));

        expect(postRes.statusCode, 201);
        expect(postReply, '{"ok":true}');
        expect(receivedBodyText, '{"user":"pigcode"}');
        expect(receivedHeaders?['origin'], 'http://localhost:3000');

        // Oversized POST (> 32 KiB) rejected locally with 413 without hitting Host
        final callsBefore = host.calls.length;
        final bigReq = await client.postUrl(entryUri);
        bigReq.add(Uint8List(mobilePreviewMaxRequestBodyBytes + 1));
        final bigRes = await bigReq.close();
        await _readAllBytes(bigRes);

        expect(bigRes.statusCode, HttpStatus.requestEntityTooLarge);
        expect(host.calls.length, callsBefore);
      },
    );

    test(
      'rewrites multiple Set-Cookie headers removing Secure and localhost Domain',
      () async {
        final host = _FakePreviewHost(
          onFetch: (_) async => const MobilePreviewFetchResponse(
            status: 200,
            statusText: 'OK',
            headers: [
              MobilePreviewHeader(
                name: 'set-cookie',
                value:
                    'session=abc; Path=/; HttpOnly; Secure; Domain=localhost',
              ),
              MobilePreviewHeader(
                name: 'set-cookie',
                value:
                    'csrf=xyz; Path=/; SECURE; Domain=.localhost; SameSite=Lax',
              ),
            ],
            bodyBase64: '',
            totalBytes: 0,
            hasMore: false,
          ),
        );
        final proxy = LocalPreviewProxy(
          previewCommands: MobilePreviewCommands(host),
        );
        addTearDown(proxy.close);

        final entryUri = await proxy.start(Uri.parse('http://localhost:5173/'));
        final client = HttpClient();
        addTearDown(() => client.close(force: true));

        final req = await client.getUrl(entryUri);
        final res = await req.close();
        await _readAllBytes(res);

        final setCookies = res.headers[HttpHeaders.setCookieHeader] ?? const [];
        expect(setCookies.length, 2);
        expect(setCookies[0], 'session=abc; Path=/; HttpOnly');
        expect(setCookies[1], 'csrf=xyz; Path=/; SameSite=Lax');
        for (final cookie in setCookies) {
          expect(cookie.toLowerCase(), isNot(contains('secure')));
          expect(cookie.toLowerCase(), isNot(contains('domain=')));
        }
      },
    );

    test(
      'rewrites same-origin 302 Location into proxy and intercepts external/cross-port 302',
      () async {
        final externalNavigations = <Uri>[];
        final host = _FakePreviewHost(
          onFetch: (params) async {
            final url = params['url'] as String;
            if (url.endsWith('/same-relative')) {
              return const MobilePreviewFetchResponse(
                status: 302,
                statusText: 'Found',
                headers: [
                  MobilePreviewHeader(
                    name: 'location',
                    value: '/dashboard?ok=1',
                  ),
                ],
                bodyBase64: '',
                totalBytes: 0,
                hasMore: false,
              );
            }
            if (url.endsWith('/same-absolute')) {
              return const MobilePreviewFetchResponse(
                status: 302,
                statusText: 'Found',
                headers: [
                  MobilePreviewHeader(
                    name: 'location',
                    value: 'http://localhost:5173/profile#bio',
                  ),
                ],
                bodyBase64: '',
                totalBytes: 0,
                hasMore: false,
              );
            }
            if (url.endsWith('/other-port')) {
              return const MobilePreviewFetchResponse(
                status: 302,
                statusText: 'Found',
                headers: [
                  MobilePreviewHeader(
                    name: 'location',
                    value: 'http://localhost:8080/admin',
                  ),
                ],
                bodyBase64: '',
                totalBytes: 0,
                hasMore: false,
              );
            }
            return const MobilePreviewFetchResponse(
              status: 302,
              statusText: 'Found',
              headers: [
                MobilePreviewHeader(
                  name: 'location',
                  value: 'https://github.com/login',
                ),
              ],
              bodyBase64: '',
              totalBytes: 0,
              hasMore: false,
            );
          },
        );
        final proxy = LocalPreviewProxy(
          previewCommands: MobilePreviewCommands(host),
          onExternalNavigation: externalNavigations.add,
        );
        addTearDown(proxy.close);

        await proxy.start(Uri.parse('http://localhost:5173/'));
        final client = HttpClient();
        addTearDown(() => client.close(force: true));

        // 1. Same-origin relative redirect
        final r1 = await client.getUrl(
          Uri.parse('http://127.0.0.1:${proxy.port}/same-relative'),
        );
        r1.followRedirects = false;
        final res1 = await r1.close();
        await _readAllBytes(res1);
        expect(res1.statusCode, 302);
        expect(
          res1.headers.value(HttpHeaders.locationHeader),
          'http://127.0.0.1:${proxy.port}/dashboard?ok=1',
        );
        expect(externalNavigations, isEmpty);

        // 2. Same-origin absolute redirect
        final r2 = await client.getUrl(
          Uri.parse('http://127.0.0.1:${proxy.port}/same-absolute'),
        );
        r2.followRedirects = false;
        final res2 = await r2.close();
        await _readAllBytes(res2);
        expect(res2.statusCode, 302);
        expect(
          res2.headers.value(HttpHeaders.locationHeader),
          'http://127.0.0.1:${proxy.port}/profile#bio',
        );
        expect(externalNavigations, isEmpty);

        // 3. Cross-port loopback redirect -> intercepted, returns 204, triggers callback
        final r3 = await client.getUrl(
          Uri.parse('http://127.0.0.1:${proxy.port}/other-port'),
        );
        r3.followRedirects = false;
        final res3 = await r3.close();
        await _readAllBytes(res3);
        expect(res3.statusCode, HttpStatus.noContent);
        expect(res3.headers.value(HttpHeaders.locationHeader), isNull);
        expect(externalNavigations, [Uri.parse('http://localhost:8080/admin')]);

        // 4. External public domain redirect -> intercepted, returns 204, triggers callback
        final r4 = await client.getUrl(
          Uri.parse('http://127.0.0.1:${proxy.port}/external'),
        );
        r4.followRedirects = false;
        final res4 = await r4.close();
        await _readAllBytes(res4);
        expect(res4.statusCode, HttpStatus.noContent);
        expect(externalNavigations.last, Uri.parse('https://github.com/login'));
      },
    );

    test(
      'maps Host preview error codes to HTTP status codes and structured errors',
      () async {
        final errors = <PreviewProxyError>[];
        var nextCode = 'PREVIEW_DISABLED';
        final host = _FakePreviewHost(
          onFetch: (_) async {
            throw MobileRpcFailure(
              MobileRpcProblem(code: nextCode, message: nextCode),
            );
          },
        );
        final proxy = LocalPreviewProxy(
          previewCommands: MobilePreviewCommands(host),
          onProxyError: errors.add,
        );
        addTearDown(proxy.close);

        final entryUri = await proxy.start(Uri.parse('http://localhost:5173/'));
        final client = HttpClient();
        addTearDown(() => client.close(force: true));

        final cases = <(String, int, PreviewProxyErrorKind)>[
          (
            'PREVIEW_DISABLED',
            HttpStatus.serviceUnavailable,
            PreviewProxyErrorKind.disabled,
          ),
          (
            'PREVIEW_UNREACHABLE',
            HttpStatus.badGateway,
            PreviewProxyErrorKind.unreachable,
          ),
          (
            'PREVIEW_TIMEOUT',
            HttpStatus.gatewayTimeout,
            PreviewProxyErrorKind.timeout,
          ),
          (
            'PREVIEW_URL_NOT_ALLOWED',
            HttpStatus.forbidden,
            PreviewProxyErrorKind.urlNotAllowed,
          ),
          (
            'PREVIEW_TOO_LARGE',
            HttpStatus.badGateway,
            PreviewProxyErrorKind.tooLarge,
          ),
        ];

        for (final (code, expectedStatus, expectedKind) in cases) {
          nextCode = code;
          final req = await client.getUrl(entryUri);
          final res = await req.close();
          await _readAllBytes(res);
          expect(res.statusCode, expectedStatus, reason: code);
          expect(errors.last.kind, expectedKind, reason: code);
          expect(errors.last.code, code);
        }
      },
    );

    test('closes port immediately on close() and on connection.done', () async {
      // 1. Explicit close()
      final host1 = _FakePreviewHost(
        onFetch: (_) async => const MobilePreviewFetchResponse(
          status: 200,
          statusText: 'OK',
          headers: [],
          bodyBase64: '',
          totalBytes: 0,
          hasMore: false,
        ),
      );
      final proxy1 = LocalPreviewProxy(
        previewCommands: MobilePreviewCommands(host1),
      );
      final uri1 = await proxy1.start(Uri.parse('http://localhost:5173/'));
      final port1 = uri1.port;
      await proxy1.close();
      expect(proxy1.isRunning, isFalse);
      await expectLater(
        Socket.connect(InternetAddress.loopbackIPv4, port1),
        throwsA(isA<SocketException>()),
      );

      // 2. Automatic close on connection.done (also cancels active streams!)
      final doneCompleter = Completer<void>();
      final firstChunkStarted = Completer<void>();
      final secondChunkGate = Completer<MobilePreviewBodyChunk>();
      final host2 = _FakePreviewHost(
        onFetch: (_) async => const MobilePreviewFetchResponse(
          status: 200,
          statusText: 'OK',
          headers: [],
          bodyStreamId: 'stream-hang-1',
          totalBytes: 64 * 1024,
          hasMore: true,
        ),
        onReadBody: (params) async {
          final offset = params['offset'] as int;
          if (offset == 0) {
            if (!firstChunkStarted.isCompleted) firstChunkStarted.complete();
            return MobilePreviewBodyChunk(
              bodyStreamId: 'stream-hang-1',
              dataBase64: base64Encode(Uint8List(32 * 1024)),
              totalBytes: 64 * 1024,
              nextOffset: 32 * 1024,
            );
          }
          return secondChunkGate.future;
        },
      );
      final proxy2 = LocalPreviewProxy(
        previewCommands: MobilePreviewCommands(host2),
        connectionDone: doneCompleter.future,
      );
      final uri2 = await proxy2.start(
        Uri.parse('http://localhost:5173/stream'),
      );
      final port2 = uri2.port;

      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final req = await client.getUrl(uri2);
      final resFuture = req.close();
      await firstChunkStarted.future;

      // Simulate connection drop
      doneCompleter.complete();
      // Let connectionDone listener trigger close()
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(proxy2.isClosed, isTrue);
      expect(host2.closedStreams, contains('stream-hang-1'));
      await expectLater(
        Socket.connect(InternetAddress.loopbackIPv4, port2),
        throwsA(isA<SocketException>()),
      );

      // Drain dangling client response cleanly without unhandled error
      try {
        final res = await resFuture;
        await _readAllBytes(res);
      } catch (_) {}
    });
  });
}
