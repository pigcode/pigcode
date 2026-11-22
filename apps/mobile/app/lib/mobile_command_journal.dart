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
  final String _computerKey;
  final String _threadPrefix;
  final T Function(String slot, Map<String, dynamic> data) decode;

  static String _computerPrefix(String computerKey) => '$_prefix$computerKey.';

  static Future<void> clearForComputer(String computerKey) =>
      withComputerStorage(
        computerKey,
        () => deleteSecurePrefix(_computerPrefix(computerKey)),
      );

  static Future<void> clearOnInstall() => deleteSecurePrefix(_prefix);

  T _parse(String slot, String value) =>
      decode(slot, jsonDecode(value) as Map<String, dynamic>);

  Future<T?> _read(String slot) async {
    final raw = await mobileSecureStorage.read(key: '$_threadPrefix$slot');
    return raw == null ? null : _parse(slot, raw);
  }

  Future<T?> read(String slot) =>
      withComputerStorage(_computerKey, () => _read(slot));

  Future<List<T>> readMatching(String prefix) =>
      withComputerStorage(_computerKey, () async {
        final entries = await mobileSecureStorage.readAll();
        return [
          for (final entry in entries.entries)
            if (entry.key.startsWith('$_threadPrefix$prefix'))
              _parse(entry.key.substring(_threadPrefix.length), entry.value),
        ];
      });

  Future<T> reserve(T command) => withComputerStorage(_computerKey, () async {
    final existing = await _read(command.slot);
    if (existing != null) return existing;
    await mobileSecureStorage.write(
      key: '$_threadPrefix${command.slot}',
      value: jsonEncode(command.toJson()),
    );
    return command;
  });

  Future<void> remove(T command, {required bool Function() mounted}) =>
      withComputerStorage(_computerKey, () async {
        final current = await _read(command.slot);
        if (current?.commandId == command.commandId && mounted()) {
          await mobileSecureStorage.delete(
            key: '$_threadPrefix${command.slot}',
          );
        }
      });
}
