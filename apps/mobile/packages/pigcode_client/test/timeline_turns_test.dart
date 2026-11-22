import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:test/test.dart';

void main() {
  test('groups the same timeline fixture as the TypeScript renderer', () {
    final path =
        '../../../../packages/contracts/fixtures/mobile-timeline-v1.json';
    final fixture =
        jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
    final raw = fixture['events'] as List<dynamic>;
    final events = raw
        .map(
          (entry) =>
              MobileTimelineEvent.fromJson(entry as Map<String, dynamic>),
        )
        .toList();
    final projection = timelineTurns(events)
        .map(
          (turn) => {
            'key': turn.key,
            'user': turn.user?.text,
            'work': turn.work.map((item) => item.kind.name).toList(),
            'answer': turn.answer?.text,
            'status': turn.status.name,
            'folded': turn.folded,
          },
        )
        .toList();
    expect(projection, fixture['turns']);
  });
}
