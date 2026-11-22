import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'theme_colors.dart';
import 'thread_status.dart';

enum _Filter { all, attention, archived }

enum _Sort { recent, title }

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
  });

  final SidebarSnapshot? snapshot;
  final String? selectedId;
  final String computerName;
  final bool online;
  final ValueChanged<String> onSelect;
  final VoidCallback onComputers;
  final FocusNode focusNode;

  @override
  State<SidebarMenu> createState() => _SidebarMenuState();
}

class _SidebarMenuState extends State<SidebarMenu> {
  final _collapsed = <String>{};
  String _query = '';
  _Filter _filter = _Filter.all;
  _Sort _sort = _Sort.recent;

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
      if (thread.archived != (_filter == _Filter.archived)) return false;
      if (_filter == _Filter.attention && !needsAttention(thread)) return false;
      return thread.title.toLowerCase().contains(_query) ||
          (names[thread.projectId] ?? '').toLowerCase().contains(_query);
    }).toList();
    if (_sort == _Sort.title) {
      shown.sort(
        (a, b) => a.title.toLowerCase().compareTo(b.title.toLowerCase()),
      );
    }
    final pinned = shown.where((thread) => thread.pinned && !thread.archived);
    final grouped = <String, List<MobileThreadSummary>>{};
    for (final thread in shown) {
      if (!thread.pinned || thread.archived) {
        grouped.putIfAbsent(thread.projectId, () => []).add(thread);
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
                        child: Text(
                          thread.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (marker != null) ...[
                        const SizedBox(width: 8),
                        if (thread.status == MobileThreadStatus.running) ...[
                          _RunningDot(color: markerColor),
                          const SizedBox(width: 5),
                        ],
                        Text(
                          marker,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: markerColor,
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
            PopupMenuButton<_Sort>(
              tooltip: '会话排序',
              initialValue: _sort,
              icon: const Icon(Icons.sort),
              onSelected: (value) => setState(() => _sort = value),
              itemBuilder: (context) => const [
                PopupMenuItem(value: _Sort.recent, child: Text('最近更新')),
                PopupMenuItem(value: _Sort.title, child: Text('按名称')),
              ],
            ),
          ],
        ),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: TextField(
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
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Wrap(
          spacing: 6,
          children: [
            for (final (value, label) in const [
              (_Filter.all, '全部'),
              (_Filter.attention, '需要处理'),
              (_Filter.archived, '已归档'),
            ])
              FilterChip(
                label: Text(label),
                selected: _filter == value,
                onSelected: (_) => setState(() => _filter = value),
              ),
          ],
        ),
      ),
      if (!widget.online && snapshot != null)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Text(
            '上次同步 ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(snapshot.syncedAt))}',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.secondaryText,
            ),
          ),
        ),
      for (final item in <Widget>[
        if (pinned.isNotEmpty) ...[
          const ListTile(title: Text('置顶'), dense: true),
          for (final thread in pinned) row(thread),
        ],
        for (final project in projects)
          if (grouped.containsKey(project.id) ||
              (_filter == _Filter.all &&
                  project.name.toLowerCase().contains(_query))) ...[
            InkWell(
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
                            ? Icons.chevron_right
                            : Icons.expand_more,
                        size: 18,
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(project.name)),
                    ],
                  ),
                ),
              ),
            ),
            if (!_collapsed.contains(project.id) || _query.isNotEmpty)
              for (final thread
                  in grouped[project.id] ?? const <MobileThreadSummary>[])
                row(thread, nested: true),
          ],
        if (snapshot != null && shown.isEmpty)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(
              _query.isNotEmpty
                  ? '没有匹配的会话'
                  : switch (_filter) {
                      _Filter.attention => '没有需要处理的会话',
                      _Filter.archived => '没有已归档的会话',
                      _Filter.all => '没有会话',
                    },
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
      child: Semantics(
        label: '管理电脑',
        button: true,
        child: OutlinedButton(
          style: OutlinedButton.styleFrom(
            minimumSize: const Size(0, 50),
            backgroundColor: colors.surface,
            side: BorderSide(color: colors.divider),
          ),
          onPressed: widget.onComputers,
          child: Row(
            children: [
              Icon(
                Icons.circle,
                size: 8,
                color: widget.online ? colors.online : colors.muted,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.computerName,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(widget.online ? '已连接' : '离线'),
            ],
          ),
        ),
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
