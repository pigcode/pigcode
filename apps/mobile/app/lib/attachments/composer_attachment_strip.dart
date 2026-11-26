import 'dart:async';

import 'package:flutter/material.dart';

import '../composer/composer_tokens.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'composer_attachments_controller.dart';
import 'image_viewer_page.dart';

/// 输入框内的横向待发图片缩略图条（置于 `MobileComposerCard` 文本输入区正上方）：
/// - 每项为 `64×64` 圆角缩略图卡片 + 右上角 `×` 取消/删除按钮；
/// - 上传中叠加环形进度条，离线暂存显示轻角标，失败态显示红色错误遮罩与点击重试；
/// - 选中 Agent 不支持原生看图时展示柔和降级提示；
/// - 可关闭的单条错误提示条（超 6 张 / 格式不支持 / 上传失败），绝不清空正文和其他图。
class ComposerAttachmentStrip extends StatelessWidget {
  const ComposerAttachmentStrip({
    super.key,
    required this.controller,
    this.supportsImages = true,
    this.onPreview,
    this.loadRemoteFull,
  });

  static const stripKey = ValueKey('composer-attachment-strip');
  static const unsupportedImagesHintKey = ValueKey(
    'composer-attachment-unsupported-images-hint',
  );
  static const errorBannerKey = ValueKey('composer-attachment-error-banner');

  static const double _thumbSize = 64;
  static const double _removeButtonSize = 20;
  static const double _slotTopInset = 8;
  static const double _slotRightInset = 8;

  final ComposerAttachmentsController controller;
  final bool supportsImages;
  final void Function(int index)? onPreview;
  final AttachmentBytesLoader? loadRemoteFull;

  void _openDefaultPreview(
    BuildContext context,
    List<ComposerAttachmentItem> items,
    int index,
  ) {
    final viewerItems = [
      for (final item in items)
        ImageViewerItem(
          attachmentId: item.remoteRef?.id,
          fileName: item.fileName,
          initialBytes: item.previewBytes,
          isFullBytes: item.draftFileName != null && item.previewBytes != null,
          width: item.width,
          height: item.height,
        ),
    ];
    unawaited(
      ImageViewerPage.open(
        context,
        items: viewerItems,
        initialIndex: index,
        loadFull: loadRemoteFull,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);

    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final items = controller.items;
        final error = controller.bannerError;
        if (items.isEmpty && error == null) {
          return const SizedBox.shrink();
        }
        return Padding(
          key: stripKey,
          padding: const EdgeInsets.fromLTRB(
            TimelineSpace.x7,
            TimelineSpace.x4,
            TimelineSpace.x7,
            0,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: TimelineSpace.x3,
            children: [
              if (items.isNotEmpty)
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    spacing: TimelineSpace.x2,
                    children: [
                      for (var i = 0; i < items.length; i++)
                        _AttachmentThumbTile(
                          key: ValueKey(
                            'composer-attachment-tile-${items[i].localId}',
                          ),
                          item: items[i],
                          onTap: () {
                            final item = items[i];
                            if (item.status ==
                                ComposerAttachmentStatus.failed) {
                              controller.retry(item.localId);
                              return;
                            }
                            if (onPreview case final preview?) {
                              preview(i);
                            } else {
                              _openDefaultPreview(context, items, i);
                            }
                          },
                          onRemove: () =>
                              unawaited(controller.remove(items[i].localId)),
                        ),
                    ],
                  ),
                ),
              if (items.isNotEmpty && !supportsImages)
                Row(
                  key: unsupportedImagesHintKey,
                  spacing: TimelineSpace.x2,
                  children: [
                    Icon(
                      Icons.info_outline_rounded,
                      size: TimelineIcon.meta,
                      color: colors.attention,
                    ),
                    Expanded(
                      child: Text(
                        '当前 Agent 不支持直接看图，将以文件路径传递',
                        style: ComposerType.notice(colors.attention),
                      ),
                    ),
                  ],
                ),
              if (error != null && error.isNotEmpty)
                Semantics(
                  liveRegion: true,
                  child: DecoratedBox(
                    key: errorBannerKey,
                    decoration: BoxDecoration(
                      color: colors.errorTint,
                      borderRadius: BorderRadius.circular(TimelineRadius.block),
                    ),
                    child: Padding(
                      padding: const EdgeInsetsDirectional.fromSTEB(
                        TimelineSpace.x5,
                        TimelineSpace.x2,
                        TimelineSpace.x2,
                        TimelineSpace.x2,
                      ),
                      child: Row(
                        spacing: TimelineSpace.x2,
                        children: [
                          Expanded(
                            child: Text(
                              error,
                              style: ComposerType.notice(colors.error),
                            ),
                          ),
                          Semantics(
                            button: true,
                            label: '关闭错误提示',
                            child: InkWell(
                              onTap: controller.dismissBannerError,
                              borderRadius: BorderRadius.circular(
                                TimelineRadius.full,
                              ),
                              child: Padding(
                                padding: const EdgeInsets.all(TimelineSpace.x2),
                                child: IconTheme(
                                  data: IconThemeData(color: colors.error),
                                  child: const WorkspaceIcon(
                                    WorkspaceGlyph.close,
                                    size: TimelineIcon.meta,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _AttachmentThumbTile extends StatelessWidget {
  const _AttachmentThumbTile({
    super.key,
    required this.item,
    required this.onTap,
    required this.onRemove,
  });

  final ComposerAttachmentItem item;
  final VoidCallback onTap;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    const thumbSize = ComposerAttachmentStrip._thumbSize;
    const removeSize = ComposerAttachmentStrip._removeButtonSize;
    const topInset = ComposerAttachmentStrip._slotTopInset;
    const rightInset = ComposerAttachmentStrip._slotRightInset;

    final statusLabel = switch (item.status) {
      ComposerAttachmentStatus.preparing => '正在处理图片 ${item.fileName}',
      ComposerAttachmentStatus.uploading =>
        '正在上传 ${item.fileName}，已完成 ${(item.progress * 100).round()}%',
      ComposerAttachmentStatus.uploaded => '已上传图片 ${item.fileName}，点按全屏预览',
      ComposerAttachmentStatus.localOffline =>
        '离线暂存图片 ${item.fileName}，恢复连接后自动上传',
      ComposerAttachmentStatus.failed => '图片 ${item.fileName} 上传失败，点按重试',
    };

    final radius = BorderRadius.circular(10);

    return SizedBox(
      width: thumbSize + rightInset,
      height: thumbSize + topInset,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            left: 0,
            bottom: 0,
            width: thumbSize,
            height: thumbSize,
            child: Semantics(
              button: true,
              label: statusLabel,
              child: GestureDetector(
                key: item.status == ComposerAttachmentStatus.failed
                    ? ValueKey('composer-attachment-retry-${item.localId}')
                    : ValueKey('composer-attachment-preview-${item.localId}'),
                onTap: onTap,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.field,
                    borderRadius: radius,
                    border: Border.all(
                      color: item.status == ComposerAttachmentStatus.failed
                          ? colors.error
                          : colors.border,
                      width: ComposerBorder.regular,
                    ),
                  ),
                  child: ClipRRect(
                    borderRadius: radius,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        if (item.previewBytes case final bytes?)
                          Image.memory(
                            bytes,
                            fit: BoxFit.cover,
                            width: thumbSize,
                            height: thumbSize,
                            gaplessPlayback: true,
                            errorBuilder: (_, _, _) => Center(
                              child: IconTheme(
                                data: IconThemeData(color: colors.muted),
                                child: const WorkspaceIcon(
                                  WorkspaceGlyph.image,
                                  size: TimelineIcon.alert,
                                ),
                              ),
                            ),
                          )
                        else
                          Center(
                            child: IconTheme(
                              data: IconThemeData(color: colors.faint),
                              child: const WorkspaceIcon(
                                WorkspaceGlyph.image,
                                size: TimelineIcon.alert,
                              ),
                            ),
                          ),
                        if (item.status == ComposerAttachmentStatus.preparing ||
                            item.status == ComposerAttachmentStatus.uploading)
                          ColoredBox(
                            color: const Color(0x66000000),
                            child: Center(
                              child: SizedBox.square(
                                dimension: 24,
                                child: CircularProgressIndicator(
                                  value:
                                      item.status ==
                                              ComposerAttachmentStatus
                                                  .uploading &&
                                          item.progress > 0
                                      ? item.progress
                                      : null,
                                  strokeWidth: 2.5,
                                  color: Colors.white,
                                  backgroundColor: Colors.white24,
                                ),
                              ),
                            ),
                          ),
                        if (item.status ==
                            ComposerAttachmentStatus.localOffline)
                          Positioned(
                            right: 4,
                            bottom: 4,
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: const Color(0xB3000000),
                                borderRadius: BorderRadius.circular(
                                  TimelineRadius.full,
                                ),
                              ),
                              child: const Padding(
                                padding: EdgeInsets.all(3),
                                child: Icon(
                                  Icons.cloud_off_rounded,
                                  size: 12,
                                  color: Colors.white,
                                ),
                              ),
                            ),
                          ),
                        if (item.status == ComposerAttachmentStatus.failed)
                          ColoredBox(
                            color: colors.error.withValues(alpha: 0.68),
                            child: const Center(
                              child: Icon(
                                Icons.refresh_rounded,
                                size: 22,
                                color: Colors.white,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            top: 0,
            right: 0,
            child: Semantics(
              button: true,
              label: '移除图片 ${item.fileName}',
              child: GestureDetector(
                key: ValueKey('composer-attachment-remove-${item.localId}'),
                behavior: HitTestBehavior.opaque,
                onTap: onRemove,
                child: SizedBox.square(
                  dimension: 32,
                  child: Align(
                    alignment: Alignment.topRight,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.foreground.withValues(alpha: 0.85),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: colors.surfaceRaised,
                          width: 1.5,
                        ),
                      ),
                      child: SizedBox.square(
                        dimension: removeSize,
                        child: Center(
                          child: IconTheme(
                            data: IconThemeData(color: colors.background),
                            child: const WorkspaceIcon(
                              WorkspaceGlyph.close,
                              size: 11,
                            ),
                          ),
                        ),
                      ),
                    ),
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
