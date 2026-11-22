import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'theme_colors.dart';

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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final chip = _fileKeys[file.path]?.currentContext;
      if (mounted && _selected == index && chip != null) {
        unawaited(Scrollable.ensureVisible(chip, alignment: .5));
      }
    });
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
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('改动'),
      actions: [
        if (_canRead && _files.isNotEmpty)
          IconButton(
            tooltip: _wrap ? '关闭换行' : '开启换行',
            isSelected: _wrap,
            icon: const Icon(Icons.wrap_text),
            onPressed: () => setState(() => _wrap = !_wrap),
          ),
      ],
    ),
    body: SafeArea(
      top: false,
      child: _files.isEmpty
          ? Center(child: Text(_canRead ? '本轮没有文件变更' : _unavailable))
          : Column(
              children: [
                _fileBar(context),
                const Divider(height: 1),
                _currentPath(context),
                Expanded(
                  child: PageView.builder(
                    controller: _page,
                    onPageChanged: _selectedPage,
                    itemCount: _files.length,
                    itemBuilder: (context, index) => _fileBody(_files[index]),
                  ),
                ),
              ],
            ),
    ),
  );

  Widget _currentPath(BuildContext context) => GestureDetector(
    behavior: HitTestBehavior.opaque,
    onHorizontalDragStart: (_) => _pathDrag = 0,
    onHorizontalDragUpdate: (details) => _pathDrag += details.primaryDelta ?? 0,
    onHorizontalDragEnd: (_) {
      if (_pathDrag.abs() < 24) return;
      final index = _selected + (_pathDrag < 0 ? 1 : -1);
      if (index >= 0 && index < _files.length) _page.jumpToPage(index);
    },
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: SizedBox(
        width: double.infinity,
        child: Text(
          _files[_selected].path,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ),
    ),
  );

  Widget _fileBar(BuildContext context) {
    final theme = Theme.of(context);
    final touchHeight = theme.platform == TargetPlatform.iOS ? 44.0 : 48.0;
    final pillHeight = math.max(
      34.0,
      MediaQuery.textScalerOf(context).scale(14) + 12,
    );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          for (var index = 0; index < _files.length; index++) ...[
            if (index != 0) const SizedBox(width: 8),
            _fileChip(
              context,
              index,
              math.max(touchHeight, pillHeight),
              pillHeight,
            ),
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
    final color = theme.colorScheme;
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
            child: Center(
              child: Container(
                height: pillHeight,
                constraints: const BoxConstraints(minWidth: 48, maxWidth: 230),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                  color: selected ? color.primary : color.surface,
                  borderRadius: BorderRadius.circular(17),
                  border: Border.all(
                    color: selected ? color.primary : color.outlineVariant,
                  ),
                ),
                child: Align(
                  widthFactor: 1,
                  child: Text(
                    file.path.split('/').last,
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: selected ? color.onPrimary : color.onSurface,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _fileBody(MobileRunChangedFile file) {
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
    );
  }
}

class _Patch {
  String text = '';
  int? next = 0;
  bool loading = false;
  Object? error;
}

enum _LineKind { header, context, added, removed }

typedef _Line = ({_LineKind kind, int? number, String text});

final _hunk = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@');

List<_Line> _diffLines(String text) {
  var oldNumber = 0;
  var newNumber = 0;
  var inHunk = false;
  final lines = text.split('\n');
  if (lines.last.isEmpty) lines.removeLast();
  final result = <_Line>[];
  for (final raw in lines) {
    if (_hunk.firstMatch(raw) case final hunk?) {
      oldNumber = int.parse(hunk.group(1)!);
      newNumber = int.parse(hunk.group(2)!);
      inHunk = true;
    }
    if (inHunk && raw.startsWith('+')) {
      result.add((
        kind: _LineKind.added,
        number: newNumber++,
        text: raw.substring(1),
      ));
    } else if (inHunk && raw.startsWith('-')) {
      result.add((
        kind: _LineKind.removed,
        number: oldNumber++,
        text: raw.substring(1),
      ));
    } else if (inHunk && raw.startsWith(' ')) {
      oldNumber++;
      result.add((
        kind: _LineKind.context,
        number: newNumber++,
        text: raw.substring(1),
      ));
    } else {
      result.add((kind: _LineKind.header, number: null, text: raw));
    }
  }
  return result;
}

const _diffStyle = TextStyle(
  fontFamily: 'monospace',
  fontSize: 12,
  height: 19 / 12,
);

class _DiffBody extends StatelessWidget {
  const _DiffBody({
    super.key,
    required this.text,
    required this.wrap,
    this.footer,
  });

  final String text;
  final bool wrap;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final lines = _diffLines(text);
    final list = ListView.builder(
      itemCount: lines.length + (footer == null ? 0 : 1),
      itemBuilder: (context, index) => index == lines.length
          ? Padding(
              padding: const EdgeInsets.all(12),
              child: Center(child: footer),
            )
          : _DiffRow(line: lines[index], wrap: wrap),
    );
    if (wrap) return list;

    final longest = lines.fold<int>(
      0,
      (length, line) => math.max(length, line.text.length),
    );
    final width = MediaQuery.textScalerOf(context).scale(12) * longest + 66;
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: math.max(constraints.maxWidth, width),
          child: list,
        ),
      ),
    );
  }
}

class _DiffRow extends StatelessWidget {
  const _DiffRow({required this.line, required this.wrap});

  final _Line line;
  final bool wrap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final (foreground, background, marker) = switch (line.kind) {
      _LineKind.added => (colors.diffAdded, colors.diffAddedBackground, '+'),
      _LineKind.removed => (
        colors.diffRemoved,
        colors.diffRemovedBackground,
        '−',
      ),
      _LineKind.header => (colors.muted, colors.surface, ''),
      _LineKind.context => (colors.foreground, colors.background, ''),
    };
    return ColoredBox(
      color: background,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 38,
            child: Text(
              line.number?.toString() ?? '',
              textAlign: TextAlign.right,
              style: _diffStyle.copyWith(color: colors.muted),
            ),
          ),
          SizedBox(
            width: 14,
            child: Text(
              marker,
              textAlign: TextAlign.center,
              style: _diffStyle.copyWith(color: foreground),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Text(
                line.text,
                softWrap: wrap,
                style: _diffStyle.copyWith(color: foreground),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
