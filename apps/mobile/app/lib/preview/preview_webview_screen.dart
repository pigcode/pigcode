import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../app_theme.dart';
import '../composer/composer_tokens.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workbench/workbench_utils.dart';
import '../workspace_icon.dart';
import 'local_preview_proxy.dart';
import 'preview_history.dart';
import 'preview_url_extractor.dart';

/// 可测试的 WebView 控制器接口（生产态桥接 `webview_flutter`，测试态可注入替身）。
abstract interface class PreviewWebViewController {
  Future<bool> canGoBack();
  Future<bool> canGoForward();
  Future<void> goBack();
  Future<void> goForward();
  Future<void> reload();
  Future<void> loadRequest(Uri uri);
}

/// 预览页向 WebView 层暴露的代理信息与导航回调。
final class PreviewWebViewHost {
  const PreviewWebViewHost({
    required this.proxyEntryUri,
    required this.targetOrigin,
    required this.isProxyOrigin,
    required this.onProgress,
    required this.onPageStarted,
    required this.onPageFinished,
    required this.onNavigationRequest,
    required this.onWebResourceError,
    required this.onAttachController,
  });

  final Uri proxyEntryUri;
  final Uri targetOrigin;
  final bool Function(Uri uri) isProxyOrigin;
  final ValueChanged<int> onProgress;
  final ValueChanged<String> onPageStarted;
  final ValueChanged<String> onPageFinished;
  final bool Function(Uri uri, {required bool isMainFrame}) onNavigationRequest;
  final void Function(String description, {required bool isForMainFrame})
  onWebResourceError;
  final ValueChanged<PreviewWebViewController> onAttachController;
}

/// 自定义 WebView 构建器（用于 Widget 测试隔离原生平台 WebView 通道）。
typedef PreviewWebViewBuilder =
    Widget Function(BuildContext context, PreviewWebViewHost host);

/// 自定义本地代理工厂（默认使用 [LocalPreviewProxy.forConnection]，便于测试观察代理回调）。
typedef LocalPreviewProxyFactory =
    LocalPreviewProxy Function({
      required MobileConnection connection,
      required void Function(Uri externalUrl) onExternalNavigation,
      required void Function(PreviewProxyError error) onProxyError,
    });

/// 手机端加密本机预览 WebView 全屏页：
/// - 启动仅绑定 `127.0.0.1:0` 的 [LocalPreviewProxy]，所有流量走加密 RPC 隧道；
/// - 顶栏仅展示还原后的真实本机地址（如 `localhost:5173/dashboard`，绝不暴露随机代理端口）与关闭按钮，紧贴细加载进度条；
/// - 底部提供后退、前进、刷新与复制真实地址工具栏；
/// - 拦截一切非当前代理域名的导航并弹窗确认；发生代理或连接错误时覆盖展示清晰的中文错误页与重试按钮；
/// - 页面关闭（`dispose`）严格销毁 [LocalPreviewProxy] 释放端口。
class MobilePreviewWebViewScreen extends StatefulWidget {
  const MobilePreviewWebViewScreen({
    super.key,
    required this.connection,
    required this.initialUrl,
    this.computerKey,
    this.historyStorage,
    this.recordHistory = true,
    this.openExternalUrl,
    this.webViewBuilder,
    this.proxyFactory,
  });

  static const closeButtonKey = ValueKey('preview-webview-close');
  static const addressTextKey = ValueKey('preview-webview-address');
  static const progressBarKey = ValueKey('preview-webview-progress');
  static const backButtonKey = ValueKey('preview-webview-back');
  static const forwardButtonKey = ValueKey('preview-webview-forward');
  static const reloadButtonKey = ValueKey('preview-webview-reload');
  static const copyUrlButtonKey = ValueKey('preview-webview-copy');
  static const errorOverlayKey = ValueKey('preview-webview-error-overlay');
  static const retryButtonKey = ValueKey('preview-webview-retry');

  final MobileConnection connection;
  final Uri initialUrl;
  final String? computerKey;
  final PreviewHistoryStorage? historyStorage;
  final bool recordHistory;
  final ExternalUrlOpener? openExternalUrl;
  final PreviewWebViewBuilder? webViewBuilder;
  final LocalPreviewProxyFactory? proxyFactory;

  static Future<void> open(
    BuildContext context, {
    required MobileConnection connection,
    required Uri initialUrl,
    String? computerKey,
    PreviewHistoryStorage? historyStorage,
    bool recordHistory = true,
    ExternalUrlOpener? openExternalUrl,
    PreviewWebViewBuilder? webViewBuilder,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => MobilePreviewWebViewScreen(
        connection: connection,
        initialUrl: initialUrl,
        computerKey: computerKey,
        historyStorage: historyStorage,
        recordHistory: recordHistory,
        openExternalUrl: openExternalUrl,
        webViewBuilder: webViewBuilder,
      ),
    ),
  );

  @override
  State<MobilePreviewWebViewScreen> createState() =>
      _MobilePreviewWebViewScreenState();
}

class _MobilePreviewWebViewScreenState
    extends State<MobilePreviewWebViewScreen> {
  LocalPreviewProxy? _proxy;
  PreviewWebViewController? _webViewController;
  Uri? _proxyEntryUri;
  Uri? _targetOrigin;
  late Uri _displayUri;

  bool _startingProxy = true;
  int _progress = 0;
  bool _canGoBack = false;
  bool _canGoForward = false;
  PreviewProxyError? _proxyError;
  bool _externalDialogOpen = false;
  int _proxyGeneration = 0;

  @override
  void initState() {
    super.initState();
    final validated = normalizePreviewInput(widget.initialUrl.toString());
    _displayUri = validated.uri ?? widget.initialUrl;
    _recordHistoryIfEnabled(_displayUri);
    _watchConnectionDone();
    unawaited(_startProxy(_displayUri));
  }

  @override
  void dispose() {
    _proxyGeneration++;
    final proxy = _proxy;
    _proxy = null;
    if (proxy != null) {
      unawaited(proxy.close());
    }
    super.dispose();
  }

  void _recordHistoryIfEnabled(Uri uri) {
    if (!widget.recordHistory) return;
    final storage =
        widget.historyStorage ??
        (() {
          final key =
              widget.computerKey ?? connectionComputerKey(widget.connection);
          return key == null ? null : PreviewHistoryStorage(key);
        })();
    if (storage == null) return;
    unawaited(
      storage.record(uri.toString()).catchError((Object _) => const <String>[]),
    );
  }

  void _watchConnectionDone() {
    unawaited(
      widget.connection.done.whenComplete(() {
        if (!mounted) return;
        setState(() {
          _proxyError = PreviewProxyError(
            kind: PreviewProxyErrorKind.disconnected,
            statusCode: 503,
            message: '电脑连接已断开，请重连后再试。',
            code: 'closed',
            requestUri: _displayUri,
            isDocumentRequest: true,
          );
          _startingProxy = false;
          _progress = 0;
        });
      }),
    );
  }

  Future<void> _startProxy(Uri targetUri) async {
    final generation = ++_proxyGeneration;
    final previous = _proxy;
    _proxy = null;
    if (previous != null) {
      unawaited(previous.close());
    }

    if (mounted) {
      setState(() {
        _startingProxy = true;
        _proxyError = null;
        _proxyEntryUri = null;
        _webViewController = null;
        _progress = 15;
      });
    }

    if (!connectionSupportsPreviewTunnel(widget.connection)) {
      if (!mounted || generation != _proxyGeneration) return;
      setState(() {
        _startingProxy = false;
        _progress = 0;
        _proxyError = PreviewProxyError(
          kind: PreviewProxyErrorKind.updateDesktop,
          statusCode: 503,
          message: '请更新电脑上的 Pigcode 后使用本机预览。',
          code: 'update-desktop',
          requestUri: targetUri,
          isDocumentRequest: true,
        );
      });
      return;
    }

    void handleExternal(Uri uri) {
      if (!mounted || generation != _proxyGeneration) return;
      unawaited(_handleExternalNavigation(uri));
    }

    void handleError(PreviewProxyError error) {
      if (!mounted || generation != _proxyGeneration) return;
      if (!error.isGlobalFailure) return;
      setState(() {
        _proxyError = error;
        _progress = 0;
      });
    }

    final proxy = widget.proxyFactory != null
        ? widget.proxyFactory!(
            connection: widget.connection,
            onExternalNavigation: handleExternal,
            onProxyError: handleError,
          )
        : LocalPreviewProxy.forConnection(
            widget.connection,
            onExternalNavigation: handleExternal,
            onProxyError: handleError,
          );

    try {
      final entryUri = await proxy.start(targetUri);
      if (!mounted || generation != _proxyGeneration) {
        unawaited(proxy.close());
        return;
      }
      setState(() {
        _proxy = proxy;
        _proxyEntryUri = entryUri;
        _targetOrigin = proxy.targetOrigin;
        _startingProxy = false;
      });
    } catch (error) {
      unawaited(proxy.close());
      if (!mounted || generation != _proxyGeneration) return;
      setState(() {
        _startingProxy = false;
        _progress = 0;
        _proxyError = error is ArgumentError
            ? PreviewProxyError(
                kind: PreviewProxyErrorKind.urlNotAllowed,
                statusCode: 403,
                message: '仅允许预览电脑本机 localhost HTTP/HTTPS 地址。',
                code: 'PREVIEW_URL_NOT_ALLOWED',
                requestUri: targetUri,
                isDocumentRequest: true,
              )
            : previewErrorFromException(
                error,
                requestUri: targetUri,
                isDocumentRequest: true,
              );
      });
    }
  }

  void _updateDisplayUrlFromProxyString(String rawUrl) {
    final uri = Uri.tryParse(rawUrl);
    final proxy = _proxy;
    final origin = _targetOrigin;
    if (uri == null || proxy == null || origin == null) return;
    if (!proxy.isProxyOrigin(uri)) return;
    final restored = proxyUriToDisplayUri(uri, origin);
    if (restored != _displayUri && mounted) {
      setState(() => _displayUri = restored);
    }
  }

  Future<void> _refreshNavigationCapabilities() async {
    final controller = _webViewController;
    if (controller == null) return;
    try {
      final back = await controller.canGoBack();
      final forward = await controller.canGoForward();
      if (!mounted) return;
      if (back != _canGoBack || forward != _canGoForward) {
        setState(() {
          _canGoBack = back;
          _canGoForward = forward;
        });
      }
    } catch (_) {
      // Ignore transient platform WebView query errors.
    }
  }

  bool _onNavigationRequest(Uri uri, {required bool isMainFrame}) {
    final scheme = uri.scheme.toLowerCase();
    if (scheme == 'about') return true;
    final proxy = _proxy;
    if (proxy != null && proxy.isProxyOrigin(uri)) {
      if (isMainFrame) {
        _updateDisplayUrlFromProxyString(uri.toString());
      }
      return true;
    }
    if (isMainFrame) {
      unawaited(_handleExternalNavigation(uri));
    }
    return false;
  }

  void _onProgress(int progress) {
    if (!mounted) return;
    final clamped = progress.clamp(0, 100);
    if (clamped != _progress) {
      setState(() => _progress = clamped);
    }
  }

  void _onPageStarted(String url) {
    if (!mounted) return;
    _updateDisplayUrlFromProxyString(url);
    unawaited(_refreshNavigationCapabilities());
  }

  void _onPageFinished(String url) {
    if (!mounted) return;
    _updateDisplayUrlFromProxyString(url);
    setState(() => _progress = 100);
    unawaited(_refreshNavigationCapabilities());
  }

  void _onWebResourceError(String description, {required bool isForMainFrame}) {
    if (!mounted || !isForMainFrame) return;
    if (_proxyError != null) return;
    setState(() {
      _progress = 0;
      _proxyError = PreviewProxyError(
        kind: PreviewProxyErrorKind.unknown,
        statusCode: 502,
        message: '页面加载失败，请确认本机服务正常运行后重试。',
        requestUri: _displayUri,
        isDocumentRequest: true,
      );
    });
  }

  Future<void> _handleExternalNavigation(Uri uri) async {
    if (!mounted || _externalDialogOpen) return;
    final scheme = uri.scheme.toLowerCase();
    if (scheme != 'http' && scheme != 'https') {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('已拦截非网页链接：${uri.toString()}')));
      return;
    }

    _externalDialogOpen = true;
    try {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) {
          final colors = Theme.of(dialogContext).brightness == Brightness.dark
              ? pigcodeDark
              : pigcodeLight;
          return MobileGlassDialog(
            title: const Text('即将离开本机预览'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: TimelineSpace.x4,
              children: [
                const Text('即将离开本机预览，在系统浏览器打开外部链接？'),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(TimelineSpace.x4),
                  decoration: BoxDecoration(
                    color: colors.field,
                    borderRadius: BorderRadius.circular(TimelineRadius.block),
                    border: Border.all(color: colors.border),
                  ),
                  child: Text(
                    uri.toString(),
                    style: TimelineType.metaMonoStyle(colors.secondaryText),
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('在浏览器打开'),
              ),
            ],
          );
        },
      );
      if (confirmed != true || !mounted) return;
      final opener = widget.openExternalUrl ?? launchExternalUrl;
      var opened = false;
      try {
        opened = await opener(uri);
      } catch (_) {
        opened = false;
      }
      if (!mounted || opened) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('无法在外部浏览器打开此链接')));
    } finally {
      _externalDialogOpen = false;
    }
  }

  Future<void> _retry() async {
    final proxy = _proxy;
    final entryUri = _proxyEntryUri;
    final controller = _webViewController;
    if (proxy == null || !proxy.isRunning || entryUri == null) {
      await _startProxy(_displayUri);
      return;
    }
    setState(() {
      _proxyError = null;
      _progress = 15;
    });
    if (controller != null) {
      try {
        final targetProxyUri = _displayUriToProxyUri(_displayUri, entryUri);
        await controller.loadRequest(targetProxyUri);
      } catch (_) {
        await controller.reload();
      }
    }
  }

  Uri _displayUriToProxyUri(Uri displayUri, Uri proxyEntryUri) {
    final path = displayUri.path.isEmpty ? '/' : displayUri.path;
    final query = displayUri.hasQuery ? '?${displayUri.query}' : '';
    final fragment = displayUri.hasFragment ? '#${displayUri.fragment}' : '';
    return Uri.parse(
      'http://127.0.0.1:${proxyEntryUri.port}$path$query$fragment',
    );
  }

  Future<void> _goBack() async {
    final controller = _webViewController;
    if (controller == null || !_canGoBack) return;
    setState(() => _proxyError = null);
    await controller.goBack();
    await _refreshNavigationCapabilities();
  }

  Future<void> _goForward() async {
    final controller = _webViewController;
    if (controller == null || !_canGoForward) return;
    setState(() => _proxyError = null);
    await controller.goForward();
    await _refreshNavigationCapabilities();
  }

  Future<void> _reload() async {
    if (_proxyError != null) {
      await _retry();
      return;
    }
    final controller = _webViewController;
    if (controller == null) {
      await _startProxy(_displayUri);
      return;
    }
    setState(() => _progress = 15);
    await controller.reload();
  }

  Future<void> _copyRealAddress() async {
    final text = _displayUri.toString();
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('已复制地址 $text')));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final brightness = theme.brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final displayAddress = formatPreviewDisplayAddress(_displayUri);
    final showProgress = _startingProxy || (_progress > 0 && _progress < 100);
    final progressValue = _startingProxy ? null : (_progress / 100.0);

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        toolbarHeight: touch + 8,
        titleSpacing: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(brightness),
        leadingWidth: touch + 14,
        leading: Align(
          alignment: AlignmentDirectional.centerStart,
          child: MobileGlassChromeButton(
            padding: const EdgeInsetsDirectional.only(start: 10),
            child: SizedBox.square(
              dimension: 40,
              child: IconButton(
                key: MobilePreviewWebViewScreen.closeButtonKey,
                tooltip: '关闭预览',
                padding: EdgeInsets.zero,
                onPressed: () => Navigator.maybePop(context),
                icon: const WorkspaceIcon(WorkspaceGlyph.close, size: 18),
              ),
            ),
          ),
        ),
        title: Padding(
          padding: const EdgeInsetsDirectional.only(end: TimelineSpace.x6),
          child: MobileGlassSurface(
            blurSigma: 16,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: TimelineSpace.x5,
                vertical: TimelineSpace.x3,
              ),
              child: Row(
                spacing: TimelineSpace.x3,
                children: [
                  IconTheme(
                    data: IconThemeData(color: colors.muted),
                    child: const WorkspaceIcon(
                      WorkspaceGlyph.laptop,
                      size: TimelineIcon.meta,
                    ),
                  ),
                  Expanded(
                    child: Text(
                      displayAddress,
                      key: MobilePreviewWebViewScreen.addressTextKey,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.metaMonoStyle(colors.foreground),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(2),
          child: showProgress
              ? LinearProgressIndicator(
                  key: MobilePreviewWebViewScreen.progressBarKey,
                  value: progressValue,
                  minHeight: 2,
                  backgroundColor: colors.divider,
                  color: ComposerSurface.accent(brightness),
                )
              : Divider(height: 2, thickness: 1, color: colors.divider),
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          _buildWebViewLayer(context),
          if (_proxyError case final error?)
            _PreviewErrorOverlay(
              key: MobilePreviewWebViewScreen.errorOverlayKey,
              error: error,
              displayAddress: displayAddress,
              onRetry: () => unawaited(_retry()),
            ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
          child: MobileGlassSurface(
            blurSigma: 20,
            child: Material(
              type: MaterialType.transparency,
              shape: const StadiumBorder(),
              child: SizedBox(
                height: touch + 2,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    SizedBox.square(
                      dimension: touch,
                      child: IconButton(
                        key: MobilePreviewWebViewScreen.backButtonKey,
                        tooltip: '后退',
                        onPressed: _canGoBack
                            ? () => unawaited(_goBack())
                            : null,
                        color: colors.foreground,
                        disabledColor: colors.faint,
                        icon: const Icon(
                          Icons.arrow_back_ios_new_rounded,
                          size: 18,
                        ),
                      ),
                    ),
                    SizedBox.square(
                      dimension: touch,
                      child: IconButton(
                        key: MobilePreviewWebViewScreen.forwardButtonKey,
                        tooltip: '前进',
                        onPressed: _canGoForward
                            ? () => unawaited(_goForward())
                            : null,
                        color: colors.foreground,
                        disabledColor: colors.faint,
                        icon: const Icon(
                          Icons.arrow_forward_ios_rounded,
                          size: 18,
                        ),
                      ),
                    ),
                    SizedBox.square(
                      dimension: touch,
                      child: IconButton(
                        key: MobilePreviewWebViewScreen.reloadButtonKey,
                        tooltip: '刷新',
                        onPressed: () => unawaited(_reload()),
                        color: colors.foreground,
                        icon: const Icon(Icons.refresh_rounded, size: 21),
                      ),
                    ),
                    SizedBox.square(
                      dimension: touch,
                      child: IconButton(
                        key: MobilePreviewWebViewScreen.copyUrlButtonKey,
                        tooltip: '复制地址',
                        onPressed: () => unawaited(_copyRealAddress()),
                        color: colors.foreground,
                        icon: const WorkspaceIcon(
                          WorkspaceGlyph.copy,
                          size: 18,
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
    );
  }

  Widget _buildWebViewLayer(BuildContext context) {
    final entryUri = _proxyEntryUri;
    final origin = _targetOrigin;
    final proxy = _proxy;
    if (_startingProxy || entryUri == null || origin == null || proxy == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    final host = PreviewWebViewHost(
      proxyEntryUri: entryUri,
      targetOrigin: origin,
      isProxyOrigin: proxy.isProxyOrigin,
      onProgress: _onProgress,
      onPageStarted: _onPageStarted,
      onPageFinished: _onPageFinished,
      onNavigationRequest: _onNavigationRequest,
      onWebResourceError: _onWebResourceError,
      onAttachController: (controller) {
        _webViewController = controller;
        unawaited(_refreshNavigationCapabilities());
      },
    );

    if (widget.webViewBuilder case final customBuilder?) {
      return KeyedSubtree(
        key: ValueKey('preview-webview-${entryUri.port}'),
        child: customBuilder(context, host),
      );
    }

    return _PlatformWebViewPane(
      key: ValueKey('preview-webview-${entryUri.port}'),
      host: host,
    );
  }
}

class _PlatformWebViewPane extends StatefulWidget {
  const _PlatformWebViewPane({super.key, required this.host});

  final PreviewWebViewHost host;

  @override
  State<_PlatformWebViewPane> createState() => _PlatformWebViewPaneState();
}

class _PlatformWebViewPaneState extends State<_PlatformWebViewPane> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    final host = widget.host;
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: host.onProgress,
          onPageStarted: host.onPageStarted,
          onPageFinished: host.onPageFinished,
          onWebResourceError: (error) => host.onWebResourceError(
            error.description,
            isForMainFrame: error.isForMainFrame ?? true,
          ),
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            if (uri == null) return NavigationDecision.prevent;
            final allow = host.onNavigationRequest(
              uri,
              isMainFrame: request.isMainFrame,
            );
            return allow
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
        ),
      );
    host.onAttachController(_FlutterWebViewControllerAdapter(_controller));
    unawaited(_controller.loadRequest(host.proxyEntryUri));
  }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
}

class _FlutterWebViewControllerAdapter implements PreviewWebViewController {
  const _FlutterWebViewControllerAdapter(this._controller);

  final WebViewController _controller;

  @override
  Future<bool> canGoBack() => _controller.canGoBack();

  @override
  Future<bool> canGoForward() => _controller.canGoForward();

  @override
  Future<void> goBack() => _controller.goBack();

  @override
  Future<void> goForward() => _controller.goForward();

  @override
  Future<void> reload() => _controller.reload();

  @override
  Future<void> loadRequest(Uri uri) => _controller.loadRequest(uri);
}

class _PreviewErrorOverlay extends StatelessWidget {
  const _PreviewErrorOverlay({
    super.key,
    required this.error,
    required this.displayAddress,
    required this.onRetry,
  });

  final PreviewProxyError error;
  final String displayAddress;
  final VoidCallback onRetry;

  ({IconData icon, String title}) _presentation(PreviewProxyErrorKind kind) =>
      switch (kind) {
        PreviewProxyErrorKind.disabled => (
          icon: Icons.block_rounded,
          title: '电脑端已关闭本机预览',
        ),
        PreviewProxyErrorKind.unreachable => (
          icon: Icons.portable_wifi_off_rounded,
          title: '无法连接电脑本机服务',
        ),
        PreviewProxyErrorKind.timeout => (
          icon: Icons.timer_off_outlined,
          title: '本机预览请求超时',
        ),
        PreviewProxyErrorKind.urlNotAllowed => (
          icon: Icons.shield_outlined,
          title: '该地址不允许本机预览',
        ),
        PreviewProxyErrorKind.tooLarge => (
          icon: Icons.data_usage_rounded,
          title: '预览内容超出大小上限',
        ),
        PreviewProxyErrorKind.disconnected => (
          icon: Icons.link_off_rounded,
          title: '电脑连接已断开',
        ),
        PreviewProxyErrorKind.updateDesktop => (
          icon: Icons.system_update_alt_rounded,
          title: '需要更新电脑端 Pigcode',
        ),
        PreviewProxyErrorKind.streamNotFound || PreviewProxyErrorKind.unknown =>
          (icon: Icons.error_outline_rounded, title: '本机预览加载失败'),
      };

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final info = _presentation(error.kind);

    return ColoredBox(
      color: colors.background,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(TimelineSpace.x9),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: colors.timelineCard,
                borderRadius: BorderRadius.circular(TimelineRadius.panel),
                border: Border.all(color: colors.timelineBorder),
                boxShadow: TimelineShadow.card,
              ),
              child: Padding(
                padding: const EdgeInsets.all(TimelineSpace.x8),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  spacing: TimelineSpace.x4,
                  children: [
                    Container(
                      width: 52,
                      height: 52,
                      decoration: BoxDecoration(
                        color: colors.field,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: Icon(
                        info.icon,
                        size: 26,
                        color: colors.secondaryText,
                      ),
                    ),
                    Text(
                      info.title,
                      textAlign: TextAlign.center,
                      style: TimelineType.headingStyle(
                        TimelineType.heading2,
                        FontWeight.w600,
                      ).copyWith(color: colors.foreground),
                    ),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.field,
                        borderRadius: BorderRadius.circular(
                          TimelineRadius.full,
                        ),
                        border: Border.all(color: colors.border),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: TimelineSpace.x5,
                          vertical: TimelineSpace.x2,
                        ),
                        child: Text(
                          displayAddress,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TimelineType.metaMonoStyle(
                            colors.secondaryText,
                          ),
                        ),
                      ),
                    ),
                    Text(
                      error.message,
                      textAlign: TextAlign.center,
                      style: TimelineType.metaStyle(
                        colors.muted,
                        height: TimelineType.noticeHeight,
                      ),
                    ),
                    const SizedBox(height: TimelineSpace.x2),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        key: MobilePreviewWebViewScreen.retryButtonKey,
                        style: FilledButton.styleFrom(
                          minimumSize: Size(0, touch),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              TimelineRadius.panel,
                            ),
                          ),
                        ),
                        onPressed: onRetry,
                        child: const Text('重试'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
