import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/offline_cache.dart';

SidebarSnapshot sidebar(String title) => SidebarSnapshot(
  projects: [MobileProjectSummary(id: 'project', name: title)],
  threads: const [],
  syncedAt: DateTime.utc(2026, 11, 23, 6),
);

TimelineSnapshot history(int length, {int chars = 0}) => TimelineSnapshot(
  events: [
    for (var seq = 1; seq <= length; seq++)
      MobileTimelineEvent(
        seq: seq,
        kind: MobileTimelineKind.messageAssistant,
        createdAt: '2026-11-23T00:00:00.000Z',
        text: '第 $seq 条${'字' * chars}',
      ),
  ],
  through: length,
  cursor: length,
  nextBefore: null,
  live: null,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'cold start reads isolated encrypted summaries and an old writer cannot undo erasure',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pigcode-offline-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      final store = OfflineCacheStore(directory: () async => root);
      final first = store.open('computer-a');
      await first.saveSidebar(sidebar('仅在甲电脑出现的项目'));
      await store.open('computer-b').saveSidebar(sidebar('仅在乙电脑出现的项目'));

      final restarted = OfflineCacheStore(directory: () async => root);
      final restored = await restarted.open('computer-a').readSidebar();
      expect(restored?.projects.single.name, '仅在甲电脑出现的项目');
      expect(restored?.syncedAt, DateTime.utc(2026, 11, 23, 6));
      expect(
        (await restarted.open('computer-b').readSidebar())
            ?.projects
            .single
            .name,
        '仅在乙电脑出现的项目',
      );
      final files = await root
          .list()
          .where((entry) => entry is File)
          .cast<File>()
          .toList();
      expect(files, hasLength(2));
      for (final file in files) {
        final disk = utf8.decode(
          await file.readAsBytes(),
          allowMalformed: true,
        );
        expect(disk, isNot(contains('仅在')));
      }

      final previous = restarted.open('computer-a');
      final erasing = restarted.clear('computer-a');
      await previous.saveSidebar(sidebar('迟到的响应'));
      await erasing;
      expect(await restarted.open('computer-a').readSidebar(), isNull);
      expect(await restarted.open('computer-b').readSidebar(), isNotNull);
      expect((await const FlutterSecureStorage().readAll()), hasLength(1));
    },
  );

  test(
    'keeps the list and evicts the least recently opened timeline',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pigcode-cache-recency-',
      );
      addTearDown(() => root.delete(recursive: true));
      final store = OfflineCacheStore(directory: () async => root);
      final cache = store.open('computer');
      final now = DateTime.utc(2026, 11, 23);
      await cache.saveSidebar(sidebar('最近列表'));
      for (var index = 0; index < 31; index++) {
        await cache.saveTimeline('$index', history(1), now);
      }
      await cache.readTimeline('0');
      await cache.saveTimeline('31', history(1), now);
      final restarted = OfflineCacheStore(
        directory: () async => root,
      ).open('computer');
      expect(await restarted.readTimeline('0'), isNotNull);
      expect(await restarted.readTimeline('1'), isNull);
      expect((await restarted.readSidebar())?.projects.single.name, '最近列表');
    },
  );

  test(
    'an unreadable temporary destination does not prevent reading saved history',
    () async {
      final root = await Directory.systemTemp.createTemp('pigcode-cache-read-');
      addTearDown(() => root.delete(recursive: true));
      final cache = OfflineCacheStore(
        directory: () async => root,
      ).open('computer');
      await cache.saveTimeline(
        'thread',
        history(1),
        DateTime.utc(2026, 11, 23),
      );
      final file = (await root.list().toList()).single;
      await Directory('${file.path}.tmp').create();
      expect(
        (await cache.readTimeline('thread'))?.snapshot.events.single.text,
        '第 1 条',
      );
    },
  );

  test(
    'retains a recent event window and stays within the encoded file budget',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pigcode-cache-budget-',
      );
      addTearDown(() => root.delete(recursive: true));
      final store = OfflineCacheStore(directory: () async => root);
      final cache = store.open('computer');
      final now = DateTime.utc(2026, 11, 23);
      final long = history(36, chars: 3500);
      await cache.saveSidebar(sidebar('需要保留的摘要'));
      for (var index = 0; index < 12; index++) {
        await cache.saveTimeline('$index', long, now);
      }
      final latest = (await cache.readTimeline('11'))!;
      expect(latest.snapshot.events.first.seq, greaterThan(1));
      expect(latest.snapshot.events.last.seq, 36);
      expect(latest.snapshot.nextBefore, latest.snapshot.events.first.seq);
      expect(latest.snapshot.cursor, 36);
      expect(latest.snapshot.live, isNull);
      expect(latest.syncedAt, now);
      expect(await cache.readTimeline('0'), isNull);
      expect(await cache.readSidebar(), isNotNull);
      final file = (await root.list().toList()).single as File;
      expect(await file.length(), lessThanOrEqualTo(offlineMaxBytes));
    },
  );
}
