import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/computers.dart';
import 'package:pigcode_mobile/local_drafts.dart';
import 'package:pigcode_mobile/mobile_secure_storage.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Installed implements SharedPreferencesAsync {
  @override
  Future<bool?> getBool(String key) async => true;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

ComputerProfile _computer(int seed) => ComputerProfile(
  address: 'wss://localhost/ws/v1/connect',
  token: 'fixture',
  computerKey: base64Url.encode(List<int>.filled(32, seed)).replaceAll('=', ''),
  name: '电脑 $seed',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'startup completes an interrupted removal before loading profiles',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'pigcode-cleanup-test-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final cache = OfflineCacheStore(directory: () async => directory);
      final removed = _computer(1);
      final kept = _computer(2);
      for (final computer in [removed, kept]) {
        await cache
            .open(computer.computerKey)
            .saveSidebar(
              SidebarSnapshot(
                projects: [
                  MobileProjectSummary(id: 'project', name: computer.name),
                ],
                threads: const [],
                syncedAt: DateTime.utc(2026, 11, 23),
              ),
            );
        await ThreadDraftStorage(
          computer.computerKey,
          'thread',
        ).save(computer.name);
      }
      await mobileSecureStorage.write(
        key: 'pigcode.mobile.computers.v1',
        value: jsonEncode([removed.toJson(), kept.toJson()]),
      );
      // A shutdown after writing the intent and before updating the profile list.
      await mobileSecureStorage.write(
        key: 'pigcode.mobile.computers.cleanup.v1',
        value: jsonEncode([removed.computerKey]),
      );
      final container = ProviderContainer(
        overrides: [
          offlineCacheProvider.overrideWithValue(cache),
          computersProvider.overrideWith(
            () => Computers(preferences: _Installed()),
          ),
        ],
      );
      addTearDown(container.dispose);
      final visible = await container.read(computersProvider.future);
      expect(visible.map((computer) => computer.computerKey), [
        kept.computerKey,
      ]);
      expect(await cache.open(removed.computerKey).readSidebar(), isNull);
      expect(
        await ThreadDraftStorage(removed.computerKey, 'thread').read(),
        isEmpty,
      );
      expect(await cache.open(kept.computerKey).readSidebar(), isNotNull);
      expect(
        await ThreadDraftStorage(kept.computerKey, 'thread').read(),
        kept.name,
      );
      expect(
        await mobileSecureStorage.read(
          key: 'pigcode.mobile.computers.cleanup.v1',
        ),
        isNull,
      );
    },
  );
}
