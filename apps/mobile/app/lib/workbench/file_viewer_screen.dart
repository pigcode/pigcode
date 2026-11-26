import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../attachments/image_viewer_page.dart';
import '../composer/composer_tokens.dart';
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../timeline_widgets.dart';
import '../workspace_icon.dart';
import 'workbench_utils.dart';

/// 手机端文件查看与轻量编辑器：
/// - 支持代码语法高亮（`re_highlight`）、等宽行号、目标行高亮与自动定位、自动换行/横向滚动、文本选择复制；
/// - 支持 Markdown 预览（复用 `gpt_markdown`）与源码一键切换（带目标行跳入时默认切到源码）；
/// - 支持普通非截断文本文件编辑保存（带 `expectedMtimeMs` 并发冲突解决与大文件透明分片提交）；
/// - 支持大文件分片续读（`nextOffset != null`）及 > 1 MiB 截断提示；
/// - 支持项目图片文件（`InteractiveViewer` 缩放 + 双击放大 + 黑底全屏预览）与二进制文件提示。
class MobileFileViewerScreen extends StatefulWidget {
  const MobileFileViewerScreen({
    super.key,
    required this.connection,
    required this.threadId,
    required this.path,
    this.initialLine,
    this.initialEditing = false,
    this.onFileChanged,
  });

  static const wrapToggleKey = ValueKey('file-viewer-wrap-toggle');
  static const markdownToggleKey = ValueKey('file-viewer-markdown-toggle');
  static const moreMenuKey = ValueKey('file-viewer-more-menu');
  static const loadMoreKey = ValueKey('file-viewer-load-more');
  static const fullscreenImageKey = ValueKey('file-viewer-image-fullscreen');
  static const truncationBannerKey = ValueKey('file-viewer-truncation-banner');
  static const editButtonKey = ValueKey('file-viewer-edit');
  static const saveButtonKey = ValueKey('file-viewer-save');
  static const cancelEditButtonKey = ValueKey('file-viewer-cancel-edit');
  static const editorInputKey = ValueKey('file-viewer-editor-input');

  final MobileConnection connection;
  final String threadId;
  final String path;
  final int? initialLine;
  final bool initialEditing;
  final VoidCallback? onFileChanged;

  static Future<void> open(
    BuildContext context, {
    required MobileConnection connection,
    required String threadId,
    required String path,
    int? initialLine,
    bool initialEditing = false,
    VoidCallback? onFileChanged,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => MobileFileViewerScreen(
        connection: connection,
        threadId: threadId,
        path: path,
        initialLine: initialLine,
        initialEditing: initialEditing,
        onFileChanged: onFileChanged,
      ),
    ),
  );

  @override
  State<MobileFileViewerScreen> createState() => _MobileFileViewerScreenState();
}

class _MobileFileViewerScreenState extends State<MobileFileViewerScreen> {
  static const _oneMiB = 1024 * 1024;
  static const _maxAutoChunksForLine = 32;

  final _verticalScroll = ScrollController();
  final _imageTransform = TransformationController();
  final _editController = TextEditingController();
  GlobalKey? _targetLineKey;
  Offset? _doubleTapPosition;

  String _canonicalPath = '';
  String? _mode;
  int _totalSize = 0;
  String _text = '';
  int _loadedBytes = 0;
  String? _languageHint;
  bool _truncated = false;
  int? _nextOffset;
  double? _mtimeMs;
  String? _eol;

  bool _editing = false;
  String _editBaseline = '';
  bool _dirty = false;
  bool _saving = false;
  int _saveSentBytes = 0;
  int _saveTotalBytes = 0;

  MobileFileImageData? _imageData;
  int _imageReceivedBytes = 0;
  int _imageTotalBytes = 0;

  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  String? _loadMoreError;

  bool _wrap = true;
  late bool _markdownPreview;
  bool _scrolledToInitialLine = false;
  int _loadGeneration = 0;

  // 高亮结果缓存，避免每次滚动/交互重复跑 syntax highlighter。
  String? _cachedHighlightText;
  String? _cachedHighlightLang;
  Brightness? _cachedHighlightBrightness;
  List<TextSpan>? _cachedLines;

  bool get _isMarkdown => isMarkdownPath(_canonicalPath);
  bool get _showingMarkdownPreview =>
      _mode == 'text' && _isMarkdown && _markdownPreview;
  bool get _exceededOneMbCap =>
      _mode == 'text' &&
      (_totalSize > _oneMiB || (_nextOffset == null && _truncated));
  bool get _canEdit =>
      !_loading &&
      _error == null &&
      _mode == 'text' &&
      !_truncated &&
      _nextOffset == null &&
      !_exceededOneMbCap &&
      connectionSupportsWorkbenchWrite(widget.connection);

  @override
  void initState() {
    super.initState();
    _canonicalPath = widget.path.trim();
    _markdownPreview = isMarkdownPath(_canonicalPath) && widget.initialLine == null;
    if (widget.initialLine != null && widget.initialLine! > 0) {
      _targetLineKey = GlobalKey();
    }
    _editController.addListener(_onEditTextChanged);
    unawaited(_loadInitial(enterEditIfRequested: widget.initialEditing));
  }

  @override
  void dispose() {
    _editController.removeListener(_onEditTextChanged);
    _editController.dispose();
    _verticalScroll.dispose();
    _imageTransform.dispose();
    super.dispose();
  }

  void _onEditTextChanged() {
    if (!_editing) return;
    final nextDirty = _editController.text != _editBaseline;
    if (nextDirty != _dirty && mounted) {
      setState(() => _dirty = nextDirty);
    }
  }

  Future<void> _loadInitial({bool enterEditIfRequested = false}) async {
    final generation = ++_loadGeneration;
    setState(() {
      _loading = true;
      _loadingMore = false;
      _error = null;
      _loadMoreError = null;
      _mode = null;
      _text = '';
      _loadedBytes = 0;
      _nextOffset = null;
      _truncated = false;
      _mtimeMs = null;
      _eol = null;
      _editing = false;
      _editBaseline = '';
      _dirty = false;
      _imageData = null;
      _imageReceivedBytes = 0;
      _imageTotalBytes = 0;
      _scrolledToInitialLine = false;
      _invalidateHighlightCache();
    });

    try {
      final chunk = await widget.connection.workbench.readFile(
        threadId: widget.threadId,
        path: widget.path,
        offset: 0,
        mode: 'auto',
      );
      if (!mounted || generation != _loadGeneration) return;

      final canonical = chunk.path.isNotEmpty ? chunk.path : widget.path;
      if (chunk.mode == 'image') {
        setState(() {
          _canonicalPath = canonical;
          _mode = 'image';
          _totalSize = chunk.totalSize;
          _imageTotalBytes = chunk.totalSize;
          _mtimeMs = chunk.mtimeMs;
        });
        await _loadImage(canonical, generation);
        return;
      }

      if (chunk.mode == 'binary') {
        setState(() {
          _canonicalPath = canonical;
          _mode = 'binary';
          _totalSize = chunk.totalSize;
          _mtimeMs = chunk.mtimeMs;
          _loading = false;
        });
        return;
      }

      var text = chunk.text ?? '';
      var loadedBytes = utf8.encode(text).length;
      var nextOffset = chunk.nextOffset;
      var truncated = chunk.truncated;
      final mtimeMs = chunk.mtimeMs;
      final eol = chunk.eol;
      final targetLine = widget.initialLine;

      // 若指定了目标行号且首片尚未覆盖到该行，自动续读直至覆盖目标行。
      if (targetLine != null && targetLine > 0 && nextOffset != null) {
        var autoLoads = 0;
        while (nextOffset != null &&
            autoLoads < _maxAutoChunksForLine &&
            _countLines(text) < targetLine) {
          autoLoads++;
          final requestedOffset = nextOffset;
          final more = await widget.connection.workbench.readFile(
            threadId: widget.threadId,
            path: canonical,
            offset: requestedOffset,
            mode: 'text',
          );
          if (!mounted || generation != _loadGeneration) return;
          final piece = more.text ?? '';
          text += piece;
          loadedBytes += utf8.encode(piece).length;
          truncated = more.truncated;
          final next = more.nextOffset;
          nextOffset = next != null && next > requestedOffset ? next : null;
        }
      }

      setState(() {
        _canonicalPath = canonical;
        _mode = 'text';
        _totalSize = chunk.totalSize;
        _text = text;
        _loadedBytes = loadedBytes;
        _languageHint = chunk.languageHint;
        _truncated = truncated;
        _nextOffset = nextOffset;
        _mtimeMs = mtimeMs;
        _eol = eol;
        _markdownPreview = isMarkdownPath(canonical) && targetLine == null;
        _loading = false;
        _invalidateHighlightCache();
      });

      if (enterEditIfRequested && _canEdit) {
        _enterEditMode();
      } else if (targetLine != null && targetLine > 0) {
        _scheduleScrollToLine(targetLine);
      }
    } catch (error) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _loading = false;
        _error = workbenchErrorMessage(
          error,
          path: widget.path,
          fallback: '暂时无法读取该文件，请重试。',
        );
      });
    }
  }

  Future<void> _loadImage(String path, int generation) async {
    try {
      final image = await widget.connection.workbench.readFileImage(
        threadId: widget.threadId,
        path: path,
        variant: 'full',
        onProgress: (received, total) {
          if (!mounted || generation != _loadGeneration) return;
          setState(() {
            _imageReceivedBytes = received;
            _imageTotalBytes = total;
          });
        },
      );
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _imageData = image;
        _totalSize = image.totalSize;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _loading = false;
        _error = workbenchErrorMessage(
          error,
          path: path,
          fallback: '暂时无法加载图片，请重试。',
        );
      });
    }
  }

  Future<void> _loadMoreText() async {
    final offset = _nextOffset;
    if (_loadingMore || offset == null || _mode != 'text') return;
    final generation = _loadGeneration;
    setState(() {
      _loadingMore = true;
      _loadMoreError = null;
    });
    try {
      final chunk = await widget.connection.workbench.readFile(
        threadId: widget.threadId,
        path: _canonicalPath,
        offset: offset,
        mode: 'text',
      );
      if (!mounted || generation != _loadGeneration) return;
      final piece = chunk.text ?? '';
      final next = chunk.nextOffset;
      setState(() {
        _text += piece;
        _loadedBytes += utf8.encode(piece).length;
        _truncated = chunk.truncated;
        _nextOffset = next != null && next > offset ? next : null;
        _loadingMore = false;
        _invalidateHighlightCache();
      });
    } catch (error) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _loadingMore = false;
        _loadMoreError = workbenchErrorMessage(
          error,
          path: _canonicalPath,
          fallback: '继续读取失败，请重试。',
        );
      });
    }
  }

  void _invalidateHighlightCache() {
    _cachedHighlightText = null;
    _cachedHighlightLang = null;
    _cachedHighlightBrightness = null;
    _cachedLines = null;
  }

  int _countLines(String value) {
    if (value.isEmpty) return 0;
    return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').length;
  }

  void _scheduleScrollToLine(int targetLine) {
    if (_scrolledToInitialLine) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _scrolledToInitialLine || _showingMarkdownPreview) return;
      _scrolledToInitialLine = true;
      if (!_verticalScroll.hasClients) return;
      const estimatedLineHeight = TimelineType.codeLineHeight;
      final viewport = _verticalScroll.position.viewportDimension;
      final maxExtent = _verticalScroll.position.maxScrollExtent;
      final targetOffset = math
          .max(0.0, (targetLine - 1) * estimatedLineHeight - viewport * 0.25)
          .clamp(0.0, maxExtent);
      _verticalScroll.jumpTo(targetOffset);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final ctx = _targetLineKey?.currentContext;
        if (ctx != null) {
          unawaited(
            Scrollable.ensureVisible(
              ctx,
              alignment: 0.25,
              duration: Duration.zero,
            ),
          );
        }
      });
    });
  }

  List<TextSpan> _highlightedLines(BuildContext context, TextStyle baseStyle) {
    final brightness = Theme.of(context).brightness;
    final lang = resolveHighlightLanguage(_languageHint, _canonicalPath);
    if (_cachedLines != null &&
        identical(_cachedHighlightText, _text) &&
        _cachedHighlightLang == lang &&
        _cachedHighlightBrightness == brightness) {
      return _cachedLines!;
    }
    final lines = highlightCodeLines(
      code: _text,
      language: lang,
      baseStyle: baseStyle,
      brightness: brightness,
    );
    _cachedHighlightText = _text;
    _cachedHighlightLang = lang;
    _cachedHighlightBrightness = brightness;
    _cachedLines = lines;
    return lines;
  }

  Future<void> _copyPath() async {
    await Clipboard.setData(ClipboardData(text: _canonicalPath));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('已复制路径 $_canonicalPath')),
    );
  }

  Future<void> _copyContent() async {
    await Clipboard.setData(ClipboardData(text: _text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          _nextOffset != null || _exceededOneMbCap ? '已复制当前已加载内容' : '已复制文件内容',
        ),
      ),
    );
  }

  void _openFullscreenImage() {
    final data = _imageData;
    if (data == null) return;
    unawaited(
      ImageViewerPage.open(
        context,
        items: [
          ImageViewerItem(
            fileName: fileBaseName(_canonicalPath),
            initialBytes: data.bytes,
            isFullBytes: true,
            width: data.width,
            height: data.height,
          ),
        ],
      ),
    );
  }

  void _handleImageDoubleTap() {
    if (!_imageTransform.value.isIdentity()) {
      _imageTransform.value = Matrix4.identity();
      return;
    }
    const targetScale = 2.5;
    final tap = _doubleTapPosition;
    if (tap == null) {
      _imageTransform.value = Matrix4.diagonal3Values(
        targetScale,
        targetScale,
        1,
      );
      return;
    }
    final matrix = Matrix4.identity()
      ..setEntry(0, 3, -tap.dx * (targetScale - 1))
      ..setEntry(1, 3, -tap.dy * (targetScale - 1))
      ..setEntry(0, 0, targetScale)
      ..setEntry(1, 1, targetScale);
    _imageTransform.value = matrix;
  }

  void _enterEditMode() {
    if (!_canEdit || _saving) return;
    final baseline = _text.replaceAll('\r\n', '\n');
    _editBaseline = baseline;
    _editController.value = TextEditingValue(
      text: baseline,
      selection: TextSelection.collapsed(offset: baseline.length),
    );
    setState(() {
      _editing = true;
      _dirty = false;
    });
  }

  Future<bool> _confirmDiscardEdits() async {
    if (!_editing || !_dirty) return true;
    final discard = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final palette = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('放弃未保存的修改？'),
          content: const Text('当前文件的修改尚未保存到电脑端，离开后不会保留。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('继续编辑'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('放弃修改'),
            ),
          ],
        );
      },
    );
    return discard == true;
  }

  Future<void> _cancelEdit() async {
    if (_saving) return;
    if (!await _confirmDiscardEdits() || !mounted) return;
    setState(() {
      _editing = false;
      _dirty = false;
    });
  }

  Future<void> _confirmDiscardAndPop() async {
    if (_saving) return;
    if (!await _confirmDiscardEdits() || !mounted) return;
    setState(() {
      _editing = false;
      _dirty = false;
    });
    if (mounted) {
      Navigator.of(context).pop();
    }
  }

  Future<void> _save({bool ignoreConflict = false}) async {
    if (_saving || !_editing) return;
    final draftText = _editController.text;
    final total = utf8.encode(draftText).length;
    setState(() {
      _saving = true;
      _saveSentBytes = 0;
      _saveTotalBytes = total;
    });
    try {
      final result = await widget.connection.workbenchWrite.writeFile(
        threadId: widget.threadId,
        path: _canonicalPath,
        text: draftText,
        expectedMtimeMs: ignoreConflict ? null : _mtimeMs,
        eol: _eol,
        onProgress: (sent, totalBytes) {
          if (!mounted) return;
          setState(() {
            _saveSentBytes = sent;
            _saveTotalBytes = totalBytes;
          });
        },
      );
      if (!mounted) return;
      final storedText =
          _eol == 'crlf' ? draftText.replaceAll('\n', '\r\n') : draftText;
      setState(() {
        _saving = false;
        _editing = false;
        _dirty = false;
        _text = storedText;
        _totalSize = result.size;
        _loadedBytes = utf8.encode(storedText).length;
        _mtimeMs = result.mtimeMs;
        _invalidateHighlightCache();
      });
      widget.onFileChanged?.call();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已保存')),
      );
    } on MobileRpcFailure catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      if (error.problem.code == 'WORKBENCH_FILE_CONFLICT') {
        await _showConflictDialog();
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: _canonicalPath,
              fallback: '保存失败，请重试。',
            ),
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            workbenchErrorMessage(
              error,
              path: _canonicalPath,
              fallback: '保存失败，请重试。',
            ),
          ),
        ),
      );
    }
  }

  Future<void> _showConflictDialog() async {
    final choice = await showDialog<String>(
      context: context,
      builder: (dialogContext) {
        final palette = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('文件已被修改'),
          content: const Text(
            '自你打开以来，电脑端或 Agent 已修改过这个文件。请选择要保留的版本：',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop('keep'),
              child: const Text('继续编辑'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop('reload'),
              child: const Text('重新加载'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop('overwrite'),
              child: const Text('强制覆盖'),
            ),
          ],
        );
      },
    );
    if (!mounted) return;
    if (choice == 'reload') {
      await _loadInitial();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已重新加载电脑端最新内容')),
      );
    } else if (choice == 'overwrite') {
      await _save(ignoreConflict: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final scaler = MediaQuery.textScalerOf(context);
    final toolbarHeight = math.max(
      52.0,
      (scaler.scale(16) + scaler.scale(12)) * 1.45 + 10,
    );
    final title = fileBaseName(_canonicalPath);
    final showSourceControls =
        !_loading &&
        _error == null &&
        _mode == 'text' &&
        !_editing &&
        !_showingMarkdownPreview;

    return PopScope(
      canPop: !(_editing && _dirty) && !_saving,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !_saving) {
          unawaited(_confirmDiscardAndPop());
        }
      },
      child: Scaffold(
        backgroundColor: colors.background,
        appBar: AppBar(
          toolbarHeight: toolbarHeight,
          titleSpacing: 0,
          scrolledUnderElevation: 0,
          systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
          leadingWidth: touch + 14,
          leading: Align(
            alignment: AlignmentDirectional.centerStart,
            child: MobileGlassChromeButton(
              padding: const EdgeInsetsDirectional.only(start: 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  tooltip: '返回',
                  padding: EdgeInsets.zero,
                  onPressed: _saving ? null : () => Navigator.maybePop(context),
                  icon: const RotatedBox(
                    quarterTurns: 1,
                    child: WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 20),
                  ),
                ),
              ),
            ),
          ),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _editing && _dirty ? '$title · 未保存' : title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontSize: 16,
                  fontWeight: FontWeight.w500,
                  height: 1.35,
                  leadingDistribution: TextLeadingDistribution.even,
                ),
              ),
              Text(
                _canonicalPath,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.muted,
                  fontSize: 12,
                  height: 1.35,
                  leadingDistribution: TextLeadingDistribution.even,
                ),
              ),
            ],
          ),
          actions: [
            Center(
              child: MobileGlassChromeButton(
                padding: const EdgeInsetsDirectional.only(end: 10),
                child: _editing
                    ? Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          TextButton(
                            key: MobileFileViewerScreen.cancelEditButtonKey,
                            style: TextButton.styleFrom(
                              foregroundColor: colors.secondaryText,
                              minimumSize: const Size(0, 40),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                              ),
                            ),
                            onPressed: _saving ? null : () => unawaited(_cancelEdit()),
                            child: const Text('取消'),
                          ),
                          TextButton(
                            key: MobileFileViewerScreen.saveButtonKey,
                            style: TextButton.styleFrom(
                              foregroundColor: _dirty
                                  ? ComposerSurface.accent(theme.brightness)
                                  : colors.muted,
                              minimumSize: const Size(0, 40),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                              ),
                            ),
                            onPressed: (!_dirty || _saving)
                                ? null
                                : () => unawaited(_save()),
                            child: Text(_saving ? '保存中…' : '保存'),
                          ),
                        ],
                      )
                    : Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (_canEdit)
                            SizedBox.square(
                              dimension: 40,
                              child: IconButton(
                                key: MobileFileViewerScreen.editButtonKey,
                                tooltip: '编辑',
                                padding: EdgeInsets.zero,
                                onPressed: _enterEditMode,
                                color: colors.foreground,
                                icon: const WorkspaceIcon(
                                  WorkspaceGlyph.pencil,
                                  size: 18,
                                ),
                              ),
                            ),
                          if (!_loading &&
                              _error == null &&
                              _mode == 'text' &&
                              _isMarkdown)
                            TextButton(
                              key: MobileFileViewerScreen.markdownToggleKey,
                              style: TextButton.styleFrom(
                                foregroundColor: colors.secondaryText,
                                minimumSize: const Size(0, 40),
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                ),
                              ),
                              onPressed: () {
                                setState(
                                  () => _markdownPreview = !_markdownPreview,
                                );
                                if (!_markdownPreview &&
                                    widget.initialLine != null) {
                                  _scrolledToInitialLine = false;
                                  _scheduleScrollToLine(widget.initialLine!);
                                }
                              },
                              child: Text(_markdownPreview ? '源码' : '预览'),
                            ),
                          if (showSourceControls)
                            SizedBox.square(
                              dimension: 40,
                              child: IconButton(
                                key: MobileFileViewerScreen.wrapToggleKey,
                                tooltip: _wrap ? '切换为横向滚动' : '切换为自动换行',
                                padding: EdgeInsets.zero,
                                onPressed: () => setState(() => _wrap = !_wrap),
                                color: _wrap
                                    ? ComposerSurface.accent(theme.brightness)
                                    : colors.muted,
                                icon: const Icon(Icons.wrap_text, size: 19),
                              ),
                            ),
                          if (!_loading &&
                              _error == null &&
                              _mode == 'image' &&
                              _imageData != null)
                            SizedBox.square(
                              dimension: 40,
                              child: IconButton(
                                key: MobileFileViewerScreen.fullscreenImageKey,
                                tooltip: '全屏预览',
                                padding: EdgeInsets.zero,
                                onPressed: _openFullscreenImage,
                                color: colors.foreground,
                                icon: const Icon(
                                  Icons.fullscreen_rounded,
                                  size: 21,
                                ),
                              ),
                            ),
                          SizedBox.square(
                            dimension: 40,
                            child: IconButton(
                              key: MobileFileViewerScreen.moreMenuKey,
                              tooltip: '更多操作',
                              padding: EdgeInsets.zero,
                              onPressed: () {
                                unawaited(
                                  showMobileSheet<void>(
                                    context,
                                    title: title,
                                    content: (sheet) => SliverList.list(
                                      children: [
                                        MobileSheetAction(
                                          label: '复制路径',
                                          glyph: WorkspaceGlyph.copy,
                                          onTap: () {
                                            Navigator.pop(sheet);
                                            unawaited(_copyPath());
                                          },
                                        ),
                                        if (_mode == 'text' &&
                                            !_loading &&
                                            _error == null)
                                          MobileSheetAction(
                                            label: '复制全文',
                                            icon: Icons.article_outlined,
                                            onTap: () {
                                              Navigator.pop(sheet);
                                              unawaited(_copyContent());
                                            },
                                          ),
                                      ],
                                    ),
                                  ),
                                );
                              },
                              icon: Icon(
                                Icons.more_horiz,
                                color: colors.foreground,
                                size: 20,
                              ),
                            ),
                          ),
                        ],
                      ),
              ),
            ),
          ],
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(1),
            child: Divider(
              height: 1,
              thickness: 1,
              color: colors.divider,
            ),
          ),
        ),
        body: SafeArea(
          top: false,
          child: _editing ? _buildEditorBody(context) : _buildBody(context),
        ),
      ),
    );
  }

  Widget _buildEditorBody(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final codeStyle = TextStyle(
      fontFamily: theme.platform == TargetPlatform.iOS ? 'Menlo' : 'monospace',
      fontFamilyFallback: TimelineType.monoFallback,
      fontSize: TimelineType.code,
      height: TimelineType.codeLineHeight / TimelineType.code,
      leadingDistribution: TextLeadingDistribution.even,
      color: colors.foreground,
    );
    final progress = _saving && _saveTotalBytes > 0
        ? (_saveSentBytes / _saveTotalBytes).clamp(0.0, 1.0)
        : null;
    return Column(
      children: [
        if (_saving)
          LinearProgressIndicator(
            value: progress,
            minHeight: 2,
            backgroundColor: colors.divider,
            color: ComposerSurface.accent(theme.brightness),
          ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: TimelineSpace.x6,
              vertical: TimelineSpace.x4,
            ),
            child: TextField(
              key: MobileFileViewerScreen.editorInputKey,
              controller: _editController,
              enabled: !_saving,
              maxLines: null,
              expands: true,
              textAlignVertical: TextAlignVertical.top,
              autocorrect: false,
              enableSuggestions: false,
              smartQuotesType: SmartQuotesType.disabled,
              smartDashesType: SmartDashesType.disabled,
              keyboardType: TextInputType.multiline,
              style: codeStyle,
              decoration: InputDecoration(
                border: InputBorder.none,
                hintText: '在此输入文件内容…',
                hintStyle: codeStyle.copyWith(color: colors.faint),
                contentPadding: EdgeInsets.zero,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildBody(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_loading) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: TimelineSpace.x4,
          children: [
            const CircularProgressIndicator.adaptive(),
            if (_mode == 'image' && _imageTotalBytes > 0 && _imageReceivedBytes > 0)
              Text(
                '正在加载图片（${formatFileSize(_imageReceivedBytes)} / ${formatFileSize(_imageTotalBytes)}）',
                style: TimelineType.smallStyle(colors.muted),
              ),
          ],
        ),
      );
    }

    if (_error case final message?) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(TimelineSpace.x9),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            spacing: TimelineSpace.x4,
            children: [
              Icon(
                Icons.error_outline_rounded,
                size: 32,
                color: colors.muted,
              ),
              Text(
                message,
                textAlign: TextAlign.center,
                style: TimelineType.contentStyle(colors.foreground),
              ),
              TextButton(
                onPressed: () => unawaited(_loadInitial()),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    return switch (_mode) {
      'binary' => _buildBinaryView(context),
      'image' => _buildImageView(context),
      'text' => _showingMarkdownPreview
          ? _buildMarkdownPreview(context)
          : _buildSourceView(context),
      _ => const SizedBox.shrink(),
    };
  }

  Widget _buildBinaryView(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(TimelineSpace.x9),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: TimelineSpace.x4,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(TimelineRadius.panel),
                border: Border.all(color: colors.border),
              ),
              alignment: Alignment.center,
              child: IconTheme(
                data: IconThemeData(color: colors.muted),
                child: const WorkspaceIcon(WorkspaceGlyph.fileText, size: 28),
              ),
            ),
            Text(
              fileBaseName(_canonicalPath),
              textAlign: TextAlign.center,
              style: TimelineType.contentStyle(
                colors.foreground,
                weight: FontWeight.w500,
              ),
            ),
            Text(
              formatFileSize(_totalSize),
              style: TimelineType.metaMonoStyle(colors.muted),
            ),
            Text(
              '二进制文件暂不支持文本预览',
              textAlign: TextAlign.center,
              style: TimelineType.metaStyle(colors.muted),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildImageView(BuildContext context) {
    final data = _imageData;
    if (data == null) return const SizedBox.shrink();
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final metaParts = <String>[
      if (data.width != null && data.height != null)
        '${data.width} × ${data.height}',
      formatFileSize(data.totalSize),
      data.mimeType,
    ];
    return Column(
      children: [
        Expanded(
          child: Container(
            color: colors.window,
            width: double.infinity,
            child: GestureDetector(
              onDoubleTapDown: (details) =>
                  _doubleTapPosition = details.localPosition,
              onDoubleTap: _handleImageDoubleTap,
              child: InteractiveViewer(
                transformationController: _imageTransform,
                minScale: 1.0,
                maxScale: 4.0,
                child: Center(
                  child: Image.memory(
                    data.bytes,
                    fit: BoxFit.contain,
                    gaplessPlayback: true,
                    errorBuilder: (_, _, _) => Text(
                      '无法解码图片内容',
                      style: TimelineType.metaStyle(colors.muted),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surface,
            border: Border(top: BorderSide(color: colors.divider)),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: TimelineSpace.x7,
              vertical: TimelineSpace.x4,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    metaParts.join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.smallStyle(colors.muted).copyWith(
                      fontFeatures: TimelineType.tabular,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _openFullscreenImage,
                  child: const Text('黑底全屏'),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildTruncationBanner(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return DecoratedBox(
      key: MobileFileViewerScreen.truncationBannerKey,
      decoration: BoxDecoration(
        color: colors.attentionTint,
        border: Border(bottom: BorderSide(color: colors.divider)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x7,
          vertical: TimelineSpace.x3,
        ),
        child: Row(
          spacing: TimelineSpace.x3,
          children: [
            Icon(
              Icons.info_outline_rounded,
              size: TimelineIcon.meta,
              color: colors.attention,
            ),
            Expanded(
              child: Text(
                '文件较大，仅展示前 1 MB 内容',
                style: TimelineType.smallStyle(colors.attention),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMarkdownPreview(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_exceededOneMbCap) _buildTruncationBanner(context),
        Expanded(
          child: SelectionArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(TimelineSpace.x7),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_text.isEmpty)
                    Center(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: TimelineSpace.x9,
                        ),
                        child: Text(
                          '空文件',
                          style: TimelineType.metaStyle(
                            Theme.of(context).brightness == Brightness.dark
                                ? pigcodeDark.muted
                                : pigcodeLight.muted,
                          ),
                        ),
                      ),
                    )
                  else
                    TimelineAnswer(text: _text, padding: EdgeInsets.zero),
                  if (_nextOffset != null || _loadMoreError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: TimelineSpace.x6),
                      child: _buildLoadMoreFooter(context),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSourceView(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final codeStyle = TextStyle(
      fontFamily: theme.platform == TargetPlatform.iOS ? 'Menlo' : 'monospace',
      fontFamilyFallback: TimelineType.monoFallback,
      fontSize: TimelineType.code,
      height: TimelineType.codeLineHeight / TimelineType.code,
      leadingDistribution: TextLeadingDistribution.even,
      color: colors.foreground,
    );

    if (_text.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_exceededOneMbCap) _buildTruncationBanner(context),
          Expanded(
            child: Center(
              child: Text('空文件', style: TimelineType.metaStyle(colors.muted)),
            ),
          ),
        ],
      );
    }

    final lines = _highlightedLines(context, codeStyle);
    final scaler = MediaQuery.textScalerOf(context);
    final gutterWidth = lineNumberGutterWidth(lines.length, scaler);
    final hasFooter = _nextOffset != null || _loadMoreError != null;
    final highlightColor = ComposerSurface.accentSoftStrong(theme.brightness);
    final accentColor = ComposerSurface.accent(theme.brightness);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_exceededOneMbCap) _buildTruncationBanner(context),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final list = SelectionArea(
                child: ListView.builder(
                  controller: _verticalScroll,
                  padding: const EdgeInsets.symmetric(
                    vertical: TimelineSpace.x4,
                  ),
                  itemCount: lines.length + (hasFooter ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (index == lines.length) {
                      return Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: SizedBox(
                          width: constraints.maxWidth,
                          child: Padding(
                            padding: const EdgeInsets.all(TimelineSpace.x6),
                            child: _buildLoadMoreFooter(context),
                          ),
                        ),
                      );
                    }
                    final lineNumber = index + 1;
                    final isHighlighted = widget.initialLine == lineNumber;
                    return Container(
                      key: isHighlighted
                          ? _targetLineKey
                          : ValueKey('file-viewer-line-$lineNumber'),
                      decoration: isHighlighted
                          ? BoxDecoration(
                              color: highlightColor,
                              border: Border(
                                left: BorderSide(
                                  color: accentColor,
                                  width: 2.5,
                                ),
                              ),
                            )
                          : null,
                      child: Row(
                        key: isHighlighted
                            ? ValueKey('file-viewer-line-$lineNumber')
                            : null,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SelectionContainer.disabled(
                            child: SizedBox(
                              width: gutterWidth,
                              child: Padding(
                                padding: const EdgeInsets.only(right: 10),
                                child: Text(
                                  '$lineNumber',
                                  textAlign: TextAlign.right,
                                  maxLines: 1,
                                  style: codeStyle.copyWith(
                                    color: isHighlighted
                                        ? accentColor
                                        : colors.faint,
                                    fontWeight: isHighlighted
                                        ? FontWeight.w600
                                        : FontWeight.w400,
                                    fontFeatures: TimelineType.tabular,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.only(right: 16),
                              child: Text.rich(
                                lines[index],
                                softWrap: _wrap,
                              ),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              );

              if (_wrap) return list;

              final normalizedLines = _text
                  .replaceAll('\r\n', '\n')
                  .replaceAll('\r', '\n')
                  .split('\n');
              final longest = normalizedLines.fold<int>(
                0,
                (best, line) => math.max(best, line.length),
              );
              final estimatedWidth =
                  scaler.scale(TimelineType.code) * 0.72 * longest +
                  gutterWidth +
                  48;
              return SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: SizedBox(
                  width: math.max(constraints.maxWidth, estimatedWidth),
                  child: list,
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _buildLoadMoreFooter(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Column(
      mainAxisSize: MainAxisSize.min,
      spacing: TimelineSpace.x2,
      children: [
        if (_loadMoreError case final message?)
          Text(
            message,
            textAlign: TextAlign.center,
            style: TimelineType.smallStyle(colors.error),
          ),
        if (_nextOffset != null)
          OutlinedButton(
            key: MobileFileViewerScreen.loadMoreKey,
            onPressed: _loadingMore ? null : () => unawaited(_loadMoreText()),
            child: Text(
              _loadingMore
                  ? '正在加载…'
                  : '加载更多（已显示 ${formatFileSize(_loadedBytes)} / 总计 ${formatFileSize(_totalSize)}）',
            ),
          ),
      ],
    );
  }
}
