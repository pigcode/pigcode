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

  test('hides Claude Code task management tools alongside todos', () {
    final turns = timelineTurns(const [
      MobileTimelineEvent(
        seq: 1,
        runId: 'r1',
        kind: MobileTimelineKind.runStarted,
        text: '追踪任务',
        createdAt: '2026-11-25T00:00:00Z',
      ),
      MobileTimelineEvent(
        seq: 2,
        runId: 'r1',
        kind: MobileTimelineKind.toolStarted,
        itemId: 't1',
        name: 'TaskCreate',
        text: '{}',
        createdAt: '2026-11-25T00:00:01Z',
      ),
      MobileTimelineEvent(
        seq: 3,
        runId: 'r1',
        kind: MobileTimelineKind.toolStarted,
        itemId: 't2',
        name: 'TaskUpdate',
        text: '{}',
        createdAt: '2026-11-25T00:00:02Z',
      ),
      MobileTimelineEvent(
        seq: 4,
        runId: 'r1',
        kind: MobileTimelineKind.toolStarted,
        itemId: 't3',
        name: 'TaskList',
        text: '{}',
        createdAt: '2026-11-25T00:00:03Z',
      ),
      MobileTimelineEvent(
        seq: 5,
        runId: 'r1',
        kind: MobileTimelineKind.toolStarted,
        itemId: 't4',
        name: 'TaskGet',
        text: '{}',
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
    expect(turns.single.work, isEmpty);
    expect(turns.single.answer?.text, '完成');
  });

  test(
    'marks running tools awaiting approval by itemId, name, or fallback and clears after resolution or run end',
    () {
      // 1. 优先按 itemId 匹配
      final byId = timelineTurns(const [
        MobileTimelineEvent(
          seq: 1,
          runId: 'r1',
          kind: MobileTimelineKind.runStarted,
          text: '执行命令',
          createdAt: '2026-11-25T00:00:00Z',
        ),
        MobileTimelineEvent(
          seq: 2,
          runId: 'r1',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'call-1',
          name: 'Bash',
          text: '{"command":"ls"}',
          createdAt: '2026-11-25T00:00:01Z',
        ),
        MobileTimelineEvent(
          seq: 3,
          runId: 'r1',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'call-2',
          name: 'Bash',
          text: '{"command":"pwd"}',
          createdAt: '2026-11-25T00:00:02Z',
        ),
        MobileTimelineEvent(
          seq: 4,
          runId: 'r1',
          kind: MobileTimelineKind.approvalRequested,
          itemId: 'call-1',
          name: 'Bash',
          createdAt: '2026-11-25T00:00:03Z',
        ),
      ]);
      expect(byId.single.work[0].pendingApproval, isTrue);
      expect(byId.single.work[1].pendingApproval, isFalse);

      // 2. itemId 不匹配但 request.name 非空：匹配最后一个同名且运行中的工具
      final byName = timelineTurns(const [
        MobileTimelineEvent(
          seq: 1,
          runId: 'r2',
          kind: MobileTimelineKind.runStarted,
          text: '检查',
          createdAt: '2026-11-25T00:00:00Z',
        ),
        MobileTimelineEvent(
          seq: 2,
          runId: 'r2',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'b1',
          name: 'Bash',
          text: '{"command":"echo 1"}',
          createdAt: '2026-11-25T00:00:01Z',
        ),
        MobileTimelineEvent(
          seq: 3,
          runId: 'r2',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'b2',
          name: 'Bash',
          text: '{"command":"echo 2"}',
          createdAt: '2026-11-25T00:00:02Z',
        ),
        MobileTimelineEvent(
          seq: 4,
          runId: 'r2',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'r1',
          name: 'Read',
          text: '{"file_path":"a.dart"}',
          createdAt: '2026-11-25T00:00:03Z',
        ),
        MobileTimelineEvent(
          seq: 5,
          runId: 'r2',
          kind: MobileTimelineKind.approvalRequested,
          itemId: 'req-1',
          name: 'Bash',
          createdAt: '2026-11-25T00:00:04Z',
        ),
      ]);
      expect(byName.single.work[0].pendingApproval, isFalse);
      expect(byName.single.work[1].pendingApproval, isTrue);
      expect(byName.single.work[2].pendingApproval, isFalse);

      // 3. request.name 非空但无同名运行中工具：不误标其他工具
      final unmatchedName = timelineTurns(const [
        MobileTimelineEvent(
          seq: 1,
          runId: 'r3',
          kind: MobileTimelineKind.runStarted,
          text: '检查',
          createdAt: '2026-11-25T00:00:00Z',
        ),
        MobileTimelineEvent(
          seq: 2,
          runId: 'r3',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'read-1',
          name: 'Read',
          text: '{"file_path":"a.dart"}',
          createdAt: '2026-11-25T00:00:01Z',
        ),
        MobileTimelineEvent(
          seq: 3,
          runId: 'r3',
          kind: MobileTimelineKind.approvalRequested,
          itemId: 'req-2',
          name: 'Bash',
          createdAt: '2026-11-25T00:00:02Z',
        ),
      ]);
      expect(unmatchedName.single.work.single.pendingApproval, isFalse);

      // 4. request.name 为空：匹配最后一个运行中工具
      final fallbackEvents = const [
        MobileTimelineEvent(
          seq: 1,
          runId: 'r4',
          kind: MobileTimelineKind.runStarted,
          text: '检查',
          createdAt: '2026-11-25T00:00:00Z',
        ),
        MobileTimelineEvent(
          seq: 2,
          runId: 'r4',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'read-1',
          name: 'Read',
          text: '{"file_path":"a.dart"}',
          createdAt: '2026-11-25T00:00:01Z',
        ),
        MobileTimelineEvent(
          seq: 3,
          runId: 'r4',
          kind: MobileTimelineKind.toolCompleted,
          itemId: 'read-1',
          name: 'Read',
          text: 'ok',
          createdAt: '2026-11-25T00:00:02Z',
        ),
        MobileTimelineEvent(
          seq: 4,
          runId: 'r4',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'cmd-1',
          name: 'Bash',
          text: '{"command":"dart test"}',
          createdAt: '2026-11-25T00:00:03Z',
        ),
        MobileTimelineEvent(
          seq: 5,
          runId: 'r4',
          kind: MobileTimelineKind.approvalRequested,
          itemId: 'req-3',
          createdAt: '2026-11-25T00:00:04Z',
        ),
      ];
      final fallback = timelineTurns(fallbackEvents);
      expect(fallback.single.work[0].pendingApproval, isFalse);
      expect(fallback.single.work[1].pendingApproval, isTrue);

      // 5. 审批解决后恢复 false
      final resolved = timelineTurns([
        ...fallbackEvents,
        const MobileTimelineEvent(
          seq: 6,
          runId: 'r4',
          kind: MobileTimelineKind.approvalResolved,
          itemId: 'req-3',
          text: '已允许一次',
          createdAt: '2026-11-25T00:00:05Z',
        ),
      ]);
      expect(resolved.single.work[1].pendingApproval, isFalse);

      // 6. run 结束后恢复 false
      final ended = timelineTurns([
        ...fallbackEvents,
        const MobileTimelineEvent(
          seq: 6,
          runId: 'r4',
          kind: MobileTimelineKind.runInterrupted,
          createdAt: '2026-11-25T00:00:05Z',
        ),
      ]);
      expect(ended.single.work[1].pendingApproval, isFalse);
    },
  );

  test('updates a running tool input when a follow-up toolStarted arrives', () {
    final turns = timelineTurns(const [
      MobileTimelineEvent(
        seq: 1,
        runId: 'r1',
        kind: MobileTimelineKind.runStarted,
        text: '跑测试',
        createdAt: '2026-11-25T00:00:00Z',
      ),
      MobileTimelineEvent(
        seq: 2,
        runId: 'r1',
        kind: MobileTimelineKind.toolStarted,
        itemId: 'bash-1',
        name: 'Bash',
        text: '{}',
        createdAt: '2026-11-25T00:00:01Z',
      ),
      MobileTimelineEvent(
        seq: 3,
        runId: 'r1',
        kind: MobileTimelineKind.toolStarted,
        itemId: 'bash-1',
        name: 'Bash',
        text: '{"command":"flutter test"}',
        createdAt: '2026-11-25T00:00:02Z',
      ),
    ]);
    expect(turns.single.work, hasLength(1));
    expect(turns.single.work.single.input?.text, '{"command":"flutter test"}');
  });
}
