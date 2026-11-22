import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const mobileSecureStorage = FlutterSecureStorage(
  iOptions: IOSOptions(
    accessibility: KeychainAccessibility.unlocked_this_device,
  ),
);

final _locks = <String, Future<void>>{};

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
