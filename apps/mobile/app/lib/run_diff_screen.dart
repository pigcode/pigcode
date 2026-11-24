import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'app_theme.dart';
import 'theme_colors.dart';
import 'workspace_icon.dart';

typedef RunChangeListLoader = Future<MobileRunChangesPage> Function(int offset);
typedef RunPatchLoader =
    Future<MobileRunDiffPage> Function(String path, int offset);

class RunDiffScreen extends StatefulWidget {
  const RunDiffScreen({
    super.key,
    required this.initial,
    this.loadFiles,
    this.loadDiff,
  });

  final MobileRunChangesPage initial;
  final RunChangeListLoader? loadFiles;
  final RunPatchLoader? loadDiff;

  static Future<void> open(
    BuildContext context, {
    required MobileRunChangesPage initial,
    RunChangeListLoader? loadFiles,
    RunPatchLoader? loadDiff,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute(
      builder: (_) => RunDiffScreen(
        initial: initial,
        loadFiles: loadFiles,
        loadDiff: loadDiff,
      ),
    ),
  );

  @override
  State<RunDiffScreen> createState() => _RunDiffScreenState();
}

class _RunDiffScreenState extends State<RunDiffScreen> {
  final _page = PageController();
  final _patches = <String, _Patch>{};
  final _fileKeys = <String, GlobalKey>{};
  late final List<MobileRunChangedFile> _files;
  int? _nextFiles;
  int _selected = 0;
  bool _wrap = true;
  bool _loadingFiles = false;
  bool _filesError = false;
  double _pathDrag = 0;

  bool get _canRead => widget.loadDiff != null && widget.initial.diffAvailable;

  @override
  void initState() {
    super.initState();
    _files = [...widget.initial.files];
    _nextFiles = widget.initial.nextOffset;
    if (_files.isNotEmpty) unawaited(_loadPatch(_files.first));
  }

  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  void _selectedPage(int index) {
    if (index == _selected) return;
    final file = _files[index];
    setState(() => _selected = index);
    if (!_patches.containsKey(file.path)) unawaited(_loadPatch(file));
  }

  Future<void> _loadFiles() async {
    final offset = _nextFiles;
    final read = widget.loadFiles;
    if (_loadingFiles || offset == null || read == null) return;
    setState(() {
      _loadingFiles = true;
      _filesError = false;
    });
    try {
      final page = await read(offset);
      if (!mounted) return;
      final seen = _files.map((file) => file.path).toSet();
      setState(() {
        _files.addAll(page.files.where((file) => seen.add(file.path)));
        final next = page.nextOffset;
        _nextFiles = next != null && next > offset ? next : null;
      });
    } catch (_) {
      if (mounted) setState(() => _filesError = true);
    } finally {
      if (mounted) setState(() => _loadingFiles = false);
    }
  }

  Future<void> _loadPatch(MobileRunChangedFile file) async {
    if (!_canRead || file.binary == true) return;
    final patch = _patches.putIfAbsent(file.path, _Patch.new);
    final offset = patch.next;
    if (patch.loading || offset == null) return;
    setState(() {
      patch.loading = true;
      patch.error = null;
    });
    try {
      final result = await widget.loadDiff!(file.path, offset);
      if (!mounted) return;
      setState(() {
        patch.text += result.text;
        final next = result.nextOffset;
        patch.next = next != null && next > offset ? next : null;
      });
    } catch (error) {
      if (mounted) setState(() => patch.error = error);
    } finally {
      if (mounted) setState(() => patch.loading = false);
    }
  }

  String get _unavailable {
    if (widget.initial.sharedWorktree == true) return '共享工作树中的改动无法按轮区分。';
    return widget.loadDiff == null ? '连接电脑后查看差异。' : '该轮检查点不可用，无法查看差异。';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
    final scaler = MediaQuery.textScalerOf(context);
    final pillHeight = math.max(34.0, scaler.scale(13) * 1.45 + 12);
    final visualBarHeight = pillHeight + 12;
    final fileBarHeight = math.max(touch, visualBarHeight);
    final toolbarHeight = math.max(
      52.0,
      (scaler.scale(17) + scaler.scale(12)) * 1.45 + 8,
    );
    return Scaffold(
      backgroundColor: palette.background,
      appBar: AppBar(
        centerTitle: true,
        toolbarHeight: toolbarHeight,
        titleSpacing: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
        leadingWidth: 72,
        leading: Navigator.canPop(context)
            ? Align(
                alignment: AlignmentDirectional.centerStart,
                child: SizedBox.square(
                  dimension: touch,
                  child: IconButton(
                    tooltip: '返回',
                    onPressed: () => Navigator.maybePop(context),
                    alignment: AlignmentDirectional.centerStart,
                    padding: const EdgeInsetsDirectional.only(start: 6),
                    icon: const RotatedBox(
                      quarterTurns: 1,
                      child: WorkspaceIcon(
                        WorkspaceGlyph.chevronDown,
                        size: 26,
                      ),
                    ),
                  ),
                ),
              )
            : null,
        title: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '改动',
              style: theme.textTheme.titleMedium?.copyWith(
                fontSize: 17,
                fontWeight: FontWeight.w500,
                height: 1.45,
                leadingDistribution: TextLeadingDistribution.even,
              ),
            ),
            Text(
              _nextFiles == null
                  ? '${_files.length} 个文件'
                  : '已加载 ${_files.length} 个文件',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: palette.muted,
                fontSize: 12,
                height: 1.45,
                leadingDistribution: TextLeadingDistribution.even,
              ),
            ),
          ],
        ),
        actions: [
          if (_canRead && _files.isNotEmpty)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: 6),
              child: Tooltip(
                message: _wrap ? '关闭换行' : '开启换行',
                child: TextButton(
                  style: TextButton.styleFrom(
                    foregroundColor: palette.secondaryText,
                    minimumSize: Size(0, touch),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    textStyle: theme.textTheme.bodyMedium?.copyWith(
                      fontSize: 15,
                      height: 1.45,
                    ),
                  ),
                  onPressed: () => setState(() => _wrap = !_wrap),
                  child: Text(_wrap ? '不换行' : '换行'),
                ),
              ),
            ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: _files.isEmpty
            ? Center(child: Text(_canRead ? '本轮没有文件变更' : _unavailable))
            : Column(
                children: [
                  _fileBar(context, fileBarHeight, pillHeight),
                  // Android 的额外触区利用路径栏上方的留白。
                  _currentPath(context, 6 - (fileBarHeight - visualBarHeight)),
                  Expanded(
                    child: PageView.builder(
                      controller: _page,
                      onPageChanged: _selectedPage,
                      itemCount: _files.length,
                      itemBuilder: (context, index) =>
                          _fileBody(_files[index], index),
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Widget _currentPath(BuildContext context, double topPadding) {
    final theme = Theme.of(context);
    final palette = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onHorizontalDragStart: (_) => _pathDrag = 0,
      onHorizontalDragUpdate: (details) =>
          _pathDrag += details.primaryDelta ?? 0,
      onHorizontalDragEnd: (_) {
        if (_pathDrag.abs() < 24) return;
        final index = _selected + (_pathDrag < 0 ? 1 : -1);
        if (index >= 0 && index < _files.length) _page.jumpToPage(index);
      },
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: palette.divider)),
        ),
        child: Padding(
          padding: EdgeInsets.fromLTRB(16, topPadding, 16, 7),
          child: SizedBox(
            width: double.infinity,
            child: Text(
              _files[_selected].path,
              style: theme.textTheme.bodySmall?.copyWith(
                color: palette.muted,
                fontSize: 12,
                height: 19 / 12,
                leadingDistribution: TextLeadingDistribution.even,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _fileBar(BuildContext context, double barHeight, double pillHeight) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(
        children: [
          for (var index = 0; index < _files.length; index++) ...[
            if (index != 0) const SizedBox(width: 8),
            _fileChip(context, index, barHeight, pillHeight),
          ],
          if (_nextFiles != null && widget.loadFiles != null)
            TextButton(
              onPressed: _loadingFiles ? null : _loadFiles,
              child: Text(
                _filesError
                    ? '重试读取文件'
                    : _loadingFiles
                    ? '正在读取…'
                    : '更多文件',
              ),
            ),
        ],
      ),
    );
  }

  Widget _fileChip(
    BuildContext context,
    int index,
    double height,
    double pillHeight,
  ) {
    final file = _files[index];
    final selected = index == _selected;
    final theme = Theme.of(context);
    final palette = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final name = file.path.split('/').last;
    final extension = name.split('.').last.toLowerCase();
    final typescript = const {'ts', 'mts', 'cts'}.contains(extension);
    final isCode =
        typescript ||
        const {
          'js',
          'mjs',
          'cjs',
          'tsx',
          'jsx',
          'dart',
          'py',
          'swift',
          'kt',
          'rs',
          'go',
          'java',
          'c',
          'h',
          'cpp',
          'css',
          'html',
          'sql',
        }.contains(extension);
    final iconColor = typescript
        ? theme.brightness == Brightness.dark
              ? const Color(0xFF6BADFF)
              : const Color(0xFF2769B7)
        : palette.timelineFile;
    final labelStyle = theme.textTheme.bodyMedium?.copyWith(
      color: palette.foreground,
      fontSize: 13,
      fontWeight: FontWeight.w400,
      height: 1.45,
      leadingDistribution: TextLeadingDistribution.even,
    );
    final counts = [
      if (file.added != null)
        TextSpan(
          text: '+${file.added}',
          style: TextStyle(color: palette.diffAdded),
        ),
      if (file.added != null && file.removed != null)
        const WidgetSpan(child: SizedBox(width: 6)),
      if (file.removed != null)
        TextSpan(
          text: '−${file.removed}',
          style: TextStyle(color: palette.diffRemoved),
        ),
    ];
    return Tooltip(
      key: _fileKeys.putIfAbsent(file.path, GlobalKey.new),
      message: file.path,
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: () => _page.jumpToPage(index),
          child: SizedBox(
            height: height,
            child: Align(
              alignment: Alignment.topCenter,
              child: Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Container(
                  height: pillHeight,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    maxWidth: 230,
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(
                    color: selected
                        ? palette.selectedOnBackground
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(17),
                    border: Border.all(
                      color: selected ? palette.strongBorder : palette.border,
                    ),
                  ),
                  child: Align(
                    widthFactor: 1,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      spacing: 6,
                      children: [
                        IconTheme(
                          data: IconThemeData(color: iconColor),
                          child: WorkspaceIcon(
                            isCode
                                ? WorkspaceGlyph.fileCode
                                : WorkspaceGlyph.fileText,
                            size: 18,
                          ),
                        ),
                        Flexible(
                          child: Text(
                            name,
                            style: labelStyle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (counts.isNotEmpty)
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 90),
                            child: Text.rich(
                              TextSpan(children: counts),
                              style: labelStyle?.copyWith(
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _fileBody(MobileRunChangedFile file, int index) {
    if (!_canRead) return Center(child: Text(_unavailable));
    if (file.binary == true) {
      return const Center(child: Text('二进制文件没有文本差异。'));
    }
    final patch = _patches[file.path];
    if (patch == null) return const SizedBox.shrink();
    if (patch.text.isEmpty && patch.loading) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    final unavailable = switch (patch.error) {
      MobileRpcFailure(:final problem)
          when problem.code == 'RESOURCE_NOT_AVAILABLE' =>
        _unavailable,
      _ => '暂时无法读取此文件的差异。',
    };
    final Widget? footer;
    if (patch.error != null) {
      footer = Column(
        children: [
          Text(unavailable),
          TextButton(
            onPressed: () => _loadPatch(file),
            child: const Text('重试'),
          ),
        ],
      );
    } else if (patch.loading || patch.next != null) {
      footer = TextButton(
        onPressed: patch.loading ? null : () => _loadPatch(file),
        child: Text(patch.loading ? '正在读取差异…' : '继续读取差异'),
      );
    } else if (patch.text.isEmpty) {
      footer = const Text('没有文本差异。');
    } else {
      footer = null;
    }

    return _DiffBody(
      key: PageStorageKey(file.path),
      text: patch.text,
      wrap: _wrap,
      footer: footer,
      swipeHint: _files.length > 1
          ? '左右滑动切换文件 · ${index + 1}/${_files.length}'
          : null,
    );
  }
}

class _Patch {
  String text = '';
  int? next = 0;
  bool loading = false;
  Object? error;
}

enum _LineKind { header, gap, context, added, removed }

typedef _Line = ({_LineKind kind, int? number, String text});

final _hunk = RegExp(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@');
final _identifierBreak = RegExp(r'[A-Za-z0-9_](?=[A-Za-z0-9_])');

List<_Line> _diffLines(String text) {
  var oldNumber = 0;
  var newNumber = 0;
  var oldLines = 0;
  var newLines = 0;
  var hasHunks = false;
  final lines = text.split('\n');
  if (lines.last.isEmpty) lines.removeLast();
  final result = <_Line>[];
  for (final line in lines) {
    final raw = line.endsWith('\r') ? line.substring(0, line.length - 1) : line;
    if (_hunk.firstMatch(raw) case final hunk?) {
      if (result.isNotEmpty) {
        result.add((kind: _LineKind.gap, number: null, text: '⋯'));
      }
      oldNumber = int.parse(hunk.group(1)!);
      oldLines = int.parse(hunk.group(2) ?? '1');
      newNumber = int.parse(hunk.group(3)!);
      newLines = int.parse(hunk.group(4) ?? '1');
      hasHunks = true;
      continue;
    }
    if (newLines > 0 && raw.startsWith('+')) {
      newLines--;
      result.add((
        kind: _LineKind.added,
        number: newNumber++,
        text: raw.substring(1),
      ));
    } else if (oldLines > 0 && raw.startsWith('-')) {
      oldLines--;
      result.add((
        kind: _LineKind.removed,
        number: oldNumber++,
        text: raw.substring(1),
      ));
    } else if (oldLines > 0 && newLines > 0 && raw.startsWith(' ')) {
      oldLines--;
      newLines--;
      oldNumber++;
      result.add((
        kind: _LineKind.context,
        number: newNumber++,
        text: raw.substring(1),
      ));
    } else if (hasHunks && raw.startsWith(r'\ No newline')) {
      result.add((kind: _LineKind.header, number: null, text: raw));
    }
  }
  return hasHunks
      ? result
      : [
          for (final line in lines)
            (kind: _LineKind.header, number: null, text: line),
        ];
}

class _DiffBody extends StatelessWidget {
  const _DiffBody({
    super.key,
    required this.text,
    required this.wrap,
    this.footer,
    this.swipeHint,
  });

  final String text;
  final bool wrap;
  final Widget? footer;
  final String? swipeHint;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final style = TextStyle(
      fontFamily: theme.platform == TargetPlatform.iOS ? 'Menlo' : 'monospace',
      fontSize: 12,
      height: 19 / 12,
      leadingDistribution: TextLeadingDistribution.even,
      color: colors.foreground,
    );
    final lines = _diffLines(text);
    return LayoutBuilder(
      builder: (context, constraints) {
        final tail = <Widget>[
          if (footer != null)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Center(child: footer),
            ),
          if (swipeHint != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Center(
                child: Text(
                  swipeHint!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.muted,
                    fontSize: 12,
                    height: 19 / 12,
                  ),
                ),
              ),
            ),
        ];
        final list = ListView.builder(
          padding: EdgeInsets.zero,
          itemCount: lines.length + tail.length,
          itemBuilder: (context, index) => index < lines.length
              ? _DiffRow(line: lines[index], wrap: wrap, style: style)
              : Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: SizedBox(
                    width: constraints.maxWidth,
                    child: tail[index - lines.length],
                  ),
                ),
        );
        if (wrap) return list;
        final longest = lines.fold<int>(
          0,
          (length, line) => math.max(length, line.text.length),
        );
        final width = MediaQuery.textScalerOf(context).scale(12) * longest + 66;
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: math.max(constraints.maxWidth, width),
            child: list,
          ),
        );
      },
    );
  }
}

class _DiffRow extends StatelessWidget {
  const _DiffRow({required this.line, required this.wrap, required this.style});

  final _Line line;
  final bool wrap;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    if (line.kind == _LineKind.gap) {
      return ColoredBox(
        color: colors.panel,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Center(
            child: Text(line.text, style: style.copyWith(color: colors.faint)),
          ),
        ),
      );
    }
    final (background, marker) = switch (line.kind) {
      _LineKind.added => (colors.diffAddedBackground, '+'),
      _LineKind.removed => (colors.diffRemovedBackground, '−'),
      _ => (colors.background, ''),
    };
    return ColoredBox(
      color: background,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 38,
            child: Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Text(
                line.number?.toString() ?? '',
                textAlign: TextAlign.right,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: style.copyWith(color: colors.faint),
              ),
            ),
          ),
          SizedBox(
            width: 14,
            child: Text(marker, style: style.copyWith(color: colors.muted)),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 14),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final text = wrap
                      ? _breakLongLine(context, line.text, constraints.maxWidth)
                      : line.text;
                  return Text(
                    text.isEmpty ? ' ' : text,
                    semanticsLabel: line.text,
                    softWrap: wrap,
                    style: line.kind == _LineKind.header
                        ? style.copyWith(color: colors.muted)
                        : style,
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _breakLongLine(BuildContext context, String text, double width) {
    final scaler = MediaQuery.textScalerOf(context);
    if (scaler.scale(12) * text.length <= width) return text;
    final measure = TextPainter(
      text: TextSpan(text: text, style: style),
      maxLines: 1,
      textDirection: Directionality.of(context),
      textScaler: scaler,
    )..layout();
    final needsBreaks = measure.width > width;
    measure.dispose();
    if (!needsBreaks) return text;
    // 给长标识符增加折行机会，标点仍由文本布局处理；读屏用原始文本。
    return text.replaceAllMapped(
      _identifierBreak,
      (letter) => '${letter[0]}\u200b',
    );
  }
}
