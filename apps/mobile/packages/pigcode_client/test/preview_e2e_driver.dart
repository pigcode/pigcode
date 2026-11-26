import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/preview.test.ts` 通过 stdin/stdout JSON-RPC 桥接的真实 Dart 联调驱动。
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
    return completer.future.timeout(const Duration(seconds: 20));
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
  final preview = MobilePreviewCommands(rpc);

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'getStatus':
          final status = await preview.getStatus(
            threadId: args['threadId'] as String?,
          );
          _replyCmd(cmdId, data: {'status': status.toJson()});
        case 'fetch':
          final rawHeaders = args['headers'] as Map<String, dynamic>?;
          final bodyBase64 = args['bodyBase64'] as String?;
          final res = await preview.fetch(
            url: args['url'] as String,
            method: (args['method'] as String?) ?? 'GET',
            headers: rawHeaders?.map(
              (key, value) => MapEntry(key, value as String),
            ),
            bodyBytes: bodyBase64 == null
                ? null
                : Uint8List.fromList(base64Decode(bodyBase64)),
            requestId: args['requestId'] as String?,
          );
          _replyCmd(cmdId, data: {'response': res.toJson()});
        case 'fetchAndReadAll':
          final rawHeaders = args['headers'] as Map<String, dynamic>?;
          final bodyBase64 = args['bodyBase64'] as String?;
          final res = await preview.fetch(
            url: args['url'] as String,
            method: (args['method'] as String?) ?? 'GET',
            headers: rawHeaders?.map(
              (key, value) => MapEntry(key, value as String),
            ),
            bodyBytes: bodyBase64 == null
                ? null
                : Uint8List.fromList(base64Decode(bodyBase64)),
            requestId: args['requestId'] as String?,
          );
          Uint8List bodyBytes;
          var chunkCount = 0;
          if (!res.hasMore && res.bodyBase64 != null) {
            bodyBytes = res.inlineBodyBytes!;
          } else {
            final builder = BytesBuilder(copy: false);
            await for (final chunk in preview.streamBody(res.bodyStreamId!)) {
              chunkCount++;
              builder.add(chunk);
            }
            bodyBytes = builder.takeBytes();
          }
          _replyCmd(
            cmdId,
            data: {
              'response': res.toJson(),
              'bodyBase64': base64Encode(bodyBytes),
              'chunkCount': chunkCount,
            },
          );
        case 'readBody':
          final chunk = await preview.readBody(
            bodyStreamId: args['bodyStreamId'] as String,
            offset: args['offset'] as int,
            length: args['length'] as int?,
          );
          _replyCmd(cmdId, data: {'chunk': chunk.toJson()});
        case 'closeBody':
          await preview.closeBody(args['bodyStreamId'] as String);
          _replyCmd(cmdId, data: {'ok': true});
        default:
          _replyCmd(cmdId, error: 'unknown action: $action');
      }
    } on MobileRpcFailure catch (error) {
      _replyCmd(cmdId, error: error.problem.message, code: error.problem.code);
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
