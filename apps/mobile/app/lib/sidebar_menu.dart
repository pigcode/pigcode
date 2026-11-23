import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_sheet.dart';
import 'offline_sync_label.dart';
import 'sidebar_options.dart';
import 'theme_colors.dart';
import 'thread_status.dart';
import 'workspace_icon.dart';

enum _ThreadAction { pin, read, archive }

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
    required this.onSelect,
    required this.onComputers,
    required this.focusNode,
    this.onNewThread,
    this.onSettings,
    this.commands,
  });

  final SidebarSnapshot? snapshot;
  final String? selectedId;
  final String computerName;
  final bool online;
  final ValueChanged<String> onSelect;
  final VoidCallback onComputers;
  final FocusNode focusNode;
  final ValueChanged<String?>? onNewThread;
  final VoidCallback? onSettings;
  final MobileSidebarCommands? commands;

  @override
  State<SidebarMenu> createState() => _SidebarMenuState();
}

class _SidebarMenuState extends State<SidebarMenu> {
  final _collapsed = <String>{};
  bool _searching = false;
  String _query = '';
  SidebarArrangement _arrangement = defaultSidebarArrangement;
  bool _updating = false;

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
    final action = await showMobileSheet<_ThreadAction>(
      context,
      title: thread.title,
      builder: (sheet) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!thread.archived)
              ListTile(
                leading: Icon(
                  thread.pinned ? Icons.push_pin_outlined : Icons.push_pin,
                ),
                title: Text(thread.pinned ? '取消置顶' : '置顶'),
                onTap: () => Navigator.pop(sheet, _ThreadAction.pin),
              ),
            if (thread.readTarget != null)
              ListTile(
                leading: Icon(
                  thread.unread
                      ? Icons.mark_email_read_outlined
                      : Icons.mail_outline,
                ),
                title: Text(thread.unread ? '标为已读' : '标为未读'),
                onTap: () => Navigator.pop(sheet, _ThreadAction.read),
              ),
            ListTile(
              leading: Icon(
                thread.archived
                    ? Icons.unarchive_outlined
                    : Icons.archive_outlined,
              ),
              title: Text(thread.archived ? '取消归档' : '归档'),
              onTap: () => Navigator.pop(sheet, _ThreadAction.archive),
            ),
          ],
        ),
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
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final size = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
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
      return Padding(
        padding: EdgeInsetsDirectional.only(start: nested ? 28 : 0),
        child: Semantics(
          selected: selected,
          button: true,
          child: Material(
            color: selected ? colors.selected : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => widget.onSelect(thread.id),
              onLongPress: _canEdit ? () => _showActions(thread) : null,
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: size),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 7,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              thread.title,
                              style: selected
                                  ? const TextStyle(fontWeight: FontWeight.w500)
                                  : null,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (names[thread.projectId] case final project?
                                when !nested)
                              Text(
                                project,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colors.muted,
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (marker != null) ...[
                        const SizedBox(width: 8),
                        if (thread.status == MobileThreadStatus.running)
                          Semantics(
                            label: marker,
                            child: _RunningDot(color: markerColor),
                          )
                        else if (marker == '未读')
                          Semantics(
                            label: marker,
                            child: Icon(
                              Icons.circle,
                              size: 6,
                              color: colors.online,
                            ),
                          )
                        else
                          DecoratedBox(
                            decoration: BoxDecoration(
                              color: markerColor.withValues(alpha: .12),
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 2,
                              ),
                              child: Text(
                                marker,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: markerColor,
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

    final content = <Widget>[
      Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 8, 4),
        child: Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text('Pigcode', style: theme.textTheme.titleLarge),
              ),
            ),
            IconButton(
              tooltip: _searching ? '关闭搜索' : '搜索会话',
              icon: Icon(_searching ? Icons.close : Icons.search),
              onPressed: () => setState(() {
                _searching = !_searching;
                if (!_searching) _query = '';
              }),
            ),
          ],
        ),
      ),
      if (_searching)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: TextField(
            autofocus: true,
            onChanged: (value) =>
                setState(() => _query = value.trim().toLowerCase()),
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: '搜索项目或会话',
              prefixIcon: const Icon(Icons.search, size: 20),
              filled: true,
              fillColor: colors.surface,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
      if (!widget.online && snapshot != null)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Text(
            offlineSyncLabel(context, snapshot.syncedAt),
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.secondaryText,
            ),
          ),
        ),
      if (widget.onNewThread case final create?)
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
          child: SizedBox(
            height: 50,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                alignment: AlignmentDirectional.centerStart,
                backgroundColor: colors.surface,
                foregroundColor: colors.foreground,
                shadowColor: colors.scrim,
                elevation: 1,
                textStyle: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w500,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                ),
              ),
              onPressed: () => create(null),
              icon: const WorkspaceIcon(WorkspaceGlyph.compose),
              label: const Text('新会话'),
            ),
          ),
        ),
      for (final item in <Widget>[
        if (pinned.isNotEmpty) ...[
          const ListTile(title: Text('置顶'), dense: true),
          for (final thread in pinned) row(thread),
        ],
        Padding(
          padding: const EdgeInsetsDirectional.only(start: 12),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _arrangement.archived
                      ? '已归档'
                      : _arrangement.grouping == SidebarGrouping.project
                      ? '项目'
                      : '会话',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.muted,
                  ),
                ),
              ),
              IconButton(
                tooltip: '分组和筛选',
                color: !_all || _arrangement.archived
                    ? colors.running
                    : colors.muted,
                icon: const Icon(Icons.tune, size: 20),
                onPressed: _showOptions,
              ),
            ],
          ),
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
                        child: ConstrainedBox(
                          constraints: BoxConstraints(minHeight: size),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 7,
                            ),
                            child: Row(
                              children: [
                                Icon(
                                  _collapsed.contains(project.id)
                                      ? Icons.folder_outlined
                                      : Icons.folder_open_outlined,
                                  color: colors.secondaryText,
                                  size: 18,
                                ),
                                const SizedBox(width: 8),
                                Flexible(
                                  child: Text(
                                    project.name,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                const SizedBox(width: 5),
                                Icon(
                                  _collapsed.contains(project.id)
                                      ? Icons.chevron_right
                                      : Icons.expand_more,
                                  color: colors.muted,
                                  size: 14,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    if (widget.onNewThread case final create?)
                      SizedBox.square(
                        dimension: size,
                        child: IconButton(
                          tooltip: '在${project.name}新建会话',
                          onPressed: () => create(project.id),
                          icon: const Icon(Icons.add, size: 20),
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
              child: FilledButton(
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 50),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 6,
                  ),
                  backgroundColor: colors.surface,
                  foregroundColor: colors.foreground,
                  shadowColor: colors.scrim,
                  elevation: 1,
                ),
                onPressed: widget.onComputers,
                child: Row(
                  children: [
                    Icon(
                      Icons.laptop_outlined,
                      size: 17,
                      color: colors.secondaryText,
                    ),
                    const SizedBox(width: 7),
                    Icon(
                      Icons.circle,
                      size: 6,
                      color: widget.online ? colors.online : colors.muted,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        widget.computerName,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      widget.online ? '已连接' : '离线',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.muted,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (widget.onSettings case final open?) ...[
            const SizedBox(width: 10),
            Material(
              color: colors.surface,
              shadowColor: colors.scrim,
              elevation: 1,
              shape: const CircleBorder(),
              child: SizedBox.square(
                dimension: 50,
                child: IconButton(
                  tooltip: '设置',
                  onPressed: open,
                  icon: const Icon(Icons.settings_outlined, size: 20),
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
            if (constraints.maxHeight < 160) {
              return ListView(children: [...content, footer]);
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: ListView(children: content)),
                footer,
              ],
            );
          },
        ),
      ),
    );
  }
}

class _RunningDot extends StatefulWidget {
  const _RunningDot({required this.color});
  final Color color;

  @override
  State<_RunningDot> createState() => _RunningDotState();
}

class _RunningDotState extends State<_RunningDot>
    with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 720),
    lowerBound: .42,
    value: 1,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse.stop();
      _pulse.value = 1;
    } else if (!_pulse.isAnimating) {
      _pulse.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: _pulse,
    child: Icon(Icons.circle, color: widget.color, size: 6),
  );
}
