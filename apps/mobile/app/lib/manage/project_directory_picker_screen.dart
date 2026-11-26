import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_utils.dart';

/// Host 授权的只读目录浏览器：在电脑用户主目录 `~` 范围内选择代码目录并添加为项目。
class ProjectDirectoryPickerScreen extends StatefulWidget {
  const ProjectDirectoryPickerScreen({
    super.key,
    required this.connectionListenable,
  });

  static const selectCurrentButtonKey = ValueKey(
    'project-picker-select-current',
  );
  static const parentUpButtonKey = ValueKey('project-picker-parent-up');
  static ValueKey<String> shortcutKey(String relPath) =>
      ValueKey('project-picker-shortcut-$relPath');
  static ValueKey<String> entryKey(String relPath) =>
      ValueKey('project-picker-entry-$relPath');
  static ValueKey<String> quickAddKey(String relPath) =>
      ValueKey('project-picker-add-$relPath');

  final ValueListenable<MobileConnection?> connectionListenable;

  static Future<MobileManagedProject?> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
  }) => Navigator.of(context).push<MobileManagedProject>(
    MaterialPageRoute<MobileManagedProject>(
      builder: (_) => ProjectDirectoryPickerScreen(
        connectionListenable: connectionListenable,
      ),
    ),
  );

  @override
  State<ProjectDirectoryPickerScreen> createState() =>
      _ProjectDirectoryPickerScreenState();
}

class _ProjectDirectoryPickerScreenState
    extends State<ProjectDirectoryPickerScreen> {
  MobileConnection? _connection;
  String _currentRelPath = '';
  MobileProjectBrowseDirsResult? _listing;
  bool _loading = true;
  bool _submitting = false;
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);
    unawaited(_load(_currentRelPath));
  }

  @override
  void didUpdateWidget(covariant ProjectDirectoryPickerScreen oldWidget) {
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
      unawaited(_load(_currentRelPath));
    }
  }

  Future<void> _load(String relPath) async {
    final conn = _connection;
    final seq = ++_seq;
    setState(() {
      _currentRelPath = relPath;
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
      final result = await conn.projects.browseDirs(relPath: relPath);
      if (!mounted || seq != _seq) return;
      setState(() {
        _listing = result;
        _currentRelPath = result.currentRelPath;
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

  Future<void> _promptAndAdd({
    required String relPath,
    required String displayPath,
    required String defaultName,
  }) async {
    final conn = _connection;
    if (conn == null || _submitting || relPath.isEmpty) return;

    final chosenName = await showAddProjectNameDialog(
      context,
      displayPath: displayPath,
      defaultName: defaultName,
    );
    if (chosenName == null || !mounted) return;

    setState(() => _submitting = true);
    try {
      final added = await conn.projects.add(
        relPath: relPath,
        name: chosenName.isEmpty ? null : chosenName,
      );
      if (!mounted) return;
      Navigator.of(context).pop(added);
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final listing = _listing;
    final canSelectCurrent =
        _connection != null &&
        !_loading &&
        !_submitting &&
        listing != null &&
        listing.currentRelPath.isNotEmpty;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: const Text('添加项目'),
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
            if (listing != null && listing.shortcuts.isNotEmpty)
              SizedBox(
                height: 46,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(
                    horizontal: TimelineSpace.x6,
                    vertical: TimelineSpace.x2,
                  ),
                  itemCount: listing.shortcuts.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(width: TimelineSpace.x2),
                  itemBuilder: (context, index) {
                    final item = listing.shortcuts[index];
                    final selected = item.relPath == listing.currentRelPath;
                    return ActionChip(
                      key: ProjectDirectoryPickerScreen.shortcutKey(
                        item.relPath,
                      ),
                      label: Text(item.label),
                      backgroundColor: selected
                          ? colors.surfaceRaised
                          : colors.field,
                      side: BorderSide(
                        color: selected ? colors.foreground : colors.border,
                      ),
                      onPressed: _submitting
                          ? null
                          : () => unawaited(_load(item.relPath)),
                    );
                  },
                ),
              ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(
                horizontal: TimelineSpace.x6,
                vertical: TimelineSpace.x3,
              ),
              decoration: BoxDecoration(
                color: colors.surface,
                border: Border(
                  top: BorderSide(color: colors.divider),
                  bottom: BorderSide(color: colors.divider),
                ),
              ),
              child: Row(
                children: [
                  if (listing?.parentRelPath case final parent?)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(end: 8),
                      child: SizedBox.square(
                        dimension: 34,
                        child: IconButton(
                          key: ProjectDirectoryPickerScreen.parentUpButtonKey,
                          tooltip: '上一级目录',
                          padding: EdgeInsets.zero,
                          onPressed: _submitting
                              ? null
                              : () => unawaited(_load(parent)),
                          icon: const Icon(Icons.arrow_upward, size: 18),
                        ),
                      ),
                    ),
                  Expanded(
                    child: Text(
                      listing?.displayPath ??
                          (_currentRelPath.isEmpty
                              ? '~'
                              : '~/$_currentRelPath'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.metaMonoStyle(colors.secondaryText),
                    ),
                  ),
                ],
              ),
            ),
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
                              onPressed: () =>
                                  unawaited(_load(_currentRelPath)),
                              child: const Text('重试'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : listing == null || listing.entries.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          '当前目录下没有可浏览的子文件夹',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: colors.muted,
                          ),
                        ),
                      ),
                    )
                  : ListView.separated(
                      itemCount:
                          listing.entries.length + (listing.truncated ? 1 : 0),
                      separatorBuilder: (_, _) =>
                          Divider(height: 1, indent: 52, color: colors.divider),
                      itemBuilder: (context, index) {
                        if (index >= listing.entries.length) {
                          return Padding(
                            padding: const EdgeInsets.all(16),
                            child: Text(
                              '目录数量较多，仅显示前 ${listing.entries.length} 项。',
                              style: TimelineType.metaStyle(colors.muted),
                              textAlign: TextAlign.center,
                            ),
                          );
                        }
                        final entry = listing.entries[index];
                        final alreadyAdded =
                            entry.alreadyAddedProjectId != null;
                        return ListTile(
                          key: ProjectDirectoryPickerScreen.entryKey(
                            entry.relPath,
                          ),
                          leading: IconTheme(
                            data: IconThemeData(color: colors.secondaryText),
                            child: const WorkspaceIcon(
                              WorkspaceGlyph.folder,
                              size: 20,
                            ),
                          ),
                          title: Row(
                            children: [
                              Flexible(
                                child: Text(
                                  entry.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              if (entry.isGitRepo) ...[
                                const SizedBox(width: 6),
                                _Badge(
                                  label: 'Git',
                                  background: colors.field,
                                  foreground: colors.secondaryText,
                                ),
                              ],
                              if (alreadyAdded) ...[
                                const SizedBox(width: 6),
                                _Badge(
                                  label: '已添加',
                                  background: colors.surfaceRaised,
                                  foreground: colors.muted,
                                ),
                              ],
                            ],
                          ),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (!alreadyAdded)
                                IconButton(
                                  key: ProjectDirectoryPickerScreen.quickAddKey(
                                    entry.relPath,
                                  ),
                                  tooltip: '添加 ${entry.name}',
                                  onPressed: _submitting
                                      ? null
                                      : () => unawaited(
                                          _promptAndAdd(
                                            relPath: entry.relPath,
                                            displayPath: '~/${entry.relPath}',
                                            defaultName: entry.name,
                                          ),
                                        ),
                                  icon: const WorkspaceIcon(
                                    WorkspaceGlyph.plus,
                                    size: 18,
                                  ),
                                ),
                              if (entry.hasChildren)
                                Icon(
                                  Icons.chevron_right,
                                  size: 18,
                                  color: colors.faint,
                                ),
                            ],
                          ),
                          onTap: _submitting
                              ? null
                              : () => unawaited(_load(entry.relPath)),
                        );
                      },
                    ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
              decoration: BoxDecoration(
                color: colors.surface,
                border: Border(top: BorderSide(color: colors.divider)),
              ),
              child: FilledButton(
                key: ProjectDirectoryPickerScreen.selectCurrentButtonKey,
                onPressed: canSelectCurrent
                    ? () {
                        final parts = listing.currentRelPath.split('/');
                        unawaited(
                          _promptAndAdd(
                            relPath: listing.currentRelPath,
                            displayPath: listing.displayPath,
                            defaultName: parts.last,
                          ),
                        );
                      }
                    : null,
                child: Text(
                  listing == null || listing.currentRelPath.isEmpty
                      ? '请进入子目录后添加项目'
                      : _submitting
                      ? '正在添加…'
                      : '添加当前目录',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({
    required this.label,
    required this.background,
    required this.foreground,
  });

  final String label;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(label, style: TimelineType.microStyle(foreground)),
  );
}
