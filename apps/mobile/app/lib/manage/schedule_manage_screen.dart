import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../mobile_status_dot.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_form_widgets.dart';
import 'manage_utils.dart';
import 'schedule_editor_screen.dart';
import 'schedule_runs_sheet.dart';

enum _ScheduleFilter { all, active, paused, completed }

final class _ScheduleTemplate {
  const _ScheduleTemplate({
    required this.id,
    required this.title,
    required this.prompt,
    required this.rule,
    required this.glyph,
  });

  final String id;
  final String title;
  final String prompt;
  final MobileScheduleRule rule;
  final WorkspaceGlyph glyph;
}

const _scheduleTemplates = <_ScheduleTemplate>[
  _ScheduleTemplate(
    id: 'standup',
    title: '每日总结',
    prompt: '总结最近一天的提交、改动和要跟进的事，写成 6 条以内的晨会总结。只看，不改文件。',
    rule: MobileScheduleRuleWeekdays(time: '09:00'),
    glyph: WorkspaceGlyph.sparkles,
  ),
  _ScheduleTemplate(
    id: 'risk',
    title: '找问题',
    prompt: '检查最近的代码改动，找出可能出错、丢数据、绕过权限或漏掉资源的地方，写上文件和行号。只看，不改文件。',
    rule: MobileScheduleRuleDaily(time: '10:00'),
    glyph: WorkspaceGlyph.shieldAlert,
  ),
  _ScheduleTemplate(
    id: 'release',
    title: '更新说明',
    prompt: '整理这一周合并的改动，按新功能、修复、体验改进和工程改进分好类，写一份能直接发布的更新说明。',
    rule: MobileScheduleRuleWeekly(days: [5], time: '16:00'),
    glyph: WorkspaceGlyph.fileText,
  ),
  _ScheduleTemplate(
    id: 'docs',
    title: '查过时文档',
    prompt: '对照最近的代码、配置和接口改动，找出文档里过时的地方，列出文件和要改的内容。',
    rule: MobileScheduleRuleWeekly(days: [3], time: '15:00'),
    glyph: WorkspaceGlyph.listChecks,
  ),
];

/// 手机端定时任务管理页：支持状态筛选、快捷模板新建、启停切换、立即运行、查看运行记录与进入编辑页。
class ScheduleManageScreen extends StatefulWidget {
  const ScheduleManageScreen({
    super.key,
    required this.connectionListenable,
    this.computerName,
    this.onOpenThread,
    this.initialProjects = const [],
  });

  static const refreshButtonKey = ValueKey('schedule-refresh-button');
  static const createButtonKey = ValueKey('schedule-create-button');
  static const filterAllKey = ValueKey('schedule-filter-all');
  static const filterActiveKey = ValueKey('schedule-filter-active');
  static const filterPausedKey = ValueKey('schedule-filter-paused');
  static const filterCompletedKey = ValueKey('schedule-filter-completed');

  static ValueKey<String> cardKey(String scheduleId) =>
      ValueKey('schedule-card-$scheduleId');
  static ValueKey<String> toggleKey(String scheduleId) =>
      ValueKey('schedule-toggle-$scheduleId');
  static ValueKey<String> runNowKey(String scheduleId) =>
      ValueKey('schedule-run-now-$scheduleId');
  static ValueKey<String> runsKey(String scheduleId) =>
      ValueKey('schedule-runs-$scheduleId');
  static ValueKey<String> templateKey(String templateId) =>
      ValueKey('schedule-template-$templateId');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String? computerName;
  final void Function(String threadId)? onOpenThread;
  final List<MobileProjectSummary> initialProjects;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    String? computerName,
    void Function(String threadId)? onOpenThread,
    List<MobileProjectSummary> initialProjects = const [],
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => ScheduleManageScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
        onOpenThread: onOpenThread,
        initialProjects: initialProjects,
      ),
    ),
  );

  @override
  State<ScheduleManageScreen> createState() => _ScheduleManageScreenState();
}

class _ScheduleManageScreenState extends State<ScheduleManageScreen> {
  MobileConnection? _connection;
  List<MobileSchedule> _schedules = const [];
  List<MobileProjectSummary> _projects = const [];
  bool _truncated = false;
  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  _ScheduleFilter _filter = _ScheduleFilter.all;
  final Set<String> _togglingIds = {};
  final Set<String> _runningIds = {};
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    _projects = List<MobileProjectSummary>.of(widget.initialProjects);
    widget.connectionListenable.addListener(_onConnectionChanged);
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant ScheduleManageScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.connectionListenable != widget.connectionListenable) {
      oldWidget.connectionListenable.removeListener(_onConnectionChanged);
      widget.connectionListenable.addListener(_onConnectionChanged);
      _onConnectionChanged();
    }
    if (!listEquals(oldWidget.initialProjects, widget.initialProjects) &&
        _projects.isEmpty &&
        widget.initialProjects.isNotEmpty) {
      _projects = List<MobileProjectSummary>.of(widget.initialProjects);
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
      unawaited(_load());
    }
  }

  Future<void> _load({bool silent = false}) async {
    final conn = _connection;
    final seq = ++_seq;
    setState(() {
      if (!silent && _schedules.isEmpty) _loading = true;
      if (silent || _schedules.isNotEmpty) _refreshing = true;
      _error = null;
    });
    if (conn == null) {
      setState(() {
        _loading = false;
        _refreshing = false;
        if (_schedules.isEmpty) {
          _error = '电脑连接已断开，重连后将自动刷新。';
        }
      });
      return;
    }

    if (_projects.isEmpty) {
      unawaited(_loadProjects(conn));
    }

    try {
      final result = await conn.schedules.list();
      if (!mounted || seq != _seq) return;
      setState(() {
        _schedules = result.schedules;
        _truncated = result.truncated;
        _loading = false;
        _refreshing = false;
      });
    } catch (error) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _loading = false;
        _refreshing = false;
        _error = manageErrorMessage(error);
      });
    }
  }

  Future<void> _loadProjects(MobileConnection conn) async {
    List<MobileProjectSummary>? loaded;
    if (connectionSupportsProjectManage(conn)) {
      try {
        final managed = await conn.projects.list();
        loaded = [
          for (final p in managed) MobileProjectSummary(id: p.id, name: p.name),
        ];
      } catch (_) {}
    }
    if (loaded == null) {
      var supportsSidebar = false;
      try {
        supportsSidebar = conn.supportsSidebar;
      } on NoSuchMethodError {
        supportsSidebar = false;
      }
      if (supportsSidebar) {
        try {
          final sidebar = await conn.openSidebar();
          final items = sidebar.snapshot?.projects;
          if (items != null) {
            loaded = List<MobileProjectSummary>.of(items);
          }
        } catch (_) {}
      }
    }
    if (!mounted || loaded == null) return;
    setState(() => _projects = loaded!);
  }

  List<MobileSchedule> get _filteredSchedules => switch (_filter) {
    _ScheduleFilter.all => _schedules,
    _ScheduleFilter.active =>
      _schedules
          .where((item) => item.status == MobileScheduleStatus.active)
          .toList(growable: false),
    _ScheduleFilter.paused =>
      _schedules
          .where((item) => item.status == MobileScheduleStatus.paused)
          .toList(growable: false),
    _ScheduleFilter.completed =>
      _schedules
          .where((item) => item.status == MobileScheduleStatus.completed)
          .toList(growable: false),
  };

  Future<void> _openEditor({
    MobileSchedule? schedule,
    _ScheduleTemplate? template,
  }) async {
    final changed = await ScheduleEditorScreen.open(
      context,
      connectionListenable: widget.connectionListenable,
      computerName: widget.computerName,
      schedule: schedule,
      projects: _projects,
      initialTitle: template?.title,
      initialPrompt: template?.prompt,
      initialRule: template?.rule,
    );
    if (!mounted || changed != true) return;
    await _load(silent: true);
  }

  Future<void> _toggleSchedule(MobileSchedule schedule, bool enabled) async {
    final conn = _connection;
    if (conn == null || _togglingIds.contains(schedule.id)) return;
    setState(() => _togglingIds.add(schedule.id));
    try {
      final updated = await conn.schedules.update(
        id: schedule.id,
        enabled: enabled,
      );
      if (!mounted) return;
      setState(() {
        _togglingIds.remove(schedule.id);
        _schedules = [
          for (final item in _schedules) item.id == updated.id ? updated : item,
        ];
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _togglingIds.remove(schedule.id));
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    }
  }

  Future<void> _runNow(MobileSchedule schedule) async {
    final conn = _connection;
    if (conn == null || _runningIds.contains(schedule.id)) return;
    setState(() => _runningIds.add(schedule.id));
    try {
      final result = await conn.schedules.runNow(id: schedule.id);
      if (!mounted) return;
      setState(() => _runningIds.remove(schedule.id));
      final message = switch (result.status) {
        MobileScheduleRunNowStatus.started => '任务开始了',
        MobileScheduleRunNowStatus.busy => '上一次还没跑完，等会再试',
        MobileScheduleRunNowStatus.unavailable => 'Agent 用不了，任务没开始',
        MobileScheduleRunNowStatus.failed => '任务没开始，去运行记录里看看',
      };
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(message)));
      if (result.status == MobileScheduleRunNowStatus.started) {
        unawaited(_load(silent: true));
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _runningIds.remove(schedule.id));
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    }
  }

  Future<void> _openRuns(MobileSchedule schedule) => ScheduleRunsSheet.show(
    context,
    connectionListenable: widget.connectionListenable,
    schedule: schedule,
    onOpenThread: widget.onOpenThread,
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: ManageAppBarTitle(
          title: '定时任务',
          computerName: widget.computerName,
        ),
        centerTitle: true,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
        leadingWidth: 58,
        leading: Align(
          alignment: AlignmentDirectional.centerStart,
          child: MobileGlassChromeButton(
            padding: const EdgeInsetsDirectional.only(start: 10),
            child: SizedBox.square(
              dimension: 40,
              child: IconButton(
                tooltip: '返回',
                padding: EdgeInsets.zero,
                onPressed: () => Navigator.maybePop(context),
                icon: const RotatedBox(
                  quarterTurns: 1,
                  child: WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 20),
                ),
              ),
            ),
          ),
        ),
        actions: [
          Center(
            child: MobileGlassChromeButton(
              padding: const EdgeInsetsDirectional.only(end: 8),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  key: ScheduleManageScreen.refreshButtonKey,
                  tooltip: '刷新',
                  padding: EdgeInsets.zero,
                  onPressed: _connection == null || _refreshing
                      ? null
                      : () => unawaited(_load(silent: true)),
                  icon: _refreshing
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator.adaptive(
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.refresh, size: 20),
                ),
              ),
            ),
          ),
          Center(
            child: MobileGlassChromeButton(
              padding: const EdgeInsetsDirectional.only(end: 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  key: ScheduleManageScreen.createButtonKey,
                  tooltip: '新建任务',
                  padding: EdgeInsets.zero,
                  onPressed: _connection == null
                      ? null
                      : () => unawaited(_openEditor()),
                  icon: const WorkspaceIcon(WorkspaceGlyph.plus, size: 20),
                ),
              ),
            ),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Divider(height: 1, thickness: 1, color: colors.divider),
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (_connection == null) const ManageOfflineBanner(),
            Expanded(child: _buildBody(context)),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_loading) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    if (_error != null && _schedules.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            spacing: 12,
            children: [
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.muted,
                ),
              ),
              OutlinedButton(
                onPressed: _connection == null
                    ? null
                    : () => unawaited(_load()),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    if (_schedules.isEmpty) {
      return RefreshIndicator.adaptive(
        onRefresh: () => _load(silent: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 32),
          children: [
            _buildEmptyHeader(context),
            const SizedBox(height: 22),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                '从模板开始',
                style: TimelineType.metaStyle(
                  colors.muted,
                  weight: FontWeight.w500,
                ),
              ),
            ),
            const SizedBox(height: 10),
            for (var i = 0; i < _scheduleTemplates.length; i++) ...[
              if (i > 0) const SizedBox(height: 10),
              _buildTemplateCard(context, _scheduleTemplates[i]),
            ],
          ],
        ),
      );
    }

    final visible = _filteredSchedules;
    return Column(
      children: [
        _buildFilterBar(context),
        Expanded(
          child: RefreshIndicator.adaptive(
            onRefresh: () => _load(silent: true),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                if (visible.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 48),
                    child: Center(
                      child: Text(
                        '没有这样的任务',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: colors.muted,
                        ),
                      ),
                    ),
                  )
                else
                  for (var i = 0; i < visible.length; i++) ...[
                    if (i > 0) const SizedBox(height: 12),
                    _buildScheduleCard(context, visible[i]),
                  ],
                if (_truncated) ...[
                  const SizedBox(height: 16),
                  Text(
                    '任务较多，已仅展示前 ${_schedules.length} 条。',
                    textAlign: TextAlign.center,
                    style: TimelineType.metaStyle(colors.muted),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildEmptyHeader(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return ManageSurfaceCard(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 22),
      children: [
        Icon(Icons.schedule, size: 30, color: colors.secondaryText),
        const SizedBox(height: 8),
        Text(
          '还没有定时任务',
          textAlign: TextAlign.center,
          style: TimelineType.contentStyle(
            colors.foreground,
            weight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          '到点自动让 Agent 干活，每次结果都在会话里',
          textAlign: TextAlign.center,
          style: TimelineType.metaStyle(colors.muted),
        ),
      ],
    );
  }

  Widget _buildTemplateCard(BuildContext context, _ScheduleTemplate template) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final enabled = _connection != null;

    return ManageSurfaceCard(
      key: ScheduleManageScreen.templateKey(template.id),
      children: [
        InkWell(
          onTap: enabled
              ? () => unawaited(_openEditor(template: template))
              : null,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 6,
              children: [
                Row(
                  children: [
                    IconTheme(
                      data: IconThemeData(
                        color: enabled ? colors.secondaryText : colors.faint,
                      ),
                      child: WorkspaceIcon(template.glyph, size: 18),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        template.title,
                        style: TimelineType.contentStyle(
                          enabled ? colors.foreground : colors.faint,
                          weight: FontWeight.w600,
                        ),
                      ),
                    ),
                    Icon(Icons.chevron_right, size: 18, color: colors.faint),
                  ],
                ),
                Text(
                  template.prompt,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TimelineType.metaStyle(colors.muted),
                ),
                Row(
                  spacing: 5,
                  children: [
                    Icon(Icons.schedule, size: 13, color: colors.faint),
                    Text(
                      describeScheduleRule(template.rule),
                      style: TimelineType.smallStyle(colors.secondaryText),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildFilterBar(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    const options = <(_ScheduleFilter, Key, String)>[
      (_ScheduleFilter.all, ScheduleManageScreen.filterAllKey, '全部'),
      (_ScheduleFilter.active, ScheduleManageScreen.filterActiveKey, '已开启'),
      (_ScheduleFilter.paused, ScheduleManageScreen.filterPausedKey, '已暂停'),
      (
        _ScheduleFilter.completed,
        ScheduleManageScreen.filterCompletedKey,
        '已结束',
      ),
    ];

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
      child: Row(
        spacing: 8,
        children: [
          for (final item in options)
            Material(
              key: item.$2,
              color: _filter == item.$1 ? colors.primary : colors.surface,
              shape: StadiumBorder(
                side: BorderSide(
                  color: _filter == item.$1 ? colors.primary : colors.border,
                ),
              ),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: () => setState(() => _filter = item.$1),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 7,
                  ),
                  child: Text(
                    item.$3,
                    style: TimelineType.smallStyle(
                      _filter == item.$1
                          ? colors.onPrimary
                          : colors.secondaryText,
                      weight: _filter == item.$1
                          ? FontWeight.w600
                          : FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildScheduleCard(BuildContext context, MobileSchedule schedule) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final online = _connection != null;
    final toggling = _togglingIds.contains(schedule.id);
    final runningNow = _runningIds.contains(schedule.id);
    final title = schedule.title.trim().isEmpty
        ? '没有名字的任务'
        : schedule.title.trim();

    final statusColor = switch (schedule.status) {
      MobileScheduleStatus.active => colors.readyMark,
      MobileScheduleStatus.paused => colors.muted,
      MobileScheduleStatus.completed => colors.faint,
    };

    final isLegacyThread = schedule.target is MobileScheduleThreadTarget;
    final targetLabel = isLegacyThread
        ? (schedule.threadTitle ?? schedule.projectName ?? '会话已删除')
        : (schedule.projectName ?? schedule.threadTitle ?? '项目已移除');

    final canToggle =
        online &&
        !toggling &&
        schedule.status != MobileScheduleStatus.completed;

    return ManageSurfaceCard(
      key: ScheduleManageScreen.cardKey(schedule.id),
      children: [
        InkWell(
          onTap: online
              ? () => unawaited(_openEditor(schedule: schedule))
              : null,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 6,
              children: [
                Row(
                  children: [
                    MobileStatusDot(color: statusColor),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TimelineType.contentStyle(
                          colors.foreground,
                          weight: FontWeight.w600,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    if (schedule.status != MobileScheduleStatus.active) ...[
                      ManageStatusTag(
                        label: scheduleStatusLabel(schedule.status),
                        background: colors.field,
                        foreground: statusColor,
                      ),
                      const SizedBox(width: 4),
                    ] else ...[
                      ManageStatusTag(
                        label: scheduleStatusLabel(schedule.status),
                        background: statusColor.withValues(alpha: 0.14),
                        foreground: statusColor,
                      ),
                      const SizedBox(width: 4),
                    ],
                    Switch.adaptive(
                      key: ScheduleManageScreen.toggleKey(schedule.id),
                      value: schedule.enabled,
                      onChanged: canToggle
                          ? (next) => unawaited(_toggleSchedule(schedule, next))
                          : null,
                    ),
                  ],
                ),
                Text(
                  schedule.prompt,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TimelineType.metaStyle(colors.secondaryText),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    _MetaBadge(
                      icon: isLegacyThread
                          ? WorkspaceGlyph.messagesSquare
                          : WorkspaceGlyph.folder,
                      label: targetLabel,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        describeScheduleRule(schedule.rule),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TimelineType.smallStyle(colors.muted),
                      ),
                    ),
                  ],
                ),
                Row(
                  children: [
                    if (schedule.status == MobileScheduleStatus.active &&
                        schedule.nextRunAt != null)
                      Expanded(
                        child: Text(
                          '下次 ${formatScheduleWhen(schedule.nextRunAt!)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TimelineType.smallStyle(colors.muted),
                        ),
                      )
                    else
                      const Spacer(),
                    Text(
                      '跑了 ${schedule.runCount} 次',
                      style: TimelineType.smallStyle(colors.muted),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
        Divider(height: 1, thickness: 1, color: colors.divider),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          child: Row(
            children: [
              TextButton.icon(
                key: ScheduleManageScreen.runNowKey(schedule.id),
                onPressed: online && !runningNow
                    ? () => unawaited(_runNow(schedule))
                    : null,
                style: TextButton.styleFrom(
                  foregroundColor: colors.foreground,
                  textStyle: TimelineType.smallStyle(
                    colors.foreground,
                    weight: FontWeight.w500,
                  ),
                ),
                icon: runningNow
                    ? const SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator.adaptive(
                          strokeWidth: 2,
                        ),
                      )
                    : const Icon(Icons.play_arrow_rounded, size: 17),
                label: const Text('现在运行'),
              ),
              const SizedBox(width: 4),
              TextButton.icon(
                key: ScheduleManageScreen.runsKey(schedule.id),
                onPressed: online ? () => unawaited(_openRuns(schedule)) : null,
                style: TextButton.styleFrom(
                  foregroundColor: colors.secondaryText,
                  textStyle: TimelineType.smallStyle(
                    colors.secondaryText,
                    weight: FontWeight.w500,
                  ),
                ),
                icon: const Icon(Icons.history, size: 16),
                label: const Text('运行记录'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MetaBadge extends StatelessWidget {
  const _MetaBadge({required this.icon, required this.label});

  final WorkspaceGlyph icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: colors.field,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        spacing: 4,
        children: [
          IconTheme(
            data: IconThemeData(color: colors.secondaryText),
            child: WorkspaceIcon(icon, size: 12),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TimelineType.smallStyle(colors.secondaryText),
            ),
          ),
        ],
      ),
    );
  }
}
