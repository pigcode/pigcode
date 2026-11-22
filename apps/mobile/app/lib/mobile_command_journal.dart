import 'dart:async';
import 'dart:convert';

import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_secure_storage.dart';

abstract interface class JournalCommand {
  String get commandId;
  String get slot;
  Map<String, Object?> toJson();
}

/// Stores commands that the user submitted and whose result is still unknown.
class MobileCommandJournal<T extends JournalCommand> {
  MobileCommandJournal(
    MobileConnection connection,
    String threadId,
    this.decode,
  ) : _computerKey = connection.computer.computerKey,
      _threadPrefix =
          '${_computerPrefix(connection.computer.computerKey)}${connection.deviceId}.${base64Url.encode(utf8.encode(threadId))}.';

  static const _prefix = 'pigcode.mobile.command.v1.';
  static final _locks = <String, Future<void>>{};
  final String _computerKey;
  final String _threadPrefix;
  final T Function(String slot, Map<String, dynamic> data) decode;

  static String _computerPrefix(String computerKey) => '$_prefix$computerKey.';

  static Future<R> _locked<R>(
    String computerKey,
    Future<R> Function() action,
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
    final keys = entries.keys.where((key) => key.startsWith(prefix)).toList();
    for (final key in keys) {
      await mobileSecureStorage.delete(key: key);
    }
  }

  static Future<void> clearForComputer(String computerKey) =>
      _locked(computerKey, () => _clear(_computerPrefix(computerKey)));

  static Future<void> clearOnInstall() => _clear(_prefix);

  T _parse(String slot, String value) =>
      decode(slot, jsonDecode(value) as Map<String, dynamic>);

  Future<T?> _read(String slot) async {
    final raw = await mobileSecureStorage.read(key: '$_threadPrefix$slot');
    return raw == null ? null : _parse(slot, raw);
  }

  Future<T?> read(String slot) => _locked(_computerKey, () => _read(slot));

  Future<List<T>> readMatching(String prefix) =>
      _locked(_computerKey, () async {
        final entries = await mobileSecureStorage.readAll();
        return [
          for (final entry in entries.entries)
            if (entry.key.startsWith('$_threadPrefix$prefix'))
              _parse(entry.key.substring(_threadPrefix.length), entry.value),
        ];
      });

  Future<T> reserve(T command) => _locked(_computerKey, () async {
    final existing = await _read(command.slot);
    if (existing != null) return existing;
    await mobileSecureStorage.write(
      key: '$_threadPrefix${command.slot}',
      value: jsonEncode(command.toJson()),
    );
    return command;
  });

  Future<void> remove(T command, {required bool Function() mounted}) => _locked(
    _computerKey,
    () async {
      final current = await _read(command.slot);
      if (current?.commandId == command.commandId && mounted()) {
        await mobileSecureStorage.delete(key: '$_threadPrefix${command.slot}');
      }
    },
  );
}
