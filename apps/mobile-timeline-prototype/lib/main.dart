/// 技术验证：Flutter 长会话时间线在 iPhone 上的表现（pigcode/monorepo#104）。一次性代码，只留在
/// prototype/mobile-timeline 分支上。
///
/// 回放一段真实的长会话（assets/session.json，由 tool/convert_claude.dart 从 Claude Code 的会话记录转出来），
/// 看冷启动、内存、流式时的掉帧，加载历史和流式输出会不会移动视口，以及键盘和中文输入法的表现。
/// 用 `--dart-define=SELFTEST=true` 启动时自动跑一遍自检，结果打在日志里，前缀是 [selftest]。
library;

import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'session.dart';
import 'timeline.dart';

final Stopwatch _sinceMain = Stopwatch();
const _selfTest = bool.fromEnvironment('SELFTEST');

void main() {
  _sinceMain.start();
  runApp(const ProtoApp());
}

class ProtoApp extends StatelessWidget {
  const ProtoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '长会话时间线',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.blueGrey, brightness: Brightness.light),
      darkTheme: ThemeData(colorSchemeSeed: Colors.blueGrey, brightness: Brightness.dark),
      home: const TimelinePage(),
    );
  }
}

/// 帧耗时：build 加 raster 超过 16.7 ms 算一次卡顿。
class FrameStats {
  final List<int> spans = [];

  void add(List<FrameTiming> timings) {
    for (final timing in timings) {
      spans.add(timing.totalSpan.inMicroseconds);
    }
  }

  void reset() => spans.clear();

  int get frames => spans.length;
  int get janky => spans.where((us) => us > 16700).length;
  double get worstMs => spans.isEmpty ? 0 : spans.reduce(math.max) / 1000;

  double percentileMs(double p) {
    if (spans.isEmpty) return 0;
    final sorted = [...spans]..sort();
    return sorted[((sorted.length - 1) * p).round()] / 1000;
  }

  String summary() {
    final ratio = frames == 0 ? '0' : (janky * 100 / frames).toStringAsFixed(1);
    return '$frames 帧，卡顿 $janky（$ratio%），p90 ${percentileMs(0.9).toStringAsFixed(1)} ms，'
        '最长 ${worstMs.toStringAsFixed(1)} ms';
  }
}

int _rssMb() => (ProcessInfo.currentRss / (1024 * 1024)).round();

class TimelinePage extends StatefulWidget {
  const TimelinePage({super.key});

  @override
  State<TimelinePage> createState() => _TimelinePageState();
}

class _TimelinePageState extends State<TimelinePage> {
  final session = ReplaySession();
  final controller = ScrollController();
  final probeKey = GlobalKey();
  final timelineKey = GlobalKey<TimelineViewState>();
  final stats = FrameStats();
  final composer = TextEditingController();
  final search = TextEditingController();
  int firstFrameMs = 0;
  String lastNote = '';

  @override
  void initState() {
    super.initState();
    SchedulerBinding.instance.addTimingsCallback(stats.add);
    WidgetsBinding.instance.addPostFrameCallback((_) => firstFrameMs = _sinceMain.elapsedMilliseconds);
    session.load().then((_) {
      if (session.missing) return;
      _note('读入 ${session.events.length} 条事件（${(session.bytes / 1024).round()} KB）用了 ${session.loadMs} ms；'
          '首帧 $firstFrameMs ms；内存 ${_rssMb()} MB');
      if (_selfTest) Future.delayed(const Duration(seconds: 2), _runSelfTest);
    });
  }

  @override
  void dispose() {
    SchedulerBinding.instance.removeTimingsCallback(stats.add);
    session.dispose();
    super.dispose();
  }

  void _note(String message) {
    debugPrint('[selftest] $message');
    if (mounted) setState(() => lastNote = message);
  }

  double? _probeY() {
    final box = probeKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.attached) return null;
    return box.localToGlobal(Offset.zero).dy;
  }

  String _drift(double? before, double? after) =>
      before == null || after == null ? '量不到' : (after - before).abs().toStringAsFixed(1);

  Future<void> _frames(int count) async {
    for (var i = 0; i < count; i++) {
      await SchedulerBinding.instance.endOfFrame;
    }
  }

  Future<void> _runSelfTest() async {
    final events = session.allTurns[session.replayIndex].items.length;
    _note('自检开始：${session.allTurns.length} 轮，回放第 ${session.replayIndex + 1} 轮（$events 项）');

    // 1. 加载更早：往上翻一些，再往历史最前面补三轮，中心线不该动。
    controller.jumpTo(math.max(controller.position.minScrollExtent, controller.position.pixels - 600));
    await _frames(3);
    final y0 = _probeY();
    final p0 = controller.position.pixels;
    final added = session.loadEarlier();
    await _frames(3);
    _note('加载更早 $added 轮：中心线移动 ${_drift(y0, _probeY())} px，'
        '滚动位置 ${p0.toStringAsFixed(1)} → ${controller.position.pixels.toStringAsFixed(1)}');

    // 2. 4 倍速回放 10 秒，贴底跟随。
    timelineKey.currentState?.jumpToBottom();
    await _frames(2);
    stats.reset();
    final rssBefore = _rssMb();
    session.setSpeed(4);
    session.play();
    await Future<void>.delayed(const Duration(seconds: 10));
    var position = controller.position;
    _note('4 倍速回放 10 秒、贴底：离底 ${(position.maxScrollExtent - position.pixels).toStringAsFixed(1)} px；'
        '下面已有 ${position.maxScrollExtent.toStringAsFixed(0)} px；${stats.summary()}');

    // 3. 在新内容里往上翻 600 px 后继续流式：内容只在下面长，正在看的地方不该动。
    controller.jumpTo(math.max(0, position.maxScrollExtent - 600));
    await _frames(3);
    final a = _probeY();
    final pa = controller.position.pixels;
    final extentBefore = controller.position.maxScrollExtent;
    for (var second = 1; second <= 6; second++) {
      await Future<void>.delayed(const Duration(seconds: 1));
      final items = session.live.isEmpty ? 0 : session.live.last.items.length;
      final running = session.live.isEmpty ? 0 : session.live.last.items.where((item) => item.running).length;
      debugPrint('[selftest]   第 $second 秒：回放到第 $items 项（$running 项运行中），'
          '新内容 ${controller.position.maxScrollExtent.toStringAsFixed(0)} px，'
          '滚动位置 ${controller.position.pixels.toStringAsFixed(0)}，中心线 ${_probeY()?.toStringAsFixed(1)}');
    }
    _note('在新内容里上翻 600 px 后继续回放 6 秒：中心线移动 ${_drift(a, _probeY())} px，'
        '滚动位置 ${pa.toStringAsFixed(1)} → ${controller.position.pixels.toStringAsFixed(1)}，'
        '下面多了 ${(controller.position.maxScrollExtent - extentBefore).toStringAsFixed(0)} px');

    // 4. 8 倍速跑完这一轮，等过程收起后再量离底。
    timelineKey.currentState?.jumpToBottom();
    session.setSpeed(8);
    final deadline = DateTime.now().add(const Duration(seconds: 120));
    while (session.playing && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    await _frames(10);
    position = controller.position;
    _note('回放结束：${stats.summary()}；离底 ${(position.maxScrollExtent - position.pixels).toStringAsFixed(1)} px；'
        '内存 $rssBefore → ${_rssMb()} MB；共 ${session.rowCount} 行');

    // 5. 全部展开：所有工具行、思考都摊开。
    stats.reset();
    final watch = Stopwatch()..start();
    session.setExpandAll(true);
    await _frames(2);
    _note('全部展开到 ${session.rowCount} 行：两帧用了 ${watch.elapsedMilliseconds} ms，${stats.summary()}，内存 ${_rssMb()} MB');

    // 6. 展开后一屏一屏往上翻。
    stats.reset();
    for (var i = 0; i < 30; i++) {
      controller.jumpTo(math.max(controller.position.minScrollExtent, controller.position.pixels - 500));
      await _frames(1);
    }
    _note('展开后往上翻 30 屏：${stats.summary()}；内存 ${_rssMb()} MB');
    session.setExpandAll(false);
    timelineKey.currentState?.jumpToBottom();
    _note('自检结束');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            _Header(session: session, search: search, onSelfTest: _runSelfTest),
            Expanded(
              child: session.missing
                  ? const Center(child: Text('先运行：dart run tool/convert_claude.dart <会话.jsonl>'))
                  : Stack(
                      children: [
                        TimelineView(key: timelineKey, session: session, controller: controller, probeKey: probeKey),
                        Positioned(top: 4, right: 8, child: _Hud(session: session, stats: stats, note: lastNote)),
                      ],
                    ),
            ),
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 8, 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: composer,
                        minLines: 1,
                        maxLines: 5,
                        style: const TextStyle(fontSize: 16),
                        decoration: const InputDecoration(
                          hintText: '回复…（试键盘和中文输入）',
                          border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(22))),
                          contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                          isDense: true,
                        ),
                      ),
                    ),
                    IconButton.filled(onPressed: composer.clear, icon: const Icon(Icons.arrow_upward)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.session, required this.search, required this.onSelfTest});

  final ReplaySession session;
  final TextEditingController search;
  final VoidCallback onSelfTest;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: session,
      builder: (context, _) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: search,
                style: const TextStyle(fontSize: 16),
                decoration: const InputDecoration(
                  hintText: '搜索（试拼音没确认就切焦点）',
                  isDense: true,
                  prefixIcon: Icon(Icons.search, size: 18),
                  border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
                ),
              ),
            ),
            IconButton(
              tooltip: session.playing ? '暂停' : '回放最长的一轮',
              onPressed: session.playing ? session.pause : session.play,
              icon: Icon(session.playing ? Icons.pause : Icons.play_arrow),
            ),
            TextButton(
              onPressed: () => session.setSpeed(switch (session.speed) { 1 => 4, 4 => 16, _ => 1 }),
              child: Text('${session.speed.toStringAsFixed(0)}×'),
            ),
            IconButton(
              tooltip: '加载更早',
              onPressed: session.canLoadEarlier ? session.loadEarlier : null,
              icon: const Icon(Icons.vertical_align_top),
            ),
            IconButton(
              tooltip: session.expandAll ? '收起' : '全部展开',
              onPressed: () => session.setExpandAll(!session.expandAll),
              icon: Icon(session.expandAll ? Icons.unfold_less : Icons.unfold_more),
            ),
            IconButton(tooltip: '自检', onPressed: onSelfTest, icon: const Icon(Icons.science_outlined)),
          ],
        ),
      ),
    );
  }
}

/// 右上角的读数：事件数、行数、帧耗时和内存，每半秒刷新，只重建自己。
class _Hud extends StatefulWidget {
  const _Hud({required this.session, required this.stats, required this.note});

  final ReplaySession session;
  final FrameStats stats;
  final String note;

  @override
  State<_Hud> createState() => _HudState();
}

class _HudState extends State<_Hud> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(milliseconds: 500), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final stats = widget.stats;
    return IgnorePointer(
      child: Container(
        constraints: const BoxConstraints(maxWidth: 260),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(6)),
        child: DefaultTextStyle(
          style: const TextStyle(color: Colors.white, fontSize: 10.5, height: 1.35),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('事件 ${widget.session.events.length} · 行 ${widget.session.rowCount} · ${_rssMb()} MB'),
              Text('${stats.frames} 帧 · 卡顿 ${stats.janky} · 最长 ${stats.worstMs.toStringAsFixed(0)} ms'),
              if (widget.note.isNotEmpty) Text(widget.note, maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
}
