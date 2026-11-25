import 'dart:async';
import 'dart:convert';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

class _WorkbenchWriteRpc implements HostRequests {
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

void main() {
  test('declares workbench.write capability and parses readFile mtimeMs as double', () {
    expect(mobileClientFeatures, contains('workbench.write'));
    expect(MobileWorkbenchWriteMethods.writeFile, 'mobile.workspace.writeFile');
    expect(MobileWorkbenchWriteMethods.writeStart, 'mobile.workspace.writeStart');
    expect(MobileWorkbenchWriteMethods.writeChunk, 'mobile.workspace.writeChunk');
    expect(MobileWorkbenchWriteMethods.writeCommit, 'mobile.workspace.writeCommit');
    expect(MobileWorkbenchWriteMethods.prMerge, 'mobile.pr.merge');

    // Fractional double mtimeMs from Node stat.mtimeMs
    final floatChunk = MobileFileChunk.fromJson({
      'path': 'lib/app.dart',
      'mode': 'text',
      'totalSize': 5,
      'binary': false,
      'truncated': false,
      'text': 'hello',
      'eol': 'lf',
      'mtimeMs': 1732500000123.75,
    });
    expect(floatChunk.mtimeMs, 1732500000123.75);

    // Integer mtimeMs also safely converted to double
    final intChunk = MobileFileChunk.fromJson({
      'path': 'lib/app.dart',
      'mode': 'text',
      'totalSize': 5,
      'binary': false,
      'truncated': false,
      'text': 'hello',
      'eol': 'lf',
      'mtimeMs': 1732500000000,
    });
    expect(intChunk.mtimeMs, 1732500000000.0);

    // Models round-trip strictly
    final wt = MobileWorktreeListResult.fromJson({
      'worktrees': [
        {'id': 'wt_1', 'name': 'repo-pigcode-abc', 'branch': 'pigcode/1234', 'active': true},
      ],
      'mainActive': false,
    });
    expect(wt.worktrees.single.active, isTrue);
    expect(wt.toJson()['mainActive'], isFalse);

    final cp = MobileCheckpointRestoreResult.fromJson({
      'checkpointId': 'ck_1',
      'affectedCount': 2,
      'affectedPaths': ['a.dart', 'b.dart'],
    });
    expect(cp.affectedPaths, ['a.dart', 'b.dart']);
    expect(
      () => MobileDeletePathResult.fromJson({'path': 'a', 'deleted': false}),
      throwsFormatException,
    );
  });

  test('writeFile uses inline path for <=32 KiB and automatic SHA-256 chunking for >32 KiB', () async {
    final rpc = _WorkbenchWriteRpc();
    final client = MobileWorkbenchWriteClient(rpc);

    // 1. Inline save (<= 32 KiB)
    rpc.onCall = (method, params) async {
      expect(method, MobileWorkbenchWriteMethods.writeFile);
      return {'path': params['path'], 'size': 12, 'mtimeMs': 1700000001.25};
    };
    final smallProgress = <(int, int)>[];
    final smallRes = await client.writeFile(
      threadId: 'th_1',
      path: 'README.md',
      text: 'hello world\n',
      expectedMtimeMs: 1700000000.5,
      eol: 'lf',
      onProgress: (sent, total) => smallProgress.add((sent, total)),
    );
    expect(smallRes, const MobileWriteFileResult(
      path: 'README.md',
      size: 12,
      mtimeMs: 1700000001.25,
    ));
    expect(smallProgress, [(12, 12)]);

    // 2. Chunked save (> 32 KiB) with CJK & emoji
    rpc.calls.clear();
    final largeText = '中文内容 🚀 const x = "pigcode";\n'.repeat(1600);
    final largeBytes = utf8.encode(largeText);
    expect(largeBytes.length, greaterThan(mobileWorkbenchWriteInlineMax));
    final expectedSha = await publicKeyFingerprint(largeBytes);

    final received = <int>[];
    String? activeSession;
    rpc.onCall = (method, params) async {
      switch (method) {
        case MobileWorkbenchWriteMethods.writeStart:
          expect(params['totalBytes'], largeBytes.length);
          expect(params['sha256'], expectedSha);
          expect(params['expectedMtimeMs'], 1700000001.25);
          expect(params['eol'], 'crlf');
          activeSession = 'sess_42';
          return {
            'sessionId': activeSession,
            'chunkBytes': mobileWorkbenchWriteChunkBytes,
          };
        case MobileWorkbenchWriteMethods.writeChunk:
          expect(params['sessionId'], activeSession);
          expect(params['offset'], received.length);
          final chunk = base64Decode(params['dataBase64'] as String);
          expect(chunk.length, lessThanOrEqualTo(mobileWorkbenchWriteChunkBytes));
          received.addAll(chunk);
          return {'receivedBytes': received.length};
        case MobileWorkbenchWriteMethods.writeCommit:
          expect(params['sessionId'], activeSession);
          expect(received.length, largeBytes.length);
          return {
            'path': 'big.ts',
            'size': largeBytes.length,
            'mtimeMs': 1700000099.5,
          };
        default:
          throw StateError('unexpected method: $method');
      }
    };

    final chunkProgress = <(int, int)>[];
    final bigRes = await client.writeFile(
      threadId: 'th_1',
      path: 'big.ts',
      text: largeText,
      expectedMtimeMs: 1700000001.25,
      eol: 'crlf',
      onProgress: (sent, total) => chunkProgress.add((sent, total)),
    );
    expect(bigRes.size, largeBytes.length);
    expect(bigRes.mtimeMs, 1700000099.5);
    expect(utf8.decode(received), largeText);
    expect(chunkProgress.length, greaterThan(1));
    expect(chunkProgress.last, (largeBytes.length, largeBytes.length));

    // 3. <= 32 KiB text whose JSON escaping exceeds 48 KiB automatically degrades to chunked write
    rpc.calls.clear();
    final heavilyEscaped = '\u0001"\\\n'.repeat(5500);
    final escapedBytes = utf8.encode(heavilyEscaped);
    expect(escapedBytes.length, lessThanOrEqualTo(mobileWorkbenchWriteInlineMax));
    expect(
      utf8.encode(jsonEncode({'text': heavilyEscaped})).length,
      greaterThan(mobileWorkbenchWriteInlineJsonMax),
    );
    final escapedSha = await publicKeyFingerprint(escapedBytes);
    final escapedReceived = <int>[];
    rpc.onCall = (method, params) async {
      switch (method) {
        case MobileWorkbenchWriteMethods.writeStart:
          expect(params['totalBytes'], escapedBytes.length);
          expect(params['sha256'], escapedSha);
          return {
            'sessionId': 'sess_escaped',
            'chunkBytes': mobileWorkbenchWriteChunkBytes,
          };
        case MobileWorkbenchWriteMethods.writeChunk:
          expect(params['sessionId'], 'sess_escaped');
          expect(params['offset'], escapedReceived.length);
          escapedReceived.addAll(base64Decode(params['dataBase64'] as String));
          return {'receivedBytes': escapedReceived.length};
        case MobileWorkbenchWriteMethods.writeCommit:
          expect(params['sessionId'], 'sess_escaped');
          return {
            'path': 'escaped.txt',
            'size': escapedBytes.length,
            'mtimeMs': 1700000123.5,
          };
        default:
          throw StateError('expected chunked write, got: $method');
      }
    };
    final escapedRes = await client.writeFile(
      threadId: 'th_1',
      path: 'escaped.txt',
      text: heavilyEscaped,
    );
    expect(escapedRes.path, 'escaped.txt');
    expect(escapedRes.size, escapedBytes.length);
    expect(utf8.decode(escapedReceived), heavilyEscaped);
    expect(
      rpc.calls.map((c) => c.$1),
      containsAllInOrder([
        MobileWorkbenchWriteMethods.writeStart,
        MobileWorkbenchWriteMethods.writeChunk,
        MobileWorkbenchWriteMethods.writeCommit,
      ]),
    );
    expect(
      rpc.calls.map((c) => c.$1),
      isNot(contains(MobileWorkbenchWriteMethods.writeFile)),
    );

    // 4. Rejects > 1 MiB before sending any RPC
    rpc.calls.clear();
    final tooBig = 'a' * (mobileWorkbenchWriteMaxBytes + 1);
    await expectLater(
      client.writeFile(threadId: 'th_1', path: 'huge.txt', text: tooBig),
      throwsRangeError,
    );
    expect(rpc.calls, isEmpty);

    await rpc.notificationsController.close();
  });

  test('dispatches file management, worktree, checkpoint, and PR write RPCs accurately', () async {
    final rpc = _WorkbenchWriteRpc();
    final prPayload = {
      'status': 'ok',
      'branch': 'feat/wb',
      'pr': {
        'number': 88,
        'title': 'Workbench write',
        'state': 'OPEN',
        'url': 'https://github.com/pigcode/pigcode/pull/88',
        'headRefName': 'feat/wb',
        'baseRefName': 'main',
        'isDraft': true,
      },
    };
    rpc.onCall = (method, params) async {
      switch (method) {
        case MobileWorkbenchWriteMethods.createFile:
          return {'path': params['path'], 'size': 3, 'mtimeMs': 100};
        case MobileWorkbenchWriteMethods.renamePath:
          return {'oldPath': params['oldPath'], 'newPath': params['newPath']};
        case MobileWorkbenchWriteMethods.deletePath:
          return {'path': params['path'], 'deleted': true};
        case MobileWorkbenchWriteMethods.worktreeList:
          return {
            'worktrees': [
              {'id': 'wt_1', 'name': 'repo-wt', 'branch': 'pigcode/1', 'active': true},
            ],
            'mainActive': false,
          };
        case MobileWorkbenchWriteMethods.worktreeCreate:
        case MobileWorkbenchWriteMethods.worktreeSwitch:
          return {
            'worktree': {
              'id': 'wt_1',
              'name': 'repo-wt',
              'branch': 'pigcode/1',
              'active': true,
            },
          };
        case MobileWorkbenchWriteMethods.worktreeRemove:
          return {'removed': true};
        case MobileWorkbenchWriteMethods.checkpointList:
          return {
            'checkpoints': [
              {
                'id': 'ck_1',
                'runId': null,
                'phase': 'manual',
                'label': 'snap',
                'createdAt': '2026-11-25T10:00:00Z',
                'restorable': true,
              },
            ],
          };
        case MobileWorkbenchWriteMethods.checkpointCreate:
          return {
            'checkpoint': {
              'id': 'ck_1',
              'runId': null,
              'phase': 'manual',
              'label': params['label'],
              'createdAt': '2026-11-25T10:00:00Z',
              'restorable': true,
            },
          };
        case MobileWorkbenchWriteMethods.checkpointRestore:
          return {
            'checkpointId': params['checkpointId'],
            'affectedCount': 1,
            'affectedPaths': ['a.dart'],
          };
        case MobileWorkbenchWriteMethods.prComment:
          return {'ok': true};
        case MobileWorkbenchWriteMethods.prCreate:
        case MobileWorkbenchWriteMethods.prMerge:
        case MobileWorkbenchWriteMethods.prReady:
        case MobileWorkbenchWriteMethods.prClose:
        case MobileWorkbenchWriteMethods.prReopen:
          return prPayload;
        default:
          throw StateError('unexpected: $method');
      }
    };

    final client = MobileWorkbenchWriteClient(rpc);
    expect((await client.createFile(threadId: 'th_1', path: 'a.dart', text: 'abc')).size, 3);
    expect(
      (await client.renamePath(threadId: 'th_1', oldPath: 'a.dart', newPath: 'b.dart')).newPath,
      'b.dart',
    );
    expect(
      (await client.deletePath(threadId: 'th_1', path: 'b.dart', recursive: true)).deleted,
      isTrue,
    );
    expect((await client.listWorktrees(threadId: 'th_1')).worktrees, hasLength(1));
    expect((await client.createWorktree(threadId: 'th_1')).id, 'wt_1');
    expect((await client.switchWorktree(threadId: 'th_1', worktreeId: 'wt_1')).id, 'wt_1');
    await client.removeWorktree(threadId: 'th_1');
    expect((await client.listCheckpoints(threadId: 'th_1')).checkpoints, hasLength(1));
    expect((await client.createCheckpoint(threadId: 'th_1', label: '  snap  ')).label, 'snap');
    expect(
      (await client.restoreCheckpoint(threadId: 'th_1', checkpointId: 'ck_1')).affectedCount,
      1,
    );
    expect(
      (await client.createPr(threadId: 'th_1', title: '  Workbench write ', draft: true))
          .pr
          ?.number,
      88,
    );
    await client.commentPr(threadId: 'th_1', body: '  LGTM  ');
    expect(
      (await client.mergePr(
        threadId: 'th_1',
        method: MobilePrMergeMethod.squash,
        deleteBranch: true,
      )).status,
      'ok',
    );
    expect((await client.readyPr(threadId: 'th_1')).status, 'ok');
    expect((await client.closePr(threadId: 'th_1')).status, 'ok');
    expect((await client.reopenPr(threadId: 'th_1')).status, 'ok');

    await rpc.notificationsController.close();
  });

  test('degrades cleanly when desktop does not support workbench.write', () async {
    final rpc = _WorkbenchWriteRpc();
    final legacy = MobileWorkbenchWriteClient(rpc, supportsWorkbenchWrite: false);

    for (final fn in [
      () => legacy.writeFile(threadId: 'th_1', path: 'a.txt', text: 'hi'),
      () => legacy.createFile(threadId: 'th_1', path: 'a.txt'),
      () => legacy.renamePath(threadId: 'th_1', oldPath: 'a', newPath: 'b'),
      () => legacy.deletePath(threadId: 'th_1', path: 'a'),
      () => legacy.listWorktrees(threadId: 'th_1'),
      () => legacy.createWorktree(threadId: 'th_1'),
      () => legacy.switchWorktree(threadId: 'th_1', worktreeId: 'wt_1'),
      () => legacy.removeWorktree(threadId: 'th_1'),
      () => legacy.listCheckpoints(threadId: 'th_1'),
      () => legacy.createCheckpoint(threadId: 'th_1'),
      () => legacy.restoreCheckpoint(threadId: 'th_1', checkpointId: 'ck_1'),
      () => legacy.createPr(threadId: 'th_1', title: 'PR'),
      () => legacy.commentPr(threadId: 'th_1', body: 'hi'),
      () => legacy.mergePr(threadId: 'th_1', method: MobilePrMergeMethod.merge),
      () => legacy.readyPr(threadId: 'th_1'),
      () => legacy.closePr(threadId: 'th_1'),
      () => legacy.reopenPr(threadId: 'th_1'),
    ]) {
      await expectLater(
        fn(),
        throwsA(
          isA<ConnectionFailure>().having((e) => e.code, 'code', 'update-desktop'),
        ),
      );
    }
    expect(rpc.calls, isEmpty);
    await rpc.notificationsController.close();
  });
}

extension on String {
  String repeat(int count) => List<String>.filled(count, this).join();
}
