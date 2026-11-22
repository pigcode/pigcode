import 'dart:async';
import 'dart:convert';

import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_secure_storage.dart';

sealed class PendingRunCommand {
  const PendingRunCommand();

  MobileRunMethod get method;
  String get commandId;
  String get threadId;
  Map<String, Object?> toJson();
  Future<MobileRunReceipt> sendVia(MobileRunCommands api);

  bool matches(MobileRunReceipt receipt) =>
      receipt.commandId == commandId &&
      receipt.method == method &&
      receipt.threadId == threadId;

  static PendingRunCommand decode(MobileRunMethod method, String raw) {
    final data = jsonDecode(raw) as Map<String, dynamic>;
    return switch (method) {
      MobileRunMethod.runStart => PendingSend(
        MobileStartRunParams.fromJson(data),
      ),
      MobileRunMethod.runInterrupt => PendingStop(
        MobileInterruptRunParams.fromJson(data),
      ),
    };
  }
}

final class PendingSend extends PendingRunCommand {
  const PendingSend(this.params);

  final MobileStartRunParams params;

  @override
  MobileRunMethod get method => MobileRunMethod.runStart;
  @override
  String get commandId => params.commandId;
  @override
  String get threadId => params.threadId;
  @override
  Map<String, Object?> toJson() => params.toJson();
  @override
  Future<MobileRunReceipt> sendVia(MobileRunCommands api) => api.start(params);
}

final class PendingStop extends PendingRunCommand {
  const PendingStop(this.params);

  final MobileInterruptRunParams params;

  @override
  MobileRunMethod get method => MobileRunMethod.runInterrupt;
  @override
  String get commandId => params.commandId;
  @override
  String get threadId => params.threadId;
  @override
  Map<String, Object?> toJson() => params.toJson();
  @override
  Future<MobileRunReceipt> sendVia(MobileRunCommands api) =>
      api.interrupt(params);
  @override
  bool matches(MobileRunReceipt receipt) =>
      super.matches(receipt) && receipt.runId == params.runId;
}

/// Outgoing, unacknowledged operations are stored separately from editable drafts.
class RunCommandJournal {
  RunCommandJournal(MobileConnection connection, String threadId)
    : _computerKey = connection.computer.computerKey,
      _threadScope =
          '${connection.deviceId}.${base64Url.encode(utf8.encode(threadId))}';

  static const _prefix = 'pigcode.mobile.command.v1.';
  static final _locks = <String, Future<void>>{};
  final String _computerKey;
  final String _threadScope;

  String _key(MobileRunMethod method) =>
      '${_computerPrefix(_computerKey)}$_threadScope.${method.name}';

  static String _computerPrefix(String computerKey) => '$_prefix$computerKey.';

  static Future<T> _locked<T>(
    String computerKey,
    Future<T> Function() action,
  ) async {
    final previous = _locks[computerKey];
    final done = Completer<void>();
    final lock = done.future;
    _locks[computerKey] = lock;
    try {
      await previous;
      return await action();
    } finally {
      done.complete();
      if (identical(_locks[computerKey], lock)) _locks.remove(computerKey);
    }
  }

  static Future<void> _clear(String prefix) async {
    final entries = await mobileSecureStorage.readAll();
    final keys = entries.keys
        .where((key) => key.startsWith(prefix))
        .toList(growable: false);
    for (final key in keys) {
      await mobileSecureStorage.delete(key: key);
    }
  }

  static Future<void> clearForComputer(String computerKey) =>
      _locked(computerKey, () => _clear(_computerPrefix(computerKey)));

  static Future<void> clearOnInstall() => _clear(_prefix);

  Future<PendingRunCommand?> _read(String key, MobileRunMethod method) async {
    final raw = await mobileSecureStorage.read(key: key);
    return raw == null ? null : PendingRunCommand.decode(method, raw);
  }

  Future<PendingRunCommand?> read(MobileRunMethod method) {
    final key = _key(method);
    return _locked(_computerKey, () => _read(key, method));
  }

  /// An older connection must not replace an unresolved command in this slot.
  Future<PendingRunCommand> reserve(PendingRunCommand command) {
    final key = _key(command.method);
    return _locked(_computerKey, () async {
      final existing = await _read(key, command.method);
      if (existing != null) return existing;
      await mobileSecureStorage.write(
        key: key,
        value: jsonEncode(command.toJson()),
      );
      return command;
    });
  }

  Future<void> remove(
    PendingRunCommand command, {
    required bool Function() mounted,
  }) {
    final key = _key(command.method);
    return _locked(_computerKey, () async {
      final current = await _read(key, command.method);
      if (current?.commandId == command.commandId && mounted()) {
        await mobileSecureStorage.delete(key: key);
      }
    });
  }
}
