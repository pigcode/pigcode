import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/computers.dart';
import 'package:pigcode_mobile/main.dart' show PigcodeApp;
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final directory = await Directory.systemTemp.createTemp(
    'pigcode-reminder-smoke-',
  );
  final cache = OfflineCacheStore(directory: () async => directory);
  final computers = [_computer(1, '甲机'), _computer(2, '乙机')];
  for (final computer in computers) {
    final local = cache.open(computer.computerKey);
    await local.saveSidebar(
      SidebarSnapshot(
        projects: const [MobileProjectSummary(id: 'project', name: '通知验收')],
        threads: [
          _thread('recent', '${computer.name}最近会话', '2026-11-23T08:00:00.000Z'),
          _thread(
            'notice-thread',
            '${computer.name}通知会话',
            '2026-11-23T07:00:00.000Z',
          ),
        ],
        syncedAt: DateTime.utc(2026, 11, 23, 8),
      ),
    );
    await local.saveTimeline(
      'notice-thread',
      TimelineSnapshot(
        events: [
          MobileTimelineEvent(
            seq: 1,
            kind: MobileTimelineKind.messageAssistant,
            createdAt: '2026-11-23T07:01:00.000Z',
            text: '${computer.name}目标历史',
          ),
        ],
        through: 1,
        cursor: 1,
        nextBefore: null,
        live: null,
      ),
      DateTime.utc(2026, 11, 23, 8),
    );
  }
  runApp(
    ProviderScope(
      overrides: [
        computersProvider.overrideWith(() => _FixtureComputers(computers)),
        offlineCacheProvider.overrideWithValue(cache),
      ],
      child: const PigcodeApp(),
    ),
  );
}

ComputerProfile _computer(int seed, String name) => ComputerProfile(
  address: 'wss://127.0.0.1:1/ws/v1/connect',
  token: 'local-notification-fixture',
  computerKey: base64Url.encode(List<int>.filled(32, seed)).replaceAll('=', ''),
  name: name,
);

MobileThreadSummary _thread(String id, String title, String updatedAt) =>
    MobileThreadSummary(
      id: id,
      projectId: 'project',
      title: title,
      updatedAt: updatedAt,
      archived: false,
      pinned: false,
      status: MobileThreadStatus.idle,
      unread: false,
    );

class _FixtureComputers extends Computers {
  _FixtureComputers(this.profiles);
  final List<ComputerProfile> profiles;

  @override
  Future<List<ComputerProfile>> build() async {
    identity = await NoiseIdentity.create(List<int>.filled(32, 3));
    deviceId = await publicKeyFingerprint(identity.publicKey);
    deviceNumber = deviceId.substring(0, 8).toUpperCase();
    return profiles;
  }
}
