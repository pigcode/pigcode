import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' show FrameTiming;

import 'package:flutter/foundation.dart' show kProfileMode;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/run_diff_screen.dart';
import 'package:pigcode_mobile/timeline_view.dart';

const _threadId = 'timeline-replay';
const _activeRun = 'replay-active';
const _tool = '回放构建日志';
const _time = '2025-06-18T08:30:00Z';
const _turns = 60;
const _pageSize = 50;
// The mobile Host serves tool text and diff patches in 8,192 UTF-16 units.
const _textPageSize = 8192;
const _toolPages = 8;
const _scrollKey = ValueKey('timeline-scroll');
const _chunks = 36;
const _chunkInterval = Duration(milliseconds: 50);
const _file = 'lib/connection.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  WidgetController.hitTestWarningShouldBeFatal = true;

  testWidgets('replays several pages, large output, a patch and live replies', (
    tester,
  ) async {
    final rpc = _ReplayHost();
    addTearDown(rpc.close);
    final subscriptionBytes = rpc.subscriptionBytes;
    final opening = Stopwatch()..start();
    final timeline = await MobileTimeline.open(rpc, _threadId);
    addTearDown(timeline.close);
    await tester.pumpWidget(_screen(timeline, rpc));
    final activeUser = find.byKey(const ValueKey('user-$_activeRun'));
    await _waitUntil(
      tester,
      () => activeUser.hitTestable().evaluate().isNotEmpty,
    );
    final firstScreenMicros = opening.elapsedMicroseconds;
    final firstScreenRssBytes = ProcessInfo.currentRss;
    final scroll = find.byKey(_scrollKey);
    ScrollPosition position() =>
        tester.widget<CustomScrollView>(scroll).controller!.position;
    await _waitUntil(tester, () => position().extentAfter <= 1);

    await tester.tap(find.text(_tool).hitTestable());
    final openFullDetails = find.text('查看完整内容');
    await _waitUntil(
      tester,
      () => openFullDetails.evaluate().isNotEmpty,
    );
    await tester.ensureVisible(openFullDetails);
    await _pumpFrames(tester, const Duration(milliseconds: 200));
    await tester.tap(openFullDetails.hitTestable());
    await _waitUntil(
      tester,
      () => find.text('读取完整内容').hitTestable().evaluate().isNotEmpty,
    );
    await _pumpFrames(tester, const Duration(milliseconds: 350));
    for (var page = 0; page < _toolPages; page++) {
      final more = find.text(page == 0 ? '读取完整内容' : '继续读取');
      await tester.ensureVisible(more);
      await _pumpFrames(tester, const Duration(milliseconds: 160));
      await tester.tap(more.hitTestable());
      final expectedBytes = _textPageSize * (page + 1);
      await _waitUntil(tester, () => rpc.toolBytesRead >= expectedBytes);
      await _pumpFrames(tester, const Duration(milliseconds: 120));
    }
    expect(rpc.toolBytesRead, _textPageSize * _toolPages);
    expect(find.text('继续读取'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await _waitUntil(
      tester,
      () => find.byTooltip('查看回放差异').hitTestable().evaluate().isNotEmpty,
    );
    await _pumpFrames(tester, const Duration(milliseconds: 350));
    await tester.tap(find.text(_tool).hitTestable());
    await _waitUntil(tester, () => openFullDetails.evaluate().isEmpty);
    await _pumpFrames(tester, const Duration(milliseconds: 200));

    await tester.tap(find.byTooltip('查看回放差异'));
    await _waitUntil(
      tester,
      () => find.text('enableReconnect(0);').evaluate().isNotEmpty,
    );
    await _pumpFrames(tester, const Duration(milliseconds: 350));
    expect(find.text('enableReconnect(0);'), findsOneWidget);
    final moreDiff = find.text('继续读取差异');
    await tester.scrollUntilVisible(
      moreDiff,
      450,
      scrollable: find.descendant(
        of: find.byType(RunDiffScreen),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is Scrollable &&
              widget.axisDirection == AxisDirection.down,
        ),
      ),
    );
    await _pumpFrames(tester, const Duration(milliseconds: 160));
    await tester.tap(moreDiff.hitTestable());
    final expectedDiffBytes = utf8.encode(rpc.patch).length;
    await _waitUntil(
      tester,
      () =>
          rpc.diffBytesRead >= expectedDiffBytes && moreDiff.evaluate().isEmpty,
    );
    await _pumpFrames(tester, const Duration(milliseconds: 120));
    expect(rpc.diffBytesRead, expectedDiffBytes);
    expect(moreDiff, findsNothing);
    await tester.binding.handlePopRoute();
    await _waitUntil(
      tester,
      () =>
          find.byType(RunDiffScreen).evaluate().isEmpty &&
          scroll.hitTestable().evaluate().isNotEmpty,
    );
    await _pumpFrames(tester, const Duration(milliseconds: 200));

    await tester.drag(scroll, const Offset(0, 440));
    final backToTail = find.byTooltip('回到底部');
    await _waitUntil(tester, () => backToTail.hitTestable().evaluate().isNotEmpty);
    await _pumpFrames(tester, const Duration(milliseconds: 450));
    expect(backToTail, findsOneWidget);
    final anchor = _visibleAnchor(tester, scroll);
    final anchorTop = tester.getTopLeft(anchor).dy;
    while (timeline.snapshot!.nextBefore != null) {
      await timeline.loadEarlier();
      await _pumpFrames(tester, const Duration(milliseconds: 160));
    }
    expect(timeline.snapshot!.events.length, rpc.eventCount);
    final prependDelta = tester.getTopLeft(anchor).dy - anchorTop;
    expect(prependDelta, closeTo(0, 1));

    rpc.append('回放还在继续。');
    await _pumpFrames(tester, const Duration(milliseconds: 200));
    final unfollowedDelta = tester.getTopLeft(anchor).dy - anchorTop;
    expect(unfollowedDelta, closeTo(0, 1));
    await tester.tap(backToTail);
    await _waitUntil(
      tester,
      () => position().extentAfter <= 1 && backToTail.evaluate().isEmpty,
    );
    // Let the engine deliver the frame timings from the scroll before sampling the replay.
    await _pumpFrames(tester, const Duration(milliseconds: 350));

    final frames = <FrameTiming>[];
    binding.addTimingsCallback(frames.addAll);
    try {
      for (var index = 1; index <= _chunks; index++) {
        rpc.append('\n\n- 第 $index 段：检查连接、历史分页和当前窗口。\n');
        await tester.pump(_chunkInterval);
      }
      await _waitUntil(tester, () => position().extentAfter <= 1);
      // Flutter 引擎按 ~1s 周期批量回传 FrameTiming（flutter/flutter#64808）。
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      await _waitUntil(tester, () => frames.isNotEmpty);
      expect(frames, isNotEmpty);
    } finally {
      binding.removeTimingsCallback(frames.addAll);
    }
    expect(timeline.snapshot!.live!.revision, _chunks + 2);
    expect(backToTail, findsNothing);
    expect(position().extentAfter, lessThanOrEqualTo(1));

    binding.reportData = {
      'mode': kProfileMode ? 'profile' : 'debug',
      'fixtureVersion': 1,
      'firstScreenMicros': firstScreenMicros,
      'firstScreenRssBytes': firstScreenRssBytes,
      'peakRssBytes': ProcessInfo.maxRss,
      'initialSubscriptionBytes': subscriptionBytes,
      'initialEventCount': rpc.initialEventCount,
      'loadedEventCount': timeline.snapshot!.events.length,
      'toolOutputBytes': rpc.toolBytesRead,
      'diffBytes': rpc.diffBytesRead,
      'streamChunks': _chunks,
      'streamIntervalMs': _chunkInterval.inMilliseconds,
      'streamFrameCount': frames.length,
      'buildMicros': _percentiles(frames.map((frame) => frame.buildDuration)),
      'rasterMicros': _percentiles(frames.map((frame) => frame.rasterDuration)),
      'totalSpanMicros': _percentiles(frames.map((frame) => frame.totalSpan)),
      'prependAnchorDeltaPx': prependDelta,
      'unfollowedStreamDeltaPx': unfollowedDelta,
      'tailExtentAfterPx': position().extentAfter,
      'anchorsPreserved': true,
      'followedLatest': true,
    };
    await tester.pumpWidget(const SizedBox.shrink());
  });
}

Widget _screen(MobileTimeline timeline, _ReplayHost rpc) => MaterialApp(
  theme: pigcodeTheme(Brightness.light),
  home: Builder(
    builder: (context) => Scaffold(
      appBar: AppBar(
        title: const Text('长会话回放'),
        actions: [
          IconButton(
            tooltip: '查看回放差异',
            icon: const Icon(Icons.difference_outlined),
            onPressed: () => RunDiffScreen.open(
              context,
              initial: const MobileRunChangesPage(
                diffAvailable: true,
                files: [
                  MobileRunChangedFile(path: _file, added: 180, removed: 180),
                ],
              ),
              loadDiff: (_, offset) async => rpc.loadDiff(offset),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: StreamBuilder<TimelineSnapshot>(
          stream: timeline.updates,
          initialData: timeline.snapshot,
          builder: (context, data) => TimelineView(
            snapshot: data.requireData,
            online: true,
            loadEarlier: timeline.loadEarlier,
            content: timeline.content,
          ),
        ),
      ),
    ),
  ),
);

Finder _visibleAnchor(WidgetTester tester, Finder scroll) {
  final viewport = tester.getRect(scroll);
  for (var turn = 1; turn <= _turns; turn++) {
    final bubble = find.byKey(ValueKey('user-replay-$turn')).hitTestable();
    if (bubble.evaluate().isNotEmpty) {
      final bounds = tester.getRect(bubble);
      if (bounds.top >= viewport.top && bounds.bottom <= viewport.bottom) {
        return bubble;
      }
    }
  }
  throw StateError('上翻后没有完整可见的历史消息可作为锚点。');
}

Future<void> _pumpFrames(WidgetTester tester, Duration total) async {
  const step = Duration(milliseconds: 16);
  var elapsed = Duration.zero;
  while (elapsed < total) {
    await tester.pump(step);
    elapsed += step;
  }
}

Future<void> _waitUntil(WidgetTester tester, bool Function() ready) async {
  final wait = Stopwatch()..start();
  while (!ready() && wait.elapsed < const Duration(seconds: 10)) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(ready(), isTrue);
}

Map<String, int> _percentiles(Iterable<Duration> durations) {
  final sorted = durations.map((value) => value.inMicroseconds).toList()
    ..sort();
  int nearestRank(double percentile) =>
      sorted[(sorted.length * percentile).ceil() - 1];
  return {
    'p50': nearestRank(.5),
    'p90': nearestRank(.9),
    'p99': nearestRank(.99),
  };
}

class _ReplayHost implements HostRequests {
  final _notifications = StreamController<Map<String, dynamic>>.broadcast(
    sync: true,
  );
  final _output = List.generate(
    1800,
    (index) =>
        '[replay $index] check connection, permissions, histories and tool output\n',
  ).join();
  final patch =
      '@@ -1,180 +1,180 @@\n${List.generate(180, (index) => '-prepareReplay($index, enabled: false);\n+enableReconnect($index);\n').join()}';
  late final List<MobileTimelineEvent> _history = _createHistory();
  late final String _subscription = jsonEncode(
    MobileTimelineSubscription(
      page: _page(_history.length),
      live: const MobileActiveRun(
        runId: _activeRun,
        startedAt: _time,
        revision: 1,
        text: '已打开固定回放。',
        textTruncated: false,
        reasoning: '',
        reasoningTruncated: false,
        tools: [],
        pending: [],
        step: '回放流式输出',
      ),
    ).toJson(),
  );

  int toolBytesRead = 0;
  int diffBytesRead = 0;
  int get subscriptionBytes => utf8.encode(_subscription).length;
  int _revision = 1;
  int get eventCount => _history.length;
  int get initialEventCount => _pageSize;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  List<MobileTimelineEvent> _createHistory() {
    var seq = 0;
    return [
      for (var turn = 1; turn <= _turns; turn++) ...[
        MobileTimelineEvent(
          seq: ++seq,
          runId: 'replay-$turn',
          kind: MobileTimelineKind.runStarted,
          createdAt: _time,
          text: '第 $turn 轮，请检查项目连接和历史状态。',
        ),
        MobileTimelineEvent(
          seq: ++seq,
          runId: 'replay-$turn',
          kind: MobileTimelineKind.reasoning,
          createdAt: _time,
          text: '检查连接与回执，再核对当前会话的结果。',
        ),
        MobileTimelineEvent(
          seq: ++seq,
          runId: 'replay-$turn',
          kind: MobileTimelineKind.toolCompleted,
          createdAt: _time,
          itemId: 'tool-$turn',
          name: '构建检查',
          text: _output.substring(0, 512),
          truncated: true,
        ),
        MobileTimelineEvent(
          seq: ++seq,
          runId: 'replay-$turn',
          kind: MobileTimelineKind.messageAssistant,
          createdAt: _time,
          text:
              '第 $turn 轮完成。\n\n- 会话列表可读取。\n- 已核对断线后的恢复提示。\n\n```dart\nfinal connected = true;\n```',
        ),
        MobileTimelineEvent(
          seq: ++seq,
          runId: 'replay-$turn',
          kind: MobileTimelineKind.runCompleted,
          createdAt: _time,
        ),
      ],
      MobileTimelineEvent(
        seq: ++seq,
        runId: _activeRun,
        kind: MobileTimelineKind.runStarted,
        createdAt: _time,
        text: '继续回放并查看这轮输出。',
      ),
      MobileTimelineEvent(
        seq: ++seq,
        runId: _activeRun,
        kind: MobileTimelineKind.toolCompleted,
        createdAt: _time,
        itemId: 'replay-log',
        name: _tool,
        text: _output.substring(0, 512),
        truncated: true,
      ),
    ];
  }

  MobileTimelinePage _page(int end) {
    final start = math.max(0, end - _pageSize);
    return MobileTimelinePage(
      events: _history.sublist(start, end),
      through: _history.last.seq,
      nextBefore: start == 0 ? null : _history[start].seq,
    );
  }

  ({String text, int? nextOffset}) _textPage(String source, int offset) {
    final end = math.min(offset + _textPageSize, source.length);
    return (
      text: source.substring(offset, end),
      nextOffset: end < source.length ? end : null,
    );
  }

  MobileRunDiffPage loadDiff(int offset) {
    final page = _textPage(patch, offset);
    diffBytesRead += page.text.length;
    return MobileRunDiffPage(text: page.text, nextOffset: page.nextOffset);
  }

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    switch (method) {
      case MobileTimelineMethods.subscribe:
        return jsonDecode(_subscription);
      case MobileTimelineMethods.history:
        final before = params['before'] as int;
        return _page(
          _history.indexWhere((event) => event.seq == before),
        ).toJson();
      case MobileTimelineMethods.content:
        final offset = params['offset'] as int? ?? 0;
        final page = _textPage(_output, offset);
        toolBytesRead += page.text.length;
        return MobileTimelineContentResult(
          text: page.text,
          nextOffset: page.nextOffset,
        ).toJson();
      case MobileTimelineMethods.unsubscribe:
        return {'ok': true};
      default:
        throw StateError('回放收到意外的请求 $method');
    }
  }

  void append(String text) => _notifications.add({
    'method': MobileTimelineMethods.delta,
    'params': {
      'threadId': _threadId,
      'runId': _activeRun,
      'revision': ++_revision,
      'kind': 'text',
      'text': text,
    },
  });

  Future<void> close() => _notifications.close();
}
