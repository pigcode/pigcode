import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:pigcode_client/pigcode_client.dart';

import 'timeline/loading_row.dart';
import 'timeline/notice_line.dart';
import 'timeline/reasoning_block.dart';
import 'timeline/summary_group.dart';
import 'timeline/tools/tool_views.dart';
import 'timeline/turn_actions.dart';
import 'timeline/user_bubble.dart';
import 'timeline/work_header.dart';
import 'timeline_widgets.dart';
import 'timeline_work.dart';
import 'workspace_icon.dart';

class TimelineView extends StatefulWidget {
  const TimelineView({
    super.key,
    required this.snapshot,
    required this.online,
    required this.loadEarlier,
    required this.content,
    this.problem,
    this.retry,
    this.changesCard,
    this.requestCard,
  });

  final TimelineSnapshot snapshot;
  final bool online;
  final Future<void> Function() loadEarlier;
  final TimelineContentLoader content;
  final String? problem;
  final VoidCallback? retry;
  final Widget Function(TimelineTurn turn)? changesCard;
  final Widget Function(TimelineTurn turn, MobileTimelineEvent request)?
  requestCard;

  @override
  State<TimelineView> createState() => _TimelineViewState();
}

typedef _Row = ({String key, int seq, Widget Function() build});

// The timeline gutter and the inner turn padding each contribute 16 pixels.
const _turnInsets = EdgeInsets.symmetric(horizontal: 32);

class _TimelineViewState extends State<TimelineView> {
  final _scroll = ScrollController();
  final _center = UniqueKey();
  final _expanded = <String>{};
  final _expandedWork = <int>{};
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
    // Older pages grow before the initial window without moving it.
    _pivot = snapshot.events.firstOrNull?.seq ?? snapshot.through + 1;
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
      final ended =
          turn.status == TimelineTurnStatus.completed ||
          turn.status == TimelineTurnStatus.failed ||
          turn.status == TimelineTurnStatus.interrupted;
      final showHeader = turn.runId != null && ended;
      final visibleWork = [
        for (final item in turn.work)
          if (!(item.kind == TimelineWorkKind.question &&
              turn.isPendingRequest(item.event.itemId)))
            item,
      ];
      final groups = !turn.folded || _expanded.contains(key)
          ? groupTimelineWork(visibleWork, _pivot)
          : const <List<TimelineWork>>[];
      final user = turn.user;
      final firstGroup = groups.firstOrNull;
      final workTouchesAbove =
          !showHeader &&
          user != null &&
          groups.length > 1 &&
          firstGroup != null &&
          ((user.seq < _pivot) == (firstGroup.first.event.seq < _pivot)) &&
          (firstGroup.length > 1 ||
              (firstGroup.first.kind == TimelineWorkKind.tool &&
                  timelineToolKind(firstGroup.first) !=
                      TimelineToolKind.other));
      if (user != null) {
        add(
          'user-$key',
          user.seq,
          () => _user(user, workTouchesAbove: workTouchesAbove),
        );
      }
      if (showHeader) {
        add(
          'summary-$key',
          turn.answer?.seq ?? turn.terminal?.seq ?? turn.firstSeq,
          () => TimelineWorkHeader(
            turn: turn,
            open: _expanded.contains(key),
            canToggle: turn.folded,
            onToggle: turn.folded
                ? () => setState(() {
                    if (!_expanded.remove(key)) _expanded.add(key);
                    _rebuildRows();
                  })
                : null,
          ),
        );
      }
      for (final (index, group) in groups.indexed) {
        final first = group.first;
        final seq = first.event.seq;
        final tail = index == groups.length - 1;
        final touchAbove = index == 0 && workTouchesAbove;
        if (group.length == 1) {
          add(
            'work-$seq',
            seq,
            () => _work(turn, first, followed: !tail, touchAbove: touchAbove),
          );
          continue;
        }
        add(
          'work-$seq',
          seq,
          () => _workGroup(turn, group, tail: tail, touchAbove: touchAbove),
        );
        if (_expandedWork.contains(seq)) {
          for (final item in group) {
            add(
              'work-member-${item.event.seq}',
              item.event.seq,
              () => DecoratedBox(
                decoration: BoxDecoration(
                  border: BorderDirectional(
                    start: BorderSide(
                      color: Theme.of(context).colorScheme.outlineVariant,
                    ),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsetsDirectional.only(start: 14),
                  child: _work(turn, item, followed: false, showIcon: false),
                ),
              ),
            );
          }
        }
      }
      for (final request in turn.pendingRequests) {
        add(
          'request-${request.seq}',
          request.seq,
          () =>
              widget.requestCard?.call(turn, request) ??
              TimelineNoticeLine(
                text: request.kind == MobileTimelineKind.approvalRequested
                    ? '有待处理的审批'
                    : '有待回答的提问',
              ),
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
            child: TimelineErrorBlock(
              text: (turn.terminal?.text?.isNotEmpty ?? false)
                  ? turn.terminal!.text!
                  : '运行失败',
            ),
          ),
        );
      }
      for (final notice in turn.notices) {
        add(
          'notice-${notice.seq}',
          notice.seq,
          () => TimelineNoticeLine(
            text: notice.text ?? 'Agent 提示',
            level: notice.kind == MobileTimelineKind.notice
                ? TimelineNoticeLevel.warning
                : TimelineNoticeLevel.info,
          ),
        );
      }
      if ((turn.changes != null && widget.changesCard != null) ||
          turn.files.isNotEmpty) {
        add(
          'files-$key',
          turn.changes?.seq ?? turn.terminal?.seq ?? turn.firstSeq,
          () =>
              widget.changesCard?.call(turn) ?? _subtle(turn.files.join(' · ')),
        );
      }
      if (turn.answer case final answer?
          when ended &&
              answer.truncated != true &&
              answer.text?.isNotEmpty == true) {
        add(
          'copy-$key',
          answer.seq,
          () => Padding(
            padding: const EdgeInsets.only(top: 4),
            child: TimelineTurnActions(
              text: answer.text!,
              createdAt: answer.createdAt,
              copyLabel: '复制回答',
            ),
          ),
        );
      }
      if (turn.status == TimelineTurnStatus.queued) {
        add(
          'loading-$key',
          turn.firstSeq,
          () => const TimelineLoadingRow(queued: true),
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
          child: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: CustomScrollView(
              key: const ValueKey('timeline-scroll'),
              controller: _scroll,
              center: _center,
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              slivers: [
                SliverPadding(
                  padding: _turnInsets,
                  sliver: SliverList.builder(
                    itemCount: _history.length + (hasEarlier ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index == _history.length) {
                        return Column(
                          children: [
                            if (_historyError case final message?)
                              Text(message),
                            TextButton(
                              onPressed: _loadingEarlier ? null : _earlier,
                              child: Text(
                                _loadingEarlier ? '正在加载…' : '加载更早的消息',
                              ),
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
                SliverToBoxAdapter(
                  key: _center,
                  child: const SizedBox.shrink(),
                ),
                SliverPadding(
                  padding: _turnInsets,
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
                    padding: _turnInsets,
                    sliver: SliverToBoxAdapter(child: _live(active)),
                  ),
                if (_history.isEmpty && _newRows.isEmpty && active == null)
                  const SliverToBoxAdapter(
                    child: Center(child: Text('这条会话还没有消息。')),
                  ),
                const SliverToBoxAdapter(child: SizedBox(height: 8)),
              ],
            ),
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
        if (!_pinned)
          Positioned(
            right: 12,
            bottom: 12,
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

  Widget _user(MobileTimelineEvent event, {required bool workTouchesAbove}) {
    return Padding(
      padding: EdgeInsets.only(
        top: 56,
        bottom:
            48 - (workTouchesAbove ? timelineWorkTouchOverhang(context) : 0),
      ),
      child: TimelineUserBubble(
        text: event.text ?? '',
        createdAt: event.createdAt,
        truncated: event.truncated == true,
        onOpenFull: widget.online ? () => _openText(event) : null,
      ),
    );
  }

  Widget _answer(
    MobileTimelineEvent event, {
    EdgeInsetsGeometry padding = const EdgeInsets.symmetric(vertical: 8),
  }) => TimelineAnswer(
    text: event.text ?? '',
    padding: padding,
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

  bool _runIsActive(TimelineTurn turn) =>
      widget.online &&
      turn.runId != null &&
      (turn.status == TimelineTurnStatus.running ||
          turn.status == TimelineTurnStatus.waiting) &&
      (widget.snapshot.live?.runId ?? _turns.lastOrNull?.runId) == turn.runId;

  WorkspaceGlyph? _toolGlyph(TimelineToolKind? tool) => switch (tool) {
    TimelineToolKind.read ||
    TimelineToolKind.search ||
    TimelineToolKind.fetch => WorkspaceGlyph.search,
    TimelineToolKind.edit => WorkspaceGlyph.pencil,
    TimelineToolKind.command ||
    TimelineToolKind.browser => WorkspaceGlyph.terminal,
    _ => null,
  };

  Widget _workGroup(
    TimelineTurn turn,
    List<TimelineWork> group, {
    required bool tail,
    required bool touchAbove,
  }) {
    final sequence = group.first.event.seq;
    final expanded = _expandedWork.contains(sequence);
    final live = widget.snapshot.live;
    final growing =
        tail &&
        _runIsActive(turn) &&
        (live?.runId != turn.runId || (live?.text.isEmpty ?? true));
    void toggle() => setState(() {
      if (!_expandedWork.remove(sequence)) _expandedWork.add(sequence);
      _rebuildRows();
    });

    if (!expanded && growing) {
      final active = group.reversed
          .where(
            (item) => item.kind == TimelineWorkKind.tool && item.output == null,
          )
          .firstOrNull;
      final preview = active ?? group.last;
      if (preview.kind == TimelineWorkKind.tool) {
        return _toolPreviewLine(
          turn,
          preview,
          followed: !tail,
          toggle: toggle,
          touchAbove: touchAbove,
        );
      }
    }

    final summary = summarizeTimelineWork(group, finished: !growing);
    return Padding(
      padding: EdgeInsets.only(bottom: tail ? 0 : 16),
      child: TimelineSummaryGroupRow(
        label: summary.label,
        icon: summary.icon,
        files: summary.filesOnly ? summary.files : const [],
        expanded: expanded,
        toggleable: true,
        onToggle: toggle,
      ),
    );
  }

  Widget _work(
    TimelineTurn turn,
    TimelineWork item, {
    required bool followed,
    bool showIcon = true,
    bool touchAbove = false,
  }) => switch (item.kind) {
    TimelineWorkKind.message => _answer(
      item.event,
      padding: EdgeInsets.only(bottom: followed ? 16 : 0),
    ),
    TimelineWorkKind.reasoning => Padding(
      padding: EdgeInsets.only(bottom: followed ? 16 : 0),
      child: TimelineReasoningBlock(
        text: item.event.text ?? '',
        truncated: item.event.truncated == true && widget.online,
        onOpenFull: () => _openText(item.event),
      ),
    ),
    TimelineWorkKind.question => TimelineWorkLine(
      label: item.result == null && _runIsActive(turn) ? '正在提问' : '问过了',
      glyph: showIcon ? WorkspaceGlyph.questionCircle : null,
      running: item.result == null && _runIsActive(turn),
      followed: followed,
    ),
    TimelineWorkKind.tool => Padding(
      padding: EdgeInsets.only(bottom: followed ? 16 : 0),
      child: TimelineToolView(
        item: item,
        ended: turn.terminal != null,
        content: widget.content,
        showIcon: showIcon,
        onOpenDetails: () => _openTool(item, turn),
      ),
    ),
  };

  void _openTool(TimelineWork item, TimelineTurn turn) {
    final input = item.input;
    final output = item.output;
    final live = widget.snapshot.live;
    final id = item.event.itemId;
    final partial = live?.runId == turn.runId && output == null
        ? live?.tools.where((tool) => tool.id == id).firstOrNull
        : null;
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
    if (sections.isEmpty) return;
    showTimelineDetails(
      context,
      item.event.name ?? '工具',
      sections,
      widget.online ? widget.content : null,
    );
  }

  /// 摘要组未展开且仍在运行时的当前项预览；只画一行，点击展开整组。
  Widget _toolPreviewLine(
    TimelineTurn turn,
    TimelineWork item, {
    required bool followed,
    required VoidCallback toggle,
    bool showIcon = true,
    bool touchAbove = false,
  }) {
    final output = item.output;
    final tool = timelineToolKind(item);
    final running = output == null && _runIsActive(turn);
    final stopped = output == null && turn.terminal != null;
    final action = switch (tool) {
      TimelineToolKind.read => '读取',
      TimelineToolKind.search => '搜索',
      TimelineToolKind.fetch => '抓取',
      TimelineToolKind.edit =>
        (item.event.name ?? '').trim().toLowerCase() == 'write' ? '写入' : '编辑',
      TimelineToolKind.mcp => '调用',
      TimelineToolKind.skill => '使用',
      TimelineToolKind.task => '处理',
      _ => '执行',
    };
    return TimelineWorkLine(
      label: output?.failed == true
          ? '执行失败'
          : stopped
          ? '已停止'
          : '${running
                ? '正在'
                : output == null
                ? ''
                : '已'}$action',
      glyph: showIcon ? _toolGlyph(tool) : null,
      detail: timelineToolDetail(item, tool),
      file: tool == TimelineToolKind.read || tool == TimelineToolKind.edit,
      running: running,
      failed: output?.failed == true,
      followed: followed,
      touchAbove: touchAbove,
      onTap: toggle,
    );
  }

  Widget _live(MobileActiveRun live) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (live.reasoning.isNotEmpty)
        TimelineReasoningBlock(
          text: live.reasoning,
          streaming: true,
          truncated: live.reasoningTruncated,
          onOpenFull: () => showTimelineDetails(context, '完整思考', [
            TimelineDetails(
              label: '思考',
              runId: live.runId,
              field: MobileTimelineContentField.reasoning,
              preview: live.reasoning,
              truncated: true,
            ),
          ], widget.content),
        ),
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
      if (live.pending.isEmpty)
        TimelineLoadingRow(
          startedAt: DateTime.tryParse(live.startedAt),
          step: live.step,
          finishedSteps: live.finishedSteps,
          totalSteps: live.totalSteps,
        ),
    ],
  );
}
