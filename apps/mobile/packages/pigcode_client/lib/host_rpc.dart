import 'dart:async';

import 'package:pigcode_transport/pigcode_transport.dart';

import 'sidebar_models.dart';

class MobileRpcFailure implements Exception {
  const MobileRpcFailure(this.problem);
  final MobileRpcProblem problem;
}

/// One receiver owns the encrypted link after authentication. Replies remain
/// associated with their caller even when sidebar notifications arrive between them.
class HostRpc {
  HostRpc(this._link) {
    unawaited(_receive());
  }

  final SecureLink _link;
  final _pending = <String, Completer<Object?>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  int _nextId = 0;

  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  Future<Object?> call(String method, Map<String, Object?> params) async {
    if (_notifications.isClosed) throw const ConnectionFailure('closed');
    final id = 'phone-${++_nextId}';
    final response = Completer<Object?>();
    _pending[id] = response;
    final result = response.future.timeout(const Duration(seconds: 8));
    unawaited(
      _link
          .send({
            'jsonrpc': '2.0',
            'id': id,
            'method': method,
            'params': params,
          })
          .catchError((Object error, StackTrace stack) {
            if (!response.isCompleted) response.completeError(error, stack);
          }),
    );
    try {
      return await result;
    } finally {
      _pending.remove(id);
    }
  }

  Future<void> _receive() async {
    try {
      while (true) {
        final value = await _link.receive(timeout: null);
        if (value['jsonrpc'] != '2.0') continue;
        final id = value['id'];
        if (id == null && value['method'] is String) {
          _notifications.add(value);
          continue;
        }
        final reply = _pending.remove(id);
        if (reply == null || reply.isCompleted) continue;
        _resolve(reply, value);
      }
    } on ConnectionFailure {
      for (final reply in _pending.values) {
        if (!reply.isCompleted) {
          reply.completeError(const ConnectionFailure('closed'));
        }
      }
      _pending.clear();
    } finally {
      unawaited(_notifications.close());
    }
  }

  void _resolve(Completer<Object?> reply, Map<String, dynamic> value) {
    try {
      if (value['error'] case final Map<String, dynamic> error) {
        reply.completeError(MobileRpcFailure(MobileRpcProblem.fromJson(error)));
      } else {
        reply.complete(value['result']);
      }
    } catch (error, stack) {
      reply.completeError(error, stack);
    }
  }
}
