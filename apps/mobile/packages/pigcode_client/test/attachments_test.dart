import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

class _AttachmentRpc implements HostRequests {
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
    data[i] = (i * 31 + 7) & 0xff;
  }
  return data;
}

void main() {
  test(
    'declares composer.attachments capability and validates attachment models',
    () {
      expect(mobileClientFeatures, contains('composer.attachments'));
      expect(
        MobileAttachmentMethods.uploadStart,
        'mobile.attachment.uploadStart',
      );
      expect(
        MobileAttachmentMethods.uploadChunk,
        'mobile.attachment.uploadChunk',
      );
      expect(
        MobileAttachmentMethods.uploadCancel,
        'mobile.attachment.uploadCancel',
      );
      expect(
        MobileAttachmentMethods.uploadFinish,
        'mobile.attachment.uploadFinish',
      );
      expect(MobileAttachmentMethods.read, 'mobile.attachment.read');

      final refJson = {
        'id': 'att_1',
        'mimeType': 'image/png',
        'fileName': 'screen.png',
        'sizeBytes': 4096,
        'width': 1170,
        'height': 2532,
      };
      final ref = MobileAttachmentRef.fromJson(refJson);
      expect(ref.toJson(), refJson);
      expect(
        () => MobileAttachmentRef.fromJson({...refJson, 'path': '/tmp/x.png'}),
        throwsFormatException,
      );
      expect(
        () => MobileAttachmentRef.fromJson({
          ...refJson,
          'mimeType': 'image/svg+xml',
        }),
        throwsFormatException,
      );
      expect(
        () => MobileAttachmentRef.fromJson({...refJson, 'sizeBytes': 0}),
        throwsFormatException,
      );

      // Timeline event with attachments + image-only turn projection.
      final event = MobileTimelineEvent.fromJson({
        'seq': 1,
        'runId': 'r1',
        'kind': 'message.user',
        'createdAt': '2026-11-25T10:00:00.000Z',
        'text': '',
        'attachments': [refJson],
      });
      expect(event.attachments, [ref]);
      expect(event.toJson()['attachments'], [refJson]);
      final turns = timelineTurns([event]);
      expect(turns, hasLength(1));
      expect(turns.single.user?.attachments, [ref]);

      // Queued message and withdraw receipt attachments.
      final queued = QueuedMessage.fromJson({
        'id': 'qm_1',
        'text': '',
        'selected': false,
        'attachments': [refJson],
      });
      expect(queued.attachments, [ref]);
      expect(queued.toJson()['attachments'], [refJson]);
      final receipt = QueueReceipt.fromJson({
        'threadId': 'th_1',
        'commandId': '11111111-1111-4111-8111-111111111111',
        'method': 'queue.withdraw',
        'effect': 'withdrawn',
        'messageId': 'qm_1',
        'text': '',
        'attachments': [refJson],
      });
      expect(receipt.attachments, [ref]);
      expect(receipt.toJson()['attachments'], [refJson]);

      // supportsImages defaults to true for legacy desktops and preserves explicit false.
      final legacyComposer = MobileThreadComposerState.fromJson({
        'instanceId': 'fake',
        'agentId': 'fake',
        'permissionMode': 'full-access',
        'planMode': false,
        'supportsPlanMode': true,
      });
      expect(legacyComposer.supportsImages, isTrue);
      expect(legacyComposer.toJson().containsKey('supportsImages'), isFalse);

      final noVisionComposer = MobileThreadComposerState.fromJson({
        'instanceId': 'pi',
        'agentId': 'pi',
        'permissionMode': 'full-access',
        'planMode': false,
        'supportsPlanMode': false,
        'supportsImages': false,
      });
      expect(noVisionComposer.supportsImages, isFalse);
      expect(noVisionComposer.toJson()['supportsImages'], isFalse);

      final legacyInstance = MobileDraftInstance.fromJson({
        'instanceId': 'fake',
        'label': 'Fake',
        'agentName': 'Fake',
        'permissionModes': ['full-access'],
        'defaultPermissionMode': 'full-access',
      });
      expect(legacyInstance.supportsImages, isTrue);
      expect(legacyInstance.toJson().containsKey('supportsImages'), isFalse);

      final visionInstance = MobileDraftInstance.fromJson({
        'instanceId': 'claude',
        'label': 'Claude',
        'agentName': 'Claude',
        'permissionModes': ['full-access'],
        'defaultPermissionMode': 'full-access',
        'supportsImages': false,
      });
      expect(visionInstance.supportsImages, isFalse);
      expect(visionInstance.toJson()['supportsImages'], isFalse);

      // startRun / createDraftThread allow empty text when attachmentIds is non-empty.
      final startParams = MobileStartRunParams.fromJson({
        'commandId': '11111111-1111-4111-8111-111111111111',
        'threadId': 'th_1',
        'text': '',
        'attachmentIds': ['att_1'],
      });
      expect(startParams.text, '');
      expect(startParams.attachmentIds, ['att_1']);
      expect(startParams.toJson()['attachmentIds'], ['att_1']);
      expect(
        () => MobileStartRunParams.fromJson({
          'commandId': '11111111-1111-4111-8111-111111111111',
          'threadId': 'th_1',
          'text': '   ',
        }),
        throwsFormatException,
      );
      expect(
        () => MobileStartRunParams.fromJson({
          'commandId': '11111111-1111-4111-8111-111111111111',
          'threadId': 'th_1',
          'text': '',
          'attachmentIds': ['1', '2', '3', '4', '5', '6', '7'],
        }),
        throwsFormatException,
      );

      final draftParams = MobileDraftCreateParams.fromJson({
        'commandId': '22222222-2222-4222-8222-222222222222',
        'projectId': 'pr_1',
        'instanceId': 'claude',
        'permissionMode': 'full-access',
        'text': '',
        'attachmentIds': ['att_1'],
      });
      expect(draftParams.text, '');
      expect(draftParams.attachmentIds, ['att_1']);
      expect(draftParams.toJson()['attachmentIds'], ['att_1']);
      expect(
        () => MobileDraftCreateParams.fromJson({
          'commandId': '22222222-2222-4222-8222-222222222222',
          'projectId': 'pr_1',
          'instanceId': 'claude',
          'permissionMode': 'full-access',
          'text': '',
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'uploadAttachment uses 4-way concurrent sliding window, tracks monotonic progress, and verifies SHA-256',
    () async {
      final rpc = _AttachmentRpc();
      // 6 chunks: 5 full 32 KiB + 1 partial 5 KiB = 165 KiB.
      final payload = _fakePngBytes(5 * mobileAttachmentChunkBytes + 5 * 1024);
      final expectedSha = await publicKeyFingerprint(payload);
      final reassembled = Uint8List(payload.length);
      var receivedTotal = 0;
      var inFlight = 0;
      var peakInFlight = 0;
      final chunkGates = <int, Completer<void>>{};
      var chunkStartedCount = 0;
      final fourInFlight = Completer<void>();

      rpc.onCall = (method, params) async {
        switch (method) {
          case MobileAttachmentMethods.uploadStart:
            expect(params['uploadId'], 'up-fixed-1');
            expect(params['mimeType'], 'image/png');
            expect(params['fileName'], 'big.png');
            expect(params['totalBytes'], payload.length);
            expect(params['sha256'], expectedSha);
            expect(params['width'], 1200);
            expect(params['height'], 900);
            return {
              'uploadId': params['uploadId'],
              'chunkBytes': mobileAttachmentChunkBytes,
            };
          case MobileAttachmentMethods.uploadChunk:
            final offset = params['offset'] as int;
            final decoded = base64Decode(params['dataBase64'] as String);
            inFlight++;
            if (inFlight > peakInFlight) peakInFlight = inFlight;
            chunkStartedCount++;
            final gate = Completer<void>();
            chunkGates[offset] = gate;
            if (chunkStartedCount == 4 && !fourInFlight.isCompleted) {
              fourInFlight.complete();
            }
            // Complete out-of-order: hold first 4 until all 4 are in flight,
            // then release them in reverse order.
            if (chunkStartedCount <= 4) {
              await gate.future;
            }
            reassembled.setRange(offset, offset + decoded.length, decoded);
            receivedTotal += decoded.length;
            inFlight--;
            return {
              'uploadId': params['uploadId'],
              'receivedBytes': receivedTotal,
            };
          case MobileAttachmentMethods.uploadFinish:
            expect(params['uploadId'], 'up-fixed-1');
            return {
              'attachment': {
                'id': 'att_uploaded',
                'mimeType': 'image/png',
                'fileName': 'big.png',
                'sizeBytes': payload.length,
                'width': 1200,
                'height': 900,
              },
            };
          default:
            throw StateError('unexpected method: $method');
        }
      };

      final progress = <MobileAttachmentUploadProgress>[];
      final client = MobileAttachmentCommands(
        rpc,
        generateUploadId: () => 'up-fixed-1',
      );
      final uploadFuture = client.uploadAttachment(
        bytes: payload,
        mimeType: 'image/png',
        fileName: 'big.png',
        width: 1200,
        height: 900,
        onProgress: progress.add,
      );

      await fourInFlight.future;
      expect(peakInFlight, 4);
      // Release chunks in reverse order to verify out-of-order handling.
      for (final offset in chunkGates.keys.toList().reversed) {
        chunkGates[offset]!.complete();
      }

      final ref = await uploadFuture;
      expect(ref.id, 'att_uploaded');
      expect(ref.sizeBytes, payload.length);
      expect(reassembled, payload);
      expect(peakInFlight, 4);
      expect(progress, hasLength(6));
      for (var i = 1; i < progress.length; i++) {
        expect(
          progress[i].uploadedBytes,
          greaterThan(progress[i - 1].uploadedBytes),
        );
      }
      expect(progress.last.uploadedBytes, payload.length);
      expect(progress.last.totalBytes, payload.length);
      expect(progress.last.fraction, 1.0);

      await rpc.notificationsController.close();
    },
  );

  test(
    'uploadAttachment cancellation and chunk failure abort remaining chunks and call uploadCancel',
    () async {
      final rpc = _AttachmentRpc();
      final payload = _fakePngBytes(6 * mobileAttachmentChunkBytes);
      final token = MobileAttachmentCancelToken();
      final firstWaveGates = <Completer<void>>[];
      final waveReady = Completer<void>();

      rpc.onCall = (method, params) async {
        switch (method) {
          case MobileAttachmentMethods.uploadStart:
            return {
              'uploadId': params['uploadId'],
              'chunkBytes': mobileAttachmentChunkBytes,
            };
          case MobileAttachmentMethods.uploadChunk:
            final gate = Completer<void>();
            firstWaveGates.add(gate);
            if (firstWaveGates.length == 4 && !waveReady.isCompleted) {
              waveReady.complete();
            }
            await gate.future;
            return {'uploadId': params['uploadId'], 'receivedBytes': 0};
          case MobileAttachmentMethods.uploadCancel:
            return {'ok': true};
          default:
            throw StateError('unexpected method: $method');
        }
      };

      final client = MobileAttachmentCommands(
        rpc,
        generateUploadId: () => 'up-cancel-1',
      );
      final uploadFuture = client.uploadAttachment(
        bytes: payload,
        mimeType: 'image/png',
        cancelToken: token,
      );
      await waveReady.future;
      token.cancel();

      await expectLater(
        uploadFuture,
        throwsA(isA<MobileAttachmentUploadCancelled>()),
      );
      // Release suspended chunk calls so no test futures leak.
      for (final gate in firstWaveGates) {
        gate.complete();
      }

      final methodsCalled = rpc.calls.map((c) => c.$1).toList();
      expect(
        methodsCalled.where((m) => m == MobileAttachmentMethods.uploadCancel),
        hasLength(1),
      );
      expect(
        methodsCalled.where((m) => m == MobileAttachmentMethods.uploadFinish),
        isEmpty,
      );
      // Remaining 2 chunks (5th and 6th) were never dispatched.
      expect(
        methodsCalled.where((m) => m == MobileAttachmentMethods.uploadChunk),
        hasLength(4),
      );

      // Chunk failure also triggers uploadCancel and rethrows the original error.
      final failRpc = _AttachmentRpc();
      var chunkAttempt = 0;
      failRpc.onCall = (method, params) async {
        switch (method) {
          case MobileAttachmentMethods.uploadStart:
            return {
              'uploadId': params['uploadId'],
              'chunkBytes': mobileAttachmentChunkBytes,
            };
          case MobileAttachmentMethods.uploadChunk:
            chunkAttempt++;
            if (chunkAttempt == 2) {
              throw const MobileRpcFailure(
                MobileRpcProblem(code: 'INVALID_PARAMS', message: 'bad chunk'),
              );
            }
            return {'uploadId': params['uploadId'], 'receivedBytes': 32768};
          case MobileAttachmentMethods.uploadCancel:
            return {'ok': true};
          default:
            throw StateError('unexpected method: $method');
        }
      };
      final failClient = MobileAttachmentCommands(
        failRpc,
        generateUploadId: () => 'up-fail-1',
      );
      await expectLater(
        failClient.uploadAttachment(bytes: payload, mimeType: 'image/png'),
        throwsA(
          isA<MobileRpcFailure>().having(
            (e) => e.problem.code,
            'code',
            'INVALID_PARAMS',
          ),
        ),
      );
      expect(
        failRpc.calls.where(
          (c) => c.$1 == MobileAttachmentMethods.uploadCancel,
        ),
        hasLength(1),
      );

      await rpc.notificationsController.close();
      await failRpc.notificationsController.close();
    },
  );

  test(
    'readAttachmentThumb and readAttachmentFull reassemble single-frame and multi-chunk payloads',
    () async {
      final rpc = _AttachmentRpc();
      final thumbBytes = _fakePngBytes(12 * 1024);
      final fullBytes = _fakePngBytes(3 * mobileAttachmentChunkBytes + 777);

      rpc.onCall = (method, params) async {
        expect(method, MobileAttachmentMethods.read);
        final variant = params['variant'] as String;
        final source = variant == 'thumb' ? thumbBytes : fullBytes;
        final offset = (params['offset'] as int?) ?? 0;
        final end = variant == 'thumb'
            ? source.length
            : (offset + mobileAttachmentChunkBytes).clamp(0, source.length);
        final slice = Uint8List.sublistView(source, offset, end);
        return {
          'attachment': {
            'id': params['attachmentId'],
            'mimeType': 'image/png',
            'fileName': 'photo.png',
            'sizeBytes': fullBytes.length,
            'width': 1000,
            'height': 800,
          },
          'mimeType': variant == 'thumb' ? 'image/jpeg' : 'image/png',
          'dataBase64': base64Encode(slice),
          'totalBytes': source.length,
          if (end < source.length) 'nextOffset': end,
        };
      };

      final client = MobileAttachmentCommands(rpc);
      final thumb = await client.readAttachmentThumb('att_1', threadId: 'th_1');
      expect(thumb.mimeType, 'image/jpeg');
      expect(thumb.bytes, thumbBytes);
      expect(rpc.calls.single.$2.containsKey('offset'), isFalse);

      final progress = <(int, int)>[];
      final full = await client.readAttachmentFull(
        'att_1',
        threadId: 'th_1',
        onProgress: (received, total) => progress.add((received, total)),
      );
      expect(full.mimeType, 'image/png');
      expect(full.bytes, fullBytes);
      expect(progress, [
        (32768, fullBytes.length),
        (65536, fullBytes.length),
        (98304, fullBytes.length),
        (fullBytes.length, fullBytes.length),
      ]);

      await rpc.notificationsController.close();
    },
  );

  test(
    'degrades gracefully for legacy desktop without composer.attachments and rejects oversized images client-side',
    () async {
      final rpc = _AttachmentRpc();
      final legacy = MobileAttachmentCommands(rpc, supportsAttachments: false);
      final sample = _fakePngBytes(64);

      await expectLater(
        legacy.uploadAttachment(bytes: sample, mimeType: 'image/png'),
        throwsA(
          isA<ConnectionFailure>().having(
            (e) => e.code,
            'code',
            'update-desktop',
          ),
        ),
      );
      await expectLater(
        legacy.readAttachmentThumb('att_1'),
        throwsA(
          isA<ConnectionFailure>().having(
            (e) => e.code,
            'code',
            'update-desktop',
          ),
        ),
      );
      await expectLater(
        legacy.readAttachmentFull('att_1'),
        throwsA(
          isA<ConnectionFailure>().having(
            (e) => e.code,
            'code',
            'update-desktop',
          ),
        ),
      );
      expect(rpc.calls, isEmpty);

      final modern = MobileAttachmentCommands(rpc);
      await expectLater(
        modern.uploadAttachment(
          bytes: Uint8List(mobileMaxImageBytes + 1),
          mimeType: 'image/png',
        ),
        throwsRangeError,
      );
      await expectLater(
        modern.uploadAttachment(bytes: Uint8List(0), mimeType: 'image/png'),
        throwsRangeError,
      );
      await expectLater(
        modern.uploadAttachment(bytes: sample, mimeType: 'image/svg+xml'),
        throwsArgumentError,
      );
      expect(rpc.calls, isEmpty);

      await rpc.notificationsController.close();
    },
  );
}
