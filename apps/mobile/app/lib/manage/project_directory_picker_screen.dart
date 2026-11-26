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
import 'manage_utils.dart';

/// Host 授权的目录浏览器与新建项目工作台：
/// - 统一卡片组视觉、可点击路径面包屑与常用目录胶囊；
/// - 支持当前目录内快速过滤、在电脑目录下安全新建文件夹并一键添加为项目；
/// - 使用底部柔和确认面板替代粗糙居中弹窗，保持跨端一致高级感。
class ProjectDirectoryPickerScreen extends StatefulWidget {
  const ProjectDirectoryPickerScreen({
    super.key,
    required this.connectionListenable,
  });

  static const selectCurrentButtonKey = ValueKey(
    'project-picker-select-current',
  );
  static const parentUpButtonKey = ValueKey('project-picker-parent-up');
  static const createFolderButtonKey = ValueKey('project-picker-create-folder');
  static const searchToggleButtonKey = ValueKey('project-picker-search-toggle');
  static const searchInputKey = ValueKey('project-picker-search-input');
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
  bool _searching = false;
  String _query = '';
  String? _error;
  int _seq = 0;

  final TextEditingController _searchController = TextEditingController();

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
    _searchController.dispose();
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
      if (_searching && _query.isNotEmpty) {
        _query = '';
        _searchController.clear();
      }
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

    final chosenName = await _showAddProjectSheet(
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

  Future<void> _promptCreateFolder() async {
    final conn = _connection;
    if (conn == null || _submitting || _loading) return;
    final parentDisplay =
        _listing?.displayPath ??
        (_currentRelPath.isEmpty ? '~' : '~/$_currentRelPath');

    final draft = await _showCreateFolderSheet(
      context,
      parentDisplayPath: parentDisplay,
    );
    if (draft == null || !mounted) return;

    setState(() => _submitting = true);
    try {
      final entry = await conn.projects.createDir(
        parentRelPath: _currentRelPath,
        name: draft.folderName,
      );
      if (!mounted) return;
      if (draft.addAsProject) {
        final added = await conn.projects.add(
          relPath: entry.relPath,
          name: draft.projectName.isEmpty ? null : draft.projectName,
        );
        if (!mounted) return;
        Navigator.of(context).pop(added);
        return;
      }
      setState(() => _submitting = false);
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text('已创建文件夹「${entry.name}」')));
      await _load(entry.relPath);
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
    final brightness = theme.brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final listing = _listing;
    final hasCurrent =
        _connection != null &&
        !_loading &&
        !_submitting &&
        listing != null &&
        listing.currentRelPath.isNotEmpty;
    final normalizedQuery = _query.trim().toLowerCase();
    final entries = listing?.entries ?? const <MobileProjectDirEntry>[];
    final filtered = normalizedQuery.isEmpty
        ? entries
        : entries
              .where((e) => e.name.toLowerCase().contains(normalizedQuery))
              .toList(growable: false);
    final currentLeafName = listing != null && listing.currentRelPath.isNotEmpty
        ? listing.currentRelPath.split('/').last
        : '';

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        backgroundColor: colors.background,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(brightness),
        centerTitle: true,
        title: Text(
          '添加项目',
          style: TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w500,
            color: colors.foreground,
            locale: const Locale('zh', 'CN'),
          ),
        ),
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
                  key: ProjectDirectoryPickerScreen.searchToggleButtonKey,
                  tooltip: _searching ? '关闭筛选' : '筛选目录',
                  padding: EdgeInsets.zero,
                  onPressed: () {
                    setState(() {
                      _searching = !_searching;
                      if (!_searching) {
                        _query = '';
                        _searchController.clear();
                      }
                    });
                  },
                  icon: Icon(
                    _searching ? Icons.close_rounded : Icons.search_rounded,
                    size: 19,
                    color: colors.foreground,
                  ),
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
                  key: ProjectDirectoryPickerScreen.createFolderButtonKey,
                  tooltip: '新建文件夹',
                  padding: EdgeInsets.zero,
                  onPressed: _connection == null || _submitting || _loading
                      ? null
                      : () => unawaited(_promptCreateFolder()),
                  icon: Icon(
                    Icons.create_new_folder_outlined,
                    size: 19,
                    color: _connection == null
                        ? colors.faint
                        : colors.foreground,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (_connection == null) const ManageOfflineBanner(),
            if (_searching)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: Container(
                  decoration: BoxDecoration(
                    color: colors.surface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: colors.border),
                  ),
                  child: TextField(
                    key: ProjectDirectoryPickerScreen.searchInputKey,
                    controller: _searchController,
                    autofocus: true,
                    onChanged: (value) => setState(() => _query = value),
                    style: TextStyle(fontSize: 14.5, color: colors.foreground),
                    decoration: InputDecoration(
                      hintText: '搜索当前目录下的文件夹',
                      hintStyle: TextStyle(color: colors.faint, fontSize: 14),
                      prefixIcon: Icon(
                        Icons.search_rounded,
                        size: 18,
                        color: colors.muted,
                      ),
                      suffixIcon: _query.isNotEmpty
                          ? IconButton(
                              tooltip: '清除搜索',
                              icon: Icon(
                                Icons.close_rounded,
                                size: 17,
                                color: colors.muted,
                              ),
                              onPressed: () {
                                _searchController.clear();
                                setState(() => _query = '');
                              },
                            )
                          : null,
                      border: InputBorder.none,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 11,
                      ),
                    ),
                  ),
                ),
              ),
            if (listing != null && listing.shortcuts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6, bottom: 8),
                child: SizedBox(
                  height: 34,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemCount: listing.shortcuts.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 8),
                    itemBuilder: (context, index) {
                      final item = listing.shortcuts[index];
                      final selected = item.relPath == listing.currentRelPath;
                      return _ShortcutPill(
                        key: ProjectDirectoryPickerScreen.shortcutKey(
                          item.relPath,
                        ),
                        colors: colors,
                        label: item.label,
                        selected: selected,
                        disabled: _submitting,
                        onTap: () => unawaited(_load(item.relPath)),
                      );
                    },
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 10),
              child: _BreadcrumbBar(
                colors: colors,
                currentRelPath: listing?.currentRelPath ?? _currentRelPath,
                parentRelPath: listing?.parentRelPath,
                disabled: _submitting,
                onNavigate: (rel) => unawaited(_load(rel)),
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
                              style: TextStyle(
                                fontSize: 14,
                                color: colors.muted,
                                locale: const Locale('zh', 'CN'),
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
                  : ListView(
                      padding: EdgeInsets.fromLTRB(
                        16,
                        2,
                        16,
                        hasCurrent ? 96 : 24,
                      ),
                      children: [
                        _CreateFolderCard(
                          colors: colors,
                          parentDisplayPath:
                              listing?.displayPath ??
                              (_currentRelPath.isEmpty
                                  ? '~'
                                  : '~/$_currentRelPath'),
                          enabled: _connection != null && !_submitting,
                          onTap: () => unawaited(_promptCreateFolder()),
                        ),
                        const SizedBox(height: 12),
                        if (filtered.isEmpty)
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 18,
                              vertical: 28,
                            ),
                            decoration: BoxDecoration(
                              color: colors.surface,
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(color: colors.border),
                            ),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                IconTheme(
                                  data: IconThemeData(color: colors.faint),
                                  child: const WorkspaceIcon(
                                    WorkspaceGlyph.folder,
                                    size: 26,
                                  ),
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  normalizedQuery.isNotEmpty
                                      ? '当前目录下没有匹配的文件夹'
                                      : '当前目录下暂无子文件夹',
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w500,
                                    color: colors.secondaryText,
                                    locale: const Locale('zh', 'CN'),
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  normalizedQuery.isNotEmpty
                                      ? '试试更换关键词，或清除搜索条件'
                                      : hasCurrent
                                      ? '可直接新建子文件夹，或点下方按钮添加当前目录'
                                      : '可点击上方卡片直接新建文件夹作为项目',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    color: colors.muted,
                                    locale: const Locale('zh', 'CN'),
                                  ),
                                ),
                              ],
                            ),
                          )
                        else ...[
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
                                for (var i = 0; i < filtered.length; i++) ...[
                                  if (i > 0)
                                    Divider(
                                      height: 1,
                                      thickness: 1,
                                      indent: 62,
                                      endIndent: 14,
                                      color: colors.divider,
                                    ),
                                  _DirectoryEntryRow(
                                    colors: colors,
                                    entry: filtered[i],
                                    disabled: _submitting,
                                    onOpenDir: () =>
                                        unawaited(_load(filtered[i].relPath)),
                                    onQuickAdd: () => unawaited(
                                      _promptAndAdd(
                                        relPath: filtered[i].relPath,
                                        displayPath: '~/${filtered[i].relPath}',
                                        defaultName: filtered[i].name,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                          if (listing != null && listing.truncated)
                            Padding(
                              padding: const EdgeInsets.only(top: 10),
                              child: Text(
                                '文件夹较多，仅展示前 ${listing.entries.length} 项，可用右上角搜索筛选',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: colors.muted,
                                  locale: const Locale('zh', 'CN'),
                                ),
                              ),
                            ),
                        ],
                      ],
                    ),
            ),
            if (hasCurrent)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                decoration: BoxDecoration(
                  color: colors.surface,
                  border: Border(top: BorderSide(color: colors.divider)),
                ),
                child: FilledButton(
                  key: ProjectDirectoryPickerScreen.selectCurrentButtonKey,
                  style: FilledButton.styleFrom(
                    backgroundColor: colors.primary,
                    foregroundColor: colors.onPrimary,
                    minimumSize: const Size(0, 48),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  onPressed: () => unawaited(
                    _promptAndAdd(
                      relPath: listing.currentRelPath,
                      displayPath: listing.displayPath,
                      defaultName: currentLeafName,
                    ),
                  ),
                  child: Text(
                    _submitting ? '正在添加…' : '将「$currentLeafName」添加为项目',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      locale: Locale('zh', 'CN'),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ShortcutPill extends StatelessWidget {
  const _ShortcutPill({
    super.key,
    required this.colors,
    required this.label,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final PigcodeColors colors;
  final String label;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? colors.primary : colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: selected
            ? BorderSide.none
            : BorderSide(color: colors.border, width: 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: disabled ? null : onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                color: selected ? colors.onPrimary : colors.secondaryText,
                locale: const Locale('zh', 'CN'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _BreadcrumbBar extends StatelessWidget {
  const _BreadcrumbBar({
    required this.colors,
    required this.currentRelPath,
    required this.parentRelPath,
    required this.disabled,
    required this.onNavigate,
  });

  final PigcodeColors colors;
  final String currentRelPath;
  final String? parentRelPath;
  final bool disabled;
  final ValueChanged<String> onNavigate;

  @override
  Widget build(BuildContext context) {
    final segments = currentRelPath.isEmpty
        ? const <String>[]
        : currentRelPath.split('/');
    final crumbs = <(String label, String relPath)>[('~', '')];
    var acc = '';
    for (final seg in segments) {
      acc = acc.isEmpty ? seg : '$acc/$seg';
      crumbs.add((seg, acc));
    }

    return Container(
      height: 38,
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.border),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: Row(
        children: [
          if (parentRelPath case final parent?)
            SizedBox.square(
              dimension: 30,
              child: IconButton(
                key: ProjectDirectoryPickerScreen.parentUpButtonKey,
                tooltip: '上一级目录',
                padding: EdgeInsets.zero,
                onPressed: disabled ? null : () => onNavigate(parent),
                icon: Icon(
                  Icons.arrow_upward_rounded,
                  size: 16,
                  color: colors.secondaryText,
                ),
              ),
            ),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              reverse: crumbs.length > 2,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Row(
                children: [
                  for (var i = 0; i < crumbs.length; i++) ...[
                    if (i > 0)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Icon(
                          Icons.chevron_right_rounded,
                          size: 15,
                          color: colors.faint,
                        ),
                      ),
                    InkWell(
                      borderRadius: BorderRadius.circular(6),
                      onTap: disabled || i == crumbs.length - 1
                          ? null
                          : () => onNavigate(crumbs[i].$2),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 5,
                          vertical: 4,
                        ),
                        child: Text(
                          crumbs[i].$1,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: i == crumbs.length - 1
                                ? FontWeight.w500
                                : FontWeight.w400,
                            color: i == crumbs.length - 1
                                ? colors.foreground
                                : colors.muted,
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CreateFolderCard extends StatelessWidget {
  const _CreateFolderCard({
    required this.colors,
    required this.parentDisplayPath,
    required this.enabled,
    required this.onTap,
  });

  final PigcodeColors colors;
  final String parentDisplayPath;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: enabled ? onTap : null,
        hoverColor: colors.hover,
        splashColor: colors.selected,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: colors.field,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(
                  Icons.create_new_folder_outlined,
                  size: 18,
                  color: colors.foreground,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '新建文件夹并创建项目',
                      style: TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w500,
                        color: colors.foreground,
                        locale: const Locale('zh', 'CN'),
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      '位置：$parentDisplayPath',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: colors.muted,
                        locale: const Locale('zh', 'CN'),
                      ),
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right_rounded, size: 18, color: colors.faint),
            ],
          ),
        ),
      ),
    );
  }
}

class _DirectoryEntryRow extends StatelessWidget {
  const _DirectoryEntryRow({
    required this.colors,
    required this.entry,
    required this.disabled,
    required this.onOpenDir,
    required this.onQuickAdd,
  });

  final PigcodeColors colors;
  final MobileProjectDirEntry entry;
  final bool disabled;
  final VoidCallback onOpenDir;
  final VoidCallback onQuickAdd;

  @override
  Widget build(BuildContext context) {
    final alreadyAdded = entry.alreadyAddedProjectId != null;
    return InkWell(
      key: ProjectDirectoryPickerScreen.entryKey(entry.relPath),
      onTap: disabled ? null : onOpenDir,
      hoverColor: colors.hover,
      splashColor: colors.selected,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 11, 10, 11),
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
                  data: IconThemeData(
                    color: entry.isGitRepo
                        ? colors.foreground
                        : colors.secondaryText,
                  ),
                  child: const WorkspaceIcon(WorkspaceGlyph.folder, size: 18),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          entry.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                            color: colors.foreground,
                          ),
                        ),
                      ),
                      if (entry.isGitRepo) ...[
                        const SizedBox(width: 6),
                        _TagPill(
                          label: 'Git',
                          background: colors.field,
                          foreground: colors.secondaryText,
                        ),
                      ],
                    ],
                  ),
                  if (alreadyAdded || entry.hasChildren) ...[
                    const SizedBox(height: 2),
                    Text(
                      alreadyAdded ? '已添加到项目列表' : '包含子文件夹',
                      style: TextStyle(
                        fontSize: 12,
                        color: alreadyAdded ? colors.readyMark : colors.muted,
                        locale: const Locale('zh', 'CN'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (alreadyAdded)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: _TagPill(
                  label: '已添加',
                  background: colors.readyMark.withValues(alpha: 0.14),
                  foreground: colors.readyMark,
                ),
              )
            else
              TextButton(
                key: ProjectDirectoryPickerScreen.quickAddKey(entry.relPath),
                onPressed: disabled ? null : onQuickAdd,
                style: TextButton.styleFrom(
                  backgroundColor: colors.field,
                  foregroundColor: colors.foreground,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 11,
                    vertical: 6,
                  ),
                  minimumSize: const Size(0, 32),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                    side: BorderSide(color: colors.border),
                  ),
                ),
                child: const Text(
                  '添加',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w500,
                    locale: Locale('zh', 'CN'),
                  ),
                ),
              ),
            if (entry.hasChildren) ...[
              const SizedBox(width: 2),
              Icon(Icons.chevron_right_rounded, size: 18, color: colors.faint),
            ],
          ],
        ),
      ),
    );
  }
}

class _TagPill extends StatelessWidget {
  const _TagPill({
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
      borderRadius: BorderRadius.circular(5),
    ),
    child: Text(
      label,
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w500,
        color: foreground,
      ),
    ),
  );
}

Future<String?> _showAddProjectSheet(
  BuildContext context, {
  required String displayPath,
  required String defaultName,
}) {
  return showMobileSheet<String>(
    context,
    title: '添加到项目列表',
    content: (sheetContext) => SliverToBoxAdapter(
      child: _AddProjectSheetBody(
        displayPath: displayPath,
        defaultName: defaultName,
        onCancel: () => Navigator.pop(sheetContext),
        onConfirm: (name) => Navigator.pop(sheetContext, name),
      ),
    ),
  );
}

class _AddProjectSheetBody extends StatefulWidget {
  const _AddProjectSheetBody({
    required this.displayPath,
    required this.defaultName,
    required this.onCancel,
    required this.onConfirm,
  });

  final String displayPath;
  final String defaultName;
  final VoidCallback onCancel;
  final ValueChanged<String> onConfirm;

  @override
  State<_AddProjectSheetBody> createState() => _AddProjectSheetBodyState();
}

class _AddProjectSheetBodyState extends State<_AddProjectSheetBody> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.defaultName,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    widget.onConfirm(_controller.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(context).bottom + 6,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: colors.field,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colors.border),
            ),
            child: Row(
              children: [
                IconTheme(
                  data: IconThemeData(color: colors.secondaryText),
                  child: const WorkspaceIcon(WorkspaceGlyph.folder, size: 17),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    widget.displayPath,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.metaMonoStyle(colors.secondaryText),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Text(
            '项目显示名称（可选）',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: colors.secondaryText,
              locale: const Locale('zh', 'CN'),
            ),
          ),
          const SizedBox(height: 6),
          Container(
            decoration: BoxDecoration(
              color: colors.field,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colors.border),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
            child: TextField(
              key: const ValueKey('project-add-name-input'),
              controller: _controller,
              autofocus: true,
              maxLength: 120,
              style: TextStyle(fontSize: 15, color: colors.foreground),
              decoration: InputDecoration(
                hintText: '留空默认使用文件夹名',
                hintStyle: TextStyle(color: colors.faint, fontSize: 14),
                counterText: '',
                border: InputBorder.none,
                suffixIcon: ValueListenableBuilder<TextEditingValue>(
                  valueListenable: _controller,
                  builder: (_, value, _) => value.text.isEmpty
                      ? const SizedBox.shrink()
                      : IconButton(
                          tooltip: '清空名称',
                          icon: Icon(
                            Icons.close_rounded,
                            size: 17,
                            color: colors.muted,
                          ),
                          onPressed: _controller.clear,
                        ),
                ),
              ),
              onSubmitted: (_) => _submit(),
            ),
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: widget.onCancel,
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(0, 46),
                    side: BorderSide(color: colors.border),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: const Text('取消'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: FilledButton(
                  key: const ValueKey('project-add-confirm'),
                  onPressed: _submit,
                  style: FilledButton.styleFrom(
                    backgroundColor: colors.primary,
                    foregroundColor: colors.onPrimary,
                    minimumSize: const Size(0, 46),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: const Text(
                    '确认添加',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      locale: Locale('zh', 'CN'),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

typedef _CreateFolderDraft = ({
  String folderName,
  bool addAsProject,
  String projectName,
});

Future<_CreateFolderDraft?> _showCreateFolderSheet(
  BuildContext context, {
  required String parentDisplayPath,
}) {
  return showMobileSheet<_CreateFolderDraft>(
    context,
    title: '新建文件夹',
    content: (sheetContext) => SliverToBoxAdapter(
      child: _CreateFolderSheetBody(
        parentDisplayPath: parentDisplayPath,
        onCancel: () => Navigator.pop(sheetContext),
        onConfirm: (draft) => Navigator.pop(sheetContext, draft),
      ),
    ),
  );
}

class _CreateFolderSheetBody extends StatefulWidget {
  const _CreateFolderSheetBody({
    required this.parentDisplayPath,
    required this.onCancel,
    required this.onConfirm,
  });

  final String parentDisplayPath;
  final VoidCallback onCancel;
  final ValueChanged<_CreateFolderDraft> onConfirm;

  @override
  State<_CreateFolderSheetBody> createState() => _CreateFolderSheetBodyState();
}

class _CreateFolderSheetBodyState extends State<_CreateFolderSheetBody> {
  final TextEditingController _folderController = TextEditingController();
  final TextEditingController _projectController = TextEditingController();
  bool _addAsProject = true;

  @override
  void dispose() {
    _folderController.dispose();
    _projectController.dispose();
    super.dispose();
  }

  String? _validationError(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    if (trimmed == '.' || trimmed == '..' || trimmed.startsWith('.')) {
      return '文件夹名称不能以「.」开头';
    }
    if (trimmed.contains('/') || trimmed.contains('\\')) {
      return '文件夹名称不能包含斜杠路径分隔符';
    }
    return null;
  }

  void _submit() {
    final name = _folderController.text.trim();
    if (name.isEmpty || _validationError(name) != null) return;
    widget.onConfirm((
      folderName: name,
      addAsProject: _addAsProject,
      projectName: _projectController.text.trim(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(context).bottom + 6,
      ),
      child: ValueListenableBuilder<TextEditingValue>(
        valueListenable: _folderController,
        builder: (_, value, _) {
          final raw = value.text.trim();
          final error = _validationError(raw);
          final previewName = raw.isEmpty ? '<新建文件夹>' : raw;
          final previewPath = widget.parentDisplayPath == '~'
              ? '~/$previewName'
              : '${widget.parentDisplayPath}/$previewName';
          final canSubmit = raw.isNotEmpty && error == null;

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: colors.field,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: colors.border),
                ),
                child: Text(
                  previewPath,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TimelineType.metaMonoStyle(
                    raw.isEmpty ? colors.muted : colors.foreground,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                '文件夹名称',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: colors.secondaryText,
                  locale: const Locale('zh', 'CN'),
                ),
              ),
              const SizedBox(height: 6),
              Container(
                decoration: BoxDecoration(
                  color: colors.field,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: error != null ? colors.error : colors.border,
                  ),
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 2,
                ),
                child: TextField(
                  key: const ValueKey('project-create-dir-input'),
                  controller: _folderController,
                  autofocus: true,
                  maxLength: 120,
                  style: TextStyle(fontSize: 15, color: colors.foreground),
                  decoration: InputDecoration(
                    hintText: '例如 my-new-app',
                    hintStyle: TextStyle(color: colors.faint, fontSize: 14),
                    counterText: '',
                    border: InputBorder.none,
                  ),
                  onSubmitted: (_) => _submit(),
                ),
              ),
              if (error != null) ...[
                const SizedBox(height: 6),
                Text(
                  error,
                  style: TextStyle(
                    fontSize: 12,
                    color: colors.error,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '创建后直接添加为项目',
                          style: TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w500,
                            color: colors.foreground,
                            locale: const Locale('zh', 'CN'),
                          ),
                        ),
                        Text(
                          '自动添加到项目列表，立即可用于新建会话',
                          style: TextStyle(
                            fontSize: 12,
                            color: colors.muted,
                            locale: const Locale('zh', 'CN'),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Switch.adaptive(
                    key: const ValueKey('project-create-dir-add-switch'),
                    value: _addAsProject,
                    onChanged: (v) => setState(() => _addAsProject = v),
                  ),
                ],
              ),
              if (_addAsProject) ...[
                const SizedBox(height: 10),
                Container(
                  decoration: BoxDecoration(
                    color: colors.field,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: colors.border),
                  ),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 2,
                  ),
                  child: TextField(
                    key: const ValueKey('project-create-dir-alias-input'),
                    controller: _projectController,
                    maxLength: 120,
                    style: TextStyle(fontSize: 14.5, color: colors.foreground),
                    decoration: InputDecoration(
                      hintText: '项目展示名（可选，留空同文件夹名）',
                      hintStyle: TextStyle(color: colors.faint, fontSize: 13.5),
                      counterText: '',
                      border: InputBorder.none,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: widget.onCancel,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 46),
                        side: BorderSide(color: colors.border),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: const Text('取消'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      key: const ValueKey('project-create-dir-confirm'),
                      onPressed: canSubmit ? _submit : null,
                      style: FilledButton.styleFrom(
                        backgroundColor: colors.primary,
                        foregroundColor: colors.onPrimary,
                        minimumSize: const Size(0, 46),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: Text(
                        _addAsProject ? '新建并添加' : '仅新建文件夹',
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w500,
                          locale: Locale('zh', 'CN'),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }
}
