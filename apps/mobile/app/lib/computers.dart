import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:shared_preferences/shared_preferences.dart';

final computersProvider =
    AsyncNotifierProvider<Computers, List<ComputerProfile>>(Computers.new);

class Computers extends AsyncNotifier<List<ComputerProfile>> {
  static const _seedKey = 'pigcode.mobile.identity.v1';
  static const _computersKey = 'pigcode.mobile.computers.v1';
  static const _installation = 'pigcode.mobile.installed.v1';
  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );
  late NoiseIdentity identity;

  @override
  Future<List<ComputerProfile>> build() async {
    final preferences = SharedPreferencesAsync();
    // An iOS Keychain item may survive uninstall. The app sandbox marker does not.
    if (!(await preferences.getBool(_installation) ?? false)) {
      await _storage.delete(key: _seedKey);
      await _storage.delete(key: _computersKey);
      await preferences.setBool(_installation, true);
    }
    final seed = await _storage.read(key: _seedKey);
    identity = await NoiseIdentity.create(
      seed == null ? null : base64Url.decode(seed),
    );
    if (seed == null) {
      await _storage.write(
        key: _seedKey,
        value: base64Url.encode(identity.seed),
      );
    }
    final raw = await _storage.read(key: _computersKey);
    if (raw == null) return const [];
    final entries = jsonDecode(raw) as List<dynamic>;
    return List.unmodifiable(
      entries.map(
        (entry) => ComputerProfile.fromJson(entry as Map<String, dynamic>),
      ),
    );
  }

  Future<void> remember(ComputerProfile computer) async {
    final previous = state.requireValue;
    final next = List<ComputerProfile>.unmodifiable([
      ...previous.where((entry) => entry.computerKey != computer.computerKey),
      computer,
    ]);
    await _storage.write(
      key: _computersKey,
      value: jsonEncode(next.map((entry) => entry.toJson()).toList()),
    );
    state = AsyncData(next);
  }
}
