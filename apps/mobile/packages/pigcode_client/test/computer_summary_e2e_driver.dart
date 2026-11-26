import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/computer-summary-dart-e2e.test.ts` 通过 stdin/stdout 桥接的真实 Dart 联调驱动。
class _StdioHostRequests implements HostRequests {
  final _pending = <String, Completer<Object?>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  var _nextId = 0;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = 'dart-summary-${++_nextId}';
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

  void handleRpcMessage(Map<String, dynamic> message) {
    final id = message['id'] as String?;
    if (id == null && message['method'] is String) {
      _notifications.add(message);
      return;
    }
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

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'summary.fetch':
          final client = MobileSummaryClient(
            rpc,
            supportsComputerSummary:
                (args['supportsComputerSummary'] as bool?) ?? true,
            computerId: args['computerId'] as String,
            computerName: args['computerName'] as String,
          );
          final result = await client.fetch();
          _replyCmd(cmdId, data: result.toJson());
        default:
          _replyCmd(cmdId, error: 'unknown action: $action');
      }
    } on MobileRpcFailure catch (failure) {
      _replyCmd(
        cmdId,
        error: failure.problem.message,
        code: failure.problem.code,
      );
    } catch (error) {
      _replyCmd(cmdId, error: error.toString());
    }
  }

  final lines = stdin.transform(utf8.decoder).transform(const LineSplitter());
  await for (final line in lines) {
    if (line.trim().isEmpty) continue;
    final msg = jsonDecode(line) as Map<String, dynamic>;
    final dir = msg['dir'] as String?;
    if (dir == 'rpc_msg') {
      rpc.handleRpcMessage(msg['message'] as Map<String, dynamic>);
    } else if (dir == 'cmd') {
      unawaited(runCommand(msg));
    } else if (dir == 'shutdown') {
      break;
    }
  }

  await rpc.close();
}
