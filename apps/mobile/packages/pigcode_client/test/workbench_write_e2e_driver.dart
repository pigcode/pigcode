import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/workbench-write.test.ts` 通过 stdin/stdout JSON-RPC 桥接的真实 Dart 联调驱动。
class _StdioHostRequests implements HostRequests {
  final _pending = <String, Completer<Object?>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  var _nextId = 0;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = 'dart-wbw-${++_nextId}';
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
  final workbench = MobileWorkbenchCommands(rpc);
  final writer = MobileWorkbenchWriteClient(rpc);

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'readFile':
          final chunk = await workbench.readFile(
            threadId: args['threadId'] as String,
            path: args['path'] as String,
            mode: (args['mode'] as String?) ?? 'text',
          );
          _replyCmd(cmdId, data: {'chunk': chunk.toJson()});
        case 'writeFile':
          final progress = <List<int>>[];
          final res = await writer.writeFile(
            threadId: args['threadId'] as String,
            path: args['path'] as String,
            text: args['text'] as String,
            expectedMtimeMs: (args['expectedMtimeMs'] as num?)?.toDouble(),
            eol: args['eol'] as String?,
            onProgress: (sent, total) => progress.add([sent, total]),
          );
          _replyCmd(
            cmdId,
            data: {'result': res.toJson(), 'progress': progress},
          );
        case 'createFile':
          final res = await writer.createFile(
            threadId: args['threadId'] as String,
            path: args['path'] as String,
            text: args['text'] as String?,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'renamePath':
          final res = await writer.renamePath(
            threadId: args['threadId'] as String,
            oldPath: args['oldPath'] as String,
            newPath: args['newPath'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'deletePath':
          final res = await writer.deletePath(
            threadId: args['threadId'] as String,
            path: args['path'] as String,
            recursive: (args['recursive'] as bool?) ?? false,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'listWorktrees':
          final res = await writer.listWorktrees(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'createWorktree':
          final res = await writer.createWorktree(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'worktree': res.toJson()});
        case 'switchWorktree':
          final res = await writer.switchWorktree(
            threadId: args['threadId'] as String,
            worktreeId: args['worktreeId'] as String,
          );
          _replyCmd(cmdId, data: {'worktree': res.toJson()});
        case 'removeWorktree':
          await writer.removeWorktree(threadId: args['threadId'] as String);
          _replyCmd(cmdId, data: {'removed': true});
        case 'listCheckpoints':
          final res = await writer.listCheckpoints(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'createCheckpoint':
          final res = await writer.createCheckpoint(
            threadId: args['threadId'] as String,
            label: args['label'] as String?,
          );
          _replyCmd(cmdId, data: {'checkpoint': res.toJson()});
        case 'restoreCheckpoint':
          final res = await writer.restoreCheckpoint(
            threadId: args['threadId'] as String,
            checkpointId: args['checkpointId'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'createPr':
          final res = await writer.createPr(
            threadId: args['threadId'] as String,
            title: args['title'] as String,
            body: args['body'] as String?,
            base: args['base'] as String?,
            draft: args['draft'] as bool?,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'commentPr':
          await writer.commentPr(
            threadId: args['threadId'] as String,
            body: args['body'] as String,
          );
          _replyCmd(cmdId, data: {'ok': true});
        case 'mergePr':
          final res = await writer.mergePr(
            threadId: args['threadId'] as String,
            method: MobilePrMergeMethod.fromWireValue(args['method'] as String),
            deleteBranch: args['deleteBranch'] as bool?,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'readyPr':
          final res = await writer.readyPr(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'closePr':
          final res = await writer.closePr(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
        case 'reopenPr':
          final res = await writer.reopenPr(
            threadId: args['threadId'] as String,
          );
          _replyCmd(cmdId, data: {'result': res.toJson()});
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
