import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../attachments/image_viewer_page.dart';
import '../composer/composer_tokens.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../timeline_widgets.dart';
import '../workspace_icon.dart';
import 'workbench_utils.dart';

enum _FileMoreAction { copyPath, copyContent }

/// 手机端只读文件查看器：
/// - 支持代码语法高亮（`re_highlight`）、等宽行号、目标行高亮与自动定位、自动换行/横向滚动、文本选择复制；
/// - 支持 Markdown 预览（复用 `gpt_markdown`）与源码一键切换（带目标行跳入时默认切到源码）；
/// - 支持大文件分片续读（`nextOffset != null`）及 > 1 MiB 截断提示；
/// - 支持项目图片文件（`InteractiveViewer` 缩放 + 双击放大 + 黑底全屏预览）与二进制文件提示。
class MobileFileViewerScreen extends StatefulWidget {
  const MobileFileViewerScreen({
    super.key,
    required this.connection,
    required this.threadId,
    required this.path,
    this.initialLine,
  });

  static const wrapToggleKey = ValueKey('file-viewer-wrap-toggle');
  static const markdownToggleKey = ValueKey('file-viewer-markdown-toggle');
  static const moreMenuKey = ValueKey('file-viewer-more-menu');
  static const loadMoreKey = ValueKey('file-viewer-load-more');
  static const fullscreenImageKey = ValueKey('file-viewer-image-fullscreen');
  static const truncationBannerKey = ValueKey('file-viewer-truncation-banner');

  final MobileConnection connection;
  final String threadId;
  final String path;
  final int? initialLine;

  static Future<void> open(
    BuildContext context, {
    required MobileConnection connection,
    required String threadId,
    required String path,
    int? initialLine,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => MobileFileViewerScreen(
        connection: connection,
        threadId: threadId,
        path: path,
        initialLine: initialLine,
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

  @override
  void initState() {
    super.initState();
    _canonicalPath = widget.path.trim();
    _markdownPreview = isMarkdownPath(_canonicalPath) && widget.initialLine == null;
    if (widget.initialLine != null && widget.initialLine! > 0) {
      _targetLineKey = GlobalKey();
    }
    unawaited(_loadInitial());
  }

  @override
  void dispose() {
    _verticalScroll.dispose();
    _imageTransform.dispose();
    super.dispose();
  }

  Future<void> _loadInitial() async {
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
        });
        await _loadImage(canonical, generation);
        return;
      }

      if (chunk.mode == 'binary') {
        setState(() {
          _canonicalPath = canonical;
          _mode = 'binary';
          _totalSize = chunk.totalSize;
          _loading = false;
        });
        return;
      }

      var text = chunk.text ?? '';
      var loadedBytes = utf8.encode(text).length;
      var nextOffset = chunk.nextOffset;
      var truncated = chunk.truncated;
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
        _markdownPreview = isMarkdownPath(canonical) && targetLine == null;
        _loading = false;
        _invalidateHighlightCache();
      });

      if (targetLine != null && targetLine > 0) {
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
        !_loading && _error == null && _mode == 'text' && !_showingMarkdownPreview;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        toolbarHeight: toolbarHeight,
        titleSpacing: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
        leadingWidth: touch + 8,
        leading: Align(
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
                child: WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 24),
              ),
            ),
          ),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
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
          if (!_loading && _error == null && _mode == 'text' && _isMarkdown)
            TextButton(
              key: MobileFileViewerScreen.markdownToggleKey,
              style: TextButton.styleFrom(
                foregroundColor: colors.secondaryText,
                minimumSize: Size(0, touch),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                padding: const EdgeInsets.symmetric(horizontal: 10),
              ),
              onPressed: () {
                setState(() => _markdownPreview = !_markdownPreview);
                if (!_markdownPreview && widget.initialLine != null) {
                  _scrolledToInitialLine = false;
                  _scheduleScrollToLine(widget.initialLine!);
                }
              },
              child: Text(_markdownPreview ? '源码' : '预览'),
            ),
          if (showSourceControls)
            SizedBox.square(
              dimension: touch,
              child: IconButton(
                key: MobileFileViewerScreen.wrapToggleKey,
                tooltip: _wrap ? '切换为横向滚动' : '切换为自动换行',
                onPressed: () => setState(() => _wrap = !_wrap),
                color: _wrap ? ComposerSurface.accent(theme.brightness) : colors.muted,
                icon: const Icon(Icons.wrap_text, size: 20),
              ),
            ),
          if (!_loading && _error == null && _mode == 'image' && _imageData != null)
            SizedBox.square(
              dimension: touch,
              child: IconButton(
                key: MobileFileViewerScreen.fullscreenImageKey,
                tooltip: '全屏预览',
                onPressed: _openFullscreenImage,
                color: colors.foreground,
                icon: const Icon(Icons.fullscreen_rounded, size: 22),
              ),
            ),
          PopupMenuButton<_FileMoreAction>(
            key: MobileFileViewerScreen.moreMenuKey,
            tooltip: '更多操作',
            icon: Icon(Icons.more_horiz, color: colors.foreground, size: 20),
            onSelected: (action) {
              switch (action) {
                case _FileMoreAction.copyPath:
                  unawaited(_copyPath());
                case _FileMoreAction.copyContent:
                  unawaited(_copyContent());
              }
            },
            itemBuilder: (context) => [
              const PopupMenuItem<_FileMoreAction>(
                value: _FileMoreAction.copyPath,
                child: Text('复制路径'),
              ),
              if (_mode == 'text' && !_loading && _error == null)
                const PopupMenuItem<_FileMoreAction>(
                  value: _FileMoreAction.copyContent,
                  child: Text('复制全文'),
                ),
            ],
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
        child: _buildBody(context),
      ),
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
