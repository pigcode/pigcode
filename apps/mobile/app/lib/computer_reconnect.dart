import 'dart:async';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

/// Owns the foreground transport for one saved computer.
class ComputerReconnect {
  ComputerReconnect({
    required this._dial,
    required this._observe,
    required this._onChange,
  });

  final Future<MobileConnection> Function() _dial;
  final Future<RelayStatusWatch> Function() _observe;
  final void Function() _onChange;
  MobileConnection? _connection;
  RelayStatusWatch? _watch;
  StreamSubscription<RelayComputerStatus>? _observation;
  Timer? _reconnect;
  Timer? _rewatch;
  int _generation = 0;
  int _retrySeconds = 1;
  bool _foreground = false;
  bool _disposed = false;
  bool _connecting = false;
  bool _terminal = false;
  String? _error;
  RelayComputerStatus? _status;

  MobileConnection? get connection => _connection;
  bool get connecting => _connecting;
  String? get error => _error;
  RelayComputerStatus? get status => _status;

  void start({required bool foreground, MobileConnection? initial}) {
    _foreground = foreground;
    if (!foreground) {
      if (initial != null) unawaited(initial.close());
      return;
    }
    if (initial != null) {
      _attach(initial, _generation);
    } else {
      unawaited(_connect(_generation));
    }
    unawaited(_watchStatus(_generation));
  }

  void setForeground(bool value) {
    if (_disposed || _foreground == value) return;
    _foreground = value;
    if (value) {
      retry();
    } else {
      _reset();
      _onChange();
    }
  }

  void retry() {
    if (_disposed || !_foreground) return;
    _reset();
    _terminal = false;
    _retrySeconds = 1;
    unawaited(_connect(_generation));
    unawaited(_watchStatus(_generation));
  }

  void dispose() {
    _disposed = true;
    _reset();
  }

  bool _current(int generation) =>
      !_disposed && _foreground && generation == _generation;

  void _reset() {
    _generation++;
    _reconnect?.cancel();
    _rewatch?.cancel();
    final connection = _connection;
    _connection = null;
    _connecting = false;
    if (connection != null) unawaited(connection.close());
    _stopWatching();
  }

  Future<void> _connect(int generation) async {
    if (!_current(generation) ||
        _connecting ||
        _connection != null ||
        _terminal) {
      return;
    }
    _connecting = true;
    _onChange();
    try {
      final connection = await _dial();
      if (_current(generation)) {
        _attach(connection, generation);
      } else {
        await connection.close();
      }
    } catch (error) {
      if (!_current(generation)) return;
      _connecting = false;
      _error = error is ConnectionFailure ? error.code : 'unreachable';
      _terminal = !const {
        'offline',
        'unreachable',
        'busy',
        'closed',
      }.contains(_error);
      _onChange();
      _scheduleConnect(generation);
    }
  }

  void _attach(MobileConnection connection, int generation) {
    _connection = connection;
    _connecting = false;
    _error = null;
    _retrySeconds = 1;
    void ended() {
      if (!_current(generation) || !identical(_connection, connection)) return;
      _connection = null;
      _error = 'closed';
      unawaited(connection.close());
      _onChange();
      _scheduleConnect(generation);
    }

    unawaited(
      connection.done.then((_) => ended(), onError: (Object _) => ended()),
    );
    _onChange();
  }

  void _scheduleConnect(int generation) {
    if (!_current(generation) || _terminal) return;
    _reconnect?.cancel();
    _reconnect = Timer(
      Duration(seconds: _retrySeconds),
      () => _connect(generation),
    );
    if (_retrySeconds < 8) _retrySeconds *= 2;
  }

  Future<void> _watchStatus(int generation) async {
    try {
      final watch = await _observe();
      if (!_current(generation)) {
        await watch.close();
        return;
      }
      _watch = watch;
      _observation = watch.updates.listen(
        (status) => _receiveStatus(generation, status),
        onError: (Object _) => _watchEnded(generation, watch),
        onDone: () => _watchEnded(generation, watch),
      );
      _receiveStatus(generation, watch.initial);
    } catch (error) {
      if (error is ConnectionFailure &&
          const {'incompatible', 'token-rejected'}.contains(error.code)) {
        return;
      }
      _scheduleWatch(generation);
    }
  }

  void _receiveStatus(int generation, RelayComputerStatus status) {
    if (!_current(generation)) return;
    final becameOnline =
        status.state == RelayComputerState.online &&
        _status?.state != RelayComputerState.online;
    _status = status;
    _onChange();
    if (becameOnline && !_connecting && _connection == null && !_terminal) {
      _reconnect?.cancel();
      unawaited(_connect(generation));
    }
  }

  void _watchEnded(int generation, RelayStatusWatch watch) {
    if (!_current(generation) || !identical(_watch, watch)) return;
    _stopWatching();
    _scheduleWatch(generation);
  }

  void _stopWatching() {
    final watch = _watch;
    final observation = _observation;
    _watch = null;
    _observation = null;
    if (watch != null) unawaited(watch.close());
    if (observation != null) unawaited(observation.cancel());
  }

  void _scheduleWatch(int generation) {
    if (!_current(generation)) return;
    _rewatch?.cancel();
    _rewatch = Timer(
      const Duration(seconds: 5),
      () => _watchStatus(generation),
    );
  }
}
