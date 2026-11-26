import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/terminal.test.ts` 通过 stdin/stdout 桥接的真实 Dart 联调驱动。
class _StdioHostRequests implements HostRequests {
  final _pending = <String, Completer<Object?>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  var _nextId = 0;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = 'dart-term-${++_nextId}';
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
  final client = MobileTerminalClient(rpc);
  final receivedOutputs = <Map<String, Object?>>[];
  final receivedExits = <Map<String, Object?>>[];
  final outSub = client.outputs.listen((event) {
    receivedOutputs.add({
      'terminalId': event.terminalId,
      'data': event.data,
      'cursor': event.cursor,
      'replay': event.replay,
      'overflow': event.overflow,
    });
  });
  final exitSub = client.exits.listen((event) {
    receivedExits.add({
      'terminalId': event.terminalId,
      'exitCode': event.exitCode,
    });
  });

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'list':
          final items = await client.list(threadId: args['threadId'] as String);
          _replyCmd(
            cmdId,
            data: {'terminals': items.map((e) => e.toJson()).toList()},
          );
        case 'open':
          final opened = await client.open(
            threadId: args['threadId'] as String,
            cols: args['cols'] as int,
            rows: args['rows'] as int,
          );
          _replyCmd(cmdId, data: {'terminal': opened.toJson()});
        case 'attach':
          final attached = await client.attach(
            threadId: args['threadId'] as String,
            terminalId: args['terminalId'] as String,
            afterCursor: args['afterCursor'] as int?,
            cols: args['cols'] as int?,
            rows: args['rows'] as int?,
          );
          _replyCmd(cmdId, data: attached.toJson());
        case 'detach':
          await client.detach(terminalId: args['terminalId'] as String);
          _replyCmd(cmdId, data: {'ok': true});
        case 'write':
          await client.write(
            terminalId: args['terminalId'] as String,
            data: args['data'] as String,
          );
          _replyCmd(cmdId, data: {'ok': true});
        case 'resize':
          final resized = await client.resize(
            terminalId: args['terminalId'] as String,
            cols: args['cols'] as int,
            rows: args['rows'] as int,
          );
          _replyCmd(cmdId, data: {'cols': resized.cols, 'rows': resized.rows});
        case 'close':
          await client.close(terminalId: args['terminalId'] as String);
          _replyCmd(cmdId, data: {'closed': true});
        case 'drainEvents':
          await Future<void>.delayed(const Duration(milliseconds: 40));
          final outs = List<Map<String, Object?>>.from(receivedOutputs);
          final ex = List<Map<String, Object?>>.from(receivedExits);
          receivedOutputs.clear();
          receivedExits.clear();
          _replyCmd(cmdId, data: {'outputs': outs, 'exits': ex});
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

  await outSub.cancel();
  await exitSub.cancel();
  await rpc.close();
}
