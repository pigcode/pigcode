import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../computers_hub.dart' show PigcodeColors;
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_form_widgets.dart';
import 'manage_utils.dart';
import 'project_directory_picker_screen.dart';

enum _ProjectRowAction { rename, remove }

/// 集中项目管理页：展示所有项目、脱敏 `~` 相对路径与会话数，支持添加、重命名与移除。
class ProjectManageScreen extends StatefulWidget {
  const ProjectManageScreen({
    super.key,
    required this.connectionListenable,
    this.computerName,
  });

  static const addButtonKey = ValueKey('project-manage-add-button');
  static ValueKey<String> projectTileKey(String projectId) =>
      ValueKey('project-manage-tile-$projectId');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String? computerName;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    String? computerName,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => ProjectManageScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
      ),
    ),
  );

  @override
  State<ProjectManageScreen> createState() => _ProjectManageScreenState();
}

class _ProjectManageScreenState extends State<ProjectManageScreen> {
  MobileConnection? _connection;
  List<MobileManagedProject> _projects = const [];
  bool _loading = true;
  bool _working = false;
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant ProjectManageScreen oldWidget) {
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
      unawaited(_load());
    }
  }

  Future<void> _load() async {
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
      final list = await conn.projects.list();
      if (!mounted || seq != _seq) return;
      setState(() {
        _projects = list;
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

  Future<void> _openAdd() async {
    final added = await ProjectDirectoryPickerScreen.open(
      context,
      connectionListenable: widget.connectionListenable,
    );
    if (!mounted || added == null) return;
    ScaffoldMessenger.maybeOf(
      context,
    )?.showSnackBar(SnackBar(content: Text('已添加项目「${added.name}」')));
    await _load();
  }

  Future<void> _showActions(MobileManagedProject project) async {
    final action = await showMobileSheet<_ProjectRowAction>(
      context,
      title: project.name,
      content: (sheetContext) => SliverList.list(
        children: [
          MobileSheetAction(
            glyph: WorkspaceGlyph.pencil,
            label: '重命名项目',
            onTap: () => Navigator.pop(sheetContext, _ProjectRowAction.rename),
          ),
          MobileSheetAction(
            glyph: WorkspaceGlyph.archive,
            label: '从列表移除',
            dividerAbove: true,
            onTap: () => Navigator.pop(sheetContext, _ProjectRowAction.remove),
          ),
        ],
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case _ProjectRowAction.rename:
        await _renameProject(project);
      case _ProjectRowAction.remove:
        await _removeProject(project);
    }
  }

  Future<void> _renameProject(MobileManagedProject project) async {
    final conn = _connection;
    if (conn == null || _working) return;
    final nextName = await showRenameProjectDialog(
      context,
      currentName: project.name,
    );
    if (!mounted || nextName == null || nextName == project.name) return;
    setState(() => _working = true);
    try {
      await conn.projects.rename(projectId: project.id, name: nextName);
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('项目已重命名')));
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _removeProject(MobileManagedProject project) async {
    final conn = _connection;
    if (conn == null || _working) return;
    final confirmed = await confirmRemoveProjectDialog(
      context,
      projectName: project.name,
    );
    if (!mounted || !confirmed) return;
    setState(() => _working = true);
    try {
      await conn.projects.remove(projectId: project.id);
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text('已移除项目「${project.name}」')));
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

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
          title: '项目管理',
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
              padding: const EdgeInsetsDirectional.only(end: 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  key: ProjectManageScreen.addButtonKey,
                  tooltip: '添加项目',
                  padding: EdgeInsets.zero,
                  onPressed: _connection == null || _working ? null : _openAdd,
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
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator.adaptive())
                  : _error != null
                  ? Center(
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
                              onPressed: () => unawaited(_load()),
                              child: const Text('重试'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : _projects.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          spacing: 12,
                          children: [
                            Text(
                              '这台电脑还没有添加项目',
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: colors.muted,
                              ),
                            ),
                            FilledButton.icon(
                              onPressed: _connection == null ? null : _openAdd,
                              icon: const WorkspaceIcon(
                                WorkspaceGlyph.plus,
                                size: 18,
                              ),
                              label: const Text('添加项目'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : RefreshIndicator.adaptive(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
                        children: [
                          Material(
                            color: colors.surface,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16),
                              side: BorderSide(color: colors.border),
                            ),
                            clipBehavior: Clip.antiAlias,
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                for (var i = 0; i < _projects.length; i++) ...[
                                  if (i > 0)
                                    Divider(
                                      height: 1,
                                      thickness: 1,
                                      indent: 62,
                                      endIndent: 14,
                                      color: colors.divider,
                                    ),
                                  _ManagedProjectRow(
                                    colors: colors,
                                    project: _projects[i],
                                    disabled: _working || _connection == null,
                                    onTap: () =>
                                        unawaited(_showActions(_projects[i])),
                                  ),
                                ],
                              ],
                            ),
                          ),
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

class _ManagedProjectRow extends StatelessWidget {
  const _ManagedProjectRow({
    required this.colors,
    required this.project,
    required this.disabled,
    required this.onTap,
  });

  final PigcodeColors colors;
  final MobileManagedProject project;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: ProjectManageScreen.projectTileKey(project.id),
      onTap: disabled ? null : onTap,
      hoverColor: colors.hover,
      splashColor: colors.selected,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Center(
                child: IconTheme(
                  data: IconThemeData(color: colors.secondaryText),
                  child: const WorkspaceIcon(WorkspaceGlyph.folder, size: 18),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    project.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      color: colors.foreground,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${project.displayPath} · ${project.threadCount} 个会话',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.metaStyle(colors.muted),
                  ),
                ],
              ),
            ),
            IconButton(
              tooltip: '管理 ${project.name}',
              onPressed: disabled ? null : onTap,
              icon: Icon(
                Icons.more_horiz_rounded,
                size: 20,
                color: colors.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
