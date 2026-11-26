import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../composer/composer_tokens.dart';
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'file_viewer_screen.dart';
import 'workbench_utils.dart';

enum _SearchMode { filename, content }

class _DirectoryCache {
  _DirectoryCache({
    required this.entries,
    required this.truncated,
    this.nextOffset,
  });

  final List<MobileDirectoryEntry> entries;
  final bool truncated;
  final int? nextOffset;
}

/// 工作台「文件」Tab：
/// - 支持 `workbench.write` 时在顶部显示当前 Worktree 快捷条、新建文件与长按/菜单重命名和删除；
/// - 顶部双模式搜索条（文件名 / 代码内容，250ms 防抖 + 清空按钮）；
/// - 可横向滚动的面包屑路径栏；
/// - 目录树懒加载缓存、下拉刷新、底部「加载更多」分页、忽略项弱化显示与符号链接标记。
class FileBrowserTab extends StatefulWidget {
  const FileBrowserTab({
    super.key,
    required this.connection,
    required this.threadId,
    this.initialDirectory = '',
    this.searchDebounce = const Duration(milliseconds: 250),
    this.revision = 0,
    this.threadBusy = false,
    this.onWorkspaceMutated,
    this.onOpenGitTab,
  });

  static const searchInputKey = ValueKey('workbench-search-input');
  static const searchClearKey = ValueKey('workbench-search-clear');
  static const filenameModeKey = ValueKey('workbench-search-mode-filename');
  static const contentModeKey = ValueKey('workbench-search-mode-content');
  static const loadMoreKey = ValueKey('workbench-load-more');
  static const worktreeBarKey = ValueKey('workbench-worktree-bar');
  static const createFileButtonKey = ValueKey('workbench-create-file');
  static ValueKey<String> entryMoreKey(String path) =>
      ValueKey('workbench-entry-more-$path');

  final MobileConnection connection;
  final String threadId;
  final String initialDirectory;
  final Duration searchDebounce;
  final int revision;
  final bool threadBusy;
  final VoidCallback? onWorkspaceMutated;
  final VoidCallback? onOpenGitTab;

  @override
  State<FileBrowserTab> createState() => _FileBrowserTabState();
}

class _FileBrowserTabState extends State<FileBrowserTab> {
  final _searchController = TextEditingController();
  final _crumbScroll = ScrollController();

  String _currentPath = '';
  final _cache = <String, _DirectoryCache>{};
  bool _loadingDir = false;
  bool _loadingMoreDir = false;
  String? _dirError;
  String? _loadMoreError;
  int _dirRequestSeq = 0;

  _SearchMode _searchMode = _SearchMode.filename;
  Timer? _debounce;
  int _searchRequestSeq = 0;
  bool _searching = false;
  String? _searchError;
  List<MobilePathEntry> _pathResults = const [];
  bool _pathResultsTruncated = false;
  List<MobileSearchMatch> _contentResults = const [];
  bool _contentResultsTruncated = false;

  MobileWorktreeListResult? _worktreeList;
  bool _loadingWorktrees = false;
  bool _mutating = false;

  bool get _canWrite => connectionSupportsWorkbenchWrite(widget.connection);
  String get _query => _searchController.text.trim();
  bool get _inSearchMode => _query.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _currentPath = _normalizeDirPath(widget.initialDirectory);
    unawaited(_loadDirectory(_currentPath));
    if (_canWrite) {
      unawaited(_loadWorktrees());
    }
  }

  @override
  void didUpdateWidget(covariant FileBrowserTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.revision != widget.revision ||
        oldWidget.threadId != widget.threadId) {
      _cache.clear();
      unawaited(_loadDirectory(_currentPath, forceRefresh: true));
      if (_canWrite) {
        unawaited(_loadWorktrees());
      }
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    _crumbScroll.dispose();
    super.dispose();
  }

  String _normalizeDirPath(String raw) {
    final normalized = raw.trim().replaceAll('\\', '/');
    final parts = normalized
        .split('/')
        .where((part) => part.isNotEmpty && part != '.')
        .toList();
    return parts.join('/');
  }

  Future<void> _loadDirectory(String path, {bool forceRefresh = false}) async {
    final target = _normalizeDirPath(path);
    if (!forceRefresh && _cache.containsKey(target)) {
      setState(() {
        _currentPath = target;
        _loadingDir = false;
        _loadingMoreDir = false;
        _dirError = null;
        _loadMoreError = null;
      });
      _scrollBreadcrumbsToEnd();
      return;
    }

    final seq = ++_dirRequestSeq;
    setState(() {
      _currentPath = target;
      _loadingDir = true;
      _loadingMoreDir = false;
      _dirError = null;
      _loadMoreError = null;
    });
    _scrollBreadcrumbsToEnd();

    try {
      final listing = await widget.connection.workbench.listDirectory(
        threadId: widget.threadId,
        path: target,
        offset: 0,
      );
      if (!mounted || seq != _dirRequestSeq) return;
      final canonical = _normalizeDirPath(listing.path);
      setState(() {
        _currentPath = canonical;
        _cache[canonical] = _DirectoryCache(
          entries: listing.entries,
          truncated: listing.truncated,
          nextOffset: listing.nextOffset,
        );
        _loadingDir = false;
      });
    } catch (error) {
      if (!mounted || seq != _dirRequestSeq) return;
      setState(() {
        _loadingDir = false;
        _dirError = workbenchErrorMessage(
          error,
          path: target,
          fallback: '暂时无法读取目录，请重试。',
        );
      });
    }
  }

  Future<void> _refreshCurrentDirectory() =>
      _loadDirectory(_currentPath, forceRefresh: true);

  Future<void> _loadMoreEntries() async {
    final current = _cache[_currentPath];
    final nextOffset = current?.nextOffset;
    if (_loadingMoreDir || current == null || nextOffset == null) return;

    final path = _currentPath;
    final seq = _dirRequestSeq;
    setState(() {
      _loadingMoreDir = true;
      _loadMoreError = null;
    });

    try {
      final page = await widget.connection.workbench.listDirectory(
        threadId: widget.threadId,
        path: path,
        offset: nextOffset,
      );
      if (!mounted || seq != _dirRequestSeq || _currentPath != path) return;
      final seen = current.entries.map((e) => e.path).toSet();
      final merged = [
        ...current.entries,
        ...page.entries.where((e) => seen.add(e.path)),
      ];
      final next = page.nextOffset;
      setState(() {
        _cache[path] = _DirectoryCache(
          entries: merged,
          truncated: page.truncated,
          nextOffset: next != null && next > nextOffset ? next : null,
        );
        _loadingMoreDir = false;
      });
    } catch (error) {
      if (!mounted || seq != _dirRequestSeq || _currentPath != path) return;
      setState(() {
        _loadingMoreDir = false;
        _loadMoreError = workbenchErrorMessage(
          error,
          path: path,
          fallback: '加载更多条目失败，请重试。',
        );
      });
    }
  }

  void _scrollBreadcrumbsToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_crumbScroll.hasClients) return;
      _crumbScroll.jumpTo(_crumbScroll.position.maxScrollExtent);
    });
  }

  void _onSearchChanged(String _) {
    _debounce?.cancel();
    final q = _query;
    if (q.isEmpty) {
      _searchRequestSeq++;
      setState(() {
        _searching = false;
        _searchError = null;
        _pathResults = const [];
        _pathResultsTruncated = false;
        _contentResults = const [];
        _contentResultsTruncated = false;
      });
      return;
    }
    setState(() {
      _searching = true;
      _searchError = null;
    });
    _debounce = Timer(widget.searchDebounce, () {
      if (mounted) unawaited(_executeSearch(q, _searchMode));
    });
  }

  void _setSearchMode(_SearchMode mode) {
    if (_searchMode == mode) return;
    _debounce?.cancel();
    setState(() {
      _searchMode = mode;
      _searchError = null;
      _pathResults = const [];
      _pathResultsTruncated = false;
      _contentResults = const [];
      _contentResultsTruncated = false;
    });
    final q = _query;
    if (q.isNotEmpty) {
      unawaited(_executeSearch(q, mode));
    }
  }

  void _clearSearch() {
    _debounce?.cancel();
    _searchController.clear();
    _searchRequestSeq++;
    setState(() {
      _searching = false;
      _searchError = null;
      _pathResults = const [];
      _pathResultsTruncated = false;
      _contentResults = const [];
      _contentResultsTruncated = false;
    });
  }

  Future<void> _executeSearch(String query, _SearchMode mode) async {
    final trimmed = query.trim();
    if (trimmed.isEmpty) return;
    final seq = ++_searchRequestSeq;
    setState(() {
      _searching = true;
      _searchError = null;
    });
    try {
      if (mode == _SearchMode.filename) {
        final result = await widget.connection.mentions.searchPaths(
          threadId: widget.threadId,
          query: trimmed,
          limit: mobileSearchPathsMaxLimit,
        );
        if (!mounted || seq != _searchRequestSeq) return;
        setState(() {
          _pathResults = result.entries;
          _pathResultsTruncated = result.truncated;
          _searching = false;
        });
      } else {
        final result = await widget.connection.workbench.searchFiles(
          threadId: widget.threadId,
          query: trimmed,
        );
        if (!mounted || seq != _searchRequestSeq) return;
        setState(() {
          _contentResults = result.matches;
          _contentResultsTruncated = result.truncated;
          _searching = false;
        });
      }
    } catch (error) {
      if (!mounted || seq != _searchRequestSeq) return;
      setState(() {
        _searching = false;
        _searchError = workbenchErrorMessage(
          error,
          fallback: '搜索失败，请稍后重试。',
        );
      });
    }
  }

  void _openFile(String path, {int? line, bool initialEditing = false}) {
    unawaited(
      MobileFileViewerScreen.open(
        context,
        connection: widget.connection,
        threadId: widget.threadId,
        path: path,
        initialLine: line,
        initialEditing: initialEditing,
        onFileChanged: _onWorkspaceChanged,
      ),
    );
  }

  void _onWorkspaceChanged() {
    _cache.clear();
    unawaited(_loadDirectory(_currentPath, forceRefresh: true));
    if (_canWrite) {
      unawaited(_loadWorktrees());
    }
    widget.onWorkspaceMutated?.call();
  }

  Future<void> _loadWorktrees() async {
    if (!_canWrite || _loadingWorktrees) return;
    _loadingWorktrees = true;
    try {
      final result = await widget.connection.workbenchWrite.listWorktrees(
        threadId: widget.threadId,
      );
      if (!mounted) return;
      setState(() => _worktreeList = result);
    } catch (_) {
      // Worktree 快捷条属增强能力，静默容错以免干扰目录浏览。
    } finally {
      _loadingWorktrees = false;
    }
  }

  String _activeWorktreeLabel() {
    final list = _worktreeList;
    if (list == null || list.mainActive) return '主工作区';
    for (final item in list.worktrees) {
      if (item.active) return item.branch ?? item.name;
    }
    return '主工作区';
  }

  Future<void> _openWorktreeSheet() async {
    if (!_canWrite) return;
    await _loadWorktrees();
    if (!mounted) return;
    await showMobileSheet<void>(
      context,
      title: '切换工作区',
      content: (sheet) {
        final list = _worktreeList;
        final worktrees = list?.worktrees ?? const <MobileWorktreeItem>[];
        final colors = Theme.of(sheet).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return SliverList.list(
          children: [
            if (widget.threadBusy)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  '会话运行中，结束后才可新建、切换或移除 Worktree。',
                  style: TimelineType.smallStyle(colors.attention),
                ),
              ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.folder_outlined, size: 20),
              title: const Text('主工作区'),
              subtitle: Text(
                (list?.mainActive ?? true)
                    ? '当前使用中'
                    : '移除当前活动 Worktree 后自动切回主工作区',
                style: TimelineType.smallStyle(colors.muted),
              ),
              trailing: (list?.mainActive ?? true)
                  ? Icon(Icons.check_rounded, color: colors.foreground, size: 18)
                  : null,
            ),
            for (final item in worktrees)
              ListTile(
                contentPadding: EdgeInsets.zero,
                enabled: !widget.threadBusy && !item.active,
                leading: const Icon(Icons.account_tree_outlined, size: 20),
                title: Text(item.branch ?? item.name),
                subtitle: item.branch != null
                    ? Text(
                        item.name,
                        style: TimelineType.smallStyle(colors.muted),
                      )
                    : null,
                trailing: item.active
                    ? Icon(
                        Icons.check_rounded,
                        color: colors.foreground,
                        size: 18,
                      )
                    : null,
                onTap: () async {
                  Navigator.pop(sheet);
                  await _switchWorktree(item.id);
                },
              ),
            const Divider(height: 16),
            if (!widget.threadBusy)
              MobileSheetAction(
                label: '新建 Worktree',
                glyph: WorkspaceGlyph.plus,
                onTap: () {
                  Navigator.pop(sheet);
                  unawaited(_createWorktree());
                },
              ),
            if (widget.onOpenGitTab != null)
              MobileSheetAction(
                label: '打开 Git 页管理全部',
                icon: Icons.tune_rounded,
                onTap: () {
                  Navigator.pop(sheet);
                  widget.onOpenGitTab?.call();
                },
              ),
          ],
        );
      },
    );
  }

  Future<void> _switchWorktree(String worktreeId) async {
    if (_mutating) return;
    setState(() => _mutating = true);
    try {
      await widget.connection.workbenchWrite.switchWorktree(
        threadId: widget.threadId,
        worktreeId: worktreeId,
      );
      if (!mounted) return;
      _onWorkspaceChanged();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已切换 Worktree')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(error, fallback: '切换 Worktree 失败。'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _createWorktree() async {
    if (_mutating || widget.threadBusy) return;
    setState(() => _mutating = true);
    try {
      final created = await widget.connection.workbenchWrite.createWorktree(
        threadId: widget.threadId,
      );
      if (!mounted) return;
      _onWorkspaceChanged();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已创建并切换到 ${created.branch ?? created.name}')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(error, fallback: '创建 Worktree 失败。'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _showCreateFileDialog() async {
    if (!_canWrite || _mutating) return;
    final prefix = _currentPath.isEmpty ? '' : '$_currentPath/';
    final resultPath = await showDialog<String>(
      context: context,
      builder: (dialogContext) => _TextPromptDialog(
        title: '新建文件',
        labelText: '相对路径',
        hintText: '如 src/example.dart',
        initialValue: prefix,
        confirmLabel: '创建并编辑',
      ),
    );
    if (!mounted || resultPath == null || resultPath.isEmpty) return;
    setState(() => _mutating = true);
    try {
      final created = await widget.connection.workbenchWrite.createFile(
        threadId: widget.threadId,
        path: resultPath,
        text: '',
      );
      if (!mounted) return;
      _onWorkspaceChanged();
      _openFile(created.path, initialEditing: true);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: resultPath,
              fallback: '创建文件失败，请检查路径后重试。',
            ),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _openEntryActions(MobileDirectoryEntry entry) async {
    if (!_canWrite || _mutating) return;
    await showMobileSheet<void>(
      context,
      title: entry.name,
      content: (sheet) => SliverList.list(
        children: [
          MobileSheetAction(
            label: '重命名 / 移动',
            glyph: WorkspaceGlyph.pencil,
            onTap: () {
              Navigator.pop(sheet);
              unawaited(_showRenameDialog(entry));
            },
          ),
          MobileSheetAction(
            label: '删除',
            icon: Icons.delete_outline_rounded,
            destructive: true,
            onTap: () {
              Navigator.pop(sheet);
              unawaited(_confirmDeleteEntry(entry));
            },
          ),
        ],
      ),
    );
  }

  Future<void> _showRenameDialog(MobileDirectoryEntry entry) async {
    final newPath = await showDialog<String>(
      context: context,
      builder: (dialogContext) => _TextPromptDialog(
        title: '重命名 ${entry.name}',
        labelText: '新路径',
        initialValue: entry.path,
        confirmLabel: '确认',
      ),
    );
    if (!mounted || newPath == null || newPath.isEmpty || newPath == entry.path) {
      return;
    }
    setState(() => _mutating = true);
    try {
      await widget.connection.workbenchWrite.renamePath(
        threadId: widget.threadId,
        oldPath: entry.path,
        newPath: newPath,
      );
      if (!mounted) return;
      _onWorkspaceChanged();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已重命名')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: newPath,
              fallback: '重命名失败，请重试。',
            ),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _confirmDeleteEntry(MobileDirectoryEntry entry) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final palette = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: Text('删除「${entry.name}」？'),
          content: Text(
            entry.isDirectory
                ? '将尝试删除目录 ${entry.path}。'
                : '将永久删除文件 ${entry.path}，此操作不可撤销。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('删除'),
            ),
          ],
        );
      },
    );
    if (!mounted || confirmed != true) return;

    setState(() => _mutating = true);
    try {
      await widget.connection.workbenchWrite.deletePath(
        threadId: widget.threadId,
        path: entry.path,
        recursive: false,
      );
      if (!mounted) return;
      _onWorkspaceChanged();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已删除 ${entry.name}')),
      );
    } on MobileRpcFailure catch (error) {
      if (!mounted) return;
      if (error.problem.code == 'WORKBENCH_DIR_NOT_EMPTY') {
        setState(() => _mutating = false);
        await _confirmRecursiveDelete(entry);
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: entry.path,
              fallback: '删除失败，请重试。',
            ),
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: entry.path,
              fallback: '删除失败，请重试。',
            ),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _confirmRecursiveDelete(MobileDirectoryEntry entry) async {
    final recursiveConfirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final palette = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('确认递归删除非空目录？'),
          content: Text('目录 ${entry.path} 不为空，继续将永久删除目录及其全部内容。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('全部删除'),
            ),
          ],
        );
      },
    );
    if (!mounted || recursiveConfirmed != true) return;
    setState(() => _mutating = true);
    try {
      await widget.connection.workbenchWrite.deletePath(
        threadId: widget.threadId,
        path: entry.path,
        recursive: true,
      );
      if (!mounted) return;
      _onWorkspaceChanged();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已删除 ${entry.name}')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: entry.path,
              fallback: '递归删除失败，请重试。',
            ),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_canWrite) _buildWorktreeBar(context),
        _buildSearchBar(context),
        if (!_inSearchMode) _buildBreadcrumbs(context),
        Expanded(
          child: _inSearchMode
              ? _buildSearchResults(context)
              : _buildDirectoryList(context),
        ),
      ],
    );
  }

  Widget _buildWorktreeBar(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final label = _activeWorktreeLabel();
    return InkWell(
      key: FileBrowserTab.worktreeBarKey,
      onTap: _mutating ? null : () => unawaited(_openWorktreeSheet()),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.background,
          border: Border(bottom: BorderSide(color: colors.divider)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: TimelineSpace.x6,
            vertical: TimelineSpace.x2 + 2,
          ),
          child: Row(
            spacing: TimelineSpace.x3,
            children: [
              Icon(
                Icons.account_tree_outlined,
                size: 15,
                color: colors.muted,
              ),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TimelineType.metaStyle(
                    colors.secondaryText,
                    weight: FontWeight.w500,
                  ),
                ),
              ),
              Text(
                widget.threadBusy ? '运行中' : '切换',
                style: TimelineType.smallStyle(colors.muted),
              ),
              Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 16,
                color: colors.muted,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSearchBar(BuildContext context) {
    final theme = Theme.of(context);
    final brightness = theme.brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.background,
        border: Border(bottom: BorderSide(color: colors.divider)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          TimelineSpace.x6,
          TimelineSpace.x4,
          TimelineSpace.x6,
          TimelineSpace.x4,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: TimelineSpace.x3,
          children: [
            Container(
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(TimelineRadius.panel),
                border: Border.all(color: colors.border),
              ),
              padding: const EdgeInsetsDirectional.only(
                start: TimelineSpace.x5,
                end: TimelineSpace.x1,
              ),
              child: Row(
                children: [
                  IconTheme(
                    data: IconThemeData(color: colors.muted),
                    child: const WorkspaceIcon(
                      WorkspaceGlyph.search,
                      size: TimelineIcon.control,
                    ),
                  ),
                  const SizedBox(width: TimelineSpace.x4),
                  Expanded(
                    child: TextField(
                      key: FileBrowserTab.searchInputKey,
                      controller: _searchController,
                      onChanged: _onSearchChanged,
                      textInputAction: TextInputAction.search,
                      style: TimelineType.contentStyle(colors.foreground),
                      decoration: InputDecoration(
                        isDense: true,
                        border: InputBorder.none,
                        hintText: _searchMode == _SearchMode.filename
                            ? '搜索文件名…'
                            : '搜索代码内容…',
                        hintStyle: TimelineType.contentStyle(colors.faint),
                        contentPadding: const EdgeInsets.symmetric(
                          vertical: 10,
                        ),
                      ),
                    ),
                  ),
                  if (_searchController.text.isNotEmpty)
                    SizedBox.square(
                      dimension: touch - 4,
                      child: IconButton(
                        key: FileBrowserTab.searchClearKey,
                        tooltip: '清空搜索',
                        padding: EdgeInsets.zero,
                        onPressed: _clearSearch,
                        icon: IconTheme(
                          data: IconThemeData(color: colors.muted),
                          child: const WorkspaceIcon(
                            WorkspaceGlyph.close,
                            size: TimelineIcon.control,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Row(
              spacing: TimelineSpace.x3,
              children: [
                _SearchModeChip(
                  key: FileBrowserTab.filenameModeKey,
                  label: '文件名',
                  selected: _searchMode == _SearchMode.filename,
                  onTap: () => _setSearchMode(_SearchMode.filename),
                ),
                _SearchModeChip(
                  key: FileBrowserTab.contentModeKey,
                  label: '代码内容',
                  selected: _searchMode == _SearchMode.content,
                  onTap: () => _setSearchMode(_SearchMode.content),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBreadcrumbs(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final segments = _currentPath.isEmpty
        ? const <String>[]
        : _currentPath.split('/');

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.background,
        border: Border(bottom: BorderSide(color: colors.divider)),
      ),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              controller: _crumbScroll,
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(
                horizontal: TimelineSpace.x6,
                vertical: TimelineSpace.x2,
              ),
              child: Row(
                children: [
                  _BreadcrumbItem(
                    key: const ValueKey('workbench-crumb-root'),
                    label: '根目录',
                    active: segments.isEmpty,
                    onTap: segments.isEmpty
                        ? null
                        : () => unawaited(_loadDirectory('')),
                  ),
                  for (var i = 0; i < segments.length; i++) ...[
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 2),
                      child: Icon(
                        Icons.chevron_right_rounded,
                        size: 16,
                        color: colors.faint,
                      ),
                    ),
                    _BreadcrumbItem(
                      key: ValueKey(
                        'workbench-crumb-${segments.take(i + 1).join('/')}',
                      ),
                      label: segments[i],
                      active: i == segments.length - 1,
                      onTap: i == segments.length - 1
                          ? null
                          : () => unawaited(
                              _loadDirectory(segments.take(i + 1).join('/')),
                            ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (_canWrite)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: TimelineSpace.x4),
              child: IconButton(
                key: FileBrowserTab.createFileButtonKey,
                tooltip: '新建文件',
                onPressed: _mutating ? null : () => unawaited(_showCreateFileDialog()),
                color: colors.foreground,
                icon: const Icon(Icons.note_add_outlined, size: 19),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildDirectoryList(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final cached = _cache[_currentPath];

    if (_loadingDir && cached == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    if (_dirError != null && cached == null) {
      return RefreshIndicator(
        onRefresh: _refreshCurrentDirectory,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: 320,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(TimelineSpace.x8),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    spacing: TimelineSpace.x4,
                    children: [
                      Text(
                        _dirError!,
                        textAlign: TextAlign.center,
                        style: TimelineType.contentStyle(colors.muted),
                      ),
                      TextButton(
                        onPressed: () =>
                            unawaited(_loadDirectory(_currentPath, forceRefresh: true)),
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    final entries = cached?.entries ?? const <MobileDirectoryEntry>[];
    if (entries.isEmpty) {
      return RefreshIndicator(
        onRefresh: _refreshCurrentDirectory,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: 280,
              child: Center(
                child: Text(
                  '此目录为空',
                  style: TimelineType.contentStyle(colors.muted),
                ),
              ),
            ),
          ],
        ),
      );
    }

    final hasPagination = cached?.nextOffset != null || _loadMoreError != null;
    return RefreshIndicator(
      onRefresh: _refreshCurrentDirectory,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
        itemCount: entries.length + (hasPagination ? 1 : 0),
        separatorBuilder: (context, index) => Divider(
          height: 1,
          thickness: 1,
          indent: 48,
          color: colors.divider,
        ),
        itemBuilder: (context, index) {
          if (index == entries.length) {
            return Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: TimelineSpace.x7,
                vertical: TimelineSpace.x6,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                spacing: TimelineSpace.x2,
                children: [
                  if (_loadMoreError case final err?)
                    Text(
                      err,
                      style: TimelineType.smallStyle(colors.error),
                    ),
                  if (cached?.nextOffset != null)
                    OutlinedButton(
                      key: FileBrowserTab.loadMoreKey,
                      onPressed: _loadingMoreDir
                          ? null
                          : () => unawaited(_loadMoreEntries()),
                      child: Text(_loadingMoreDir ? '正在加载…' : '加载更多'),
                    ),
                ],
              ),
            );
          }
          final entry = entries[index];
          return _DirectoryEntryRow(
            entry: entry,
            showMore: _canWrite,
            onMore: _canWrite ? () => unawaited(_openEntryActions(entry)) : null,
            onLongPress: _canWrite
                ? () => unawaited(_openEntryActions(entry))
                : null,
            onTap: () {
              if (entry.isDirectory) {
                unawaited(_loadDirectory(entry.path));
              } else {
                _openFile(entry.path);
              }
            },
          );
        },
      ),
    );
  }

  Widget _buildSearchResults(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_searching) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    if (_searchError case final message?) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(TimelineSpace.x8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            spacing: TimelineSpace.x4,
            children: [
              Text(
                message,
                textAlign: TextAlign.center,
                style: TimelineType.contentStyle(colors.muted),
              ),
              TextButton(
                onPressed: () => unawaited(_executeSearch(_query, _searchMode)),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    if (_searchMode == _SearchMode.filename) {
      if (_pathResults.isEmpty) {
        return Center(
          child: Text(
            '未找到匹配的文件',
            style: TimelineType.contentStyle(colors.muted),
          ),
        );
      }
      return ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
        itemCount: _pathResults.length + (_pathResultsTruncated ? 1 : 0),
        separatorBuilder: (context, index) => Divider(
          height: 1,
          thickness: 1,
          indent: 48,
          color: colors.divider,
        ),
        itemBuilder: (context, index) {
          if (index == _pathResults.length) {
            return Padding(
              padding: const EdgeInsets.all(TimelineSpace.x6),
              child: Center(
                child: Text(
                  '仅显示前 ${_pathResults.length} 条结果，请输入更精确的关键词',
                  style: TimelineType.smallStyle(colors.muted),
                ),
              ),
            );
          }
          final entry = _pathResults[index];
          final isDir = entry.kind == MobilePathEntryKind.dir;
          final name = fileBaseName(entry.path);
          final parent = fileParentDir(entry.path);
          return _FilenameSearchRow(
            entry: entry,
            name: name,
            parent: parent,
            isDir: isDir,
            onTap: () {
              if (isDir) {
                _clearSearch();
                unawaited(_loadDirectory(entry.path));
              } else {
                _openFile(entry.path);
              }
            },
          );
        },
      );
    }

    if (_contentResults.isEmpty) {
      return Center(
        child: Text(
          '未找到匹配的代码内容',
          style: TimelineType.contentStyle(colors.muted),
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
      itemCount: _contentResults.length + (_contentResultsTruncated ? 1 : 0),
      separatorBuilder: (context, index) => Divider(
        height: 1,
        thickness: 1,
        color: colors.divider,
      ),
      itemBuilder: (context, index) {
        if (index == _contentResults.length) {
          return Padding(
            padding: const EdgeInsets.all(TimelineSpace.x6),
            child: Center(
              child: Text(
                '仅显示前 ${_contentResults.length} 条命中结果，请缩小搜索范围',
                style: TimelineType.smallStyle(colors.muted),
              ),
            ),
          );
        }
        final match = _contentResults[index];
        return _ContentSearchRow(
          match: match,
          query: _query,
          onTap: () => _openFile(match.path, line: match.line),
        );
      },
    );
  }
}

class _SearchModeChip extends StatelessWidget {
  const _SearchModeChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? colors.selectedOnSurface : Colors.transparent,
        shape: StadiumBorder(
          side: BorderSide(
            color: selected ? colors.strongBorder : colors.border,
          ),
        ),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: TimelineSpace.x6,
              vertical: TimelineSpace.x3,
            ),
            child: Text(
              label,
              style: TimelineType.metaStyle(
                selected ? colors.foreground : colors.muted,
                weight: selected ? FontWeight.w500 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _BreadcrumbItem extends StatelessWidget {
  const _BreadcrumbItem({
    super.key,
    required this.label,
    required this.active,
    this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final child = Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: TimelineSpace.x3,
        vertical: TimelineSpace.x3,
      ),
      child: Text(
        label,
        style: TimelineType.metaStyle(
          active ? colors.foreground : colors.muted,
          weight: active ? FontWeight.w500 : FontWeight.w400,
        ),
      ),
    );
    if (onTap == null) return child;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(TimelineRadius.small),
      child: child,
    );
  }
}

class _DirectoryEntryRow extends StatelessWidget {
  const _DirectoryEntryRow({
    required this.entry,
    required this.onTap,
    this.showMore = false,
    this.onMore,
    this.onLongPress,
  });

  final MobileDirectoryEntry entry;
  final VoidCallback onTap;
  final bool showMore;
  final VoidCallback? onMore;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final glyph = workbenchFileGlyph(entry.path, isDirectory: entry.isDirectory);
    final iconColor = entry.isDirectory
        ? colors.timelineFile
        : colors.secondaryText;

    final row = ConstrainedBox(
      constraints: BoxConstraints(minHeight: touch),
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          TimelineSpace.x7,
          TimelineSpace.x3,
          showMore ? TimelineSpace.x2 : TimelineSpace.x7,
          TimelineSpace.x3,
        ),
        child: Row(
          spacing: TimelineSpace.x4,
          children: [
            IconTheme(
              data: IconThemeData(color: iconColor),
              child: WorkspaceIcon(glyph, size: 18),
            ),
            Expanded(
              child: Row(
                spacing: TimelineSpace.x3,
                children: [
                  Flexible(
                    child: Text(
                      entry.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.contentStyle(colors.foreground),
                    ),
                  ),
                  if (entry.symlink)
                    Tooltip(
                      message: '符号链接',
                      child: Icon(
                        Icons.link_rounded,
                        size: TimelineIcon.meta,
                        color: colors.faint,
                      ),
                    ),
                ],
              ),
            ),
            if (!entry.isDirectory && entry.size != null)
              Text(
                formatFileSize(entry.size!),
                style: TimelineType.smallStyle(colors.faint).copyWith(
                  fontFeatures: TimelineType.tabular,
                ),
              ),
            if (entry.isDirectory)
              Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: colors.faint,
              ),
            if (showMore)
              IconButton(
                key: FileBrowserTab.entryMoreKey(entry.path),
                tooltip: '更多操作',
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints.tightFor(width: 36, height: 36),
                onPressed: onMore,
                icon: Icon(
                  Icons.more_horiz,
                  size: 18,
                  color: colors.muted,
                ),
              ),
          ],
        ),
      ),
    );

    return InkWell(
      key: ValueKey('workbench-entry-${entry.path}'),
      onTap: onTap,
      onLongPress: onLongPress,
      child: entry.ignored ? Opacity(opacity: 0.5, child: row) : row,
    );
  }
}

class _FilenameSearchRow extends StatelessWidget {
  const _FilenameSearchRow({
    required this.entry,
    required this.name,
    required this.parent,
    required this.isDir,
    required this.onTap,
  });

  final MobilePathEntry entry;
  final String name;
  final String parent;
  final bool isDir;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final glyph = workbenchFileGlyph(entry.path, isDirectory: isDir);

    return InkWell(
      key: ValueKey('workbench-path-result-${entry.path}'),
      onTap: onTap,
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: touch),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: TimelineSpace.x7,
            vertical: TimelineSpace.x3,
          ),
          child: Row(
            spacing: TimelineSpace.x5,
            children: [
              IconTheme(
                data: IconThemeData(
                  color: isDir ? colors.timelineFile : colors.secondaryText,
                ),
                child: WorkspaceIcon(glyph, size: 18),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.contentStyle(
                        colors.foreground,
                        weight: FontWeight.w500,
                      ),
                    ),
                    if (parent.isNotEmpty)
                      Text(
                        parent,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TimelineType.smallStyle(colors.muted),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ContentSearchRow extends StatelessWidget {
  const _ContentSearchRow({
    required this.match,
    required this.query,
    required this.onTap,
  });

  final MobileSearchMatch match;
  final String query;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final accent = ComposerSurface.accentText(brightness);
    final highlightBg = ComposerSurface.accentSoftStrong(brightness);

    return InkWell(
      key: ValueKey('workbench-content-result-${match.path}:${match.line}'),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x7,
          vertical: TimelineSpace.x4,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          spacing: TimelineSpace.x2,
          children: [
            Row(
              spacing: TimelineSpace.x3,
              children: [
                Expanded(
                  child: Text(
                    match.path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.metaStyle(
                      colors.foreground,
                      weight: FontWeight.w500,
                    ),
                  ),
                ),
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.field,
                    borderRadius: BorderRadius.circular(TimelineRadius.small),
                    border: Border.all(color: colors.border),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: TimelineSpace.x3,
                      vertical: 1,
                    ),
                    child: Text(
                      ':${match.line}',
                      style: TimelineType.microStyle(accent).copyWith(
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            Text.rich(
              _highlightPreview(
                match.preview.trim(),
                query,
                baseStyle: TimelineType.codeStyle(colors.secondaryText),
                highlightStyle: TimelineType.codeStyle(colors.foreground)
                    .copyWith(
                      backgroundColor: highlightBg,
                      fontWeight: FontWeight.w600,
                    ),
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }

  TextSpan _highlightPreview(
    String preview,
    String query, {
    required TextStyle baseStyle,
    required TextStyle highlightStyle,
  }) {
    if (query.isEmpty || preview.isEmpty) {
      return TextSpan(text: preview, style: baseStyle);
    }
    final lowerPreview = preview.toLowerCase();
    final lowerQuery = query.toLowerCase();
    final spans = <TextSpan>[];
    var start = 0;
    while (true) {
      final found = lowerPreview.indexOf(lowerQuery, start);
      if (found < 0) {
        if (start < preview.length) {
          spans.add(TextSpan(text: preview.substring(start), style: baseStyle));
        }
        break;
      }
      if (found > start) {
        spans.add(
          TextSpan(text: preview.substring(start, found), style: baseStyle),
        );
      }
      final end = found + lowerQuery.length;
      spans.add(
        TextSpan(text: preview.substring(found, end), style: highlightStyle),
      );
      start = end;
    }
    return TextSpan(style: baseStyle, children: spans);
  }
}

class _TextPromptDialog extends StatefulWidget {
  const _TextPromptDialog({
    required this.title,
    required this.labelText,
    required this.initialValue,
    required this.confirmLabel,
    this.hintText,
  });

  final String title;
  final String labelText;
  final String? hintText;
  final String initialValue;
  final String confirmLabel;

  @override
  State<_TextPromptDialog> createState() => _TextPromptDialogState();
}

class _TextPromptDialogState extends State<_TextPromptDialog> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialValue);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final trimmed = _controller.text.trim();
    if (trimmed.isNotEmpty) {
      Navigator.of(context).pop(trimmed);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MobileGlassDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        autocorrect: false,
        decoration: InputDecoration(
          labelText: widget.labelText,
          hintText: widget.hintText,
          border: const OutlineInputBorder(),
        ),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
