/// 回放用的会话：从 assets/session.json 读出线程事件，按轮整理成时间线上的行。
///
/// 打开时只放最近的一段历史在中心线以上（参照 DSH Go：至少两轮、50 行），「加载更早」往上补；
/// 最长的那一轮在中心线以下按原来的节奏回放，回复逐字流出，命令输出逐行流出。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

enum ItemKind { user, assistant, reasoning, tool }

class TimelineItem {
  TimelineItem(this.id, this.kind, String text, {this.toolName, this.input}) : text = ValueNotifier(text);

  final String id;
  final ItemKind kind;

  /// 正文；工具行放的是输出。流式时一点点变长。
  final ValueNotifier<String> text;
  final String? toolName;
  final Map<String, dynamic>? input;
  final ValueNotifier<bool> expanded = ValueNotifier(false);
  bool running = false;
  bool streaming = false;
  int? exitCode;
}

class Turn {
  Turn(this.index);

  final int index;
  final List<TimelineItem> items = [];
  bool done = false;

  /// 跑完的轮默认收成一行，点开后展开。
  bool expanded = false;

  int get toolCount => items.where((item) => item.kind == ItemKind.tool).length;
  int get thoughtCount => items.where((item) => item.kind == ItemKind.reasoning).length;
}

enum RowKind { item, summary }

/// 时间线上的一行：一个条目，或者跑完那一轮的摘要行。
class RowRef {
  RowRef.item(TimelineItem this.item, this.turn) : kind = RowKind.item;
  RowRef.summary(this.turn)
      : kind = RowKind.summary,
        item = null;

  final RowKind kind;
  final TimelineItem? item;
  final Turn turn;

  String get id => item?.id ?? 'summary-${turn.index}';
}

/// 一轮在时间线上的行：运行中全部展开；跑完以后只留用户消息、摘要行和最后的回答。
List<RowRef> rowsOf(Turn turn, {required bool expandAll}) {
  final rows = <RowRef>[];
  final user = turn.items.where((item) => item.kind == ItemKind.user).firstOrNull;
  if (!turn.done) return [for (final item in turn.items) RowRef.item(item, turn)];
  if (user != null) rows.add(RowRef.item(user, turn));
  rows.add(RowRef.summary(turn));
  if (turn.expanded || expandAll) {
    rows.addAll([for (final item in turn.items) if (item != user) RowRef.item(item, turn)]);
    return rows;
  }
  final answer = turn.items.lastWhere((item) => item.kind == ItemKind.assistant, orElse: () => user ?? turn.items.last);
  if (answer != user) rows.add(RowRef.item(answer, turn));
  return rows;
}

class ReplaySession extends ChangeNotifier {
  List<Map<String, dynamic>> events = const [];
  int loadMs = 0;
  int bytes = 0;
  bool missing = false;

  /// 全部的轮，按时间顺序；最长的那一轮留给回放，不放进历史。
  final List<Turn> allTurns = [];
  final List<Turn> history = [];
  final List<Turn> live = [];
  int _historyStart = 0;
  int replayIndex = 0;

  bool expandAll = false;
  double speed = 1;
  bool playing = false;

  /// 流式的每一小段都加一，时间线靠它判断要不要跟到底。
  final ValueNotifier<int> tick = ValueNotifier(0);

  List<Map<String, dynamic>> _replayEvents = const [];
  int _cursor = 0;
  Timer? _timer;
  Turn? _liveTurn;
  final Map<String, TimelineItem> _liveTools = {};

  int get rowCount =>
      [...history, ...live].fold(0, (sum, turn) => sum + rowsOf(turn, expandAll: expandAll).length);

  Future<void> load() async {
    final watch = Stopwatch()..start();
    final String raw;
    try {
      raw = await rootBundle.loadString('assets/session.json');
    } catch (_) {
      missing = true;
      notifyListeners();
      return;
    }
    bytes = raw.length;
    final decoded = jsonDecode(raw) as Map<String, dynamic>;
    events = (decoded['events'] as List).cast<Map<String, dynamic>>();
    loadMs = watch.elapsedMilliseconds;
    _buildTurns();
    _openWindow();
    notifyListeners();
  }

  void _buildTurns() {
    final byRun = <String, List<Map<String, dynamic>>>{};
    final order = <String>[];
    for (final event in events) {
      final run = event['runId'] as String?;
      if (run == null) continue;
      if (!byRun.containsKey(run)) order.add(run);
      byRun.putIfAbsent(run, () => []).add(event);
    }
    var longest = 0;
    for (final (index, run) in order.indexed) {
      final turn = Turn(index);
      final tools = <String, TimelineItem>{};
      for (final event in byRun[run]!) {
        _apply(turn, tools, event);
      }
      turn.done = true;
      allTurns.add(turn);
      if (byRun[run]!.length > longest) {
        longest = byRun[run]!.length;
        replayIndex = index;
      }
    }
    _replayEvents = byRun[order[replayIndex]] ?? const [];
  }

  /// 打开时的窗口：回放那一轮之前，从后往前取，至少两轮、50 行。
  void _openWindow() {
    var start = replayIndex;
    var rows = 0;
    while (start > 0 && (replayIndex - start < 2 || rows < 50)) {
      start -= 1;
      rows += allTurns[start].items.length;
    }
    _historyStart = start;
    history
      ..clear()
      ..addAll(allTurns.sublist(start, replayIndex));
  }

  bool get canLoadEarlier => _historyStart > 0;

  /// 往上补三轮；只往历史的最前面加，已经在屏幕上的行不动。
  int loadEarlier() {
    if (!canLoadEarlier) return 0;
    final start = math.max(0, _historyStart - 3);
    history.insertAll(0, allTurns.sublist(start, _historyStart));
    final added = _historyStart - start;
    _historyStart = start;
    notifyListeners();
    return added;
  }

  void setExpandAll(bool value) {
    expandAll = value;
    notifyListeners();
  }

  void toggleTurn(Turn turn) {
    turn.expanded = !turn.expanded;
    notifyListeners();
  }

  void setSpeed(double value) {
    speed = value;
    notifyListeners();
  }

  void _apply(Turn turn, Map<String, TimelineItem> tools, Map<String, dynamic> event) {
    final payload = (event['payload'] as Map?)?.cast<String, dynamic>() ?? const {};
    final id = 't${turn.index}-${event['seq']}';
    switch (event['type']) {
      case 'run.started':
        turn.items.add(TimelineItem(id, ItemKind.user, payload['text'] as String? ?? ''));
      case 'reasoning.completed':
        turn.items.add(TimelineItem(id, ItemKind.reasoning, payload['text'] as String? ?? ''));
      case 'message.completed':
        turn.items.add(TimelineItem(id, ItemKind.assistant, payload['text'] as String? ?? ''));
      case 'tool.started':
        final item = TimelineItem(id, ItemKind.tool, '',
            toolName: payload['name'] as String? ?? 'tool', input: (payload['input'] as Map?)?.cast<String, dynamic>());
        item.running = true;
        tools[payload['toolCallId'] as String? ?? id] = item;
        turn.items.add(item);
      case 'tool.completed':
        final item = tools[payload['toolCallId'] as String? ?? ''];
        if (item == null) return;
        item
          ..running = false
          ..exitCode = payload['exitCode'] as int?
          ..text.value = payload['output'] as String? ?? '';
    }
  }

  // ─── 回放 ──────────────────────────────────────────────

  void play() {
    if (playing) return;
    if (_liveTurn == null || _cursor >= _replayEvents.length) {
      _liveTurn = Turn(allTurns.length + live.length);
      live.add(_liveTurn!);
      _liveTools.clear();
      _cursor = 0;
    }
    playing = true;
    notifyListeners();
    _step();
  }

  void pause() {
    playing = false;
    _timer?.cancel();
    notifyListeners();
  }

  Duration _scaled(int ms) => Duration(microseconds: (ms * 1000 / speed).round());

  void _step() {
    if (!playing) return;
    final turn = _liveTurn!;
    if (_cursor >= _replayEvents.length) {
      turn.done = true;
      playing = false;
      notifyListeners();
      return;
    }
    final event = _replayEvents[_cursor];
    final next = _cursor + 1 < _replayEvents.length ? _replayEvents[_cursor + 1] : null;
    _cursor += 1;
    final gap = next == null
        ? 0
        : DateTime.parse(next['createdAt'] as String).difference(DateTime.parse(event['createdAt'] as String)).inMilliseconds;
    final delay = _scaled(gap.clamp(40, 900));
    void then() => _timer = Timer(delay, _step);

    final payload = (event['payload'] as Map?)?.cast<String, dynamic>() ?? const {};
    switch (event['type']) {
      case 'message.completed':
        final item = TimelineItem('live-${event['seq']}', ItemKind.assistant, '')..streaming = true;
        turn.items.add(item);
        notifyListeners();
        _streamText(item, payload['text'] as String? ?? '', then);
      case 'tool.completed':
        final item = _liveTools[payload['toolCallId'] as String? ?? ''];
        if (item == null) return then();
        final output = payload['output'] as String? ?? '';
        if (item.toolName == 'Bash' && output.contains('\n')) {
          _streamLines(item, output, () {
            item
              ..running = false
              ..exitCode = payload['exitCode'] as int?;
            notifyListeners();
            then();
          });
        } else {
          item
            ..running = false
            ..exitCode = payload['exitCode'] as int?
            ..text.value = output;
          notifyListeners();
          then();
        }
      default:
        _apply(turn, _liveTools, {...event, 'seq': 'live-${event['seq']}'});
        notifyListeners();
        then();
    }
  }

  void _streamText(TimelineItem item, String text, VoidCallback done) {
    var at = 0;
    _timer = Timer.periodic(_scaled(40), (timer) {
      if (!playing) return timer.cancel();
      at = math.min(text.length, at + 6);
      item.text.value = text.substring(0, at);
      tick.value += 1;
      if (at >= text.length) {
        timer.cancel();
        item.streaming = false;
        notifyListeners();
        done();
      }
    });
  }

  void _streamLines(TimelineItem item, String output, VoidCallback done) {
    final lines = output.split('\n');
    final shown = math.min(lines.length, 300);
    var at = 0;
    _timer = Timer.periodic(_scaled(25), (timer) {
      if (!playing) return timer.cancel();
      at = math.min(shown, at + 2);
      item.text.value = lines.take(at).join('\n');
      tick.value += 1;
      if (at >= shown) {
        timer.cancel();
        item.text.value = output;
        done();
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
