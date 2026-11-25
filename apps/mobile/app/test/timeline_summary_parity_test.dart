import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/timeline_work.dart';

String _workItemTag(TimelineWork item) => item.kind == TimelineWorkKind.tool
    ? 'tool:${item.event.name ?? item.output?.name ?? ''}'
    : item.kind.name;

String? _iconCategoryOf(TimelineToolKind? icon) => switch (icon) {
  TimelineToolKind.browser => 'browser',
  TimelineToolKind.edit => 'change',
  TimelineToolKind.command ||
  TimelineToolKind.mcp ||
  TimelineToolKind.skill ||
  TimelineToolKind.task => 'run',
  TimelineToolKind.read ||
  TimelineToolKind.search ||
  TimelineToolKind.fetch => 'explore',
  TimelineToolKind.plan ||
  TimelineToolKind.ask ||
  TimelineToolKind.other ||
  null => null,
};

({int explore, int run, int unresolved}) _parseCounts(
  List<TimelineWork> items,
  List<String> files,
) {
  // 通过 summarizeTimelineWork 产出的文案验证公开统计行为。
  final summary = summarizeTimelineWork(items, finished: true);
  int extract(RegExp pattern) {
    final match = pattern.firstMatch(summary.label);
    return match == null ? 0 : int.parse(match.group(1)!);
  }

  return (
    explore: extract(RegExp(r'已查阅 (\d+) 项')),
    run: extract(RegExp(r'已执行 (\d+) 命令')),
    unresolved: extract(RegExp(r'已修改 (\d+) 次（路径未知）')),
  );
}

void main() {
  test(
    'merges tool chains in the shared summary-group fixture identically to TypeScript',
    () {
      const path =
          '../../../packages/contracts/fixtures/timeline-summary-groups-v1.json';
      final fixture =
          jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
      final scenarios = fixture['scenarios'] as List<dynamic>;

      for (final rawScenario in scenarios) {
        final scenario = rawScenario as Map<String, dynamic>;
        final name = scenario['name'] as String;
        final rawEvents = scenario['events'] as List<dynamic>;
        final events = rawEvents
            .map(
              (entry) =>
                  MobileTimelineEvent.fromJson(entry as Map<String, dynamic>),
            )
            .toList();
        final turns = timelineTurns(events);
        expect(turns, hasLength(1), reason: name);

        final groups = groupTimelineWork(turns.single.work, 0);
        final projected = groups.map((group) {
          if (group.length == 1) {
            return {'kind': 'single', 'item': _workItemTag(group.single)};
          }
          final summary = summarizeTimelineWork(group, finished: true);
          final counts = _parseCounts(group, summary.files);
          return {
            'kind': 'group',
            'items': group.map(_workItemTag).toList(),
            'counts': {
              'explore': counts.explore,
              'run': counts.run,
              'files': summary.files,
              'unresolved': counts.unresolved,
            },
            'iconCategory': _iconCategoryOf(summary.icon),
          };
        }).toList();

        expect(projected, scenario['entries'], reason: name);
      }
    },
  );
}
