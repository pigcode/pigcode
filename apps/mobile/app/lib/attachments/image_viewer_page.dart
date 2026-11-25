import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';

/// 全屏图片查看器中的单页数据源（兼容输入框本地预览与时间线远端附件）。
@immutable
final class ImageViewerItem {
  const ImageViewerItem({
    required this.fileName,
    this.attachmentId,
    this.initialBytes,
    this.isFullBytes = false,
    this.width,
    this.height,
  });

  factory ImageViewerItem.fromRef(
    MobileAttachmentRef ref, {
    Uint8List? initialBytes,
  }) => ImageViewerItem(
    attachmentId: ref.id,
    fileName: ref.fileName,
    initialBytes: initialBytes,
    width: ref.width,
    height: ref.height,
  );

  final String fileName;
  final String? attachmentId;
  final Uint8List? initialBytes;
  final bool isFullBytes;
  final int? width;
  final int? height;
}

typedef AttachmentBytesLoader = Future<Uint8List?> Function(String attachmentId);

/// 黑色背景全屏图片查看器：
/// - `PageView` 支持左右滑动切换同一消息内的多张图片，顶部显示页码、文件名与关闭按钮；
/// - 每页支持 `InteractiveViewer` 双指缩放及双击放大/还原；
/// - 时间线图片打开时优先立即展示已缓存的缩略图，同时后台加载高清原图并平滑切换。
class ImageViewerPage extends StatefulWidget {
  const ImageViewerPage({
    super.key,
    required this.items,
    this.initialIndex = 0,
    this.loadThumb,
    this.loadFull,
  });

  static const pageKey = ValueKey('image-viewer-page');
  static const closeButtonKey = ValueKey('image-viewer-close');
  static const pageViewKey = ValueKey('image-viewer-pageview');
  static const retryButtonKey = ValueKey('image-viewer-retry');

  final List<ImageViewerItem> items;
  final int initialIndex;
  final AttachmentBytesLoader? loadThumb;
  final AttachmentBytesLoader? loadFull;

  static Future<void> open(
    BuildContext context, {
    required List<ImageViewerItem> items,
    int initialIndex = 0,
    AttachmentBytesLoader? loadThumb,
    AttachmentBytesLoader? loadFull,
  }) {
    if (items.isEmpty) return Future<void>.value();
    final safeIndex = initialIndex.clamp(0, items.length - 1);
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => ImageViewerPage(
          items: items,
          initialIndex: safeIndex,
          loadThumb: loadThumb,
          loadFull: loadFull,
        ),
      ),
    );
  }

  @override
  State<ImageViewerPage> createState() => _ImageViewerPageState();
}

class _ImageViewerPageState extends State<ImageViewerPage> {
  late final PageController _pageController;
  late int _currentIndex;
  bool _currentZoomed = false;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex.clamp(0, widget.items.length - 1);
    _pageController = PageController(initialPage: _currentIndex);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.items[_currentIndex];
    final touch = timelineTouchHeight(context);

    return Scaffold(
      key: ImageViewerPage.pageKey,
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          PageView.builder(
            key: ImageViewerPage.pageViewKey,
            controller: _pageController,
            physics: _currentZoomed
                ? const NeverScrollableScrollPhysics()
                : null,
            itemCount: widget.items.length,
            onPageChanged: (index) => setState(() {
              _currentIndex = index;
              _currentZoomed = false;
            }),
            itemBuilder: (context, index) => _ImageViewerSlide(
              key: ValueKey('image-viewer-slide-$index-${widget.items[index].attachmentId ?? widget.items[index].fileName}'),
              item: widget.items[index],
              loadThumb: widget.loadThumb,
              loadFull: widget.loadFull,
              onZoomChanged: (zoomed) {
                if (index == _currentIndex && _currentZoomed != zoomed) {
                  setState(() => _currentZoomed = zoomed);
                }
              },
            ),
          ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: DecoratedBox(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Color(0xB3000000), Colors.transparent],
                ),
              ),
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: TimelineSpace.x4,
                    vertical: TimelineSpace.x2,
                  ),
                  child: Row(
                    children: [
                      const SizedBox(width: TimelineSpace.x2),
                      Text(
                        '${_currentIndex + 1} / ${widget.items.length}',
                        style: TimelineType.metaStyle(
                          Colors.white,
                          weight: FontWeight.w500,
                        ).copyWith(fontFeatures: TimelineType.tabular),
                      ),
                      const SizedBox(width: TimelineSpace.x4),
                      Expanded(
                        child: Text(
                          current.fileName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TimelineType.metaStyle(Colors.white70),
                        ),
                      ),
                      SizedBox.square(
                        dimension: touch,
                        child: IconButton(
                          key: ImageViewerPage.closeButtonKey,
                          tooltip: '关闭预览',
                          onPressed: () => Navigator.of(context).pop(),
                          icon: const IconTheme(
                            data: IconThemeData(color: Colors.white),
                            child: WorkspaceIcon(
                              WorkspaceGlyph.close,
                              size: TimelineIcon.alert,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ImageViewerSlide extends StatefulWidget {
  const _ImageViewerSlide({
    super.key,
    required this.item,
    this.loadThumb,
    this.loadFull,
    this.onZoomChanged,
  });

  final ImageViewerItem item;
  final AttachmentBytesLoader? loadThumb;
  final AttachmentBytesLoader? loadFull;
  final ValueChanged<bool>? onZoomChanged;

  @override
  State<_ImageViewerSlide> createState() => _ImageViewerSlideState();
}

class _ImageViewerSlideState extends State<_ImageViewerSlide> {
  final _transformController = TransformationController();
  Offset? _doubleTapPosition;
  bool _isZoomed = false;
  int _pointerCount = 0;

  Uint8List? _thumbBytes;
  Uint8List? _fullBytes;
  bool _loadingFull = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _transformController.addListener(_syncZoomState);
    if (widget.item.isFullBytes) {
      _fullBytes = widget.item.initialBytes;
    } else {
      _thumbBytes = widget.item.initialBytes;
    }
    _startLoads();
  }

  @override
  void dispose() {
    _transformController.removeListener(_syncZoomState);
    _transformController.dispose();
    super.dispose();
  }

  void _syncZoomState() {
    final zoomed = _transformController.value.getMaxScaleOnAxis() > 1.01;
    if (zoomed != _isZoomed) {
      setState(() => _isZoomed = zoomed);
      widget.onZoomChanged?.call(zoomed);
    }
  }

  void _startLoads() {
    final attachmentId = widget.item.attachmentId;
    if (attachmentId == null) return;
    if (_thumbBytes == null && _fullBytes == null && widget.loadThumb != null) {
      unawaited(_loadThumb(attachmentId));
    }
    if (_fullBytes == null && widget.loadFull != null) {
      unawaited(_loadFull(attachmentId));
    }
  }

  Future<void> _loadThumb(String attachmentId) async {
    try {
      final bytes = await widget.loadThumb!(attachmentId);
      if (!mounted || bytes == null || bytes.isEmpty) return;
      if (_thumbBytes == null) {
        setState(() => _thumbBytes = bytes);
      }
    } catch (_) {
      // 缩略图加载失败由原图加载兜底。
    }
  }

  Future<void> _loadFull(String attachmentId) async {
    if (_loadingFull || widget.loadFull == null) return;
    setState(() {
      _loadingFull = true;
      _failed = false;
    });
    try {
      final bytes = await widget.loadFull!(attachmentId);
      if (!mounted) return;
      if (bytes == null || bytes.isEmpty) {
        setState(() {
          _loadingFull = false;
          _failed = true;
        });
        return;
      }
      setState(() {
        _fullBytes = bytes;
        _loadingFull = false;
        _failed = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingFull = false;
        _failed = true;
      });
    }
  }

  void _handleDoubleTap() {
    final current = _transformController.value;
    if (!current.isIdentity()) {
      _transformController.value = Matrix4.identity();
      return;
    }
    const targetScale = 2.5;
    final tap = _doubleTapPosition;
    if (tap == null) {
      _transformController.value = Matrix4.diagonal3Values(
        targetScale,
        targetScale,
        1,
      );
      return;
    }
    final dx = -tap.dx * (targetScale - 1);
    final dy = -tap.dy * (targetScale - 1);
    final matrix = Matrix4.identity()
      ..setEntry(0, 3, dx)
      ..setEntry(1, 3, dy)
      ..setEntry(0, 0, targetScale)
      ..setEntry(1, 1, targetScale);
    _transformController.value = matrix;
  }

  @override
  Widget build(BuildContext context) {
    final displayBytes = _fullBytes ?? _thumbBytes;
    final attachmentId = widget.item.attachmentId;
    final hasImage = displayBytes != null && displayBytes.isNotEmpty;

    return Stack(
      fit: StackFit.expand,
      children: [
        if (hasImage)
          Listener(
            onPointerDown: (_) {
              setState(() => _pointerCount++);
            },
            onPointerUp: (_) {
              setState(() => _pointerCount = (_pointerCount - 1).clamp(0, 10));
            },
            onPointerCancel: (_) {
              setState(() => _pointerCount = (_pointerCount - 1).clamp(0, 10));
            },
            child: GestureDetector(
              onDoubleTapDown: (details) =>
                  _doubleTapPosition = details.localPosition,
              onDoubleTap: _handleDoubleTap,
              child: InteractiveViewer(
                transformationController: _transformController,
                panEnabled: _isZoomed,
                scaleEnabled: _isZoomed || _pointerCount >= 2,
                minScale: 1.0,
                maxScale: 4.0,
                child: Center(
                  child: AnimatedSwitcher(
                    duration: MediaQuery.disableAnimationsOf(context)
                        ? Duration.zero
                        : TimelineMotion.med,
                    child: Image.memory(
                      displayBytes,
                      key: ValueKey(
                        _fullBytes != null
                            ? 'image-viewer-full-${attachmentId ?? widget.item.fileName}'
                            : 'image-viewer-thumb-${attachmentId ?? widget.item.fileName}',
                      ),
                      fit: BoxFit.contain,
                      gaplessPlayback: true,
                      errorBuilder: (_, _, _) => const _ViewerFallbackMessage(
                        text: '无法解码图片内容',
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        else if (_failed)
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              spacing: TimelineSpace.x4,
              children: [
                const _ViewerFallbackMessage(text: '无法加载原图'),
                if (attachmentId != null && widget.loadFull != null)
                  OutlinedButton(
                    key: ImageViewerPage.retryButtonKey,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.white,
                      side: const BorderSide(color: Colors.white54),
                    ),
                    onPressed: () => unawaited(_loadFull(attachmentId)),
                    child: const Text('重试'),
                  ),
              ],
            ),
          )
        else
          const Center(
            child: CircularProgressIndicator.adaptive(
              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
            ),
          ),
        if (hasImage && _loadingFull)
          Positioned(
            left: 0,
            right: 0,
            bottom: TimelineSpace.x9,
            child: SafeArea(
              top: false,
              child: Center(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: const Color(0xA6000000),
                    borderRadius: BorderRadius.circular(TimelineRadius.full),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: TimelineSpace.x6,
                      vertical: TimelineSpace.x3,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      spacing: TimelineSpace.x4,
                      children: [
                        const SizedBox.square(
                          dimension: 14,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        ),
                        Text(
                          '加载原图中…',
                          style: TimelineType.smallStyle(Colors.white),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        if (hasImage && _failed && attachmentId != null && widget.loadFull != null)
          Positioned(
            left: TimelineSpace.x7,
            right: TimelineSpace.x7,
            bottom: TimelineSpace.x9,
            child: SafeArea(
              top: false,
              child: Center(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: const Color(0xCC000000),
                    borderRadius: BorderRadius.circular(TimelineRadius.panel),
                    border: Border.all(color: Colors.white24),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: TimelineSpace.x6,
                      vertical: TimelineSpace.x2,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      spacing: TimelineSpace.x4,
                      children: [
                        Text(
                          '原图加载失败，当前显示缩略图',
                          style: TimelineType.smallStyle(Colors.white),
                        ),
                        TextButton(
                          key: ImageViewerPage.retryButtonKey,
                          style: TextButton.styleFrom(
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(
                              horizontal: TimelineSpace.x4,
                            ),
                          ),
                          onPressed: () => unawaited(_loadFull(attachmentId)),
                          child: const Text('重试'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _ViewerFallbackMessage extends StatelessWidget {
  const _ViewerFallbackMessage({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: TimelineType.metaStyle(Colors.white70),
  );
}
