import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/computers.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_mobile/preview/local_preview_proxy.dart';
import 'package:pigcode_mobile/preview/preview_history.dart';
import 'package:pigcode_mobile/preview/preview_tab.dart';
import 'package:pigcode_mobile/preview/preview_url_extractor.dart';
import 'package:pigcode_mobile/preview/preview_webview_screen.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_mobile/workbench/mobile_workbench_screen.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _InstalledPrefs implements SharedPreferencesAsync {
  @override
  Future<bool?> getBool(String key) async => true;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final _sidebarSnapshot = SidebarSnapshot(
  projects: const [MobileProjectSummary(id: 'proj-1', name: 'Pigcode')],
  threads: const [
    MobileThreadSummary(
      id: 'thread-1',
      projectId: 'proj-1',
      title: '预览测试会话',
      updatedAt: '2026-11-25T15:00:00.000Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.completed,
      unread: false,
    ),
  ],
  syncedAt: DateTime.utc(2026, 11, 25, 15),
);

class _FakeHost implements HostRequests {
  _FakeHost({this.onPreviewStatus});

  Future<MobilePreviewStatus> Function(Map<String, Object?> params)?
  onPreviewStatus;

  final List<({String method, Map<String, Object?> params})> calls = [];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobilePreviewMethods.status:
        if (onPreviewStatus != null) {
          return (await onPreviewStatus!(params)).toJson();
        }
        return const MobilePreviewStatus(
          enabled: true,
          desktopUrls: [],
        ).toJson();
      case MobilePreviewMethods.fetch:
        final html = utf8.encode('<html><body>Preview OK</body></html>');
        return MobilePreviewFetchResponse(
          status: 200,
          statusText: 'OK',
          headers: const [
            MobilePreviewHeader(name: 'content-type', value: 'text/html'),
          ],
          bodyBase64: base64Encode(html),
          totalBytes: html.length,
          hasMore: false,
        ).toJson();
      case MobilePreviewMethods.closeBody:
        return {'ok': true};
      case MobileWorkbenchMethods.list:
        return const MobileDirectoryListing(
          path: '',
          entries: [
            MobileDirectoryEntry(
              path: 'README.md',
              name: 'README.md',
              kind: 'file',
              size: 100,
            ),
          ],
          truncated: false,
        ).toJson();
      case MobileWorkbenchMethods.prStatus:
        return const MobilePrStatusResult(status: 'no-pr', branch: 'main')
            .toJson();
      case QueueMethods.get:
        return QueueSnapshot(
          threadId: (params['threadId'] as String?) ?? 'thread-1',
          paused: false,
          messages: const [],
        ).toJson();
      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

class _FakeSidebar implements MobileSidebar {
  _FakeSidebar(this.snapshot);

  @override
  final SidebarSnapshot snapshot;

  @override
  Stream<SidebarSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeTimeline implements MobileTimeline {
  _FakeTimeline(this.snapshot);

  @override
  final TimelineSnapshot snapshot;

  @override
  Stream<TimelineSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _PreviewTestConnection implements MobileConnection {
  _PreviewTestConnection({
    required _FakeHost host,
    this.supportsWorkbenchRead = true,
    this.supportsPreviewTunnel = true,
    TimelineSnapshot? timeline,
    Completer<void>? doneCompleter,
    String? computerKey,
  }) : _timeline =
           timeline ??
           TimelineSnapshot(
             events: const [],
             through: 0,
             cursor: 0,
             nextBefore: null,
             live: null,
           ),
       done = (doneCompleter ?? Completer<void>()).future,
       computer = ComputerProfile(
         address: 'wss://localhost/ws/v1/connect',
         token: 'test-token',
         computerKey:
             computerKey ??
             base64Url.encode(List<int>.filled(32, 9)).replaceAll('=', ''),
         name: '测试电脑',
       ),
       workbench = MobileWorkbenchCommands(
         host,
         supportsWorkbenchRead: supportsWorkbenchRead,
       ),
       preview = MobilePreviewCommands(
         host,
         supportsPreviewTunnel: supportsPreviewTunnel,
       ),
       mentions = MobileMentionCommands(host),
       queue = MobileQueueCommands(host),
       changes = MobileRunChanges(host);

  final TimelineSnapshot _timeline;

  @override
  final bool supportsWorkbenchRead;

  @override
  final bool supportsPreviewTunnel;

  @override
  final MobileWorkbenchCommands workbench;

  @override
  final MobilePreviewCommands preview;

  @override
  final MobileMentionCommands mentions;

  @override
  final MobileQueueCommands queue;

  @override
  final MobileRunChanges changes;

  @override
  final ComputerProfile computer;

  @override
  final Future<void> done;

  @override
  String get computerName => '测试电脑';

  @override
  String get deviceId => 'device-preview-test';

  @override
  bool get supportsSidebar => true;

  @override
  bool get supportsSidebarCommands => false;

  @override
  bool get supportsDraftCommands => true;

  @override
  bool get supportsRunCommands => false;

  @override
  bool get supportsRequestCommands => false;

  @override
  bool get supportsRunChanges => false;

  @override
  bool get supportsComposerControls => false;

  @override
  bool get supportsComposerMentions => true;

  @override
  bool get supportsAttachments => false;

  @override
  Future<MobileSidebar> openSidebar() async => _FakeSidebar(_sidebarSnapshot);

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) async => _FakeTimeline(_timeline);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeWebViewController implements PreviewWebViewController {
  bool backEnabled = false;
  bool forwardEnabled = false;
  int goBackCalls = 0;
  int goForwardCalls = 0;
  int reloadCalls = 0;
  final List<Uri> loadedRequests = [];

  @override
  Future<bool> canGoBack() async => backEnabled;

  @override
  Future<bool> canGoForward() async => forwardEnabled;

  @override
  Future<void> goBack() async {
    goBackCalls++;
  }

  @override
  Future<void> goForward() async {
    goForwardCalls++;
  }

  @override
  Future<void> reload() async {
    reloadCalls++;
  }

  @override
  Future<void> loadRequest(Uri uri) async {
    loadedRequests.add(uri);
  }
}

Widget _wrapApp(Widget child) => ProviderScope(
  child: MaterialApp(
    theme: pigcodeTheme(Brightness.light),
    home: child,
  ),
);

ComputerProfile _computer(int seed) => ComputerProfile(
  address: 'wss://localhost/ws/v1/connect',
  token: 'fixture',
  computerKey: base64Url.encode(List<int>.filled(32, seed)).replaceAll('=', ''),
  name: '电脑 $seed',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  group('URL 规范化、提取与去重', () {
    test('normalizePreviewInput normalizes port/localhost inputs and rejects unsafe URLs', () {
      expect(
        normalizePreviewInput('5173').uri?.toString(),
        'http://localhost:5173/',
      );
      expect(
        normalizePreviewInput('localhost:3000/app?x=1').uri?.toString(),
        'http://localhost:3000/app?x=1',
      );
      expect(
        normalizePreviewInput('127.0.0.1:8080').uri?.toString(),
        'http://127.0.0.1:8080/',
      );
      expect(
        normalizePreviewInput('[::1]:4000/home').uri?.toString(),
        'http://[::1]:4000/home',
      );
      expect(
        normalizePreviewInput('https://localhost:8443/secure').uri?.toString(),
        'https://localhost:8443/secure',
      );

      for (final invalid in const [
        '',
        '0',
        '65536',
        '22',
        '3306',
        'https://example.com',
        'http://192.168.1.10:3000',
        'http://user:pass@localhost:5173',
        'http://2130706433:5173',
        'http://0177.0.0.1:5173',
        'ftp://localhost:5173',
        'javascript:alert(1)',
        'file:///etc/passwd',
      ]) {
        final result = normalizePreviewInput(invalid);
        expect(result.isValid, isFalse, reason: invalid);
        expect(result.error, isNotNull, reason: invalid);
        expect(result.error, isNotEmpty, reason: invalid);
      }
    });

    test('isLocalhostPreviewUrl distinguishes explicit localhost URLs from bare ports and external URLs', () {
      expect(isLocalhostPreviewUrl('http://localhost:5173'), isTrue);
      expect(isLocalhostPreviewUrl('http://127.0.0.1:3000/login'), isTrue);
      expect(isLocalhostPreviewUrl('https://[::1]:8443/'), isTrue);
      expect(isLocalhostPreviewUrl('5173'), isFalse);
      expect(isLocalhostPreviewUrl('https://github.com/pigcode'), isFalse);
      expect(isLocalhostPreviewUrl('http://localhost:22'), isFalse);
    });

    test('extractPreviewUrlsFromText and extractPreviewUrlsFromTurns strip ANSI/punctuation and deduplicate latest-first', () {
      const sample =
          '➜ Local: \x1B[36mhttp://localhost:5173/。\x1B[0m\n'
          '也可看（http://127.0.0.1:3000/docs_(v1)），'
          '或者 [预览](http://localhost:5173)。\n'
          '外链 https://example.com:8080/ignored 不应提取。';
      expect(
        extractPreviewUrlsFromText(sample),
        [
          'http://localhost:5173/',
          'http://127.0.0.1:3000/docs_(v1)',
        ],
      );

      final turns = timelineTurns(const [
        MobileTimelineEvent(
          seq: 1,
          runId: 'r1',
          kind: MobileTimelineKind.toolStarted,
          itemId: 'cmd-1',
          name: 'Bash',
          text: '{"command":"pnpm dev"}',
          createdAt: '2026-11-25T15:00:00Z',
        ),
        MobileTimelineEvent(
          seq: 2,
          runId: 'r1',
          kind: MobileTimelineKind.toolCompleted,
          itemId: 'cmd-1',
          name: 'Bash',
          text: 'ready at http://localhost:3000/old and http://[::1]:4173/app!',
          createdAt: '2026-11-25T15:00:01Z',
        ),
        MobileTimelineEvent(
          seq: 3,
          runId: 'r1',
          kind: MobileTimelineKind.messageAssistant,
          text: '开发服务已在 http://localhost:5173/dashboard 启动，旧入口 http://localhost:3000/old。',
          createdAt: '2026-11-25T15:00:02Z',
        ),
        MobileTimelineEvent(
          seq: 4,
          runId: 'r1',
          kind: MobileTimelineKind.runCompleted,
          createdAt: '2026-11-25T15:00:03Z',
        ),
      ]);

      expect(
        extractPreviewUrlsFromTurns(turns),
        [
          'http://localhost:3000/old',
          'http://localhost:5173/dashboard',
          'http://[::1]:4173/app',
        ],
      );
    });
  });

  group('PreviewHistoryStorage 隔离、上限与删电脑清理', () {
    test('isolates by computerKey, caps at 10 entries, and clears on Computers.forget', () async {
      final dir = await Directory.systemTemp.createTemp(
        'pigcode-preview-history-test-',
      );
      addTearDown(() => dir.delete(recursive: true));
      final cache = OfflineCacheStore(directory: () async => dir);
      final removed = _computer(11);
      final kept = _computer(12);

      final removedHistory = PreviewHistoryStorage(removed.computerKey);
      final keptHistory = PreviewHistoryStorage(kept.computerKey);

      for (var port = 5101; port <= 5112; port++) {
        await removedHistory.record('http://localhost:$port/');
      }
      await keptHistory.record('http://localhost:3000/');

      final storedRemoved = await removedHistory.read();
      expect(storedRemoved.length, previewHistoryLimit);
      expect(storedRemoved.first, 'http://localhost:5112/');
      expect(storedRemoved.last, 'http://localhost:5103/');
      expect(await keptHistory.read(), ['http://localhost:3000/']);

      // Remove a single item
      final afterRemove = await removedHistory.remove('http://localhost:5112/');
      expect(afterRemove.first, 'http://localhost:5111/');
      expect(afterRemove.length, previewHistoryLimit - 1);

      // Forget removed computer -> only removed computer's preview history is cleared
      final container = ProviderContainer(
        overrides: [
          offlineCacheProvider.overrideWithValue(cache),
          computersProvider.overrideWith(
            () => Computers(preferences: _InstalledPrefs()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(computersProvider.future);
      await container.read(computersProvider.notifier).remember(removed);
      await container.read(computersProvider.notifier).remember(kept);
      // Re-record after remember() (remember clears stale pre-pair data for new computers)
      await PreviewHistoryStorage(removed.computerKey).record('http://localhost:5173/');
      await PreviewHistoryStorage(kept.computerKey).record('http://localhost:3000/');

      expect(
        await container.read(computersProvider.notifier).forget(removed),
        isTrue,
      );
      expect(await PreviewHistoryStorage(removed.computerKey).read(), isEmpty);
      expect(
        await PreviewHistoryStorage(kept.computerKey).read(),
        ['http://localhost:3000/'],
      );
    });
  });

  group('MobileWorkbenchScreen 能力位裁剪与 3 分段切换', () {
    testWidgets('shows all 3 tabs when both workbench.read and preview.tunnel are supported', (tester) async {
      final host = _FakeHost(
        onPreviewStatus: (_) async => const MobilePreviewStatus(
          enabled: true,
          desktopUrls: ['http://localhost:5173/'],
        ),
      );
      final conn = _PreviewTestConnection(
        host: host,
        supportsWorkbenchRead: true,
        supportsPreviewTunnel: true,
      );

      await tester.pumpWidget(
        _wrapApp(
          MobileWorkspace(
            connection: conn,
            connected: true,
            connectionLabel: '已连接',
            reconnect: () {},
            onComputers: () {},
            computer: conn.computer,
            deviceId: conn.deviceId,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final workbenchBtn = find.byKey(
        const ValueKey('workspace-workbench-button'),
      );
      expect(workbenchBtn, findsOneWidget);

      await tester.tap(workbenchBtn);
      await tester.pumpAndSettle();

      expect(find.byKey(MobileWorkbenchScreen.filesTabKey), findsOneWidget);
      expect(find.byKey(MobileWorkbenchScreen.prTabKey), findsOneWidget);
      expect(find.byKey(MobileWorkbenchScreen.previewTabKey), findsOneWidget);

      await tester.tap(find.byKey(MobileWorkbenchScreen.previewTabKey));
      await tester.pumpAndSettle();
      expect(find.text('电脑窗口正在预览'), findsOneWidget);
      expect(find.text('localhost:5173'), findsOneWidget);
    });

    testWidgets('shows workbench button with only preview tab when computer only supports preview.tunnel', (tester) async {
      final host = _FakeHost(
        onPreviewStatus: (_) async => const MobilePreviewStatus(
          enabled: true,
          desktopUrls: ['http://localhost:4000/'],
        ),
      );
      final conn = _PreviewTestConnection(
        host: host,
        supportsWorkbenchRead: false,
        supportsPreviewTunnel: true,
      );

      await tester.pumpWidget(
        _wrapApp(
          MobileWorkspace(
            connection: conn,
            connected: true,
            connectionLabel: '已连接',
            reconnect: () {},
            onComputers: () {},
            computer: conn.computer,
            deviceId: conn.deviceId,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final workbenchBtn = find.byKey(
        const ValueKey('workspace-workbench-button'),
      );
      expect(workbenchBtn, findsOneWidget);

      await tester.tap(workbenchBtn);
      await tester.pumpAndSettle();

      expect(find.byKey(MobileWorkbenchScreen.filesTabKey), findsNothing);
      expect(find.byKey(MobileWorkbenchScreen.prTabKey), findsNothing);
      expect(find.byKey(MobileWorkbenchScreen.previewTabKey), findsOneWidget);
      expect(find.text('localhost:4000'), findsOneWidget);
    });
  });

  group('PreviewTab 分组、开关提示、端口直开与历史清理', () {
    testWidgets('renders disabled banner, deduplicated 3 sections, history delete/clear, and port launch', (tester) async {
      final history = PreviewHistoryStorage('computer-preview-tab-test');
      await history.record('http://localhost:5173/'); // duplicate of desktop
      await history.record('http://localhost:8080/admin');
      await history.record('http://localhost:9000/docs');

      final host = _FakeHost(
        onPreviewStatus: (_) async => const MobilePreviewStatus(
          enabled: false,
          desktopUrls: ['http://localhost:5173'],
        ),
      );
      final conn = _PreviewTestConnection(host: host);

      final openedTargets = <Uri>[];
      await tester.pumpWidget(
        _wrapApp(
          Scaffold(
            body: PreviewTab(
              connection: conn,
              threadId: 'thread-1',
              historyStorage: history,
              timelineUrls: const [
                'http://localhost:5173/',
                'http://localhost:3000/dashboard',
              ],
              onOpenPreviewUrl: (uri) async => openedTargets.add(uri),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Disabled warning card
      expect(find.byKey(PreviewTab.disabledBannerKey), findsOneWidget);
      expect(
        find.text('电脑端已关闭手机本机预览，请在电脑「设置 → 手机连接」中开启。'),
        findsOneWidget,
      );

      // 3 groups deduplicated (localhost:5173 only appears once in desktop section)
      expect(find.text('电脑窗口正在预览'), findsOneWidget);
      expect(find.text('当前会话发现的本机地址'), findsOneWidget);
      expect(find.text('最近预览历史'), findsOneWidget);
      expect(find.text('localhost:5173'), findsOneWidget);
      expect(find.text('localhost:3000/dashboard'), findsOneWidget);
      expect(find.text('localhost:9000/docs'), findsOneWidget);
      expect(find.text('localhost:8080/admin'), findsOneWidget);

      // Invalid input shows Chinese error
      await tester.enterText(find.byKey(PreviewTab.urlInputKey), 'https://evil.com');
      await tester.tap(find.byKey(PreviewTab.openButtonKey));
      await tester.pumpAndSettle();
      expect(find.byKey(PreviewTab.inputErrorKey), findsOneWidget);
      expect(openedTargets, isEmpty);

      // Pure port input opens normalized URL
      await tester.enterText(find.byKey(PreviewTab.urlInputKey), '5174');
      await tester.tap(find.byKey(PreviewTab.openButtonKey));
      await tester.pumpAndSettle();
      expect(openedTargets, [Uri.parse('http://localhost:5174/')]);

      // Delete single history item
      await tester.tap(
        find.byKey(const ValueKey('preview-history-delete-http://localhost:9000/docs')),
      );
      await tester.pumpAndSettle();
      expect(find.text('localhost:9000/docs'), findsNothing);

      // Clear remaining history
      await tester.tap(find.byKey(PreviewTab.clearHistoryButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('最近预览历史'), findsNothing);
      expect(await history.read(), isEmpty);
    });
  });

  group('MobilePreviewWebViewScreen 顶栏真实地址、错误态重试与外部跳转确认', () {
    testWidgets('shows real target address without proxy port, handles error+retry, external confirm, and closes proxy on dispose', (tester) async {
      String? copiedText;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            if (call.method == 'Clipboard.setData') {
              final args = call.arguments as Map<dynamic, dynamic>;
              copiedText = args['text'] as String?;
            }
            return null;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding
            .instance
            .defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null),
      );

      final host = _FakeHost();
      final doneCompleter = Completer<void>();
      final conn = _PreviewTestConnection(
        host: host,
        doneCompleter: doneCompleter,
      );

      PreviewWebViewHost? capturedHost;
      void Function(PreviewProxyError)? capturedOnProxyError;
      final fakeController = _FakeWebViewController()
        ..backEnabled = true
        ..forwardEnabled = false;
      final openedExternal = <Uri>[];

      await tester.pumpWidget(
        _wrapApp(
          MobilePreviewWebViewScreen(
            connection: conn,
            initialUrl: Uri.parse('http://localhost:5173/dashboard'),
            openExternalUrl: (uri) async {
              openedExternal.add(uri);
              return true;
            },
            proxyFactory: ({
              required connection,
              required onExternalNavigation,
              required onProxyError,
            }) {
              capturedOnProxyError = onProxyError;
              return LocalPreviewProxy.forConnection(
                connection,
                onExternalNavigation: onExternalNavigation,
                onProxyError: onProxyError,
              );
            },
            webViewBuilder: (context, webHost) {
              capturedHost = webHost;
              webHost.onAttachController(fakeController);
              return const Center(child: Text('FakeWebViewSurface'));
            },
          ),
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();

      expect(capturedHost, isNotNull);
      expect(capturedOnProxyError, isNotNull);
      final proxyEntry = capturedHost!.proxyEntryUri;
      expect(proxyEntry.host, '127.0.0.1');
      expect(proxyEntry.port, greaterThan(0));

      // Verify the local proxy socket is actively listening while screen is open
      await tester.runAsync(() async {
        final socket = await Socket.connect(
          InternetAddress.loopbackIPv4,
          proxyEntry.port,
        );
        await socket.close();
      });

      // Top bar displays real target address, never exposing 127.0.0.1:<proxyPort>
      expect(find.text('localhost:5173/dashboard'), findsOneWidget);
      expect(find.textContaining('${proxyEntry.port}'), findsNothing);

      // Simulate navigating to /login?tab=1 inside proxy
      capturedHost!.onPageFinished(
        'http://127.0.0.1:${proxyEntry.port}/login?tab=1',
      );
      await tester.pumpAndSettle();
      expect(find.text('localhost:5173/login?tab=1'), findsOneWidget);

      // Copy real address copies real localhost URL
      await tester.tap(find.byKey(MobilePreviewWebViewScreen.copyUrlButtonKey));
      await tester.pumpAndSettle();
      expect(copiedText, 'http://localhost:5173/login?tab=1');

      // Back button drives controller
      await tester.tap(find.byKey(MobilePreviewWebViewScreen.backButtonKey));
      await tester.pumpAndSettle();
      expect(fakeController.goBackCalls, 1);

      // Proxy error PREVIEW_UNREACHABLE shows native Chinese error overlay
      capturedOnProxyError!(
        previewErrorFromException(
          const MobileRpcFailure(
            MobileRpcProblem(
              code: 'PREVIEW_UNREACHABLE',
              message: 'ECONNREFUSED',
            ),
          ),
          requestUri: Uri.parse('http://localhost:5173/login?tab=1'),
          isDocumentRequest: true,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(MobilePreviewWebViewScreen.errorOverlayKey), findsOneWidget);
      expect(find.text('无法连接电脑本机服务'), findsOneWidget);

      // Tap retry -> clears error overlay and calls loadRequest on WebView
      await tester.tap(find.byKey(MobilePreviewWebViewScreen.retryButtonKey));
      await tester.pumpAndSettle();
      expect(find.byKey(MobilePreviewWebViewScreen.errorOverlayKey), findsNothing);
      expect(fakeController.loadedRequests, isNotEmpty);

      // External navigation triggers confirmation dialog
      final allowExternal = capturedHost!.onNavigationRequest(
        Uri.parse('https://github.com/pigcode'),
        isMainFrame: true,
      );
      expect(allowExternal, isFalse);
      await tester.pumpAndSettle();
      expect(find.text('即将离开本机预览，在系统浏览器打开外部链接？'), findsOneWidget);
      await tester.tap(find.text('在浏览器打开'));
      await tester.pumpAndSettle();
      expect(openedExternal, [Uri.parse('https://github.com/pigcode')]);

      // Connection drop shows disconnected overlay
      doneCompleter.complete();
      await tester.pumpAndSettle();
      expect(find.byKey(MobilePreviewWebViewScreen.errorOverlayKey), findsOneWidget);
      expect(find.text('电脑连接已断开'), findsOneWidget);

      // Dispose screen -> proxy port is closed
      final boundPort = proxyEntry.port;
      await tester.pumpWidget(_wrapApp(const SizedBox.shrink()));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.runAsync(() async {
        await expectLater(
          Socket.connect(InternetAddress.loopbackIPv4, boundPort),
          throwsA(isA<SocketException>()),
        );
      });
    });
  });

  group('时间线 localhost 链接直达与公网外链确认', () {
    testWidgets('opens MobilePreviewWebViewScreen when tapping localhost link online and shows notices offline/legacy', (tester) async {
      final timeline = TimelineSnapshot(
        events: const [
          MobileTimelineEvent(
            seq: 1,
            runId: 'r1',
            kind: MobileTimelineKind.messageAssistant,
            text:
                '[打开本地预览](http://localhost:5173/app)\n\n'
                '[Vitest 文档](https://vitest.dev/guide/)',
            createdAt: '2026-11-25T15:00:00Z',
          ),
          MobileTimelineEvent(
            seq: 2,
            runId: 'r1',
            kind: MobileTimelineKind.runCompleted,
            createdAt: '2026-11-25T15:00:01Z',
          ),
        ],
        through: 2,
        cursor: 2,
        nextBefore: null,
        live: null,
      );

      final host = _FakeHost();
      final onlineConn = _PreviewTestConnection(
        host: host,
        supportsPreviewTunnel: true,
        timeline: timeline,
      );
      final externalOpened = <Uri>[];

      // 1. Online + preview.tunnel supported -> tapping localhost link opens MobilePreviewWebViewScreen
      await tester.pumpWidget(
        _wrapApp(
          Scaffold(
            body: TimelinePane(
              connection: onlineConn,
              threadId: 'thread-1',
              online: true,
              openExternalUrl: (uri) async {
                externalOpened.add(uri);
                return true;
              },
              previewWebViewBuilder: (_, _) =>
                  const Center(child: Text('InlinePreviewWebView')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('打开本地预览', findRichText: true));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pumpAndSettle();

      expect(find.byType(MobilePreviewWebViewScreen), findsOneWidget);
      expect(find.text('localhost:5173/app'), findsOneWidget);

      // Return to timeline
      await tester.tap(find.byKey(MobilePreviewWebViewScreen.closeButtonKey));
      await tester.pumpAndSettle();
      expect(find.byType(MobilePreviewWebViewScreen), findsNothing);

      // 2. Public http/https link -> pops confirmation dialog and invokes openExternalUrl
      await tester.tap(find.text('Vitest 文档', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.text('打开外部链接'), findsOneWidget);
      await tester.tap(find.text('在浏览器打开'));
      await tester.pumpAndSettle();
      expect(externalOpened, [Uri.parse('https://vitest.dev/guide/')]);

      // 3. Legacy desktop without preview.tunnel -> shows update hint SnackBar
      final legacyConn = _PreviewTestConnection(
        host: host,
        supportsPreviewTunnel: false,
        timeline: timeline,
      );
      await tester.pumpWidget(
        _wrapApp(
          Scaffold(
            body: TimelinePane(
              connection: legacyConn,
              threadId: 'thread-1',
              online: true,
              previewWebViewBuilder: (_, _) =>
                  const Center(child: Text('InlinePreviewWebView')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('打开本地预览', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.byType(MobilePreviewWebViewScreen), findsNothing);
      expect(find.text('请更新电脑上的 Pigcode 后使用本机预览'), findsOneWidget);

      // 4. Offline -> shows offline hint SnackBar
      await tester.pumpWidget(
        _wrapApp(
          Scaffold(
            body: TimelinePane(
              connection: onlineConn,
              threadId: 'thread-1',
              online: false,
              previewWebViewBuilder: (_, _) =>
                  const Center(child: Text('InlinePreviewWebView')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('打开本地预览', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.byType(MobilePreviewWebViewScreen), findsNothing);
      expect(find.text('电脑当前离线，连接后再打开本机预览'), findsOneWidget);
    });
  });
}
