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
      _lease = ComputerStorageLease(connection.computer.computerKey),
      _threadPrefix =
          '${_computerPrefix(connection.computer.computerKey)}${connection.deviceId}.${base64Url.encode(utf8.encode(threadId))}.';

  static const _prefix = 'pigcode.mobile.command.v1.';
  final String _computerKey;
  final ComputerStorageLease _lease;
  final String _threadPrefix;
  final T Function(String slot, Map<String, dynamic> data) decode;

  static String _computerPrefix(String computerKey) => '$_prefix$computerKey.';

  static Future<void> clearForComputer(String computerKey) {
    invalidateComputerStorage(computerKey);
    return withComputerStorage(
      computerKey,
      () => deleteSecurePrefix(_computerPrefix(computerKey)),
    );
  }

  static Future<void> clearOnInstall() => deleteSecurePrefix(_prefix);

  T _parse(String slot, String value) =>
      decode(slot, jsonDecode(value) as Map<String, dynamic>);

  Future<T?> _read(String slot) async {
    final raw = await mobileSecureStorage.read(key: '$_threadPrefix$slot');
    return raw == null ? null : _parse(slot, raw);
  }

  Future<T?> read(String slot) => withComputerStorage(_computerKey, () async {
    if (!_lease.valid) return null;
    final result = await _read(slot);
    return _lease.valid ? result : null;
  });

  Future<List<T>> readMatching(String prefix) =>
      withComputerStorage(_computerKey, () async {
        if (!_lease.valid) return [];
        final entries = await mobileSecureStorage.readAll();
        if (!_lease.valid) return [];
        return [
          for (final entry in entries.entries)
            if (entry.key.startsWith('$_threadPrefix$prefix'))
              _parse(entry.key.substring(_threadPrefix.length), entry.value),
        ];
      });

  Future<T> reserve(T command) => withComputerStorage(_computerKey, () async {
    if (!_lease.valid) throw StateError('Computer authorization changed');
    final existing = await _read(command.slot);
    if (!_lease.valid) throw StateError('Computer authorization changed');
    if (existing != null) return existing;
    await mobileSecureStorage.write(
      key: '$_threadPrefix${command.slot}',
      value: jsonEncode(command.toJson()),
    );
    return command;
  });

  Future<bool> remove(
    T command, {
    required bool Function() mounted,
    Future<void> Function()? beforeRemove,
  }) => withComputerStorage(_computerKey, () async {
    if (!_lease.valid) return false;
    final current = await _read(command.slot);
    if (current?.commandId == command.commandId && mounted() && _lease.valid) {
      final commit = beforeRemove;
      if (commit != null) await commit();
      if (!mounted() || !_lease.valid) return false;
      await mobileSecureStorage.delete(key: '$_threadPrefix${command.slot}');
      return true;
    }
    return false;
  });
}
