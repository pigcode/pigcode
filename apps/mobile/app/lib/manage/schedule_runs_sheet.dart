import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../mobile_glass.dart';
import '../mobile_status_dot.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_utils.dart';

const _scheduleWeekdays = <int, String>{
  DateTime.monday: '周一',
  DateTime.tuesday: '周二',
  DateTime.wednesday: '周三',
  DateTime.thursday: '周四',
  DateTime.friday: '周五',
  DateTime.saturday: '周六',
  DateTime.sunday: '周日',
};

String _twoDigits(int value) => value.toString().padLeft(2, '0');

/// 将定时任务运行时刻格式化为本地易读文本：「今天 09:00」「明天 09:00」「11月20日 周五 09:00」。
String formatScheduleWhen(String iso, {DateTime? now}) {
  final parsed = DateTime.tryParse(iso)?.toLocal();
  if (parsed == null) return iso;
  final reference = (now ?? DateTime.now()).toLocal();
  final timeText = '${_twoDigits(parsed.hour)}:${_twoDigits(parsed.minute)}';
  final todayUtc = DateTime.utc(reference.year, reference.month, reference.day);
  final targetUtc = DateTime.utc(parsed.year, parsed.month, parsed.day);
  final diffDays = targetUtc.difference(todayUtc).inDays;
  if (diffDays == 0) return '今天 $timeText';
  if (diffDays == 1) return '明天 $timeText';
  if (diffDays == -1) return '昨天 $timeText';
  final weekday = _scheduleWeekdays[parsed.weekday] ?? '';
  if (parsed.year == reference.year) {
    return '${parsed.month}月${parsed.day}日 $weekday $timeText';
  }
  return '${parsed.year}年${parsed.month}月${parsed.day}日 $timeText';
}

/// 将运行历史时间戳格式化为紧凑本地日期时间。
String formatScheduleDateTime(String iso, {DateTime? now}) {
  final parsed = DateTime.tryParse(iso)?.toLocal();
  if (parsed == null) return iso;
  final reference = (now ?? DateTime.now()).toLocal();
  final timeText =
      '${_twoDigits(parsed.hour)}:${_twoDigits(parsed.minute)}:${_twoDigits(parsed.second)}';
  if (parsed.year == reference.year) {
    return '${parsed.month}月${parsed.day}日 $timeText';
  }
  return '${parsed.year}/${parsed.month}/${parsed.day} $timeText';
}

/// 计算一次运行记录的耗时；未结束或时间无效时返回 null。
String? formatScheduleRunDuration(String triggeredAt, String? finishedAt) {
  if (finishedAt == null) return null;
  final start = DateTime.tryParse(triggeredAt);
  final end = DateTime.tryParse(finishedAt);
  if (start == null || end == null) return null;
  final diff = end.difference(start);
  if (diff.isNegative) return null;
  return formatTimelineDuration(diff);
}

/// 将 Host 返回的运行记录错误码转换为中文说明。
String? scheduleRunErrorMessage(String? error) {
  final trimmed = error?.trim();
  if (trimmed == null || trimmed.isEmpty) return null;
  return switch (trimmed) {
    'THREAD_BUSY' => '会话在忙',
    'SCHEDULE_BUSY' => '上一次还没跑完',
    'AGENT_UNAVAILABLE' => 'Agent 用不了',
    'PROJECT_UNAVAILABLE' => '项目没打开，或者文件夹不在了',
    _ => trimmed,
  };
}

/// 定时任务状态中文标签。
String scheduleStatusLabel(MobileScheduleStatus status) => switch (status) {
  MobileScheduleStatus.active => '已开启',
  MobileScheduleStatus.paused => '已暂停',
  MobileScheduleStatus.completed => '已结束',
};

/// 定时任务运行记录底部面板：支持分页加载更多、查看对应会话与删除单条记录。
class ScheduleRunsSheet extends StatefulWidget {
  const ScheduleRunsSheet({
    super.key,
    required this.connectionListenable,
    required this.schedule,
    this.onOpenThread,
  });

  static const int pageSize = 20;
  static const loadMoreButtonKey = ValueKey('schedule-runs-load-more');

  static ValueKey<String> runTileKey(String runId) =>
      ValueKey('schedule-run-$runId');
  static ValueKey<String> openThreadKey(String runId) =>
      ValueKey('schedule-run-open-$runId');
  static ValueKey<String> deleteRunKey(String runId) =>
      ValueKey('schedule-run-delete-$runId');

  final ValueListenable<MobileConnection?> connectionListenable;
  final MobileSchedule schedule;
  final void Function(String threadId)? onOpenThread;

  static Future<void> show(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required MobileSchedule schedule,
    void Function(String threadId)? onOpenThread,
  }) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    const radius = BorderRadius.vertical(top: Radius.circular(22));
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: false,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      barrierColor: colors.scrim,
      barrierLabel: '关闭',
      elevation: 0,
      clipBehavior: Clip.none,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : const AnimationStyle(
              duration: Duration(milliseconds: 260),
              reverseDuration: Duration(milliseconds: 200),
            ),
      builder: (_) => MobileGlassSheetSurface(
        borderRadius: radius,
        child: SafeArea(
          top: false,
          child: ScheduleRunsSheet(
            connectionListenable: connectionListenable,
            schedule: schedule,
            onOpenThread: onOpenThread,
          ),
        ),
      ),
    );
  }

  @override
  State<ScheduleRunsSheet> createState() => _ScheduleRunsSheetState();
}

class _ScheduleRunsSheetState extends State<ScheduleRunsSheet> {
  MobileConnection? _connection;
  List<MobileScheduleRun> _runs = const [];
  int _total = 0;
  bool _loading = true;
  bool _loadingMore = false;
  final Set<String> _deletingIds = {};
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);
    unawaited(_loadInitial());
  }

  @override
  void didUpdateWidget(covariant ScheduleRunsSheet oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.connectionListenable != widget.connectionListenable) {
      oldWidget.connectionListenable.removeListener(_onConnectionChanged);
      widget.connectionListenable.addListener(_onConnectionChanged);
      _onConnectionChanged();
    }
  }

  @override
  void dispose() {
    widget.connectionListenable.removeListener(_onConnectionChanged);
    super.dispose();
  }

  void _onConnectionChanged() {
    if (!mounted) return;
    final next = widget.connectionListenable.value;
    final reconnected = next != null && !identical(next, _connection);
    setState(() => _connection = next);
    if (reconnected) {
      unawaited(_loadInitial());
    }
  }

  Future<void> _loadInitial() async {
    final conn = _connection;
    final seq = ++_seq;
    setState(() {
      _loading = true;
      _error = null;
    });
    if (conn == null) {
      setState(() {
        _loading = false;
        _error = '电脑连接已断开，重连后将自动刷新。';
      });
      return;
    }
    try {
      final page = await conn.schedules.runs(
        id: widget.schedule.id,
        limit: ScheduleRunsSheet.pageSize,
        offset: 0,
      );
      if (!mounted || seq != _seq) return;
      setState(() {
        _runs = List<MobileScheduleRun>.of(page.runs);
        _total = page.total;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _loading = false;
        _error = manageErrorMessage(error);
      });
    }
  }

  Future<void> _loadMore() async {
    final conn = _connection;
    if (conn == null || _loadingMore || _runs.length >= _total) return;
    final seq = _seq;
    setState(() => _loadingMore = true);
    try {
      final page = await conn.schedules.runs(
        id: widget.schedule.id,
        limit: ScheduleRunsSheet.pageSize,
        offset: _runs.length,
      );
      if (!mounted || seq != _seq) return;
      final existingIds = {for (final item in _runs) item.id};
      final merged = <MobileScheduleRun>[
        ..._runs,
        for (final item in page.runs)
          if (existingIds.add(item.id)) item,
      ];
      setState(() {
        _runs = merged;
        _total = page.total;
        _loadingMore = false;
      });
    } catch (error) {
      if (!mounted || seq != _seq) return;
      setState(() => _loadingMore = false);
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    }
  }

  Future<void> _deleteRun(MobileScheduleRun run) async {
    final conn = _connection;
    if (conn == null || _deletingIds.contains(run.id)) return;
    setState(() => _deletingIds.add(run.id));
    try {
      final deleted = await conn.schedules.deleteRun(id: run.id);
      if (!mounted) return;
      setState(() {
        _deletingIds.remove(run.id);
        if (deleted) {
          _runs = _runs.where((item) => item.id != run.id).toList();
          if (_total > 0) _total--;
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _deletingIds.remove(run.id));
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    }
  }

  void _handleOpenThread(String threadId) {
    final callback = widget.onOpenThread;
    if (callback == null) return;
    Navigator.of(context).pop();
    callback(threadId);
  }

  String _runStatusLabel(MobileScheduleRunStatus status) => switch (status) {
    MobileScheduleRunStatus.running => '运行中',
    MobileScheduleRunStatus.succeeded => '成功',
    MobileScheduleRunStatus.failed => '失败',
    MobileScheduleRunStatus.stopped => '已停止',
    MobileScheduleRunStatus.skipped => '已跳过',
  };

  Color _runStatusColor(
    MobileScheduleRunStatus status,
    ({
      Color running,
      Color readyMark,
      Color error,
      Color muted,
      Color attention,
    })
    palette,
  ) => switch (status) {
    MobileScheduleRunStatus.running => palette.running,
    MobileScheduleRunStatus.succeeded => palette.readyMark,
    MobileScheduleRunStatus.failed => palette.error,
    MobileScheduleRunStatus.stopped => palette.muted,
    MobileScheduleRunStatus.skipped => palette.attention,
  };

  String _runSourceLabel(MobileScheduleRunSource source) => switch (source) {
    MobileScheduleRunSource.schedule => '定时触发',
    MobileScheduleRunSource.manual => '手动运行',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final title = widget.schedule.title.trim().isEmpty
        ? '没有名字的任务'
        : widget.schedule.title.trim();

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 8, bottom: 4),
          child: SizedBox(
            width: 36,
            height: 5,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: colors.strongBorder,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsetsDirectional.only(
            start: 20,
            end: 10,
            bottom: 8,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '运行记录',
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        color: colors.foreground,
                      ),
                    ),
                    Text(
                      _total > 0 ? '$title · 共 $_total 次' : title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.metaStyle(colors.muted),
                    ),
                  ],
                ),
              ),
              MobileSheetCloseButton(onPressed: () => Navigator.pop(context)),
            ],
          ),
        ),
        Divider(height: 1, thickness: 1, color: colors.divider),
        if (_connection == null) const ManageOfflineBanner(),
        Flexible(child: _buildBody(context)),
      ],
    );
  }

  Widget _buildBody(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(child: CircularProgressIndicator.adaptive()),
      );
    }

    if (_error != null && _runs.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: 12,
          children: [
            Text(
              _error!,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: colors.muted),
            ),
            OutlinedButton(
              onPressed: _connection == null
                  ? null
                  : () => unawaited(_loadInitial()),
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    if (_runs.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 44),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: 6,
          children: [
            Icon(Icons.history, size: 30, color: colors.faint),
            Text(
              '还没运行过',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: colors.secondaryText,
                fontWeight: FontWeight.w500,
              ),
            ),
            Text(
              '到点自动运行或手动触发后，记录会显示在这里。',
              textAlign: TextAlign.center,
              style: TimelineType.metaStyle(colors.muted),
            ),
          ],
        ),
      );
    }

    final hasMore = _runs.length < _total;
    return ListView.separated(
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
      itemCount: _runs.length + (hasMore ? 1 : 0),
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, index) {
        if (index == _runs.length) {
          return Center(
            child: OutlinedButton(
              key: ScheduleRunsSheet.loadMoreButtonKey,
              onPressed: _connection == null || _loadingMore
                  ? null
                  : () => unawaited(_loadMore()),
              child: _loadingMore
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                    )
                  : Text('加载更多（已显示 ${_runs.length} / $_total）'),
            ),
          );
        }
        return _buildRunCard(context, _runs[index]);
      },
    );
  }

  Widget _buildRunCard(BuildContext context, MobileScheduleRun run) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final statusColor = _runStatusColor(run.status, (
      running: colors.running,
      readyMark: colors.readyMark,
      error: colors.error,
      muted: colors.muted,
      attention: colors.attention,
    ));
    final reason = scheduleRunErrorMessage(run.error);
    final duration = formatScheduleRunDuration(run.triggeredAt, run.finishedAt);
    final canOpenThread = run.threadId != null && widget.onOpenThread != null;
    final deleting = _deletingIds.contains(run.id);

    final content = Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 6,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: 5,
                  children: [
                    MobileStatusDot(color: statusColor),
                    Text(
                      _runStatusLabel(run.status),
                      style: TimelineType.smallStyle(
                        statusColor,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: colors.field,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  _runSourceLabel(run.source),
                  style: TimelineType.microStyle(colors.secondaryText),
                ),
              ),
              const Spacer(),
              IconButton(
                key: ScheduleRunsSheet.deleteRunKey(run.id),
                tooltip: '删除记录',
                visualDensity: VisualDensity.compact,
                onPressed: _connection == null || deleting
                    ? null
                    : () => unawaited(_deleteRun(run)),
                icon: deleting
                    ? const SizedBox.square(
                        dimension: 16,
                        child: CircularProgressIndicator.adaptive(
                          strokeWidth: 2,
                        ),
                      )
                    : Icon(Icons.delete_outline, size: 18, color: colors.muted),
              ),
            ],
          ),
          Text(
            '触发：${formatScheduleDateTime(run.triggeredAt)}',
            style: TimelineType.metaStyle(colors.foreground),
          ),
          if (run.finishedAt != null)
            Text(
              duration != null
                  ? '结束：${formatScheduleDateTime(run.finishedAt!)} · 用时 $duration'
                  : '结束：${formatScheduleDateTime(run.finishedAt!)}',
              style: TimelineType.metaStyle(colors.muted),
            )
          else if (run.status == MobileScheduleRunStatus.running)
            Text('正在执行中…', style: TimelineType.metaStyle(colors.running)),
          if (reason != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color:
                    (run.status == MobileScheduleRunStatus.skipped
                            ? colors.attention
                            : colors.error)
                        .withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                reason,
                style: TimelineType.smallStyle(
                  run.status == MobileScheduleRunStatus.skipped
                      ? colors.attention
                      : colors.error,
                ),
              ),
            ),
          if (canOpenThread)
            Padding(
              padding: const EdgeInsets.only(top: 2, right: 6),
              child: InkWell(
                key: ScheduleRunsSheet.openThreadKey(run.id),
                borderRadius: BorderRadius.circular(8),
                onTap: () => _handleOpenThread(run.threadId!),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    children: [
                      IconTheme(
                        data: IconThemeData(color: colors.secondaryText),
                        child: const WorkspaceIcon(
                          WorkspaceGlyph.messagesSquare,
                          size: 14,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        '查看会话',
                        style: TimelineType.smallStyle(
                          colors.secondaryText,
                          weight: FontWeight.w500,
                        ),
                      ),
                      const Spacer(),
                      Icon(Icons.chevron_right, size: 18, color: colors.faint),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );

    return Material(
      key: ScheduleRunsSheet.runTileKey(run.id),
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: canOpenThread
          ? InkWell(
              onTap: () => _handleOpenThread(run.threadId!),
              child: content,
            )
          : content,
    );
  }
}
