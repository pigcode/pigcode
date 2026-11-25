import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/theme_colors.dart';
import 'package:pigcode_mobile/timeline/loading_row.dart';
import 'package:pigcode_mobile/timeline/notice_line.dart';
import 'package:pigcode_mobile/timeline/summary_group.dart';
import 'package:pigcode_mobile/timeline/timeline_tokens.dart';
import 'package:pigcode_mobile/timeline/tool_row.dart';
import 'package:pigcode_mobile/timeline/tools/inline_diff.dart';
import 'package:pigcode_mobile/timeline/user_bubble.dart';
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
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
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
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
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
    expect(find.text('工作中'), findsOneWidget);
    expect(find.text('正在回答'), findsOneWidget);
    expect(find.text('计划 1/3'), findsOneWidget);
    expect(find.byType(TimelineLoadingRow), findsOneWidget);
    await tester.tap(find.text('用时 3 秒'));
    await tester.pumpAndSettle();
    expect(find.text('过程 20'), findsNothing);
    await tester.tap(find.text('思考'));
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

  testWidgets(
    'caps expanded summary group height to 16 lines, follows new items, and stops following when scrolled up',
    (tester) async {
      List<Widget> buildItems(int count) => [
        for (var i = 1; i <= count; i++)
          SizedBox(
            height: 36,
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('摘要项 $i'),
            ),
          ),
      ];

      Widget host(int count) => MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: Scaffold(
          body: TimelineSummaryGroup(
            label: '已查阅 $count 项',
            icon: null,
            files: const [],
            expanded: true,
            toggleable: true,
            children: buildItems(count),
          ),
        ),
      );

      await tester.pumpWidget(host(20));
      await tester.pumpAndSettle();

      final bodyFinder = find.byType(TimelineSummaryGroupBody);
      final bodyRect = tester.getRect(bodyFinder);
      expect(
        bodyRect.height,
        lessThanOrEqualTo(TimelineSummary.maxBodyHeight + TimelineSpace.x4 + 1),
      );

      final innerScrollable = find.descendant(
        of: bodyFinder,
        matching: find.byType(Scrollable),
      );
      final position = tester.state<ScrollableState>(innerScrollable).position;
      expect(position.maxScrollExtent, greaterThan(0));
      expect(position.pixels, closeTo(position.maxScrollExtent, 2));

      // 追加新项时自动跟随到底部。
      await tester.pumpWidget(host(22));
      await tester.pumpAndSettle();
      expect(position.pixels, closeTo(position.maxScrollExtent, 2));

      // 手动上翻后停止跟随新项。
      await tester.drag(innerScrollable, const Offset(0, 200));
      await tester.pumpAndSettle();
      final scrolledOffset = position.pixels;
      expect(scrolledOffset, lessThan(position.maxScrollExtent - 20));

      await tester.pumpWidget(host(24));
      await tester.pumpAndSettle();
      expect(position.pixels, closeTo(scrolledOffset, 2));
    },
  );

  testWidgets(
    'renders desktop file chip rules on summary groups (single file, 3 + N, hidden when expanded)',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: const [
                TimelineSummaryGroupRow(
                  label: '已修改 1 文件',
                  singleFileLabel: '已修改',
                  icon: null,
                  files: ['src/app.dart'],
                  expanded: false,
                  toggleable: true,
                ),
                TimelineSummaryGroupRow(
                  label: '已修改 4 文件',
                  icon: null,
                  files: [
                    'src/a.dart',
                    'src/b.dart',
                    'src/c.dart',
                    'src/d.dart',
                  ],
                  expanded: false,
                  toggleable: true,
                ),
                TimelineSummaryGroupRow(
                  label: '已修改 2 文件',
                  icon: null,
                  files: ['src/e.dart', 'src/f.dart'],
                  expanded: true,
                  toggleable: true,
                ),
              ],
            ),
          ),
        ),
      );
      expect(find.text('已修改'), findsOneWidget);
      expect(find.text('app.dart'), findsOneWidget);
      expect(find.text('已修改 1 文件'), findsNothing);

      expect(find.text('已修改 4 文件'), findsOneWidget);
      expect(find.text('a.dart'), findsOneWidget);
      expect(find.text('b.dart'), findsOneWidget);
      expect(find.text('c.dart'), findsOneWidget);
      expect(find.text('d.dart'), findsNothing);
      expect(find.text('+1'), findsOneWidget);

      // 展开后只显示统计，不显示文件 chip。
      expect(find.text('已修改 2 文件'), findsOneWidget);
      expect(find.text('e.dart'), findsNothing);
    },
  );

  testWidgets(
    'clamps long user bubbles with mask and leaves short bubbles unmasked',
    (tester) async {
      final longText = List.generate(12, (i) => '第 ${i + 1} 行用于测试超长气泡折叠行为。')
          .join('\n');
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              child: Column(
                children: [
                  const TimelineUserBubble(text: '简短消息'),
                  TimelineUserBubble(text: '$longText\n参考 @lib/main.dart'),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 短气泡不套渐隐遮罩；长气泡有 1 个渐隐遮罩和「展开」按钮。
      expect(find.byType(ShaderMask), findsOneWidget);
      expect(find.byTooltip('展开'), findsOneWidget);
      expect(find.text('main.dart'), findsOneWidget);

      await tester.tap(find.byTooltip('展开'));
      await tester.pumpAndSettle();
      expect(find.byType(ShaderMask), findsNothing);
      expect(find.byTooltip('收起'), findsOneWidget);
    },
  );

  testWidgets(
    'renders code block desktop defaults, notice levels, queued loading row, and unwrapped inline diff',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const TimelineCodeBlock(
                    name: 'TS',
                    code: 'const answer = 42;\n',
                    closed: true,
                  ),
                  const TimelineCodeBlock(
                    name: '',
                    code: 'plain text',
                    closed: true,
                  ),
                  const TimelineNoticeLine(
                    text: '普通信息',
                    level: TimelineNoticeLevel.info,
                  ),
                  const TimelineNoticeLine(
                    text: '警告信息',
                    level: TimelineNoticeLevel.warning,
                  ),
                  const TimelineNoticeLine(
                    text: '错误信息',
                    level: TimelineNoticeLevel.error,
                  ),
                  const TimelineErrorBlock(text: '执行出错'),
                  const TimelineLoadingRow(queued: true),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 代码块语言小写、缺省为 text、默认不折行。
      expect(find.text('ts'), findsOneWidget);
      expect(find.text('text'), findsOneWidget);
      expect(find.byTooltip('自动换行'), findsNWidgets(2));
      await tester.tap(find.byTooltip('自动换行').first);
      await tester.pumpAndSettle();
      expect(find.byTooltip('不折行'), findsOneWidget);

      // Notice 三级底色严格对应桌面 token。
      Container containerOf(String label) => tester.widget<Container>(
        find
            .ancestor(of: find.text(label), matching: find.byType(Container))
            .first,
      );
      expect(
        (containerOf('普通信息').decoration as BoxDecoration).color,
        pigcodeLight.timelineInlineCode,
      );
      expect(
        (containerOf('警告信息').decoration as BoxDecoration).color,
        pigcodeLight.attentionTint,
      );
      expect(
        (containerOf('错误信息').decoration as BoxDecoration).color,
        pigcodeLight.errorTint,
      );
      expect(find.text('排队中'), findsOneWidget);

      // 编辑工具展开后直接展示内联 diff，不套 TimelineToolDetails 双层灰壳。
      await tester.pumpWidget(
        page(const [
          MobileTimelineEvent(
            seq: 1,
            runId: 'edit-run',
            kind: MobileTimelineKind.toolStarted,
            itemId: 'e1',
            name: 'Edit',
            text: '{"file_path":"lib/a.dart","old_string":"a","new_string":"b"}',
            createdAt: '2026-11-22T10:00:00.000Z',
          ),
          MobileTimelineEvent(
            seq: 2,
            runId: 'edit-run',
            kind: MobileTimelineKind.toolCompleted,
            itemId: 'e1',
            name: 'Edit',
            text: '',
            createdAt: '2026-11-22T10:00:01.000Z',
          ),
        ]),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('已编辑'));
      await tester.pumpAndSettle();
      expect(find.byType(TimelineInlineDiff), findsOneWidget);
      expect(find.byType(TimelineToolDetails), findsNothing);
    },
  );
}
