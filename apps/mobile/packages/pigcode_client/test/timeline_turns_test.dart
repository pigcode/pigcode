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

  test('keeps a completed turn without an answer unfolded', () {
    final turns = timelineTurns(const [
      MobileTimelineEvent(
        seq: 1,
        runId: 'r1',
        kind: MobileTimelineKind.runStarted,
        text: '检查一下',
        createdAt: '2026-11-25T00:00:00Z',
      ),
      MobileTimelineEvent(
        seq: 2,
        runId: 'r1',
        kind: MobileTimelineKind.reasoning,
        text: '先看文件',
        createdAt: '2026-11-25T00:00:01Z',
      ),
      MobileTimelineEvent(
        seq: 3,
        runId: 'r1',
        kind: MobileTimelineKind.runCompleted,
        createdAt: '2026-11-25T00:00:02Z',
      ),
    ]);
    expect(turns, hasLength(1));
    expect(turns.single.status, TimelineTurnStatus.completed);
    expect(turns.single.answer, isNull);
    expect(turns.single.folded, isFalse);
  });

  test('tracks pending requests until they are resolved', () {
    final turns = timelineTurns(const [
      MobileTimelineEvent(
        seq: 1,
        runId: 'r1',
        kind: MobileTimelineKind.runStarted,
        text: '跑一下',
        createdAt: '2026-11-25T00:00:00Z',
      ),
      MobileTimelineEvent(
        seq: 2,
        runId: 'r1',
        kind: MobileTimelineKind.approvalRequested,
        itemId: 'a1',
        createdAt: '2026-11-25T00:00:01Z',
      ),
      MobileTimelineEvent(
        seq: 3,
        runId: 'r1',
        kind: MobileTimelineKind.questionRequested,
        itemId: 'q1',
        createdAt: '2026-11-25T00:00:02Z',
      ),
      MobileTimelineEvent(
        seq: 4,
        runId: 'r1',
        kind: MobileTimelineKind.approvalResolved,
        itemId: 'a1',
        text: '已允许一次',
        createdAt: '2026-11-25T00:00:03Z',
      ),
      MobileTimelineEvent(
        seq: 5,
        runId: 'r1',
        kind: MobileTimelineKind.questionAnswered,
        itemId: 'q1',
        text: '已回答 · A',
        createdAt: '2026-11-25T00:00:04Z',
      ),
      MobileTimelineEvent(
        seq: 6,
        runId: 'r1',
        kind: MobileTimelineKind.messageAssistant,
        text: '完成',
        createdAt: '2026-11-25T00:00:05Z',
      ),
      MobileTimelineEvent(
        seq: 7,
        runId: 'r1',
        kind: MobileTimelineKind.runCompleted,
        createdAt: '2026-11-25T00:00:06Z',
      ),
    ]);
    final turn = turns.single;
    expect(turn.pendingRequests, isEmpty);
    expect(turn.requestHistory, hasLength(2));
    expect(turn.isPendingRequest('a1'), isFalse);
    expect(turn.notices.map((event) => event.text), ['已允许一次', '已回答 · A']);
    final question = turn.work.singleWhere(
      (item) => item.kind == TimelineWorkKind.question,
    );
    expect(question.result?.itemId, 'q1');
  });

  test('clears pending requests when the run ends', () {
    final turns = timelineTurns(const [
      MobileTimelineEvent(
        seq: 1,
        runId: 'r1',
        kind: MobileTimelineKind.runStarted,
        text: '跑一下',
        createdAt: '2026-11-25T00:00:00Z',
      ),
      MobileTimelineEvent(
        seq: 2,
        runId: 'r1',
        kind: MobileTimelineKind.approvalRequested,
        itemId: 'a1',
        createdAt: '2026-11-25T00:00:01Z',
      ),
      MobileTimelineEvent(
        seq: 3,
        runId: 'r1',
        kind: MobileTimelineKind.runFailed,
        text: '失败',
        createdAt: '2026-11-25T00:00:02Z',
      ),
    ]);
    expect(turns.single.pendingRequests, isEmpty);
    expect(turns.single.isPendingRequest('a1'), isFalse);
  });
}
