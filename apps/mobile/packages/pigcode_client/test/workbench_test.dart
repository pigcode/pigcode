import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

class _WorkbenchRpc implements HostRequests {
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

Uint8List _fakePngBytes(int totalBytes) {
  final data = Uint8List(totalBytes);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  data.setRange(0, sig.length, sig);
  for (var i = sig.length; i < totalBytes; i++) {
    data[i] = (i * 37 + 11) & 0xff;
  }
  return data;
}

void main() {
  test(
    'declares workbench.read capability and validates workbench models strictly',
    () {
      expect(mobileClientFeatures, contains('workbench.read'));
      expect(MobileWorkbenchMethods.list, 'mobile.workspace.list');
      expect(MobileWorkbenchMethods.readFile, 'mobile.workspace.readFile');
      expect(MobileWorkbenchMethods.search, 'mobile.workspace.search');
      expect(MobileWorkbenchMethods.prStatus, 'mobile.pr.status');

      // Directory listing
      final listingJson = {
        'path': 'src',
        'entries': [
          {
            'path': 'src/widgets',
            'name': 'widgets',
            'kind': 'directory',
            'ignored': true,
          },
          {
            'path': 'src/main.dart',
            'name': 'main.dart',
            'kind': 'file',
            'symlink': true,
            'size': 2048,
          },
        ],
        'truncated': true,
        'nextOffset': 2,
      };
      final listing = MobileDirectoryListing.fromJson(listingJson);
      expect(listing.path, 'src');
      expect(listing.entries, hasLength(2));
      expect(listing.entries.first.isDirectory, isTrue);
      expect(listing.entries.first.ignored, isTrue);
      expect(listing.entries.last.isFile, isTrue);
      expect(listing.entries.last.symlink, isTrue);
      expect(listing.entries.last.size, 2048);
      expect(listing.toJson(), listingJson);
      expect(listing, MobileDirectoryListing.fromJson(listingJson));

      expect(
        () => MobileDirectoryEntry.fromJson({
          'path': 'a',
          'name': 'a',
          'kind': 'file',
          'ignored': false,
        }),
        throwsFormatException,
      );
      expect(
        () => MobileDirectoryListing.fromJson({...listingJson, 'extra': 1}),
        throwsFormatException,
      );

      // Text, image, binary file chunks
      final textChunkJson = {
        'path': 'lib/app.dart',
        'mode': 'text',
        'totalSize': 1234,
        'binary': false,
        'truncated': true,
        'text': 'void main() {}\n',
        'eol': 'lf',
        'languageHint': 'dart',
        'nextOffset': 15,
      };
      final textChunk = MobileFileChunk.fromJson(textChunkJson);
      expect(textChunk.toJson(), textChunkJson);
      expect(textChunk, MobileFileChunk.fromJson(textChunkJson));

      final binaryChunkJson = {
        'path': 'build/app.bin',
        'mode': 'binary',
        'totalSize': 4096,
        'binary': true,
        'truncated': false,
      };
      expect(
        MobileFileChunk.fromJson(binaryChunkJson).toJson(),
        binaryChunkJson,
      );

      expect(
        () => MobileFileChunk.fromJson({
          ...binaryChunkJson,
          'mimeType': 'image/svg+xml',
        }),
        throwsFormatException,
      );

      // Search result
      final searchJson = {
        'query': 'workbench',
        'matches': [
          {
            'path': 'lib/workbench.dart',
            'line': 42,
            'preview': 'class MobileWorkbench {}',
          },
        ],
        'truncated': false,
      };
      final search = MobileSearchResult.fromJson(searchJson);
      expect(search.toJson(), searchJson);
      expect(search, MobileSearchResult.fromJson(searchJson));
      expect(
        () => MobileSearchMatch.fromJson({
          'path': 'a.dart',
          'line': 0,
          'preview': 'x',
        }),
        throwsFormatException,
      );

      // PR status (all 6 statuses + detailed checksSummary)
      final okPrJson = {
        'status': 'ok',
        'branch': 'feat/workbench',
        'pr': {
          'number': 149,
          'title': 'Host mobile workbench.read protocol',
          'state': 'OPEN',
          'url': 'https://github.com/pigcode/pigcode/pull/149',
          'headRefName': 'feat/workbench',
          'baseRefName': 'main',
          'isDraft': false,
          'additions': 500,
          'deletions': 20,
          'changedFiles': 10,
          'reviewDecision': 'APPROVED',
          'checksSummary': {'total': 5, 'passed': 4, 'failed': 0, 'pending': 1},
          'updatedAt': '2026-11-25T15:00:00Z',
        },
      };
      final okPr = MobilePrStatusResult.fromJson(okPrJson);
      expect(okPr.toJson(), okPrJson);
      expect(okPr, MobilePrStatusResult.fromJson(okPrJson));
      expect(okPr.pr?.checksSummary?.passed, 4);

      // Explicit null reviewDecision is accepted cleanly
      final nullReviewPr = MobilePrStatusResult.fromJson({
        'status': 'ok',
        'branch': 'feat/workbench',
        'pr': {
          'number': 150,
          'title': 'Draft',
          'state': 'OPEN',
          'url': 'https://github.com/pigcode/pigcode/pull/150',
          'headRefName': 'feat/workbench',
          'baseRefName': 'main',
          'reviewDecision': null,
        },
      });
      expect(nullReviewPr.pr?.reviewDecision, isNull);

      for (final status in [
        'no-pr',
        'not-git',
        'no-remote',
        'gh-unavailable',
        'gh-unauthenticated',
      ]) {
        final parsed = MobilePrStatusResult.fromJson({
          'status': status,
          'branch': status == 'not-git' ? null : 'main',
        });
        expect(parsed.status, status);
        expect(parsed.pr, isNull);
      }

      expect(
        () => MobilePrStatusResult.fromJson({
          'status': 'unknown',
          'branch': null,
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'passes pagination, search, readFile, and prStatus params accurately',
    () async {
      final rpc = _WorkbenchRpc();
      rpc.onCall = (method, params) async {
        switch (method) {
          case MobileWorkbenchMethods.list:
            return {
              'path': params['path'] ?? '',
              'entries': [
                {
                  'path': 'src/a.dart',
                  'name': 'a.dart',
                  'kind': 'file',
                  'size': 12,
                },
              ],
              'truncated': true,
              'nextOffset': 51,
            };
          case MobileWorkbenchMethods.readFile:
            return {
              'path': params['path'],
              'mode': 'text',
              'totalSize': 100,
              'binary': false,
              'truncated': false,
              'text': 'hello',
              'eol': 'lf',
              'languageHint': 'dart',
            };
          case MobileWorkbenchMethods.search:
            return {
              'query': params['query'],
              'matches': [
                {
                  'path': 'src/a.dart',
                  'line': 3,
                  'preview': 'final hello = 1;',
                },
              ],
              'truncated': false,
            };
          case MobileWorkbenchMethods.prStatus:
            return {'status': 'no-pr', 'branch': 'feat/test'};
          default:
            throw StateError('unexpected method: $method');
        }
      };

      final commands = MobileWorkbenchCommands(rpc);

      final page = await commands.listDirectory(
        threadId: 'th_1',
        path: 'src',
        offset: 50,
        limit: 100,
      );
      expect(page.nextOffset, 51);
      expect(rpc.calls.last.$1, MobileWorkbenchMethods.list);
      expect(rpc.calls.last.$2, {
        'threadId': 'th_1',
        'path': 'src',
        'offset': 50,
        'limit': 100,
      });

      final rootPage = await commands.listDirectory(threadId: 'th_1');
      expect(rootPage.path, '');
      expect(rpc.calls.last.$1, MobileWorkbenchMethods.list);
      expect(rpc.calls.last.$2, {'threadId': 'th_1'});

      final chunk = await commands.readFile(
        threadId: 'th_1',
        path: 'src/a.dart',
        offset: 10,
        length: 4096,
        mode: 'text',
        variant: 'full',
      );
      expect(chunk.text, 'hello');
      expect(rpc.calls.last.$1, MobileWorkbenchMethods.readFile);
      expect(rpc.calls.last.$2, {
        'threadId': 'th_1',
        'path': 'src/a.dart',
        'offset': 10,
        'length': 4096,
        'mode': 'text',
        'variant': 'full',
      });

      final search = await commands.searchFiles(
        threadId: 'th_1',
        query: '  hello  ',
        glob: '*.dart',
        limit: 25,
      );
      expect(search.matches.single.line, 3);
      expect(rpc.calls.last.$1, MobileWorkbenchMethods.search);
      expect(rpc.calls.last.$2, {
        'threadId': 'th_1',
        'query': 'hello',
        'glob': '*.dart',
        'limit': 25,
      });

      final pr = await commands.getPrStatus(threadId: 'th_1');
      expect(pr.status, 'no-pr');
      expect(pr.branch, 'feat/test');
      expect(rpc.calls.last.$1, MobileWorkbenchMethods.prStatus);
      expect(rpc.calls.last.$2, {'threadId': 'th_1'});

      await rpc.notificationsController.close();
    },
  );

  test(
    'readFileImage reassembles multi-chunk images and detects corrupted offsets or size changes',
    () async {
      final rpc = _WorkbenchRpc();
      final fullPng = _fakePngBytes(3 * mobileAttachmentChunkBytes + 512);

      rpc.onCall = (method, params) async {
        expect(method, MobileWorkbenchMethods.readFile);
        expect(params['mode'], 'image');
        final offset = (params['offset'] as int?) ?? 0;
        final end = (offset + mobileAttachmentChunkBytes).clamp(
          0,
          fullPng.length,
        );
        final slice = Uint8List.sublistView(fullPng, offset, end);
        return {
          'path': 'assets/hero.png',
          'mode': 'image',
          'totalSize': fullPng.length,
          'binary': true,
          'truncated': end < fullPng.length,
          'mimeType': 'image/png',
          'dataBase64': base64Encode(slice),
          'width': 1280,
          'height': 720,
          if (end < fullPng.length) 'nextOffset': end,
        };
      };

      final commands = MobileWorkbenchCommands(rpc);
      final progress = <(int, int)>[];
      final image = await commands.readFileImage(
        threadId: 'th_1',
        path: 'assets/hero.png',
        onProgress: (received, total) => progress.add((received, total)),
      );

      expect(image.path, 'assets/hero.png');
      expect(image.mimeType, 'image/png');
      expect(image.bytes, fullPng);
      expect(image.totalSize, fullPng.length);
      expect(image.width, 1280);
      expect(image.height, 720);
      expect(progress, [
        (32768, fullPng.length),
        (65536, fullPng.length),
        (98304, fullPng.length),
        (fullPng.length, fullPng.length),
      ]);

      // Detect size change mid-transfer
      var callCount = 0;
      rpc.onCall = (method, params) async {
        callCount++;
        final chunk = Uint8List(32768);
        return {
          'path': 'assets/hero.png',
          'mode': 'image',
          'totalSize': callCount == 1 ? 65536 : 70000,
          'binary': true,
          'truncated': callCount == 1,
          'mimeType': 'image/png',
          'dataBase64': base64Encode(chunk),
          if (callCount == 1) 'nextOffset': 32768,
        };
      };
      await expectLater(
        commands.readFileImage(threadId: 'th_1', path: 'assets/hero.png'),
        throwsFormatException,
      );

      await rpc.notificationsController.close();
    },
  );

  test(
    'degrades gracefully on legacy desktop without workbench.read and validates arguments',
    () async {
      final rpc = _WorkbenchRpc();
      final legacy = MobileWorkbenchCommands(rpc, supportsWorkbenchRead: false);

      for (final call in [
        () => legacy.listDirectory(threadId: 'th_1'),
        () => legacy.readFile(threadId: 'th_1', path: 'README.md'),
        () => legacy.readFileImage(threadId: 'th_1', path: 'logo.png'),
        () => legacy.searchFiles(threadId: 'th_1', query: 'main'),
        () => legacy.getPrStatus(threadId: 'th_1'),
      ]) {
        await expectLater(
          call(),
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

      final modern = MobileWorkbenchCommands(rpc);
      await expectLater(
        modern.listDirectory(threadId: 'th_1', offset: -1),
        throwsRangeError,
      );
      await expectLater(
        modern.listDirectory(threadId: 'th_1', limit: 201),
        throwsRangeError,
      );
      await expectLater(
        modern.readFile(threadId: 'th_1', path: ''),
        throwsArgumentError,
      );
      await expectLater(
        modern.readFile(threadId: 'th_1', path: 'a.dart', length: 32769),
        throwsRangeError,
      );
      await expectLater(
        modern.searchFiles(threadId: 'th_1', query: '   '),
        throwsArgumentError,
      );
      await expectLater(modern.getPrStatus(threadId: ''), throwsArgumentError);
      expect(rpc.calls, isEmpty);

      await rpc.notificationsController.close();
    },
  );
}
