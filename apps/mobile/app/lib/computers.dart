import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'mobile_secure_storage.dart';
import 'mobile_command_journal.dart';

final computersProvider =
    AsyncNotifierProvider<Computers, List<ComputerProfile>>(Computers.new);

class Computers extends AsyncNotifier<List<ComputerProfile>> {
  static const _seedKey = 'pigcode.mobile.identity.v1';
  static const _computersKey = 'pigcode.mobile.computers.v1';
  static const _installation = 'pigcode.mobile.installed.v1';
  late NoiseIdentity identity;
  late String deviceNumber;

  @override
  Future<List<ComputerProfile>> build() async {
    final preferences = SharedPreferencesAsync();
    // An iOS Keychain item may survive uninstall. The app sandbox marker does not.
    if (!(await preferences.getBool(_installation) ?? false)) {
      await mobileSecureStorage.delete(key: _seedKey);
      await mobileSecureStorage.delete(key: _computersKey);
      await MobileCommandJournal.clearOnInstall();
      await preferences.setBool(_installation, true);
    }
    final seed = await mobileSecureStorage.read(key: _seedKey);
    identity = await NoiseIdentity.create(
      seed == null ? null : base64Url.decode(seed),
    );
    if (seed == null) {
      await mobileSecureStorage.write(
        key: _seedKey,
        value: base64Url.encode(identity.seed),
      );
    }
    deviceNumber = (await publicKeyFingerprint(
      identity.publicKey,
    )).substring(0, 8).toUpperCase();
    final raw = await mobileSecureStorage.read(key: _computersKey);
    if (raw == null) return const [];
    final entries = jsonDecode(raw) as List<dynamic>;
    return List.unmodifiable(
      entries.map(
        (entry) => ComputerProfile.fromJson(entry as Map<String, dynamic>),
      ),
    );
  }

  Future<void> remember(ComputerProfile computer) async {
    final next = [...state.requireValue];
    final index = next.indexWhere(
      (entry) => entry.computerKey == computer.computerKey,
    );
    if (index < 0) {
      await MobileCommandJournal.clearForComputer(computer.computerKey);
      next.add(computer);
    } else {
      next[index] = computer;
    }
    return _save(next);
  }

  Future<bool> forget(ComputerProfile computer) async {
    await _save(
      state.requireValue.where(
        (entry) => entry.computerKey != computer.computerKey,
      ),
    );
    try {
      await MobileCommandJournal.clearForComputer(computer.computerKey);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _save(Iterable<ComputerProfile> entries) async {
    final next = List<ComputerProfile>.unmodifiable(entries);
    await mobileSecureStorage.write(
      key: _computersKey,
      value: jsonEncode(next.map((entry) => entry.toJson()).toList()),
    );
    state = AsyncData(next);
  }
}
