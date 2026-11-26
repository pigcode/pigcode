import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// 仅供 `apps/host/src/mobile/manage-5b-dart-e2e.test.ts` 通过 stdin/stdout 桥接的真实 Dart 联调驱动。
class _StdioHostRequests implements HostRequests {
  final _pending = <String, Completer<Object?>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  var _nextId = 0;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = 'dart-5b-${++_nextId}';
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
  final schedules = MobileScheduleManageClient(
    rpc,
    supportsScheduleManage: true,
  );
  final plugins = MobilePluginManageClient(rpc, supportsPluginManage: true);

  Future<void> runCommand(Map<String, dynamic> msg) async {
    final cmdId = msg['cmdId'] as String;
    final action = msg['action'] as String;
    final args = (msg['args'] as Map<String, dynamic>?) ?? const {};
    try {
      switch (action) {
        case 'schedule.list':
          final result = await schedules.list();
          _replyCmd(cmdId, data: result.toJson());
        case 'schedule.create':
          final created = await schedules.create(
            projectId: args['projectId'] as String,
            title: args['title'] as String?,
            prompt: args['prompt'] as String,
            rule: MobileScheduleRule.fromJson(
              args['rule'] as Map<String, dynamic>,
            ),
            endsAt: args['endsAt'] as String?,
            enabled: args['enabled'] as bool?,
            execution: args['execution'] is Map<String, dynamic>
                ? MobileScheduleExecution.fromJson(
                    args['execution'] as Map<String, dynamic>,
                  )
                : null,
          );
          _replyCmd(
            cmdId,
            data: {
              'schedule': created.toJson(),
              'summary': describeScheduleRule(created.rule),
            },
          );
        case 'schedule.update':
          final updated = await schedules.update(
            id: args['id'] as String,
            title: args['title'] as String?,
            prompt: args['prompt'] as String?,
            rule: args['rule'] is Map<String, dynamic>
                ? MobileScheduleRule.fromJson(
                    args['rule'] as Map<String, dynamic>,
                  )
                : null,
            endsAt: args['endsAt'] as String?,
            clearEndsAt: args['clearEndsAt'] == true,
            enabled: args['enabled'] as bool?,
            execution: args['execution'] is Map<String, dynamic>
                ? MobileScheduleExecution.fromJson(
                    args['execution'] as Map<String, dynamic>,
                  )
                : null,
          );
          _replyCmd(
            cmdId,
            data: {
              'schedule': updated.toJson(),
              'summary': describeScheduleRule(updated.rule),
            },
          );
        case 'schedule.runNow':
          final res = await schedules.runNow(id: args['id'] as String);
          _replyCmd(cmdId, data: res.toJson());
        case 'schedule.runs':
          final page = await schedules.runs(
            id: args['id'] as String,
            limit: (args['limit'] as int?) ?? 20,
            offset: (args['offset'] as int?) ?? 0,
          );
          _replyCmd(cmdId, data: page.toJson());
        case 'schedule.deleteRun':
          final deleted = await schedules.deleteRun(id: args['id'] as String);
          _replyCmd(cmdId, data: {'deleted': deleted});
        case 'schedule.delete':
          final deleted = await schedules.delete(id: args['id'] as String);
          _replyCmd(cmdId, data: {'deleted': deleted});
        case 'plugin.list':
          final result = await plugins.list();
          _replyCmd(cmdId, data: result.toJson());
        case 'plugin.setEnabled':
          final plugin = await plugins.setEnabled(
            id: args['id'] as String,
            enabled: args['enabled'] as bool,
          );
          _replyCmd(cmdId, data: {'plugin': plugin.toJson()});
        case 'plugin.update':
          final plugin = await plugins.update(id: args['id'] as String);
          _replyCmd(cmdId, data: {'plugin': plugin.toJson()});
        case 'plugin.uninstall':
          await plugins.uninstall(id: args['id'] as String);
          _replyCmd(cmdId, data: {'uninstalled': true});
        case 'plugin.marketplaces':
          final result = await plugins.marketplaces();
          _replyCmd(cmdId, data: result.toJson());
        case 'plugin.refreshMarketplaces':
          final result = await plugins.refreshMarketplaces(
            id: args['id'] as String?,
            ifStale: args['ifStale'] as bool?,
          );
          _replyCmd(cmdId, data: result.toJson());
        case 'plugin.installFromMarketplace':
          final plugin = await plugins.installFromMarketplace(
            marketplace: args['marketplace'] as String,
            name: args['name'] as String,
          );
          _replyCmd(cmdId, data: {'plugin': plugin.toJson()});
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
