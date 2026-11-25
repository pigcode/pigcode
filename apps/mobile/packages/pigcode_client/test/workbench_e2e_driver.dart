import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/workbench.test.ts` 通过 stdin/stdout JSON-RPC 桥接的真实 Dart 联调驱动。
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
  final workbench = MobileWorkbenchCommands(rpc);

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'listDirectory':
          final listing = await workbench.listDirectory(
            threadId: args['threadId'] as String,
            path: (args['path'] as String?) ?? '',
            offset: (args['offset'] as int?) ?? 0,
            limit: args['limit'] as int?,
          );
          _replyCmd(cmdId, data: {'listing': listing.toJson()});
        case 'readFile':
          final chunk = await workbench.readFile(
            threadId: args['threadId'] as String,
            path: args['path'] as String,
            offset: (args['offset'] as int?) ?? 0,
            length: args['length'] as int?,
            mode: (args['mode'] as String?) ?? 'auto',
            variant: (args['variant'] as String?) ?? 'full',
          );
          _replyCmd(cmdId, data: {'chunk': chunk.toJson()});
        case 'readFileAllText':
          final buffer = StringBuffer();
          var offset = 0;
          var chunkCount = 0;
          MobileFileChunk? lastChunk;
          while (true) {
            chunkCount++;
            final chunk = await workbench.readFile(
              threadId: args['threadId'] as String,
              path: args['path'] as String,
              offset: offset,
              mode: 'text',
            );
            lastChunk = chunk;
            buffer.write(chunk.text ?? '');
            final next = chunk.nextOffset;
            if (next == null) break;
            offset = next;
          }
          _replyCmd(
            cmdId,
            data: {
              'text': buffer.toString(),
              'chunkCount': chunkCount,
              'eol': lastChunk.eol,
              'languageHint': lastChunk.languageHint,
              'totalSize': lastChunk.totalSize,
              'truncated': lastChunk.truncated,
            },
          );
        case 'readFileImage':
          final progress = <List<int>>[];
          final image = await workbench.readFileImage(
            threadId: args['threadId'] as String,
            path: args['path'] as String,
            variant: (args['variant'] as String?) ?? 'full',
            onProgress: (received, total) => progress.add([received, total]),
          );
          _replyCmd(
            cmdId,
            data: {
              'path': image.path,
              'mimeType': image.mimeType,
              'totalSize': image.totalSize,
              'width': image.width,
              'height': image.height,
              'dataBase64': base64Encode(image.bytes),
              'progress': progress,
            },
          );
        case 'searchFiles':
          final result = await workbench.searchFiles(
            threadId: args['threadId'] as String,
            query: args['query'] as String,
            glob: args['glob'] as String?,
            limit: args['limit'] as int?,
          );
          _replyCmd(cmdId, data: {'result': result.toJson()});
        case 'getPrStatus':
          final result = await workbench.getPrStatus(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'result': result.toJson()});
        default:
          _replyCmd(cmdId, error: 'unknown action: $action');
      }
    } on MobileRpcFailure catch (error) {
      _replyCmd(
        cmdId,
        error: error.problem.message,
        code: error.problem.code,
      );
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
