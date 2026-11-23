import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/timeline_view.dart';
import 'package:pigcode_mobile/timeline_widgets.dart';

List<MobileTimelineEvent> runs(int start, int end) => [
  for (var index = start; index <= end; index++) ...[
    MobileTimelineEvent(
      seq: index * 10,
      runId: 'r$index',
      kind: MobileTimelineKind.runStarted,
      text: '用户 $index',
      createdAt: '2026-11-22T10:00:00.000Z',
    ),
    MobileTimelineEvent(
      seq: index * 10 + 1,
      runId: 'r$index',
      kind: MobileTimelineKind.reasoning,
      text: '过程 $index',
      createdAt: '2026-11-22T10:00:01.000Z',
    ),
    MobileTimelineEvent(
      seq: index * 10 + 2,
      runId: 'r$index',
      kind: MobileTimelineKind.messageAssistant,
      text: '最终回答 $index',
      createdAt: '2026-11-22T10:00:02.000Z',
    ),
    MobileTimelineEvent(
      seq: index * 10 + 3,
      runId: 'r$index',
      kind: MobileTimelineKind.runCompleted,
      createdAt: '2026-11-22T10:00:03.000Z',
    ),
  ],
];

Widget page(List<MobileTimelineEvent> events, {MobileActiveRun? live}) =>
    MaterialApp(
      home: Scaffold(
        body: TimelineView(
          snapshot: TimelineSnapshot(
            events: events,
            through: 203,
            cursor: 203,
            nextBefore: 50,
            live: live,
          ),
          online: true,
          loadEarlier: () async {},
          content: ({seq, runId, toolId, required field, offset}) async =>
              const MobileTimelineContentResult(text: '完整工具输出'),
        ),
      ),
    );

void main() {
  final scroll = find.byKey(const ValueKey('timeline-scroll'));

  testWidgets('starts a short conversation near the top of the viewport', (
    tester,
  ) async {
    await tester.pumpWidget(page(runs(20, 20)));
    await tester.pumpAndSettle();
    final viewport = tester.getRect(scroll);
    final firstMessage = tester.getRect(find.byKey(const ValueKey('user-r20')));
    expect(firstMessage.top - viewport.top, inInclusiveRange(0, 48));
  });

  testWidgets('collapses completed work and shows the current activity', (
    tester,
  ) async {
    await tester.pumpWidget(
      page(
        runs(20, 20),
        live: const MobileActiveRun(
          runId: 'live',
          startedAt: '2026-11-22T10:00:00.000Z',
          revision: 2,
          text: '正在追加',
          textTruncated: false,
          reasoning: '',
          reasoningTruncated: false,
          pending: [],
          tools: [],
          step: '正在回答',
          finishedSteps: 1,
          totalSteps: 3,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('用时 3 秒'), findsOneWidget);
    expect(find.text('过程 20'), findsNothing);
    expect(find.text('正在回答'), findsOneWidget);
    expect(find.text('1/3'), findsOneWidget);
    expect(
      tester.getSize(find.byType(TimelineActivity)).height,
      greaterThanOrEqualTo(44),
    );
    await tester.tap(find.text('用时 3 秒'));
    await tester.pumpAndSettle();
    expect(find.text('过程 20'), findsOneWidget);
  });

  testWidgets(
    'prepending history preserves the viewport after the reader scrolls up',
    (tester) async {
      await tester.pumpWidget(page(runs(8, 20)));
      await tester.pumpAndSettle();
      final controller = tester.widget<CustomScrollView>(scroll).controller!;
      expect(
        controller.position.pixels,
        closeTo(controller.position.maxScrollExtent, 1),
      );
      await tester.drag(scroll, const Offset(0, 445));
      await tester.pumpAndSettle();
      expect(find.byTooltip('回到底部'), findsOneWidget);

      Finder? visible;
      for (var index = 8; index <= 20; index++) {
        final item = find.byKey(ValueKey('user-r$index'));
        if (item.evaluate().isNotEmpty) {
          final y = tester.getTopLeft(item).dy;
          if (y > 5 && y < 500) {
            visible = item;
            break;
          }
        }
      }
      expect(visible, isNotNull);
      final before = tester.getTopLeft(visible!).dy;
      final context = tester.element(visible);
      ScrollUpdateNotification(
        metrics: FixedScrollMetrics(
          minScrollExtent: 0,
          maxScrollExtent: 300,
          pixels: 300,
          viewportDimension: 100,
          axisDirection: AxisDirection.right,
          devicePixelRatio: 1,
        ),
        context: context,
        scrollDelta: 100,
        dragDetails: DragUpdateDetails(globalPosition: Offset.zero),
      ).dispatch(context);
      await tester.pump();
      await tester.pumpWidget(page(runs(1, 20)));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(visible).dy, closeTo(before, 1));

      await tester.pumpWidget(page([...runs(1, 20), ...runs(21, 21)]));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(visible).dy, closeTo(before, 1));
      await tester.fling(scroll, const Offset(0, -900), 2500);
      await tester.pumpAndSettle();
      expect(
        controller.position.pixels,
        closeTo(controller.position.maxScrollExtent, 1),
      );
    },
  );
}
