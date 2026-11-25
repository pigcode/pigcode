import 'dart:io';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import '../composer/composer_tokens.dart';
import '../mobile_status_dot.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/relative_time.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'share_receiver.dart';

/// 某台已配对电脑在「发送到 Pigcode」目标选择器中的实时状态快照。
@immutable
final class ShareComputerTargetInfo {
  const ShareComputerTargetInfo({
    required this.computer,
    required this.connected,
    this.supportsAttachments,
    this.snapshot,
    this.activeThreadId,
    this.loading = false,
  });

  final ComputerProfile computer;
  final bool connected;

  /// `true` / `false` 表示已连接且已确认能力位；`null` 表示当前离线或尚未握手完成。
  final bool? supportsAttachments;
  final SidebarSnapshot? snapshot;
  final String? activeThreadId;
  final bool loading;

  bool get unsupportedDesktop => connected && supportsAttachments == false;
}

/// 统一的「发送到 Pigcode」目标选择弹层（Android & iOS 共用）：
/// - 顶部展示待分享图片横向缩略图条，可逐张移除（全删完自动关闭并清理批次）；
/// - 未配对电脑时展示清晰引导与「去配对」按钮；
/// - 2 台及以上电脑展示多电脑切换器，切换后同步刷新会话列表与能力位；
/// - 已连上但旧版电脑不支持 `composer.attachments` 时展示升级提示并禁用目标点选；
/// - 按顺序置顶展示「当前会话」「新建会话」与可搜索过滤的「最近会话」列表。
class ShareTargetSheet extends StatefulWidget {
  const ShareTargetSheet({
    super.key,
    required this.batch,
    required this.computers,
    required this.selectedComputerKey,
    required this.computerInfo,
    required this.onSelectComputer,
    required this.onRemoveImage,
    required this.onSelectTarget,
    required this.onPair,
    required this.onClose,
    this.busy = false,
    this.computersLoading = false,
    this.thumbnailBuilder,
  });

  static const sheetKey = ValueKey('share-target-sheet');
  static const closeButtonKey = ValueKey('share-target-close');
  static const searchFieldKey = ValueKey('share-target-search');
  static const newThreadTileKey = ValueKey('share-target-new-thread');
  static const currentThreadTileKey = ValueKey('share-target-current-thread');
  static const unpairedHintKey = ValueKey('share-target-unpaired');
  static const pairButtonKey = ValueKey('share-target-pair-button');
  static const unsupportedBannerKey = ValueKey(
    'share-target-unsupported-banner',
  );
  static const truncatedNoticeKey = ValueKey('share-target-truncated-notice');

  static ValueKey<String> computerChipKey(String computerKey) =>
      ValueKey('share-target-computer-$computerKey');

  static ValueKey<String> threadTileKey(String threadId) =>
      ValueKey('share-target-thread-$threadId');

  static ValueKey<String> removeImageKey(int index) =>
      ValueKey('share-target-remove-image-$index');

  final IncomingShareBatch batch;
  final List<ComputerProfile> computers;
  final String? selectedComputerKey;
  final ShareComputerTargetInfo? computerInfo;
  final bool busy;
  final bool computersLoading;
  final ValueChanged<ComputerProfile> onSelectComputer;
  final ValueChanged<int> onRemoveImage;
  final ValueChanged<ShareTargetSelection> onSelectTarget;
  final VoidCallback onPair;
  final VoidCallback onClose;
  final Widget Function(BuildContext context, String path)? thumbnailBuilder;

  @override
  State<ShareTargetSheet> createState() => _ShareTargetSheetState();
}

class _ShareTargetSheetState extends State<ShareTargetSheet> {
  final _searchController = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final brightness = theme.brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final touch = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
    final info = widget.computerInfo;
    final unsupported = info?.unsupportedDesktop == true;
    final selectedKey =
        widget.selectedComputerKey ?? widget.computers.firstOrNull?.computerKey;
    const radius = BorderRadius.vertical(top: Radius.circular(22));

    final snapshot = info?.snapshot;
    final projectsById = {
      for (final project
          in snapshot?.projects ?? const <MobileProjectSummary>[])
        project.id: project.name,
    };

    final allActiveThreads =
        (snapshot?.threads ?? const <MobileThreadSummary>[])
            .where((thread) => !thread.archived)
            .toList()
          ..sort((a, b) {
            final updated = b.updatedAt.compareTo(a.updatedAt);
            return updated == 0 ? a.id.compareTo(b.id) : updated;
          });

    final currentThread = info?.activeThreadId == null
        ? null
        : allActiveThreads
              .where((thread) => thread.id == info!.activeThreadId)
              .firstOrNull;

    bool matchesQuery(MobileThreadSummary thread) {
      if (_query.isEmpty) return true;
      final projectName = projectsById[thread.projectId] ?? '';
      return thread.title.toLowerCase().contains(_query) ||
          projectName.toLowerCase().contains(_query);
    }

    final showCurrentThread =
        currentThread != null && matchesQuery(currentThread);
    final showNewThread =
        _query.isEmpty ||
        '新建会话'.contains(_query) ||
        '新会话'.contains(_query);
    final recentThreads = [
      for (final thread in allActiveThreads)
        if (thread.id != currentThread?.id && matchesQuery(thread)) thread,
    ];

    return MobileGlassSheetSurface(
      key: ShareTargetSheet.sheetKey,
      borderRadius: radius,
      child: SafeArea(
        top: false,
        child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 8, bottom: 4),
                    child: SizedBox(
                      width: 36,
                      height: 5,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.strongBorder,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsetsDirectional.only(start: 20, end: 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Row(
                          spacing: 8,
                          children: [
                            Flexible(
                              child: Semantics(
                                header: true,
                                child: Text(
                                  '发送到 Pigcode',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.titleMedium?.copyWith(
                                    fontSize: 17,
                                    fontWeight: FontWeight.w500,
                                    height: 1.45,
                                    leadingDistribution:
                                        TextLeadingDistribution.even,
                                    locale: const Locale('zh', 'CN'),
                                  ),
                                ),
                              ),
                            ),
                            DecoratedBox(
                              decoration: BoxDecoration(
                                color: colors.field,
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 2,
                                ),
                                child: Text(
                                  '${widget.batch.paths.length} 张',
                                  style: theme.textTheme.labelSmall?.copyWith(
                                    color: colors.muted,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      MobileSheetCloseButton(
                        buttonKey: ShareTargetSheet.closeButtonKey,
                        tooltip: '关闭',
                        touchDimension: touch,
                        onPressed: widget.busy ? null : widget.onClose,
                      ),
                    ],
                  ),
                ),
                _ThumbnailStrip(
                  paths: widget.batch.paths,
                  busy: widget.busy,
                  onRemove: widget.onRemoveImage,
                  thumbnailBuilder: widget.thumbnailBuilder,
                ),
                if (widget.batch.truncatedCount > 0)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                    child: DecoratedBox(
                      key: ShareTargetSheet.truncatedNoticeKey,
                      decoration: BoxDecoration(
                        color: colors.attentionTint,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 8,
                        ),
                        child: Row(
                          spacing: 8,
                          children: [
                            Icon(
                              Icons.info_outline_rounded,
                              size: 16,
                              color: colors.attention,
                            ),
                            Expanded(
                              child: Text(
                                '每条消息最多添加 6 张图片，已忽略超出部分',
                                style: ComposerType.notice(colors.attention),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                if (widget.busy)
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: LinearProgressIndicator(minHeight: 2),
                  ),
                const SizedBox(height: 12),
                Divider(height: 1, thickness: 1, color: colors.divider),
                if (widget.computers.isEmpty && widget.computersLoading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 36),
                    child: Center(child: CircularProgressIndicator.adaptive()),
                  )
                else if (widget.computers.isEmpty)
                  _UnpairedState(
                    busy: widget.busy,
                    onPair: widget.onPair,
                  )
                else
                  Flexible(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (widget.computers.length >= 2)
                          _ComputerSwitcher(
                            computers: widget.computers,
                            selectedKey: selectedKey,
                            connectedKey: info?.connected == true
                                ? info!.computer.computerKey
                                : null,
                            busy: widget.busy,
                            onSelect: widget.onSelectComputer,
                          ),
                        if (unsupported)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                            child: Semantics(
                              liveRegion: true,
                              child: DecoratedBox(
                                key: ShareTargetSheet.unsupportedBannerKey,
                                decoration: BoxDecoration(
                                  color: colors.errorTint,
                                  borderRadius: BorderRadius.circular(12),
                                ),
                                child: Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    spacing: 10,
                                    children: [
                                      Icon(
                                        Icons.error_outline_rounded,
                                        size: 18,
                                        color: colors.error,
                                      ),
                                      Expanded(
                                        child: Text(
                                          '这台电脑的 Pigcode 版本暂不支持发送图片，请先更新电脑端',
                                          style: theme.textTheme.bodySmall
                                              ?.copyWith(
                                                color: colors.error,
                                                fontSize: 13,
                                                height: 1.45,
                                                locale: const Locale(
                                                  'zh',
                                                  'CN',
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
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
                          child: TextField(
                            key: ShareTargetSheet.searchFieldKey,
                            controller: _searchController,
                            enabled: !unsupported && !widget.busy,
                            onChanged: (value) => setState(
                              () => _query = value.trim().toLowerCase(),
                            ),
                            textInputAction: TextInputAction.search,
                            decoration: InputDecoration(
                              hintText: '搜索会话',
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 10,
                              ),
                              prefixIcon: Padding(
                                padding: const EdgeInsetsDirectional.only(
                                  start: 12,
                                  end: 8,
                                ),
                                child: IconTheme(
                                  data: IconThemeData(color: colors.muted),
                                  child: const WorkspaceIcon(
                                    WorkspaceGlyph.search,
                                    size: 16,
                                  ),
                                ),
                              ),
                              prefixIconConstraints: const BoxConstraints(
                                minWidth: 36,
                                minHeight: 36,
                              ),
                              suffixIcon: _query.isNotEmpty
                                  ? IconButton(
                                      tooltip: '清空搜索',
                                      onPressed: () {
                                        _searchController.clear();
                                        setState(() => _query = '');
                                      },
                                      icon: const Icon(Icons.close, size: 16),
                                    )
                                  : null,
                              filled: true,
                              fillColor: colors.field,
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(12),
                                borderSide: BorderSide.none,
                              ),
                            ),
                          ),
                        ),
                        Flexible(
                          child: Opacity(
                            opacity: unsupported ? 0.45 : 1.0,
                            child: ListView(
                              shrinkWrap: true,
                              padding: const EdgeInsets.fromLTRB(
                                16,
                                4,
                                16,
                                20,
                              ),
                              children: [
                                if (showCurrentThread && selectedKey != null)
                                  _TargetRow(
                                    key: ShareTargetSheet.currentThreadTileKey,
                                    title: currentThread.title,
                                    subtitle:
                                        projectsById[currentThread.projectId],
                                    badge: '当前会话',
                                    glyph: WorkspaceGlyph.messagesSquare,
                                    highlighted: true,
                                    enabled: !unsupported && !widget.busy,
                                    onTap: () => widget.onSelectTarget(
                                      ShareTargetSelection.existingThread(
                                        computerKey: selectedKey,
                                        threadId: currentThread.id,
                                      ),
                                    ),
                                  ),
                                if (showNewThread && selectedKey != null)
                                  _TargetRow(
                                    key: ShareTargetSheet.newThreadTileKey,
                                    title: '新建会话',
                                    subtitle: '创建新会话并附带这些图片',
                                    glyph: WorkspaceGlyph.compose,
                                    enabled: !unsupported && !widget.busy,
                                    onTap: () => widget.onSelectTarget(
                                      ShareTargetSelection.newThread(
                                        computerKey: selectedKey,
                                      ),
                                    ),
                                  ),
                                if (recentThreads.isNotEmpty) ...[
                                  Padding(
                                    padding: const EdgeInsets.fromLTRB(
                                      8,
                                      12,
                                      8,
                                      6,
                                    ),
                                    child: Text(
                                      '最近会话',
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                            color: colors.muted,
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                          ),
                                    ),
                                  ),
                                  for (final thread in recentThreads)
                                    if (selectedKey != null)
                                      _TargetRow(
                                        key: ShareTargetSheet.threadTileKey(
                                          thread.id,
                                        ),
                                        title: thread.title,
                                        subtitle: _threadSubtitle(
                                          projectsById[thread.projectId],
                                          thread.updatedAt,
                                        ),
                                        enabled: !unsupported && !widget.busy,
                                        onTap: () => widget.onSelectTarget(
                                          ShareTargetSelection.existingThread(
                                            computerKey: selectedKey,
                                            threadId: thread.id,
                                          ),
                                        ),
                                      ),
                                ] else if (info?.loading == true)
                                  const Padding(
                                    padding: EdgeInsets.symmetric(vertical: 20),
                                    child: Center(
                                      child:
                                          CircularProgressIndicator.adaptive(),
                                    ),
                                  )
                                else if (!showCurrentThread)
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 8,
                                      vertical: 16,
                                    ),
                                    child: Text(
                                      _query.isNotEmpty
                                          ? '没有匹配的会话'
                                          : '暂无缓存的最近会话，可先选择「新建会话」',
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(color: colors.muted),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
    );
  }

  String? _threadSubtitle(String? projectName, String updatedAt) {
    final relative = timelineRelativeTime(updatedAt);
    final parts = <String>[
      if (projectName != null && projectName.isNotEmpty) projectName,
      if (relative.isNotEmpty) relative,
    ];
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

class _ThumbnailStrip extends StatelessWidget {
  const _ThumbnailStrip({
    required this.paths,
    required this.busy,
    required this.onRemove,
    this.thumbnailBuilder,
  });

  final List<String> paths;
  final bool busy;
  final ValueChanged<int> onRemove;
  final Widget Function(BuildContext context, String path)? thumbnailBuilder;

  static const double _thumbSize = 64;
  static const double _removeSize = 20;
  static const double _inset = 8;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final radius = BorderRadius.circular(10);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          spacing: TimelineSpace.x2,
          children: [
            for (var i = 0; i < paths.length; i++)
              SizedBox(
                width: _thumbSize + _inset,
                height: _thumbSize + _inset,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Positioned(
                      left: 0,
                      bottom: 0,
                      width: _thumbSize,
                      height: _thumbSize,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.field,
                          borderRadius: radius,
                          border: Border.all(
                            color: colors.border,
                            width: ComposerBorder.regular,
                          ),
                        ),
                        child: ClipRRect(
                          borderRadius: radius,
                          child: thumbnailBuilder != null
                              ? thumbnailBuilder!(context, paths[i])
                              : Image.file(
                                  File(paths[i]),
                                  fit: BoxFit.cover,
                                  width: _thumbSize,
                                  height: _thumbSize,
                                  cacheWidth: 192,
                                  errorBuilder: (_, _, _) => Center(
                                    child: IconTheme(
                                      data: IconThemeData(color: colors.muted),
                                      child: const WorkspaceIcon(
                                        WorkspaceGlyph.image,
                                        size: 20,
                                      ),
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
                        label: '移除第 ${i + 1} 张图片',
                        child: GestureDetector(
                          key: ShareTargetSheet.removeImageKey(i),
                          behavior: HitTestBehavior.opaque,
                          onTap: busy ? null : () => onRemove(i),
                          child: SizedBox.square(
                            dimension: 30,
                            child: Align(
                              alignment: Alignment.topRight,
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: colors.foreground.withValues(
                                    alpha: 0.85,
                                  ),
                                  shape: BoxShape.circle,
                                  border: Border.all(
                                    color: colors.surface,
                                    width: 1.5,
                                  ),
                                ),
                                child: SizedBox.square(
                                  dimension: _removeSize,
                                  child: Center(
                                    child: IconTheme(
                                      data: IconThemeData(
                                        color: colors.background,
                                      ),
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
              ),
          ],
        ),
      ),
    );
  }
}

class _UnpairedState extends StatelessWidget {
  const _UnpairedState({required this.busy, required this.onPair});

  final bool busy;
  final VoidCallback onPair;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      key: ShareTargetSheet.unpairedHintKey,
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconTheme(
            data: IconThemeData(color: colors.muted),
            child: const WorkspaceIcon(WorkspaceGlyph.laptop, size: 36),
          ),
          const SizedBox(height: 12),
          Text(
            '还没有配对电脑，请先扫码配对后再发送图片',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.secondaryText,
              locale: const Locale('zh', 'CN'),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: ShareTargetSheet.pairButtonKey,
            onPressed: busy ? null : onPair,
            icon: const Icon(Icons.qr_code_scanner, size: 18),
            label: const Text('去配对'),
            style: FilledButton.styleFrom(minimumSize: const Size(140, 46)),
          ),
        ],
      ),
    );
  }
}

class _ComputerSwitcher extends StatelessWidget {
  const _ComputerSwitcher({
    required this.computers,
    required this.selectedKey,
    required this.connectedKey,
    required this.busy,
    required this.onSelect,
  });

  final List<ComputerProfile> computers;
  final String? selectedKey;
  final String? connectedKey;
  final bool busy;
  final ValueChanged<ComputerProfile> onSelect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          spacing: 8,
          children: [
            for (final computer in computers)
              _ComputerPill(
                key: ShareTargetSheet.computerChipKey(computer.computerKey),
                name: computer.name,
                selected: computer.computerKey == selectedKey,
                connected: computer.computerKey == connectedKey,
                colors: colors,
                theme: theme,
                onTap: busy ? null : () => onSelect(computer),
              ),
          ],
        ),
      ),
    );
  }
}

class _ComputerPill extends StatelessWidget {
  const _ComputerPill({
    super.key,
    required this.name,
    required this.selected,
    required this.connected,
    required this.colors,
    required this.theme,
    required this.onTap,
  });

  final String name;
  final bool selected;
  final bool connected;
  final dynamic colors;
  final ThemeData theme;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: selected ? palette.primary : palette.field,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: selected ? palette.primary : palette.border,
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              spacing: 6,
              children: [
                if (connected)
                  MobileStatusDot(
                    color: selected ? palette.onPrimary : palette.readyMark,
                  )
                else
                  IconTheme(
                    data: IconThemeData(
                      color: selected
                          ? palette.onPrimary
                          : palette.secondaryText,
                    ),
                    child: const WorkspaceIcon(WorkspaceGlyph.laptop, size: 14),
                  ),
                Text(
                  name,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: selected ? palette.onPrimary : palette.foreground,
                    fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TargetRow extends StatelessWidget {
  const _TargetRow({
    super.key,
    required this.title,
    required this.enabled,
    required this.onTap,
    this.subtitle,
    this.badge,
    this.glyph,
    this.highlighted = false,
  });

  final String title;
  final String? subtitle;
  final String? badge;
  final WorkspaceGlyph? glyph;
  final bool highlighted;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Semantics(
        button: true,
        enabled: enabled,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: enabled ? onTap : null,
            borderRadius: BorderRadius.circular(12),
            child: Ink(
              decoration: BoxDecoration(
                color: highlighted ? colors.selected : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 52),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  child: Row(
                    spacing: 12,
                    children: [
                      if (glyph case final icon?)
                        DecoratedBox(
                          decoration: BoxDecoration(
                            color: colors.field,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: SizedBox.square(
                            dimension: 36,
                            child: Center(
                              child: IconTheme(
                                data: IconThemeData(
                                  color: colors.secondaryText,
                                ),
                                child: WorkspaceIcon(icon, size: 18),
                              ),
                            ),
                          ),
                        ),
                      Expanded(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              spacing: 8,
                              children: [
                                Flexible(
                                  child: Text(
                                    title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: theme.textTheme.bodyMedium?.copyWith(
                                      fontSize: 15,
                                      fontWeight: highlighted
                                          ? FontWeight.w500
                                          : FontWeight.w400,
                                      color: colors.foreground,
                                      locale: const Locale('zh', 'CN'),
                                    ),
                                  ),
                                ),
                                if (badge case final label?)
                                  DecoratedBox(
                                    decoration: BoxDecoration(
                                      color: colors.primary,
                                      borderRadius: BorderRadius.circular(999),
                                    ),
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 7,
                                        vertical: 2,
                                      ),
                                      child: Text(
                                        label,
                                        style: theme.textTheme.labelSmall
                                            ?.copyWith(
                                              fontSize: 11,
                                              fontWeight: FontWeight.w500,
                                              color: colors.onPrimary,
                                              locale: const Locale('zh', 'CN'),
                                            ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                            if (subtitle case final sub? when sub.isNotEmpty)
                              Text(
                                sub,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  fontSize: 12,
                                  color: colors.muted,
                                  locale: const Locale('zh', 'CN'),
                                ),
                              ),
                          ],
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
    );
  }
}
