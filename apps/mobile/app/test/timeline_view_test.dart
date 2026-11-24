import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/theme_colors.dart';
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

  testWidgets('opens tool details over a painted workspace surface', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DecoratedBox(
            decoration: const BoxDecoration(color: Colors.white),
            child: TimelineView(
              snapshot: TimelineSnapshot(
                events: const [
                  MobileTimelineEvent(
                    seq: 1,
                    runId: 'review',
                    kind: MobileTimelineKind.toolStarted,
                    itemId: 'read',
                    name: 'Read',
                    text: 'docs/mobile.md',
                    createdAt: '2026-11-22T10:00:00.000Z',
                  ),
                ],
                through: 1,
                cursor: 1,
                nextBefore: null,
                live: null,
              ),
              online: true,
              loadEarlier: () async {},
              content: ({seq, runId, toolId, required field, offset}) async =>
                  throw StateError('unexpected read'),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('正在读取'));
    await tester.pumpAndSettle();
    expect(find.text('参数'), findsOneWidget);
  });

  testWidgets(
    'groups tool activity around work messages and keeps details reachable',
    (tester) async {
      var sequence = 0;
      MobileTimelineEvent event(
        MobileTimelineKind kind, {
        String? id,
        String? name,
        String? text,
        bool? truncated,
      }) => MobileTimelineEvent(
        seq: ++sequence,
        runId: 'work',
        kind: kind,
        itemId: id,
        name: name,
        text: text,
        truncated: truncated,
        createdAt: '2026-11-22T10:00:00.000Z',
      );
      List<MobileTimelineEvent> tool(String id, String name, String input) => [
        event(MobileTimelineKind.toolStarted, id: id, name: name, text: input),
        event(MobileTimelineKind.toolCompleted, id: id, name: name),
      ];
      await tester.pumpWidget(
        page([
          event(MobileTimelineKind.runStarted, text: '整理项目'),
          event(MobileTimelineKind.reasoning, text: '查阅结构，再修改入口。'),
          ...tool('read', 'Read', '{"file_path":"docs/mobile.md"}'),
          ...tool('grep', 'Grep', '{"pattern":"timeline"}'),
          ...tool('first-edit', 'Edit', '{"file_path":"app/main.dart"}'),
          event(
            MobileTimelineKind.toolStarted,
            id: 'second-edit',
            name: 'Edit',
            text: '{"file_path":"app/./main.dart","old_string":"unfinished',
            truncated: true,
          ),
          event(
            MobileTimelineKind.toolCompleted,
            id: 'second-edit',
            name: 'Edit',
          ),
          event(MobileTimelineKind.messageAssistant, text: '已更新入口，准备验证。'),
          event(
            MobileTimelineKind.toolStarted,
            id: 'test',
            name: 'Bash',
            text: '{"description":"运行验证","command":"flutter test"}',
          ),
        ]),
      );
      await tester.pumpAndSettle();
      final summary = find.text('已查阅 2 项，已修改 1 文件');
      expect(summary, findsOneWidget);
      expect(find.textContaining('正在执行'), findsOneWidget);
      expect(find.textContaining('mobile.md'), findsNothing);

      await tester.tap(summary);
      await tester.pumpAndSettle();
      final read = find.textContaining('mobile.md');
      await tester.ensureVisible(read);
      await tester.tap(read);
      await tester.pumpAndSettle();
      expect(find.text('参数'), findsOneWidget);
    },
  );

  testWidgets('uses the dark foreground for inline Markdown code', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: pigcodeTheme(Brightness.dark),
        home: const Scaffold(
          body: TimelineAnswer(text: '运行 `flutter test` 复验。'),
        ),
      ),
    );
    final codeColors = <Color?>[];
    for (final paragraph
        in tester.allRenderObjects.whereType<RenderParagraph>()) {
      paragraph.text.visitChildren((span) {
        if (span is TextSpan && span.text?.contains('flutter test') == true) {
          codeColors.add(span.style?.color);
        }
        return true;
      });
    }
    expect(codeColors, isNotEmpty);
    expect(codeColors, everyElement(pigcodeDark.foreground));
  });

  testWidgets('shows the duration of a completed exchange with no tool work', (
    tester,
  ) async {
    final events = runs(
      20,
      20,
    ).where((event) => event.kind != MobileTimelineKind.reasoning).toList();
    await tester.pumpWidget(page(events));
    await tester.pumpAndSettle();
    final viewport = tester.getRect(scroll);
    final firstMessage = tester.getRect(find.byKey(const ValueKey('user-r20')));
    expect(firstMessage.top - viewport.top, inInclusiveRange(0, 48));
    expect(find.text('用时 3 秒'), findsOneWidget);
    final messenger = tester.binding.defaultBinaryMessenger;
    String? copied;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String;
      }
      return null;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
    });
    await tester.tap(find.byTooltip('复制回答'));
    expect(copied, '最终回答 20');
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
