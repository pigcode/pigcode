import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_glass.dart';
import 'mobile_sheet.dart';
import 'mobile_status_dot.dart';
import 'offline_sync_label.dart';
import 'sidebar_options.dart';
import 'theme_colors.dart';
import 'thread_status.dart';
import 'workspace_icon.dart';

enum _ThreadAction { pin, read, archive }

enum _ProjectAction { newThread, rename, remove }

const _timeGroups = ['今天', '昨天', '最近 7 天', '最近 30 天', '更早'];

SidebarCategory _category(MobileThreadSummary thread) =>
    switch (thread.status) {
      MobileThreadStatus.waitingApproval => SidebarCategory.attention,
      MobileThreadStatus.failed => SidebarCategory.error,
      MobileThreadStatus.running ||
      MobileThreadStatus.queued => SidebarCategory.working,
      _ => thread.unread ? SidebarCategory.unread : SidebarCategory.done,
    };

String _timeGroup(MobileThreadSummary thread, DateTime now) {
  final date = DateTime.parse(thread.updatedAt).toLocal();
  final start = DateTime.utc(now.year, now.month, now.day);
  final day = DateTime.utc(date.year, date.month, date.day);
  final days = start.difference(day).inDays;
  if (days <= 0) return _timeGroups[0];
  if (days == 1) return _timeGroups[1];
  if (days < 7) return _timeGroups[2];
  if (days < 30) return _timeGroups[3];
  return _timeGroups[4];
}

class SidebarMenu extends StatefulWidget {
  const SidebarMenu({
    super.key,
    required this.snapshot,
    required this.selectedId,
    required this.computerName,
    required this.online,
    this.connectionLabel,
    required this.onSelect,
    required this.onComputers,
    required this.focusNode,
    this.onNewThread,
    this.onAddProject,
    this.onRenameProject,
    this.onRemoveProject,
    this.onSettings,
    this.commands,
    this.active = true,
  });

  static const addProjectButtonKey = ValueKey('sidebar-add-project');

  final SidebarSnapshot? snapshot;
  final String? selectedId;
  final String computerName;
  final bool online;
  final String? connectionLabel;
  final ValueChanged<String> onSelect;
  final VoidCallback onComputers;
  final FocusNode focusNode;
  final ValueChanged<String?>? onNewThread;
  final VoidCallback? onAddProject;
  final ValueChanged<MobileProjectSummary>? onRenameProject;
  final ValueChanged<MobileProjectSummary>? onRemoveProject;
  final VoidCallback? onSettings;
  final MobileSidebarCommands? commands;
  final bool active;

  @override
  State<SidebarMenu> createState() => _SidebarMenuState();
}

class _SidebarMenuState extends State<SidebarMenu> {
  final _collapsed = <String>{};
  bool _searching = false;
  String _query = '';
  SidebarArrangement _arrangement = defaultSidebarArrangement;
  bool _updating = false;
  double _headerHeight = 0;
  double _footerHeight = 0;

  bool get _canEdit => widget.online && widget.commands != null && !_updating;
  bool get _all => _arrangement.filters.length == SidebarCategory.values.length;
  bool get _attention =>
      _arrangement.filters.length == 2 &&
      _arrangement.filters.containsAll({
        SidebarCategory.attention,
        SidebarCategory.unread,
      });

  Future<void> _run(Future<void> Function(MobileSidebarCommands) change) async {
    if (!_canEdit) return;
    final commands = widget.commands!;
    setState(() => _updating = true);
    try {
      await change(commands);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('暂时无法更新会话，请重试。')));
      }
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  Future<void> _showActions(MobileThreadSummary thread) async {
    final items = [
      if (!thread.archived)
        (
          thread.pinned ? WorkspaceGlyph.pinOff : WorkspaceGlyph.pin,
          thread.pinned ? '取消置顶' : '置顶',
          _ThreadAction.pin,
        ),
      if (thread.readTarget != null)
        (
          thread.unread ? WorkspaceGlyph.mailOpen : WorkspaceGlyph.mail,
          thread.unread ? '标为已读' : '标为未读',
          _ThreadAction.read,
        ),
      (
        thread.archived
            ? WorkspaceGlyph.archiveRestore
            : WorkspaceGlyph.archive,
        thread.archived ? '取消归档' : '归档',
        _ThreadAction.archive,
      ),
    ];
    final action = await showMobileSheet<_ThreadAction>(
      context,
      title: thread.title,
      content: (sheet) => SliverList.builder(
        itemCount: items.length,
        itemBuilder: (_, index) {
          final (glyph, label, value) = items[index];
          return MobileSheetAction(
            glyph: glyph,
            label: label,
            dividerAbove: index > 0,
            onTap: () => Navigator.pop(sheet, value),
          );
        },
      ),
    );
    if (action == null || !mounted) return;
    await _run(
      (commands) => switch (action) {
        _ThreadAction.pin => commands.setPinned(thread.id, !thread.pinned),
        _ThreadAction.read => commands.markRead(thread.id, thread.unread),
        _ThreadAction.archive => commands.archive(thread.id, !thread.archived),
      },
    );
  }

  Future<void> _showProjectActions(MobileProjectSummary project) async {
    final items = [
      if (widget.onNewThread != null)
        (WorkspaceGlyph.compose, '新建会话', _ProjectAction.newThread),
      if (widget.onRenameProject != null)
        (WorkspaceGlyph.pencil, '重命名项目', _ProjectAction.rename),
      if (widget.onRemoveProject != null)
        (WorkspaceGlyph.archive, '从列表移除', _ProjectAction.remove),
    ];
    if (items.isEmpty) return;
    final action = await showMobileSheet<_ProjectAction>(
      context,
      title: project.name,
      content: (sheet) => SliverList.builder(
        itemCount: items.length,
        itemBuilder: (_, index) {
          final (glyph, label, value) = items[index];
          return MobileSheetAction(
            glyph: glyph,
            label: label,
            dividerAbove: index > 0,
            onTap: () => Navigator.pop(sheet, value),
          );
        },
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case _ProjectAction.newThread:
        widget.onNewThread?.call(project.id);
      case _ProjectAction.rename:
        widget.onRenameProject?.call(project);
      case _ProjectAction.remove:
        widget.onRemoveProject?.call(project);
    }
  }

  Future<void> _showOptions() async {
    final unread =
        widget.snapshot?.threads.any((thread) => thread.unread) ?? false;
    final markAll = await showSidebarOptions(
      context,
      current: _arrangement,
      canMarkAllRead: _canEdit && unread,
      onChanged: (arrangement) {
        if (mounted) setState(() => _arrangement = arrangement);
      },
    );
    if (mounted && markAll == true) {
      await _run((commands) => commands.markAllRead());
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isIOS = theme.platform == TargetPlatform.iOS;
    final isAndroid = theme.platform == TargetPlatform.android;
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final size = isAndroid ? 48.0 : 44.0;
    final headerInset = (56 - size) / 2;
    final textScaler = MediaQuery.textScalerOf(context);
    final pinnedHeadingTrim = isAndroid
        ? ((32 - textScaler.scale(13) * 1.45) / 2).clamp(0.0, 6.0)
        : 0.0;

    // 对齐系统字体的字形基线，点击区域仍由原来的按钮布局决定。
    Widget alignedLabel(Widget child, Offset offset) =>
        isIOS ? Transform.translate(offset: offset, child: child) : child;

    TextStyle labelStyle(
      double fontSize, {
      Color? color,
      FontWeight fontWeight = FontWeight.w400,
      double? letterSpacing,
    }) => theme.textTheme.bodyMedium!.copyWith(
      color: color,
      fontSize: fontSize,
      fontWeight: fontWeight,
      height: 1.45,
      letterSpacing: letterSpacing ?? (isIOS ? -.24 : 0),
      leadingDistribution: TextLeadingDistribution.even,
      locale: const Locale('zh', 'CN'),
    );

    Widget line(String text, TextStyle style) => SizedBox(
      height: textScaler.scale(style.fontSize!) * 1.45,
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: Text(
          text,
          style: style,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );

    final connectionText = widget.online
        ? '已连接'
        : widget.connectionLabel?.split(' · ').first ?? '电脑离线';
    final snapshot = widget.snapshot;
    final projects = snapshot?.projects ?? const <MobileProjectSummary>[];
    final names = {for (final project in projects) project.id: project.name};
    final shown = (snapshot?.threads ?? const <MobileThreadSummary>[]).where((
      thread,
    ) {
      if (thread.archived != _arrangement.archived) return false;
      if (!_arrangement.archived &&
          !_arrangement.filters.contains(_category(thread)) &&
          !(_arrangement.filters.contains(SidebarCategory.unread) &&
              thread.unread)) {
        return false;
      }
      return thread.title.toLowerCase().contains(_query) ||
          (names[thread.projectId] ?? '').toLowerCase().contains(_query);
    }).toList();
    shown.sort((a, b) {
      final rank = switch (_arrangement.sort) {
        SidebarSort.recent => 0,
        SidebarSort.title => a.title.toLowerCase().compareTo(
          b.title.toLowerCase(),
        ),
        SidebarSort.status => _category(a).index.compareTo(_category(b).index),
      };
      if (rank != 0) return rank;
      final updated = b.updatedAt.compareTo(a.updatedAt);
      return updated == 0 ? a.id.compareTo(b.id) : updated;
    });
    final pinned = shown
        .where((thread) => thread.pinned && !thread.archived)
        .toList();
    final matchingProjects = shown.map((thread) => thread.projectId).toSet();
    final grouped = <String, List<MobileThreadSummary>>{};
    final now = DateTime.now();
    for (final thread in shown) {
      if (!thread.pinned || thread.archived) {
        final group = switch (_arrangement.grouping) {
          SidebarGrouping.project => thread.projectId,
          SidebarGrouping.time => _timeGroup(thread, now),
          SidebarGrouping.status =>
            thread.unread && _category(thread) == SidebarCategory.unread
                ? '需要处理'
                : sidebarCategoryLabels[_category(thread)]!,
        };
        grouped.putIfAbsent(group, () => []).add(thread);
      }
    }

    Widget row(MobileThreadSummary thread, {bool nested = false}) {
      final marker = widget.online ? threadMarker(thread) : null;
      final markerColor = switch (thread.status) {
        MobileThreadStatus.failed => colors.error,
        MobileThreadStatus.waitingApproval => colors.attention,
        MobileThreadStatus.running ||
        MobileThreadStatus.queued => colors.running,
        _ => colors.muted,
      };
      final selected = widget.selectedId == thread.id;
      final titleStyle = TextStyle(
        fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
        color: thread.archived ? colors.muted : colors.foreground,
        letterSpacing: isIOS ? -.29 : 0,
      );
      return Semantics(
        selected: selected,
        button: true,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () => widget.onSelect(thread.id),
            onLongPress: _canEdit ? () => _showActions(thread) : null,
            child: Ink(
              decoration: BoxDecoration(
                color: selected ? colors.selected : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: EdgeInsetsDirectional.fromSTEB(
                    nested ? 40 : 12,
                    4,
                    12,
                    4,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (nested)
                              alignedLabel(
                                Text(
                                  thread.title,
                                  style: titleStyle,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const Offset(0, -1 / 3),
                              )
                            else
                              line(
                                thread.title,
                                labelStyle(15).merge(titleStyle),
                              ),
                            if (names[thread.projectId] case final project?
                                when !nested)
                              line(
                                project,
                                labelStyle(
                                  12,
                                  color: colors.muted,
                                  letterSpacing: isIOS ? -.039 : 0,
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (marker != null) ...[
                        const SizedBox(width: 10),
                        if (thread.status == MobileThreadStatus.running)
                          Semantics(
                            label: marker,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 4,
                              ),
                              child: MobileRunningDotMatrix(
                                color: colors.statusAccent,
                              ),
                            ),
                          )
                        else if (marker == '未读')
                          Semantics(
                            label: marker,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 4,
                              ),
                              child: MobileStatusDot(color: colors.readyMark),
                            ),
                          )
                        else
                          DecoratedBox(
                            decoration: BoxDecoration(
                              color: switch (thread.status) {
                                MobileThreadStatus.failed => colors.errorTint,
                                MobileThreadStatus.waitingApproval =>
                                  colors.attentionTint,
                                _ => markerColor.withValues(alpha: .12),
                              },
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 2,
                              ),
                              child: line(
                                marker,
                                labelStyle(
                                  12,
                                  color: markerColor,
                                  fontWeight: FontWeight.w500,
                                  letterSpacing: isIOS ? -.24 : -.039,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    Widget groupLabel(String label, {bool withOptions = false}) => Padding(
      padding: const EdgeInsetsDirectional.only(start: 12, end: 2),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          // 文字按 Android 的字形基线上移留出空间，块高仍按原型保留 40。
          minHeight: withOptions ? 46 : 40,
        ),
        child: Row(
          children: [
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(
                  top: withOptions ? 8 : 8 + pinnedHeadingTrim,
                ),
                child: withOptions
                    ? line(label, labelStyle(13, color: colors.muted))
                    : alignedLabel(
                        line(label, labelStyle(13, color: colors.muted)),
                        const Offset(0, 1 / 3),
                      ),
              ),
            ),
            if (withOptions &&
                widget.online &&
                widget.onAddProject != null &&
                !_arrangement.archived &&
                _arrangement.grouping == SidebarGrouping.project)
              SizedBox.square(
                dimension: size < 46 ? size : 46,
                child: IconButton(
                  key: SidebarMenu.addProjectButtonKey,
                  tooltip: '添加项目',
                  color: colors.muted,
                  padding: EdgeInsetsDirectional.only(
                    end: 4,
                    bottom: size == 48 ? 10 : 9,
                  ),
                  alignment: AlignmentDirectional.bottomEnd,
                  icon: const WorkspaceIcon(WorkspaceGlyph.plus, size: 18),
                  onPressed: widget.onAddProject,
                ),
              ),
            if (withOptions)
              SizedBox.square(
                // 原型的分组标题高 46，图标保持原位置。
                dimension: size < 46 ? size : 46,
                child: IconButton(
                  tooltip: '分组和筛选',
                  color: !_all || _arrangement.archived
                      ? colors.running
                      : colors.muted,
                  padding: EdgeInsetsDirectional.only(
                    end: 8,
                    bottom: size == 48 ? 10 : 9,
                  ),
                  alignment: AlignmentDirectional.bottomEnd,
                  icon: const WorkspaceIcon(WorkspaceGlyph.sliders, size: 18),
                  onPressed: _showOptions,
                ),
              ),
          ],
        ),
      ),
    );

    final header = <Widget>[
      Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          20,
          headerInset + 3,
          8,
          headerInset - 3,
        ),
        child: Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: alignedLabel(
                  Text(
                    'Pigcode',
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontSize: 22,
                      fontWeight: FontWeight.w500,
                      height: 1.45,
                      letterSpacing: isAndroid ? -.24 : null,
                      leadingDistribution: TextLeadingDistribution.even,
                    ),
                  ),
                  const Offset(1, -1),
                ),
              ),
            ),
            SizedBox.square(
              dimension: size,
              child: IconButton(
                tooltip: _searching ? '关闭搜索' : '搜索会话',
                padding: EdgeInsetsDirectional.only(
                  end: _searching ? 12 : 10.5,
                ),
                alignment: AlignmentDirectional.centerEnd,
                icon: _searching
                    ? const Icon(Icons.close, size: 18)
                    : const WorkspaceIcon(WorkspaceGlyph.search, size: 21),
                onPressed: () => setState(() {
                  _searching = !_searching;
                  if (!_searching) _query = '';
                }),
              ),
            ),
          ],
        ),
      ),
      if (_searching)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: MobileGlassSurface(
            borderRadius: const BorderRadius.all(Radius.circular(14)),
            blurSigma: 14,
            useNativeGlass: widget.active,
            child: Material(
              type: MaterialType.transparency,
              child: TextField(
                autofocus: true,
                onChanged: (value) =>
                    setState(() => _query = value.trim().toLowerCase()),
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  hintText: '搜索项目或会话',
                  prefixIcon: Icon(Icons.search, size: 20),
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 12,
                  ),
                ),
              ),
            ),
          ),
        ),
      if (widget.onNewThread case final create?)
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 50),
            child: MobileGlassSurface(
              borderRadius: const BorderRadius.all(Radius.circular(16)),
              blurSigma: 16,
              useNativeGlass: widget.active,
              child: Material(
                type: MaterialType.transparency,
                child: TextButton(
                  style: TextButton.styleFrom(
                    alignment: AlignmentDirectional.centerStart,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    foregroundColor: colors.foreground,
                    textStyle: labelStyle(16, fontWeight: FontWeight.w500),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  onPressed: () => create(null),
                  child: Row(
                    children: [
                      const WorkspaceIcon(WorkspaceGlyph.compose),
                      const SizedBox(width: 10),
                      Flexible(
                        child: alignedLabel(
                          const Text('新会话'),
                          const Offset(0, -2 / 3),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
    ];
    final content = <Widget>[
      if (!widget.online && snapshot != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
          child: Text(
            '离线 · ${offlineSyncLabel(snapshot.syncedAt)}',
            style: labelStyle(12, color: colors.muted),
          ),
        ),
      for (final item in <Widget>[
        if (pinned.isNotEmpty) ...[
          groupLabel('置顶'),
          for (final thread in pinned) row(thread),
        ],
        groupLabel(
          _arrangement.archived
              ? '已归档'
              : _arrangement.grouping == SidebarGrouping.project
              ? '项目'
              : '会话',
          withOptions: true,
        ),
        if (_arrangement.grouping == SidebarGrouping.project)
          for (final project in projects)
            if (matchingProjects.contains(project.id) ||
                (!_arrangement.archived &&
                    _all &&
                    project.name.toLowerCase().contains(_query))) ...[
              if (_arrangement.archived)
                ListTile(title: Text(project.name), dense: true)
              else
                Row(
                  children: [
                    Expanded(
                      child: InkWell(
                        onTap: () => setState(() {
                          if (!_collapsed.remove(project.id)) {
                            _collapsed.add(project.id);
                          }
                        }),
                        onLongPress:
                            widget.online &&
                                (widget.onRenameProject != null ||
                                    widget.onRemoveProject != null)
                            ? () => _showProjectActions(project)
                            : null,
                        child: ConstrainedBox(
                          // 原型项目行高 44；Android 的 48 触区由相邻留白承担。
                          constraints: const BoxConstraints(minHeight: 44),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 7,
                            ),
                            child: Row(
                              children: [
                                IconTheme(
                                  data: IconThemeData(
                                    color: colors.secondaryText,
                                  ),
                                  child: WorkspaceIcon(
                                    _collapsed.contains(project.id)
                                        ? WorkspaceGlyph.folder
                                        : WorkspaceGlyph.folderOpen,
                                    size: 18,
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Flexible(
                                  child: alignedLabel(
                                    Text(
                                      project.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: labelStyle(15),
                                    ),
                                    const Offset(0, -1 / 3),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                IconTheme(
                                  data: IconThemeData(color: colors.faint),
                                  child: RotatedBox(
                                    quarterTurns:
                                        _collapsed.contains(project.id) ? 3 : 0,
                                    child: const WorkspaceIcon(
                                      WorkspaceGlyph.chevronDown,
                                      size: 14,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    if (widget.onNewThread case final create?)
                      SizedBox.square(
                        dimension: size < 44 ? size : 44,
                        child: IconButton(
                          tooltip: '在${project.name}新建会话',
                          onPressed: () => create(project.id),
                          color: colors.muted,
                          padding: const EdgeInsetsDirectional.only(end: 9),
                          alignment: AlignmentDirectional.centerEnd,
                          icon: const WorkspaceIcon(
                            WorkspaceGlyph.plus,
                            size: 18,
                          ),
                        ),
                      ),
                  ],
                ),
              if (_arrangement.archived ||
                  !_collapsed.contains(project.id) ||
                  _query.isNotEmpty)
                for (final thread
                    in grouped[project.id] ?? const <MobileThreadSummary>[])
                  row(thread, nested: true),
            ],
        if (_arrangement.grouping != SidebarGrouping.project)
          for (final label
              in _arrangement.grouping == SidebarGrouping.time
                  ? _timeGroups
                  : const ['需要处理', '出错', '进行中', '已完成'])
            if (grouped[label] case final threads?) ...[
              ListTile(title: Text(label), dense: true),
              for (final thread in threads) row(thread),
            ],
        if (snapshot != null && shown.isEmpty)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(
              _query.isNotEmpty
                  ? '没有匹配的会话'
                  : _arrangement.archived
                  ? '没有已归档的会话'
                  : _attention
                  ? '没有需要处理的会话'
                  : '没有会话',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.secondaryText,
              ),
            ),
          ),
      ])
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: item,
        ),
    ];
    final footer = Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              label: '管理电脑',
              child: MobileGlassSurface(
                blurSigma: 16,
                useNativeGlass: widget.active,
                child: Material(
                  type: MaterialType.transparency,
                  shape: const StadiumBorder(),
                  child: TextButton(
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 50),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 6,
                      ),
                      foregroundColor: colors.foreground,
                      textStyle: labelStyle(14),
                    ),
                    onPressed: widget.onComputers,
                    child: Row(
                      children: [
                        IconTheme(
                          data: IconThemeData(color: colors.secondaryText),
                          child: const WorkspaceIcon(
                            WorkspaceGlyph.laptop,
                            size: 18,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: LayoutBuilder(
                            builder: (context, constraints) => Row(
                              mainAxisSize: MainAxisSize.min,
                              spacing: 6,
                              children: [
                                MobileStatusDot(
                                  color: widget.online
                                      ? colors.readyMark
                                      : colors.faint,
                                ),
                                Flexible(
                                  child: Text(
                                    widget.computerName,
                                    overflow: TextOverflow.ellipsis,
                                    maxLines: 1,
                                    style: TextStyle(
                                      fontWeight: FontWeight.w500,
                                      letterSpacing: isAndroid ? .2 : null,
                                    ),
                                  ),
                                ),
                                ConstrainedBox(
                                  constraints: BoxConstraints(
                                    maxWidth: constraints.maxWidth * .6,
                                  ),
                                  child: Text(
                                    connectionText,
                                    style: TextStyle(color: colors.muted),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (widget.onSettings case final open?) ...[
            const SizedBox(width: 10),
            MobileGlassSurface(
              blurSigma: 16,
              useNativeGlass: widget.active,
              child: Material(
                type: MaterialType.transparency,
                shape: const CircleBorder(),
                child: SizedBox.square(
                  dimension: 50,
                  child: IconButton(
                    tooltip: '设置',
                    onPressed: open,
                    icon: const WorkspaceIcon(WorkspaceGlyph.settings),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
    return Material(
      color: colors.window,
      child: Focus(
        focusNode: widget.focusNode,
        child: LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxHeight < 320 || textScaler.scale(22) > 44) {
              return SafeArea(
                child: ListView(children: [...header, ...content, footer]),
              );
            }
            final mediaPadding = MediaQuery.paddingOf(context);
            final topFallback =
                mediaPadding.top +
                56 +
                (widget.onNewThread != null ? 60 : 0) +
                (_searching ? 56 : 0);
            final bottomFallback = mediaPadding.bottom + 68;
            final listTop = _headerHeight > 0 ? _headerHeight : topFallback;
            final listBottom =
                (_footerHeight > 0 ? _footerHeight : bottomFallback) + 12;

            return Stack(
              fit: StackFit.expand,
              children: [
                Positioned.fill(
                  child: ListView(
                    padding: EdgeInsets.only(top: listTop, bottom: listBottom),
                    children: content,
                  ),
                ),
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: MobileTopGlassVeil(
                    height: listTop + 14,
                    color: colors.window,
                  ),
                ),
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: MobileMeasureSize(
                    onChange: (measured) {
                      if (!mounted) return;
                      if ((_headerHeight - measured.height).abs() > 0.5) {
                        setState(() => _headerHeight = measured.height);
                      }
                    },
                    child: SafeArea(
                      bottom: false,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: header,
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: MobileBottomGlassVeil(
                    height: listBottom + 10,
                    color: colors.window,
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: MobileMeasureSize(
                    onChange: (measured) {
                      if (!mounted) return;
                      if ((_footerHeight - measured.height).abs() > 0.5) {
                        setState(() => _footerHeight = measured.height);
                      }
                    },
                    child: SafeArea(top: false, child: footer),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
