import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../composer/composer_tokens.dart';
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
  });

  static const searchInputKey = ValueKey('workbench-search-input');
  static const searchClearKey = ValueKey('workbench-search-clear');
  static const filenameModeKey = ValueKey('workbench-search-mode-filename');
  static const contentModeKey = ValueKey('workbench-search-mode-content');
  static const loadMoreKey = ValueKey('workbench-load-more');

  final MobileConnection connection;
  final String threadId;
  final String initialDirectory;
  final Duration searchDebounce;

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

  String get _query => _searchController.text.trim();
  bool get _inSearchMode => _query.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _currentPath = _normalizeDirPath(widget.initialDirectory);
    unawaited(_loadDirectory(_currentPath));
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

  void _openFile(String path, {int? line}) {
    unawaited(
      MobileFileViewerScreen.open(
        context,
        connection: widget.connection,
        threadId: widget.threadId,
        path: path,
        initialLine: line,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
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
              onTap: segments.isEmpty ? null : () => unawaited(_loadDirectory('')),
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
  const _DirectoryEntryRow({required this.entry, required this.onTap});

  final MobileDirectoryEntry entry;
  final VoidCallback onTap;

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
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x7,
          vertical: TimelineSpace.x3,
        ),
        child: Row(
          spacing: TimelineSpace.x5,
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
          ],
        ),
      ),
    );

    return InkWell(
      key: ValueKey('workbench-entry-${entry.path}'),
      onTap: onTap,
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
