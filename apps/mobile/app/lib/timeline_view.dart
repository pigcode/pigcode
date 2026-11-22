import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:pigcode_client/pigcode_client.dart';

import 'timeline_widgets.dart';

class TimelineView extends StatefulWidget {
  const TimelineView({
    super.key,
    required this.snapshot,
    required this.online,
    required this.loadEarlier,
    required this.content,
    this.problem,
    this.retry,
  });

  final TimelineSnapshot snapshot;
  final bool online;
  final Future<void> Function() loadEarlier;
  final TimelineContentLoader content;
  final String? problem;
  final VoidCallback? retry;

  @override
  State<TimelineView> createState() => _TimelineViewState();
}

typedef _Row = ({String key, int seq, Widget Function() build});

class _TimelineViewState extends State<TimelineView> {
  final _scroll = ScrollController();
  final _center = UniqueKey();
  final _expanded = <String>{};
  late final int _pivot;
  List<TimelineTurn> _turns = const [];
  List<_Row> _history = const [];
  List<_Row> _newRows = const [];
  bool _pinned = true;
  bool _userScrolling = false;
  bool _settling = false;
  bool _loadingEarlier = false;
  String? _historyError;

  @override
  void initState() {
    super.initState();
    final snapshot = widget.snapshot;
    final activeId = snapshot.live?.runId;
    _pivot = activeId == null
        ? snapshot.through + 1
        : snapshot.events
                  .where((event) => event.runId == activeId)
                  .firstOrNull
                  ?.seq ??
              snapshot.through + 1;
    _turns = timelineTurns(snapshot.events);
    _rebuildRows();
    _follow();
  }

  @override
  void didUpdateWidget(covariant TimelineView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.snapshot.events, widget.snapshot.events)) {
      final previous = _turns;
      _turns = timelineTurns(widget.snapshot.events);
      if (!_pinned) {
        final running = previous
            .where((turn) => !turn.folded)
            .map((turn) => turn.key)
            .toSet();
        for (final turn in _turns) {
          if (turn.folded && running.contains(turn.key)) {
            _expanded.add(turn.key);
          }
        }
      }
      _rebuildRows();
    }
    if (!identical(oldWidget.snapshot, widget.snapshot)) _follow();
  }

  void _rebuildRows() {
    final history = <_Row>[];
    final after = <_Row>[];
    void add(String key, int sequence, Widget Function() build) {
      (sequence < _pivot ? history : after).add((
        key: key,
        seq: sequence,
        build: build,
      ));
    }

    for (final turn in _turns) {
      final key = turn.key;
      if (turn.user case final user?) {
        add('user-$key', user.seq, () => _user(user));
      }
      if (!turn.folded || _expanded.contains(key)) {
        for (final item in turn.work) {
          add(
            'work-${item.event.seq}',
            item.event.seq,
            () => _work(turn, item),
          );
        }
      }
      if (turn.folded) {
        add(
          'summary-$key',
          turn.terminal?.seq ?? turn.firstSeq,
          () => _summary(turn),
        );
      }
      for (final notice in turn.notices) {
        add(
          'notice-${notice.seq}',
          notice.seq,
          () => _subtle(notice.text ?? 'Agent 提示'),
        );
      }
      if (turn.answer case final answer?) {
        add('answer-${answer.seq}', answer.seq, () => _answer(answer));
      }
      if (turn.status == TimelineTurnStatus.failed) {
        add(
          'failure-$key',
          turn.terminal?.seq ?? turn.firstSeq,
          () => Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              turn.terminal?.text ?? '运行失败',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        );
      } else if (turn.status == TimelineTurnStatus.interrupted) {
        add(
          'stopped-$key',
          turn.terminal?.seq ?? turn.firstSeq,
          () => _subtle('已停下'),
        );
      }
      if (turn.files.isNotEmpty) {
        add(
          'files-$key',
          turn.terminal?.seq ?? turn.firstSeq,
          () => _subtle(turn.files.join(' · ')),
        );
      }
    }
    _history = history.reversed.toList();
    _newRows = after;
  }

  void _follow() {
    if (!_pinned || _settling || _userScrolling) return;
    _settling = true;
    double? last;
    var stable = 0;
    var frames = 0;
    void check(Duration _) {
      if (!mounted || !_pinned || _userScrolling || !_scroll.hasClients) {
        _settling = false;
        return;
      }
      final position = _scroll.position;
      final bottom = position.maxScrollExtent;
      if ((position.pixels - bottom).abs() > .5) _scroll.jumpTo(bottom);
      stable = last == bottom ? stable + 1 : 0;
      last = bottom;
      if (stable >= 2 || ++frames >= 16) {
        _settling = false;
        return;
      }
      WidgetsBinding.instance.addPostFrameCallback(check);
      WidgetsBinding.instance.scheduleFrame();
    }

    WidgetsBinding.instance.addPostFrameCallback(check);
    WidgetsBinding.instance.scheduleFrame();
  }

  bool _scrollNotification(ScrollNotification notice) {
    if (notice.depth != 0 || notice.metrics.axis != Axis.vertical) return false;
    if ((notice is ScrollStartNotification && notice.dragDetails != null) ||
        (notice is UserScrollNotification &&
            notice.direction != ScrollDirection.idle)) {
      _userScrolling = true;
    }
    if (!_userScrolling) return false;
    if (notice is ScrollEndNotification) {
      _userScrolling = false;
      final nearBottom = notice.metrics.extentAfter < 40;
      if (_pinned != nearBottom) setState(() => _pinned = nearBottom);
      _follow();
    } else if (notice.metrics.extentAfter >= 40 && _pinned) {
      setState(() => _pinned = false);
    }
    return false;
  }

  Future<void> _earlier() async {
    if (_loadingEarlier) return;
    setState(() {
      _loadingEarlier = true;
      _historyError = null;
    });
    try {
      await widget.loadEarlier();
    } catch (_) {
      if (mounted) setState(() => _historyError = '暂时无法读取更早的消息。');
    } finally {
      if (mounted) setState(() => _loadingEarlier = false);
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active = widget.online ? widget.snapshot.live : null;
    final activitySpace = timelineActivityTouchHeight(context) + 10;
    final hasEarlier = widget.online && widget.snapshot.nextBefore != null;
    return Stack(
      children: [
        NotificationListener<Notification>(
          onNotification: (notification) {
            if (notification is ScrollNotification) {
              return _scrollNotification(notification);
            }
            if (notification is ScrollMetricsNotification &&
                notification.depth == 0 &&
                notification.metrics.axis == Axis.vertical) {
              _follow();
            }
            return false;
          },
          child: CustomScrollView(
            key: const ValueKey('timeline-scroll'),
            controller: _scroll,
            center: _center,
            anchor: 1,
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverList.builder(
                  itemCount: _history.length + (hasEarlier ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (index == _history.length) {
                      return Column(
                        children: [
                          if (_historyError case final message?) Text(message),
                          TextButton(
                            onPressed: _loadingEarlier ? null : _earlier,
                            child: Text(_loadingEarlier ? '正在加载…' : '加载更早的消息'),
                          ),
                        ],
                      );
                    }
                    final row = _history[index];
                    return KeyedSubtree(
                      key: ValueKey(row.key),
                      child: row.build(),
                    );
                  },
                ),
              ),
              SliverToBoxAdapter(key: _center, child: const SizedBox.shrink()),
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                sliver: SliverList.builder(
                  itemCount: _newRows.length,
                  itemBuilder: (context, index) {
                    final row = _newRows[index];
                    return KeyedSubtree(
                      key: ValueKey(row.key),
                      child: row.build(),
                    );
                  },
                ),
              ),
              if (active != null)
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverToBoxAdapter(child: _live(active)),
                ),
              if (_history.isEmpty && _newRows.isEmpty && active == null)
                const SliverToBoxAdapter(
                  child: Center(child: Text('这条会话还没有消息。')),
                ),
              SliverToBoxAdapter(child: SizedBox(height: activitySpace)),
            ],
          ),
        ),
        if (widget.problem case final message?)
          Positioned(
            top: 4,
            left: 12,
            right: 12,
            child: Card(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(
                  children: [
                    Expanded(child: Text(message)),
                    if (widget.retry != null)
                      TextButton(
                        onPressed: widget.retry,
                        child: const Text('重试'),
                      ),
                  ],
                ),
              ),
            ),
          ),
        if (active != null)
          Positioned(
            left: 12,
            right: 12,
            bottom: 5,
            child: TimelineActivity(run: active),
          ),
        if (!_pinned)
          Positioned(
            right: 12,
            bottom: active == null ? 12 : activitySpace,
            child: IconButton.filledTonal(
              tooltip: '回到底部',
              onPressed: () {
                setState(() => _pinned = true);
                _follow();
              },
              icon: const Icon(Icons.arrow_downward),
            ),
          ),
      ],
    );
  }

  Widget _user(MobileTimelineEvent event) => Align(
    alignment: Alignment.centerRight,
    child: Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 14),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(event.text ?? ''),
          if (event.truncated == true)
            TextButton(
              onPressed: widget.online ? () => _openText(event) : null,
              child: const Text('查看完整正文'),
            ),
        ],
      ),
    ),
  );

  Widget _answer(MobileTimelineEvent event) => TimelineAnswer(
    text: event.text ?? '',
    more: widget.online && event.truncated == true
        ? () => _openText(event)
        : null,
  );

  void _openText(MobileTimelineEvent event) =>
      showTimelineDetails(context, '完整正文', [
        TimelineDetails(
          label: '正文',
          seq: event.seq,
          field: MobileTimelineContentField.text,
          preview: event.text ?? '',
          truncated: event.truncated ?? false,
        ),
      ], widget.online ? widget.content : null);

  Widget _subtle(String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Text(
      value,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
    ),
  );

  Widget _summary(TimelineTurn turn) {
    final start = DateTime.tryParse(turn.startedAt);
    final end = DateTime.tryParse(turn.terminal?.createdAt ?? '');
    final seconds = start == null || end == null
        ? 0
        : end.difference(start).inSeconds.clamp(0, 999999);
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        key: ValueKey('fold-${turn.key}'),
        onPressed: () => setState(() {
          if (!_expanded.remove(turn.key)) _expanded.add(turn.key);
          _rebuildRows();
        }),
        icon: Icon(
          _expanded.contains(turn.key) ? Icons.expand_less : Icons.expand_more,
          size: 16,
        ),
        label: Text('用时 $seconds 秒'),
      ),
    );
  }

  Widget _work(TimelineTurn turn, TimelineWork item) => switch (item.kind) {
    TimelineWorkKind.message => _answer(item.event),
    TimelineWorkKind.reasoning => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _subtle(item.event.text ?? ''),
        if (item.event.truncated == true && widget.online)
          TextButton(
            onPressed: () => _openText(item.event),
            child: const Text('查看完整过程'),
          ),
      ],
    ),
    TimelineWorkKind.question => _subtle('Agent 提出了问题'),
    TimelineWorkKind.tool => _tool(turn, item),
  };

  Widget _tool(TimelineTurn turn, TimelineWork item) {
    final output = item.output;
    final input = item.input;
    final id = item.event.itemId;
    final live = widget.snapshot.live;
    final partial = live?.runId == turn.runId && output == null
        ? live?.tools.where((tool) => tool.id == id).firstOrNull
        : null;
    final title = item.event.name ?? '工具';
    final preview = output?.text ?? partial?.text ?? input?.text;
    final sections = [
      if (input != null)
        TimelineDetails(
          label: '参数',
          field: MobileTimelineContentField.input,
          seq: input.seq,
          preview: input.text ?? '',
          truncated: input.truncated ?? false,
        ),
      if (output != null)
        TimelineDetails(
          label: '输出',
          field: MobileTimelineContentField.output,
          seq: output.seq,
          preview: output.text ?? '',
          truncated: output.truncated ?? false,
        ),
      if (partial != null)
        TimelineDetails(
          label: '输出',
          field: MobileTimelineContentField.output,
          runId: live?.runId,
          toolId: id,
          preview: partial.text,
          truncated: partial.truncated,
        ),
    ];
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        output?.failed == true
            ? Icons.error_outline
            : Icons.construction_outlined,
        size: 18,
      ),
      title: Text(title),
      subtitle: preview == null || preview.isEmpty
          ? null
          : Text(preview, maxLines: 2, overflow: TextOverflow.ellipsis),
      onTap: sections.isEmpty
          ? null
          : () => showTimelineDetails(
              context,
              title,
              sections,
              widget.online ? widget.content : null,
            ),
    );
  }

  Widget _live(MobileActiveRun live) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (live.reasoning.isNotEmpty) _subtle(live.reasoning),
      if (live.text.isNotEmpty)
        TimelineAnswer(
          text: live.text,
          streaming: true,
          more: live.textTruncated
              ? () => showTimelineDetails(context, '完整正文', [
                  TimelineDetails(
                    label: '正文',
                    runId: live.runId,
                    field: MobileTimelineContentField.text,
                    preview: live.text,
                    truncated: true,
                  ),
                ], widget.content)
              : null,
        ),
    ],
  );
}
