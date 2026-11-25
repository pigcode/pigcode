import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'attachments/attachment_cache.dart';
import 'mobile_secure_storage.dart';
import 'mobile_command_journal.dart';
import 'local_drafts.dart';
import 'offline_cache.dart';

final computersProvider =
    AsyncNotifierProvider<Computers, List<ComputerProfile>>(Computers.new);

class Computers extends AsyncNotifier<List<ComputerProfile>> {
  Computers({this._preferences});

  static const _seedKey = 'pigcode.mobile.identity.v1';
  static const _computersKey = 'pigcode.mobile.computers.v1';
  static const _cleanupKey = 'pigcode.mobile.computers.cleanup.v1';
  static const _installation = 'pigcode.mobile.installed.v1';
  final SharedPreferencesAsync? _preferences;
  late NoiseIdentity identity;
  late String deviceNumber;
  late String deviceId;

  @override
  Future<List<ComputerProfile>> build() async {
    final preferences = _preferences ?? SharedPreferencesAsync();
    // An iOS Keychain item may survive uninstall. The app sandbox marker does not.
    if (!(await preferences.getBool(_installation) ?? false)) {
      await mobileSecureStorage.delete(key: _seedKey);
      await mobileSecureStorage.delete(key: _computersKey);
      await mobileSecureStorage.delete(key: _cleanupKey);
      await MobileCommandJournal.clearOnInstall();
      await clearDraftsOnInstall();
      await ref.read(offlineCacheProvider).clearOnInstall();
      await ref.read(attachmentCacheProvider).clearAllAttachmentCaches();
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
    deviceId = await publicKeyFingerprint(identity.publicKey);
    deviceNumber = deviceId.substring(0, 8).toUpperCase();
    return withComputerStorage(_computersKey, () async {
      final raw = await mobileSecureStorage.read(key: _computersKey);
      final entries = raw == null ? const [] : jsonDecode(raw) as List<dynamic>;
      final all = entries
          .map(
            (entry) => ComputerProfile.fromJson(entry as Map<String, dynamic>),
          )
          .toList();
      final pending = await _pendingCleanup();
      final available = List<ComputerProfile>.unmodifiable(
        all.where((computer) => !pending.contains(computer.computerKey)),
      );
      final saved =
          available.length == all.length || await _tryPersist(available);
      for (final key in pending.toList()) {
        await _finishCleanup(key, pending, clearIntent: saved);
      }
      return available;
    });
  }

  Future<void> remember(ComputerProfile computer) => withComputerStorage(
    _computersKey,
    () async {
      final next = [...state.requireValue];
      final index = next.indexWhere(
        (entry) => entry.computerKey == computer.computerKey,
      );
      if (index < 0) {
        await _clearComputerData(computer.computerKey);
        next.add(computer);
      } else {
        next[index] = computer;
      }
      await _save(next);
      if (index < 0) {
        final pending = await _pendingCleanup();
        if (pending.remove(computer.computerKey)) await _writeCleanup(pending);
      }
    },
  );

  Future<bool> forget(ComputerProfile computer) async {
    final key = computer.computerKey;
    invalidateComputerStorage(key);
    return withComputerStorage(_computersKey, () async {
      final pending = (await _pendingCleanup())..add(key);
      await _writeCleanup(pending);
      final remaining = List<ComputerProfile>.unmodifiable(
        state.requireValue.where((entry) => entry.computerKey != key),
      );
      state = AsyncData(remaining);
      final saved = await _tryPersist(remaining);
      final cleaned = await _finishCleanup(key, pending, clearIntent: saved);
      return saved && cleaned;
    });
  }

  Future<Set<String>> _pendingCleanup() async {
    final raw = await mobileSecureStorage.read(key: _cleanupKey);
    return raw == null
        ? <String>{}
        : (jsonDecode(raw) as List).cast<String>().toSet();
  }

  Future<void> _writeCleanup(Set<String> keys) => keys.isEmpty
      ? mobileSecureStorage.delete(key: _cleanupKey)
      : mobileSecureStorage.write(
          key: _cleanupKey,
          value: jsonEncode(keys.toList()),
        );

  Future<bool> _finishCleanup(
    String key,
    Set<String> pending, {
    required bool clearIntent,
  }) async {
    try {
      await _clearComputerData(key);
      if (clearIntent) {
        await _writeCleanup({...pending}..remove(key));
        pending.remove(key);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<bool> _tryPersist(List<ComputerProfile> profiles) async {
    try {
      await _persist(profiles);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _clearComputerData(String key) async {
    await Future.wait([
      ref.read(offlineCacheProvider).clear(key),
      ref.read(attachmentCacheProvider).clearComputerAttachmentCache(key),
      MobileCommandJournal.clearForComputer(key),
      clearComputerDrafts(key),
    ]);
  }

  Future<void> _save(Iterable<ComputerProfile> entries) async {
    final next = List<ComputerProfile>.unmodifiable(entries);
    await _persist(next);
    state = AsyncData(next);
  }

  Future<void> _persist(List<ComputerProfile> entries) =>
      mobileSecureStorage.write(
        key: _computersKey,
        value: jsonEncode(entries.map((entry) => entry.toJson()).toList()),
      );
}
