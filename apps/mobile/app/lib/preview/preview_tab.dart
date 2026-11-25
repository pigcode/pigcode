import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workbench/workbench_utils.dart';
import '../workspace_icon.dart';
import 'local_preview_proxy.dart';
import 'preview_history.dart';
import 'preview_url_extractor.dart';
import 'preview_webview_screen.dart';

/// 工作台「预览」Tab：
/// - 进入后拉取 `connection.preview.getStatus(threadId: threadId)`（支持下拉刷新）；
/// - 电脑端关闭预览开关时在顶部展示醒目中文提示卡片；
/// - 提供端口/地址快捷输入框（支持纯端口号如 `5173`、回车或点「打开」直开）；
/// - 自动去重展示 3 个分组：电脑窗口正在预览、当前会话发现的本机地址、最近预览历史（支持单条删除/长按删除与清空）。
class PreviewTab extends StatefulWidget {
  const PreviewTab({
    super.key,
    required this.connection,
    required this.threadId,
    this.timelineUrls = const [],
    this.timelineUrlsProvider,
    this.active = true,
    this.computerKey,
    this.historyStorage,
    this.onOpenPreviewUrl,
    this.openExternalUrl,
    this.webViewBuilder,
  });

  static const disabledBannerKey = ValueKey('preview-disabled-banner');
  static const urlInputKey = ValueKey('preview-url-input');
  static const openButtonKey = ValueKey('preview-open-button');
  static const inputErrorKey = ValueKey('preview-input-error');
  static const clearHistoryButtonKey = ValueKey('preview-history-clear');

  final MobileConnection connection;
  final String threadId;
  final List<String> timelineUrls;
  final List<String> Function()? timelineUrlsProvider;
  final bool active;
  final String? computerKey;
  final PreviewHistoryStorage? historyStorage;
  final Future<void> Function(Uri url)? onOpenPreviewUrl;
  final ExternalUrlOpener? openExternalUrl;
  final PreviewWebViewBuilder? webViewBuilder;

  @override
  State<PreviewTab> createState() => _PreviewTabState();
}

class _PreviewTabState extends State<PreviewTab> {
  final _urlController = TextEditingController();

  PreviewHistoryStorage? _historyStorage;
  MobilePreviewStatus? _status;
  List<String> _historyUrls = const [];
  List<String> _timelineUrls = const [];
  bool _loading = false;
  bool _hasRequested = false;
  String? _loadError;
  String? _inputError;
  int _requestSeq = 0;

  @override
  void initState() {
    super.initState();
    _historyStorage = _resolveHistoryStorage();
    _timelineUrls = _readLatestTimelineUrls();
    if (widget.active) {
      unawaited(_load());
    }
  }

  @override
  void didUpdateWidget(covariant PreviewTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.computerKey != widget.computerKey ||
        oldWidget.historyStorage != widget.historyStorage ||
        !identical(oldWidget.connection, widget.connection)) {
      _historyStorage = _resolveHistoryStorage();
    }
    _timelineUrls = _readLatestTimelineUrls();
    if (widget.active && !_hasRequested) {
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _urlController.dispose();
    super.dispose();
  }

  PreviewHistoryStorage? _resolveHistoryStorage() {
    if (widget.historyStorage case final injected?) return injected;
    final key = widget.computerKey ?? connectionComputerKey(widget.connection);
    return key == null ? null : PreviewHistoryStorage(key);
  }

  List<String> _readLatestTimelineUrls() =>
      widget.timelineUrlsProvider?.call() ?? widget.timelineUrls;

  Future<void> _load() async {
    _hasRequested = true;
    final seq = ++_requestSeq;
    setState(() {
      _loading = true;
      _loadError = null;
      _timelineUrls = _readLatestTimelineUrls();
    });

    final historyFuture =
        _historyStorage?.read().catchError((Object _) => const <String>[]) ??
        Future.value(const <String>[]);

    try {
      final results = await Future.wait<Object>([
        widget.connection.preview.getStatus(threadId: widget.threadId),
        historyFuture,
      ]);
      if (!mounted || seq != _requestSeq) return;
      setState(() {
        _status = results[0] as MobilePreviewStatus;
        _historyUrls = results[1] as List<String>;
        _loading = false;
      });
    } catch (error) {
      final history = await historyFuture;
      if (!mounted || seq != _requestSeq) return;
      final proxyError = previewErrorFromException(error);
      setState(() {
        _historyUrls = history;
        _loading = false;
        _loadError = proxyError.message;
      });
    }
  }

  Future<void> _reloadHistory() async {
    final storage = _historyStorage;
    if (storage == null) return;
    final history = await storage.read().catchError((Object _) => const <String>[]);
    if (!mounted) return;
    setState(() => _historyUrls = history);
  }

  Future<void> _openUrl(Uri uri) async {
    if (_inputError != null) {
      setState(() => _inputError = null);
    }
    if (widget.onOpenPreviewUrl case final customOpen?) {
      if (_historyStorage case final storage?) {
        final updated = await storage
            .record(uri.toString())
            .catchError((Object _) => _historyUrls);
        if (mounted) setState(() => _historyUrls = updated);
      }
      await customOpen(uri);
      await _reloadHistory();
      return;
    }

    await MobilePreviewWebViewScreen.open(
      context,
      connection: widget.connection,
      initialUrl: uri,
      computerKey: widget.computerKey,
      historyStorage: _historyStorage,
      openExternalUrl: widget.openExternalUrl,
      webViewBuilder: widget.webViewBuilder,
    );
    await _reloadHistory();
  }

  void _submitInput() {
    final result = normalizePreviewInput(_urlController.text);
    if (!result.isValid) {
      setState(() => _inputError = result.error);
      return;
    }
    setState(() => _inputError = null);
    final uri = result.uri!;
    FocusScope.of(context).unfocus();
    unawaited(_openUrl(uri));
  }

  Future<void> _removeHistoryItem(String url) async {
    final storage = _historyStorage;
    if (storage == null) return;
    final updated = await storage.remove(url);
    if (!mounted) return;
    setState(() => _historyUrls = updated);
  }

  Future<void> _confirmRemoveHistoryItem(String url) async {
    final display = _displayLabelFor(url);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => MobileGlassDialog(
        title: const Text('删除预览记录'),
        content: Text('要从最近预览历史中移除 $display 吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await _removeHistoryItem(url);
    }
  }

  Future<void> _clearHistory() async {
    final storage = _historyStorage;
    if (storage == null) return;
    await storage.clear();
    if (!mounted) return;
    setState(() => _historyUrls = const []);
  }

  String _displayLabelFor(String rawUrl) {
    final uri = Uri.tryParse(rawUrl);
    if (uri == null) return rawUrl;
    return formatPreviewDisplayAddress(uri);
  }

  ({
    List<String> desktop,
    List<String> timeline,
    List<String> history,
  })
  _deduplicatedGroups() {
    final seen = <String>{};

    List<String> takeUnique(Iterable<String> rawList) {
      final result = <String>[];
      for (final raw in rawList) {
        final normalized = normalizePreviewInput(raw).uri?.toString();
        if (normalized == null) continue;
        if (seen.add(normalized)) {
          result.add(normalized);
        }
      }
      return result;
    }

    final desktop = takeUnique(_status?.desktopUrls ?? const []);
    final timeline = takeUnique(_timelineUrls);
    final history = takeUnique(_historyUrls);
    return (desktop: desktop, timeline: timeline, history: history);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (!_hasRequested) {
      return const SizedBox.shrink();
    }

    if (_loading && _status == null && _loadError == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    final groups = _deduplicatedGroups();
    final hasAnyUrl =
        groups.desktop.isNotEmpty ||
        groups.timeline.isNotEmpty ||
        groups.history.isNotEmpty;
    final disabled = _status != null && !_status!.enabled;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(TimelineSpace.x7),
        children: [
          if (disabled) ...[
            _DisabledBanner(key: PreviewTab.disabledBannerKey),
            const SizedBox(height: TimelineSpace.x6),
          ],
          if (_loadError case final message?) ...[
            _LoadErrorCard(
              message: message,
              onRetry: () => unawaited(_load()),
            ),
            const SizedBox(height: TimelineSpace.x6),
          ],
          _buildQuickInput(context),
          const SizedBox(height: TimelineSpace.x7),
          if (groups.desktop.isNotEmpty) ...[
            _PreviewSectionCard(
              title: '电脑窗口正在预览',
              glyph: WorkspaceGlyph.laptop,
              urls: groups.desktop,
              displayLabel: _displayLabelFor,
              onOpen: (url) => unawaited(_openUrl(Uri.parse(url))),
            ),
            const SizedBox(height: TimelineSpace.x6),
          ],
          if (groups.timeline.isNotEmpty) ...[
            _PreviewSectionCard(
              title: '当前会话发现的本机地址',
              glyph: WorkspaceGlyph.terminal,
              urls: groups.timeline,
              displayLabel: _displayLabelFor,
              onOpen: (url) => unawaited(_openUrl(Uri.parse(url))),
            ),
            const SizedBox(height: TimelineSpace.x6),
          ],
          if (groups.history.isNotEmpty) ...[
            _PreviewSectionCard(
              title: '最近预览历史',
              glyph: WorkspaceGlyph.search,
              urls: groups.history,
              displayLabel: _displayLabelFor,
              onOpen: (url) => unawaited(_openUrl(Uri.parse(url))),
              onDelete: (url) => unawaited(_removeHistoryItem(url)),
              onLongPress: (url) => unawaited(_confirmRemoveHistoryItem(url)),
              headerTrailing: TextButton(
                key: PreviewTab.clearHistoryButtonKey,
                style: TextButton.styleFrom(
                  foregroundColor: colors.muted,
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(
                    horizontal: TimelineSpace.x3,
                  ),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                onPressed: () => unawaited(_clearHistory()),
                child: const Text('清空'),
              ),
            ),
          ],
          if (!hasAnyUrl && _loadError == null)
            _EmptyPreviewHint(disabled: disabled),
        ],
      ),
    );
  }

  Widget _buildQuickInput(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: TimelineSpace.x2,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          spacing: TimelineSpace.x3,
          children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: colors.field,
                  borderRadius: BorderRadius.circular(TimelineRadius.panel),
                  border: Border.all(
                    color: _inputError != null ? colors.error : colors.border,
                  ),
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: TimelineSpace.x5,
                ),
                child: TextField(
                  key: PreviewTab.urlInputKey,
                  controller: _urlController,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.go,
                  autocorrect: false,
                  enableSuggestions: false,
                  onChanged: (_) {
                    if (_inputError != null) {
                      setState(() => _inputError = null);
                    }
                  },
                  onSubmitted: (_) => _submitInput(),
                  style: TimelineType.contentStyle(colors.foreground),
                  decoration: InputDecoration(
                    isDense: true,
                    border: InputBorder.none,
                    hintText: '输入端口（如 5173）或 localhost 地址',
                    hintStyle: TimelineType.metaStyle(colors.faint),
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                ),
              ),
            ),
            FilledButton(
              key: PreviewTab.openButtonKey,
              style: FilledButton.styleFrom(
                minimumSize: Size(72, touch),
                padding: const EdgeInsets.symmetric(
                  horizontal: TimelineSpace.x6,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(TimelineRadius.panel),
                ),
              ),
              onPressed: _submitInput,
              child: const Text('打开'),
            ),
          ],
        ),
        if (_inputError case final error?)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: TimelineSpace.x2),
            child: Text(
              error,
              key: PreviewTab.inputErrorKey,
              style: TimelineType.smallStyle(colors.error),
            ),
          ),
      ],
    );
  }
}

class _DisabledBanner extends StatelessWidget {
  const _DisabledBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.attentionTint,
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
        border: Border.all(color: colors.attention.withValues(alpha: 0.35)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(TimelineSpace.x6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          spacing: TimelineSpace.x4,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(
                Icons.info_outline_rounded,
                size: TimelineIcon.alert,
                color: colors.attention,
              ),
            ),
            Expanded(
              child: Text(
                '电脑端已关闭手机本机预览，请在电脑「设置 → 手机连接」中开启。',
                style: TimelineType.metaStyle(
                  colors.attention,
                  weight: FontWeight.w500,
                  height: TimelineType.noticeHeight,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LoadErrorCard extends StatelessWidget {
  const _LoadErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.errorTint,
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
        border: Border.all(color: colors.error.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x6,
          vertical: TimelineSpace.x4,
        ),
        child: Row(
          spacing: TimelineSpace.x3,
          children: [
            Icon(
              Icons.error_outline_rounded,
              size: TimelineIcon.alert,
              color: colors.error,
            ),
            Expanded(
              child: Text(
                message,
                style: TimelineType.metaStyle(
                  colors.error,
                  height: TimelineType.noticeHeight,
                ),
              ),
            ),
            TextButton(onPressed: onRetry, child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}

class _PreviewSectionCard extends StatelessWidget {
  const _PreviewSectionCard({
    required this.title,
    required this.glyph,
    required this.urls,
    required this.displayLabel,
    required this.onOpen,
    this.onDelete,
    this.onLongPress,
    this.headerTrailing,
  });

  final String title;
  final WorkspaceGlyph glyph;
  final List<String> urls;
  final String Function(String url) displayLabel;
  final ValueChanged<String> onOpen;
  final ValueChanged<String>? onDelete;
  final ValueChanged<String>? onLongPress;
  final Widget? headerTrailing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: TimelineSpace.x3,
      children: [
        Row(
          children: [
            IconTheme(
              data: IconThemeData(color: colors.muted),
              child: WorkspaceIcon(glyph, size: TimelineIcon.meta),
            ),
            const SizedBox(width: TimelineSpace.x3),
            Expanded(
              child: Text(
                title,
                style: TimelineType.metaStyle(
                  colors.muted,
                  weight: FontWeight.w500,
                ),
              ),
            ),
            ?headerTrailing,
          ],
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.timelineCard,
            borderRadius: BorderRadius.circular(TimelineRadius.panel),
            border: Border.all(color: colors.timelineBorder),
            boxShadow: TimelineShadow.card,
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(TimelineRadius.panel),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < urls.length; i++) ...[
                  if (i > 0)
                    Divider(height: 1, thickness: 1, color: colors.divider),
                  Material(
                    type: MaterialType.transparency,
                    child: InkWell(
                      key: ValueKey('preview-url-item-${urls[i]}'),
                      onTap: () => onOpen(urls[i]),
                      onLongPress: onLongPress == null
                          ? null
                          : () => onLongPress!(urls[i]),
                      child: ConstrainedBox(
                        constraints: BoxConstraints(minHeight: touch),
                        child: Padding(
                          padding: EdgeInsetsDirectional.only(
                            start: TimelineSpace.x6,
                            end: onDelete != null
                                ? TimelineSpace.x2
                                : TimelineSpace.x5,
                            top: TimelineSpace.x3,
                            bottom: TimelineSpace.x3,
                          ),
                          child: Row(
                            spacing: TimelineSpace.x3,
                            children: [
                              Expanded(
                                child: Text(
                                  displayLabel(urls[i]),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TimelineType.metaMonoStyle(
                                    colors.foreground,
                                  ),
                                ),
                              ),
                              if (onDelete != null)
                                SizedBox.square(
                                  dimension: 36,
                                  child: IconButton(
                                    key: ValueKey(
                                      'preview-history-delete-${urls[i]}',
                                    ),
                                    tooltip: '删除记录',
                                    padding: EdgeInsets.zero,
                                    onPressed: () => onDelete!(urls[i]),
                                    icon: IconTheme(
                                      data: IconThemeData(color: colors.faint),
                                      child: const WorkspaceIcon(
                                        WorkspaceGlyph.close,
                                        size: TimelineIcon.meta,
                                      ),
                                    ),
                                  ),
                                )
                              else
                                Icon(
                                  Icons.chevron_right_rounded,
                                  size: 18,
                                  color: colors.faint,
                                ),
                            ],
                          ),
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
    );
  }
}

class _EmptyPreviewHint extends StatelessWidget {
  const _EmptyPreviewHint({required this.disabled});

  final bool disabled;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.timelineCard,
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
        border: Border.all(color: colors.timelineBorder),
      ),
      child: Padding(
        padding: const EdgeInsets.all(TimelineSpace.x8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: TimelineSpace.x3,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: colors.field,
                shape: BoxShape.circle,
              ),
              alignment: Alignment.center,
              child: IconTheme(
                data: IconThemeData(color: colors.secondaryText),
                child: const WorkspaceIcon(WorkspaceGlyph.laptop, size: 22),
              ),
            ),
            Text(
              '本机加密预览',
              style: TimelineType.headingStyle(
                TimelineType.heading3,
                FontWeight.w600,
              ).copyWith(color: colors.foreground),
            ),
            Text(
              disabled
                  ? '在电脑开启手机本机预览后，可直接访问电脑 localhost 开发页面。'
                  : '输入电脑上的本地开发端口（如 5173、3000）或点击时间线里的 localhost 链接，即可安全预览本机网页。',
              textAlign: TextAlign.center,
              style: TimelineType.metaStyle(
                colors.muted,
                height: TimelineType.noticeHeight,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
