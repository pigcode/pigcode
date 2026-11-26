import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/attachments.test.ts` 通过 stdin/stdout JSON-RPC 桥接的真实 Dart 联调驱动。
class _StdioHostRequests implements HostRequests {
  final _pending = <String, Completer<Object?>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  var _nextId = 0;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = 'dart-${++_nextId}';
    final completer = Completer<Object?>();
    _pending[id] = completer;
    stdout.writeln(
      jsonEncode({
        'dir': 'rpc_req',
        'id': id,
        'method': method,
        'params': params,
      }),
    );
    return completer.future.timeout(const Duration(seconds: 15));
  }

  void handleRpcResponse(Map<String, dynamic> message) {
    final id = message['id'] as String?;
    final completer = id == null ? null : _pending.remove(id);
    if (completer == null || completer.isCompleted) return;
    final error = message['error'];
    if (error is Map<String, dynamic>) {
      completer.completeError(
        MobileRpcFailure(MobileRpcProblem.fromJson(error)),
      );
    } else {
      completer.complete(message['result']);
    }
  }

  void handleNotification(Map<String, dynamic> message) {
    if (!_notifications.isClosed) _notifications.add(message);
  }

  Future<void> close() async {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.completeError(const ConnectionFailure('closed'));
      }
    }
    _pending.clear();
    await _notifications.close();
  }
}

void _replyCmd(String cmdId, {Object? data, String? error, String? code}) {
  stdout.writeln(
    jsonEncode({
      'dir': 'cmd_res',
      'cmdId': cmdId,
      'ok': error == null,
      'data': ?data,
      'error': ?error,
      'code': ?code,
    }),
  );
}

Future<void> main() async {
  final rpc = _StdioHostRequests();
  final attachments = MobileAttachmentCommands(rpc);
  final runs = MobileRunCommands(rpc);
  final drafts = MobileDraftCommands(rpc);
  final queue = MobileQueueCommands(rpc);
  final composer = MobileComposerCommands(rpc);

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'upload':
          final bytes = Uint8List.fromList(
            base64Decode(args['dataBase64'] as String),
          );
          final progress = <Map<String, Object>>[];
          final cancelAfterChunks = args['cancelAfterChunks'] as int?;
          final token = cancelAfterChunks == null
              ? null
              : MobileAttachmentCancelToken();
          final ref = await attachments.uploadAttachment(
            bytes: bytes,
            mimeType: args['mimeType'] as String,
            fileName: args['fileName'] as String?,
            width: args['width'] as int?,
            height: args['height'] as int?,
            cancelToken: token,
            onProgress: (p) {
              progress.add({
                'uploadedBytes': p.uploadedBytes,
                'totalBytes': p.totalBytes,
              });
              if (cancelAfterChunks != null &&
                  progress.length >= cancelAfterChunks) {
                token!.cancel();
              }
            },
          );
          _replyCmd(
            cmdId,
            data: {'attachment': ref.toJson(), 'progress': progress},
          );
        case 'readThumb':
          final result = await attachments.readAttachmentThumb(
            args['attachmentId'] as String,
            threadId: args['threadId'] as String?,
          );
          _replyCmd(
            cmdId,
            data: {
              'attachment': result.attachment.toJson(),
              'mimeType': result.mimeType,
              'dataBase64': base64Encode(result.bytes),
            },
          );
        case 'readFull':
          final progress = <List<int>>[];
          final result = await attachments.readAttachmentFull(
            args['attachmentId'] as String,
            threadId: args['threadId'] as String?,
            onProgress: (received, total) => progress.add([received, total]),
          );
          _replyCmd(
            cmdId,
            data: {
              'attachment': result.attachment.toJson(),
              'mimeType': result.mimeType,
              'dataBase64': base64Encode(result.bytes),
              'progress': progress,
            },
          );
        case 'startRun':
          final params = MobileStartRunParams.fromJson(
            args['params'] as Map<String, dynamic>,
          );
          final receipt = await runs.start(params);
          _replyCmd(cmdId, data: {'receipt': receipt.toJson()});
        case 'draftOptions':
          final options = await drafts.options();
          _replyCmd(
            cmdId,
            data: {
              'options': options.toJson(),
              'supportsImages': {
                for (final item in options.instances)
                  item.instanceId: item.supportsImages,
              },
            },
          );
        case 'createDraft':
          final params = MobileDraftCreateParams.fromJson(
            args['params'] as Map<String, dynamic>,
          );
          final receipt = await drafts.create(params);
          _replyCmd(cmdId, data: {'receipt': receipt.toJson()});
        case 'openTimeline':
          final timeline = await MobileTimeline.open(
            rpc,
            args['threadId'] as String,
          );
          try {
            final snap = timeline.snapshot!;
            final turns = timelineTurns(snap.events);
            _replyCmd(
              cmdId,
              data: {
                'events': snap.events.map((e) => e.toJson()).toList(),
                'composer': snap.composer?.toJson(),
                'composerSupportsImages': snap.composer?.supportsImages,
                'turns': turns
                    .map(
                      (t) => {
                        'userText': t.user?.text,
                        'userAttachments':
                            t.user?.attachments
                                .map((a) => a.toJson())
                                .toList() ??
                            const [],
                      },
                    )
                    .toList(),
              },
            );
          } finally {
            await timeline.close();
          }
        case 'switchAgent':
          final state = await composer.switchAgent(
            threadId: args['threadId'] as String,
            instanceId: args['instanceId'] as String,
            modelId: args['modelId'] as String?,
          );
          _replyCmd(
            cmdId,
            data: {
              'composer': state.toJson(),
              'supportsImages': state.supportsImages,
            },
          );
        case 'queueSnapshot':
          final snap = await queue.snapshot(args['threadId'] as String);
          _replyCmd(cmdId, data: {'snapshot': snap.toJson()});
        case 'queueWithdraw':
          final receipt = await queue.submit(
            QueueMethod.queueWithdraw,
            QueueWithdrawParams(
              threadId: args['threadId'] as String,
              commandId: args['commandId'] as String,
              messageId: args['messageId'] as String,
            ).toJson(),
          );
          _replyCmd(cmdId, data: {'receipt': receipt.toJson()});
        default:
          _replyCmd(cmdId, error: 'unknown action: $action');
      }
    } on MobileRpcFailure catch (error) {
      _replyCmd(cmdId, error: error.problem.message, code: error.problem.code);
    } on MobileAttachmentUploadCancelled {
      _replyCmd(cmdId, error: 'cancelled', code: 'UPLOAD_CANCELLED');
    } catch (error) {
      _replyCmd(cmdId, error: error.toString());
    }
  }

  try {
    await for (final line
        in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
      if (line.trim().isEmpty) continue;
      final msg = jsonDecode(line) as Map<String, dynamic>;
      switch (msg['dir']) {
        case 'rpc_res':
          rpc.handleRpcResponse(msg);
        case 'rpc_notify':
          rpc.handleNotification(msg['message'] as Map<String, dynamic>);
        case 'cmd':
          unawaited(runCommand(msg));
        case 'exit':
          return;
      }
    }
  } finally {
    await rpc.close();
  }
}
