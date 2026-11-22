import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const mobileSecureStorage = FlutterSecureStorage(
  iOptions: IOSOptions(
    accessibility: KeychainAccessibility.unlocked_this_device,
  ),
);

final _locks = <String, Future<void>>{};
final _computerEpochs = <String, int>{};

/// Stops storage work from an obsolete connection after a computer is cleared.
class ComputerStorageLease {
  ComputerStorageLease(this.computerKey)
    : _epoch = _computerEpochs[computerKey] ?? 0;

  final String computerKey;
  final int _epoch;

  bool get valid => (_computerEpochs[computerKey] ?? 0) == _epoch;
}

void invalidateComputerStorage(String computerKey) {
  _computerEpochs[computerKey] = (_computerEpochs[computerKey] ?? 0) + 1;
}

Future<T> withComputerStorage<T>(
  String computerKey,
  Future<T> Function() use,
) async {
  final previous = _locks[computerKey];
  final done = Completer<void>();
  final lock = done.future;
  _locks[computerKey] = lock;
  try {
    await previous;
    return await use();
  } finally {
    done.complete();
    if (identical(_locks[computerKey], lock)) _locks.remove(computerKey);
  }
}

Future<void> deleteSecurePrefix(String prefix) async {
  final entries = await mobileSecureStorage.readAll();
  final keys = entries.keys.where((key) => key.startsWith(prefix)).toList();
  for (final key in keys) {
    await mobileSecureStorage.delete(key: key);
  }
}
