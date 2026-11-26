import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/attachments/image_viewer_page.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_mobile/workbench/file_browser_tab.dart';
import 'package:pigcode_mobile/workbench/file_viewer_screen.dart';
import 'package:pigcode_mobile/workbench/mobile_workbench_screen.dart';
import 'package:pigcode_mobile/workbench/pr_status_tab.dart';
import 'package:pigcode_mobile/workbench/workbench_utils.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

// 1x1 PNG 像素字节，用于测试项目图片只读查看与全屏预览。
final Uint8List _samplePngBytes = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

final _sidebarSnapshot = SidebarSnapshot(
  projects: const [MobileProjectSummary(id: 'proj-1', name: 'Pigcode')],
  threads: const [
    MobileThreadSummary(
      id: 'thread-1',
      projectId: 'proj-1',
      title: '工作台测试会话',
      updatedAt: '2026-11-25T10:00:00.000Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.completed,
      unread: false,
    ),
  ],
  syncedAt: DateTime.utc(2026, 11, 25, 10),
);

class _FakeHost implements HostRequests {
  _FakeHost({
    this.onListDirectory,
    this.onReadFile,
    this.onSearchFiles,
    this.onSearchPaths,
    this.onPrStatus,
  });

  final Future<MobileDirectoryListing> Function(Map<String, Object?> params)?
  onListDirectory;
  final Future<MobileFileChunk> Function(Map<String, Object?> params)?
  onReadFile;
  final Future<MobileSearchResult> Function(Map<String, Object?> params)?
  onSearchFiles;
  final Future<MobileSearchPathsResult> Function(Map<String, Object?> params)?
  onSearchPaths;
  final Future<MobilePrStatusResult> Function(Map<String, Object?> params)?
  onPrStatus;

  final List<({String method, Map<String, Object?> params})> calls = [];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileWorkbenchMethods.list:
        if (onListDirectory != null) {
          return (await onListDirectory!(params)).toJson();
        }
        return const MobileDirectoryListing(
          path: '',
          entries: [],
          truncated: false,
        ).toJson();
      case MobileWorkbenchMethods.readFile:
        if (onReadFile != null) {
          return (await onReadFile!(params)).toJson();
        }
        throw const MobileRpcFailure(
          MobileRpcProblem(
            code: 'RESOURCE_NOT_AVAILABLE',
            message: 'Not found',
          ),
        );
      case MobileWorkbenchMethods.search:
        if (onSearchFiles != null) {
          return (await onSearchFiles!(params)).toJson();
        }
        return MobileSearchResult(
          query: (params['query'] as String?) ?? '',
          matches: const [],
          truncated: false,
        ).toJson();
      case MobileMentionMethods.searchPaths:
        if (onSearchPaths != null) {
          return (await onSearchPaths!(params)).toJson();
        }
        return const MobileSearchPathsResult(
          entries: [],
          truncated: false,
        ).toJson();
      case MobileWorkbenchMethods.prStatus:
        if (onPrStatus != null) {
          return (await onPrStatus!(params)).toJson();
        }
        return const MobilePrStatusResult(
          status: 'no-pr',
          branch: 'main',
        ).toJson();
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

class _WorkbenchConnection implements MobileConnection {
  _WorkbenchConnection({
    required _FakeHost host,
    this.supportsWorkbenchRead = true,
    TimelineSnapshot? timeline,
  }) : _host = host,
       _timeline =
           timeline ??
           TimelineSnapshot(
             events: const [],
             through: 0,
             cursor: 0,
             nextBefore: null,
             live: null,
           ),
       workbench = MobileWorkbenchCommands(
         host,
         supportsWorkbenchRead: supportsWorkbenchRead,
       ),
       mentions = MobileMentionCommands(host),
       queue = MobileQueueCommands(host),
       changes = MobileRunChanges(host);

  final _FakeHost _host;
  final TimelineSnapshot _timeline;

  _FakeHost get host => _host;

  @override
  final bool supportsWorkbenchRead;

  @override
  final MobileWorkbenchCommands workbench;

  @override
  final MobileMentionCommands mentions;

  @override
  final MobileQueueCommands queue;

  @override
  final MobileRunChanges changes;

  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'test-token',
    computerKey: base64Url.encode(List<int>.filled(32, 7)).replaceAll('=', ''),
    name: '测试电脑',
  );

  @override
  final done = Completer<void>().future;

  @override
  String get computerName => '测试电脑';

  @override
  String get deviceId => 'device-test';

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

class _LegacyStubConnection implements MobileConnection {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _wrapApp(Widget child, {Brightness brightness = Brightness.light}) =>
    ProviderScope(
      child: MaterialApp(
        theme: pigcodeTheme(brightness),
        builder: (context, inner) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: inner!,
        ),
        home: child,
      ),
    );

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  group('workbench utils', () {
    test('connectionSupportsWorkbenchRead degrades safely on legacy stub', () {
      expect(connectionSupportsWorkbenchRead(null), isFalse);
      expect(connectionSupportsWorkbenchRead(_LegacyStubConnection()), isFalse);
    });

    test('parseFileReference handles mentions, line numbers and formats', () {
      expect(parseFileReference('@lib/main.dart:42'), (
        path: 'lib/main.dart',
        line: 42,
      ));
      expect(parseFileReference('main.dart:18:4'), (
        path: 'main.dart',
        line: 18,
      ));
      expect(parseFileReference('./docs/guide.md#L7'), (
        path: 'docs/guide.md',
        line: 7,
      ));
      expect(parseFileReference('src\\app\\index.ts'), (
        path: 'src/app/index.ts',
        line: null,
      ));
    });

    test('formatFileSize formats bytes, KB and MB cleanly', () {
      expect(formatFileSize(512), '512 B');
      expect(formatFileSize(3277), '3.2 KB');
      expect(formatFileSize(1024 * 1024), '1 MB');
    });
  });

  group('Header 工作台按钮显隐与入口', () {
    testWidgets(
      'shows workbench button when online & supported, opens screen, and hides in draft/offline/legacy',
      (tester) async {
        final host = _FakeHost(
          onListDirectory: (_) async => const MobileDirectoryListing(
            path: '',
            entries: [
              MobileDirectoryEntry(
                path: 'README.md',
                name: 'README.md',
                kind: 'file',
                size: 120,
              ),
            ],
            truncated: false,
          ),
        );
        final supportedConn = _WorkbenchConnection(
          host: host,
          supportsWorkbenchRead: true,
        );

        await tester.pumpWidget(
          _wrapApp(
            MobileWorkspace(
              connection: supportedConn,
              connected: true,
              connectionLabel: '已连接',
              reconnect: () {},
              onComputers: () {},
              computer: supportedConn.computer,
              deviceId: supportedConn.deviceId,
            ),
          ),
        );
        await tester.pumpAndSettle();

        final workbenchBtn = find.byKey(
          const ValueKey('workspace-workbench-button'),
        );
        expect(workbenchBtn, findsOneWidget);
        expect(tester.getSize(workbenchBtn).width, greaterThanOrEqualTo(44));
        expect(tester.getSize(workbenchBtn).height, greaterThanOrEqualTo(44));

        // 点按进入全屏工作台并展示文件目录。
        await tester.tap(workbenchBtn);
        await tester.pumpAndSettle();
        expect(find.byType(MobileWorkbenchScreen), findsOneWidget);
        expect(find.text('README.md'), findsOneWidget);
        expect(find.byKey(MobileWorkbenchScreen.filesTabKey), findsOneWidget);
        expect(find.byKey(MobileWorkbenchScreen.prTabKey), findsOneWidget);
        expect(find.byKey(MobileWorkbenchScreen.previewTabKey), findsNothing);

        // 返回会话页，进入新会话草稿时隐藏工作台按钮。
        await tester.tap(find.byTooltip('返回'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('新会话'));
        await tester.pumpAndSettle();
        expect(workbenchBtn, findsNothing);

        // 离线时隐藏工作台按钮。
        await tester.pumpWidget(
          _wrapApp(
            MobileWorkspace(
              connection: supportedConn,
              connected: false,
              connectionLabel: '电脑离线',
              reconnect: () {},
              onComputers: () {},
              computer: supportedConn.computer,
              deviceId: supportedConn.deviceId,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(workbenchBtn, findsNothing);

        // 连接不支持 workbench.read 的旧版电脑时隐藏工作台按钮。
        final legacyConn = _WorkbenchConnection(
          host: host,
          supportsWorkbenchRead: false,
        );
        await tester.pumpWidget(
          _wrapApp(
            MobileWorkspace(
              connection: legacyConn,
              connected: true,
              connectionLabel: '已连接',
              reconnect: () {},
              onComputers: () {},
              computer: legacyConn.computer,
              deviceId: legacyConn.deviceId,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(workbenchBtn, findsNothing);
      },
    );

    testWidgets(
      'supports optional previewTabBuilder slot and preserves tab state via IndexedStack',
      (tester) async {
        var prLoads = 0;
        final host = _FakeHost(
          onListDirectory: (params) async {
            final path = (params['path'] as String?) ?? '';
            if (path == 'lib') {
              return const MobileDirectoryListing(
                path: 'lib',
                entries: [
                  MobileDirectoryEntry(
                    path: 'lib/app.dart',
                    name: 'app.dart',
                    kind: 'file',
                    size: 512,
                  ),
                ],
                truncated: false,
              );
            }
            return const MobileDirectoryListing(
              path: '',
              entries: [
                MobileDirectoryEntry(
                  path: 'lib',
                  name: 'lib',
                  kind: 'directory',
                ),
              ],
              truncated: false,
            );
          },
          onPrStatus: (_) async {
            prLoads++;
            return const MobilePrStatusResult(
              status: 'no-pr',
              branch: 'feat/preview',
            );
          },
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            MobileWorkbenchScreen(
              connection: conn,
              threadId: 'thread-1',
              initialTab: MobileWorkbenchTab.preview,
              previewTabBuilder: (_) => const Center(child: Text('本机预览占位页')),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(MobileWorkbenchScreen.previewTabKey), findsOneWidget);
        expect(find.text('本机预览占位页'), findsOneWidget);
        expect(prLoads, 0);

        // 切到「文件」并进入 lib 目录。
        await tester.tap(find.byKey(MobileWorkbenchScreen.filesTabKey));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('workbench-entry-lib')));
        await tester.pumpAndSettle();
        expect(find.text('app.dart'), findsOneWidget);

        // 切到「PR」触发首次加载，再切回「文件」保持目录位置，再切回「PR」不重复请求。
        await tester.tap(find.byKey(MobileWorkbenchScreen.prTabKey));
        await tester.pumpAndSettle();
        expect(prLoads, 1);
        expect(find.text('feat/preview'), findsOneWidget);

        await tester.tap(find.byKey(MobileWorkbenchScreen.filesTabKey));
        await tester.pumpAndSettle();
        expect(find.text('app.dart'), findsOneWidget);

        await tester.tap(find.byKey(MobileWorkbenchScreen.prTabKey));
        await tester.pumpAndSettle();
        expect(prLoads, 1);
      },
    );
  });

  group('文件 Tab：目录树、面包屑、分页、忽略项与双模式搜索', () {
    testWidgets(
      'navigates breadcrumbs, paginates entries, styles ignored & symlink entries',
      (tester) async {
        var rootListCalls = 0;
        final host = _FakeHost(
          onListDirectory: (params) async {
            final path = (params['path'] as String?) ?? '';
            final offset = (params['offset'] as int?) ?? 0;
            if (path.isEmpty && offset == 0) {
              rootListCalls++;
              return const MobileDirectoryListing(
                path: '',
                entries: [
                  MobileDirectoryEntry(
                    path: 'src',
                    name: 'src',
                    kind: 'directory',
                  ),
                  MobileDirectoryEntry(
                    path: 'build',
                    name: 'build',
                    kind: 'directory',
                    ignored: true,
                  ),
                  MobileDirectoryEntry(
                    path: 'latest.log',
                    name: 'latest.log',
                    kind: 'file',
                    symlink: true,
                    size: 3277,
                  ),
                ],
                truncated: true,
                nextOffset: 3,
              );
            }
            if (path.isEmpty && offset == 3) {
              return const MobileDirectoryListing(
                path: '',
                entries: [
                  MobileDirectoryEntry(
                    path: 'pubspec.yaml',
                    name: 'pubspec.yaml',
                    kind: 'file',
                    size: 640,
                  ),
                ],
                truncated: false,
              );
            }
            if (path == 'src') {
              return const MobileDirectoryListing(
                path: 'src',
                entries: [
                  MobileDirectoryEntry(
                    path: 'src/mobile',
                    name: 'mobile',
                    kind: 'directory',
                  ),
                ],
                truncated: false,
              );
            }
            if (path == 'src/mobile') {
              return const MobileDirectoryListing(
                path: 'src/mobile',
                entries: [
                  MobileDirectoryEntry(
                    path: 'src/mobile/main.dart',
                    name: 'main.dart',
                    kind: 'file',
                    size: 2048,
                  ),
                ],
                truncated: false,
              );
            }
            return const MobileDirectoryListing(
              path: '',
              entries: [],
              truncated: false,
            );
          },
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            MobileWorkbenchScreen(
              connection: conn,
              threadId: 'thread-1',
              searchDebounce: Duration.zero,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('根目录'), findsOneWidget);
        expect(find.text('src'), findsOneWidget);
        expect(find.text('3.2 KB'), findsOneWidget);

        // .gitignore 忽略条目使用弱化透明度（0.5）。
        final ignoredRow = find.byKey(const ValueKey('workbench-entry-build'));
        final opacityWidget = tester.widget<Opacity>(
          find.descendant(of: ignoredRow, matching: find.byType(Opacity)),
        );
        expect(opacityWidget.opacity, 0.5);

        // 符号链接条目带链接小标记。
        final symlinkRow = find.byKey(
          const ValueKey('workbench-entry-latest.log'),
        );
        expect(
          find.descendant(
            of: symlinkRow,
            matching: find.byIcon(Icons.link_rounded),
          ),
          findsOneWidget,
        );

        // 点击「加载更多」追加第二页条目。
        await tester.tap(find.byKey(FileBrowserTab.loadMoreKey));
        await tester.pumpAndSettle();
        expect(find.text('pubspec.yaml'), findsOneWidget);
        expect(find.byKey(FileBrowserTab.loadMoreKey), findsNothing);

        // 逐级进入 src -> mobile，再点击面包屑「根目录」直接跳回（命中缓存不重新请求）。
        await tester.tap(find.byKey(const ValueKey('workbench-entry-src')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('workbench-entry-src/mobile')),
        );
        await tester.pumpAndSettle();
        expect(find.text('main.dart'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('workbench-crumb-src')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('workbench-crumb-src/mobile')),
          findsOneWidget,
        );

        await tester.tap(find.byKey(const ValueKey('workbench-crumb-root')));
        await tester.pumpAndSettle();
        expect(find.text('pubspec.yaml'), findsOneWidget);
        expect(rootListCalls, 1);
      },
    );

    testWidgets(
      'supports filename search and content search jumping to highlighted target line',
      (tester) async {
        final codeLines = [
          for (var i = 1; i <= 50; i++)
            i == 42
                ? "const targetToken = 'pigcode_hit';"
                : 'final line$i = $i;',
        ].join('\n');

        final host = _FakeHost(
          onSearchPaths: (params) async {
            expect(params['query'], 'main');
            return const MobileSearchPathsResult(
              entries: [
                MobilePathEntry(
                  path: 'lib/app/main.dart',
                  kind: MobilePathEntryKind.file,
                ),
              ],
              truncated: false,
            );
          },
          onSearchFiles: (params) async {
            expect(params['query'], 'targetToken');
            return const MobileSearchResult(
              query: 'targetToken',
              matches: [
                MobileSearchMatch(
                  path: 'lib/app/main.dart',
                  line: 42,
                  preview: "const targetToken = 'pigcode_hit';",
                ),
              ],
              truncated: false,
            );
          },
          onReadFile: (params) async => MobileFileChunk(
            path: params['path'] as String,
            mode: 'text',
            totalSize: codeLines.length,
            binary: false,
            truncated: false,
            text: codeLines,
            eol: 'lf',
            languageHint: 'dart',
          ),
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            MobileWorkbenchScreen(
              connection: conn,
              threadId: 'thread-1',
              searchDebounce: const Duration(milliseconds: 50),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 1. 文件名搜索
        await tester.enterText(
          find.byKey(FileBrowserTab.searchInputKey),
          'main',
        );
        await tester.pump(const Duration(milliseconds: 80));
        await tester.pumpAndSettle();

        expect(find.text('main.dart'), findsOneWidget);
        expect(find.text('lib/app'), findsOneWidget);

        await tester.tap(
          find.byKey(const ValueKey('workbench-path-result-lib/app/main.dart')),
        );
        await tester.pumpAndSettle();
        expect(find.byType(MobileFileViewerScreen), findsOneWidget);
        expect(find.text('lib/app/main.dart'), findsOneWidget);

        await tester.tap(find.byTooltip('返回'));
        await tester.pumpAndSettle();

        // 2. 切到代码内容搜索，点中结果后直达第 42 行并高亮
        await tester.tap(find.byKey(FileBrowserTab.contentModeKey));
        await tester.enterText(
          find.byKey(FileBrowserTab.searchInputKey),
          'targetToken',
        );
        await tester.pump(const Duration(milliseconds: 80));
        await tester.pumpAndSettle();

        expect(find.text(':42'), findsOneWidget);
        await tester.tap(
          find.byKey(
            const ValueKey('workbench-content-result-lib/app/main.dart:42'),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byType(MobileFileViewerScreen), findsOneWidget);
        final targetLineFinder = find.byKey(
          const ValueKey('file-viewer-line-42'),
        );
        expect(targetLineFinder, findsOneWidget);
        final targetContainer = tester.widget<Container>(
          find
              .ancestor(of: targetLineFinder, matching: find.byType(Container))
              .first,
        );
        expect(targetContainer.decoration, isA<BoxDecoration>());
        expect((targetContainer.decoration! as BoxDecoration).color, isNotNull);
      },
    );
  });

  group('只读文件查看器（源码/大文件/Markdown/图片/二进制）', () {
    testWidgets(
      'renders highlighted source, toggles wrap, loads more chunks, and shows 1MB cap banner',
      (tester) async {
        final host = _FakeHost(
          onReadFile: (params) async {
            final offset = (params['offset'] as int?) ?? 0;
            if (offset == 0) {
              return const MobileFileChunk(
                path: 'lib/service.dart',
                mode: 'text',
                totalSize: 2 * 1024 * 1024,
                binary: false,
                truncated: true,
                text: 'void main() {\n  print("chunk-1");\n}',
                eol: 'lf',
                languageHint: 'dart',
                nextOffset: 35,
              );
            }
            return const MobileFileChunk(
              path: 'lib/service.dart',
              mode: 'text',
              totalSize: 2 * 1024 * 1024,
              binary: false,
              truncated: true,
              text: '\n// chunk-2-appended',
              eol: 'lf',
              languageHint: 'dart',
            );
          },
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            MobileFileViewerScreen(
              connection: conn,
              threadId: 'thread-1',
              path: 'lib/service.dart',
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 超过 1 MiB 显示截断提示条。
        expect(find.text('文件较大，仅展示前 1 MB 内容'), findsOneWidget);
        expect(find.text('service.dart'), findsOneWidget);
        expect(find.text('lib/service.dart'), findsOneWidget);

        // 自动换行 -> 横向滚动切换。
        expect(find.byTooltip('切换为横向滚动'), findsOneWidget);
        await tester.tap(find.byKey(MobileFileViewerScreen.wrapToggleKey));
        await tester.pumpAndSettle();
        expect(find.byTooltip('切换为自动换行'), findsOneWidget);

        // 点击「加载更多」追加第二片。
        expect(find.textContaining('加载更多（已显示'), findsOneWidget);
        await tester.tap(find.byKey(MobileFileViewerScreen.loadMoreKey));
        await tester.pumpAndSettle();
        expect(find.textContaining('chunk-2-appended'), findsOneWidget);
        expect(find.byKey(MobileFileViewerScreen.loadMoreKey), findsNothing);
      },
    );

    testWidgets(
      'Markdown defaults to preview, toggles to source, and opens source when initialLine is set',
      (tester) async {
        const md = '# 标题一\n\n这是 **Markdown** 段落。\n\n第三行内容。';
        final host = _FakeHost(
          onReadFile: (_) async => MobileFileChunk(
            path: 'docs/README.md',
            mode: 'text',
            totalSize: md.length,
            binary: false,
            truncated: false,
            text: md,
            eol: 'lf',
            languageHint: 'markdown',
          ),
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            MobileFileViewerScreen(
              connection: conn,
              threadId: 'thread-1',
              path: 'docs/README.md',
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 默认预览态渲染 GptMarkdown，按钮文案为「源码」。
        expect(find.byType(GptMarkdown), findsOneWidget);
        expect(find.text('源码'), findsOneWidget);

        // 切到源码态显示行号与原始 Markdown 语法。
        await tester.tap(find.byKey(MobileFileViewerScreen.markdownToggleKey));
        await tester.pumpAndSettle();
        expect(find.byType(GptMarkdown), findsNothing);
        expect(find.text('预览'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('file-viewer-line-1')),
          findsOneWidget,
        );

        // 带 initialLine 跳入时默认切到源码并高亮对应行。
        await tester.pumpWidget(
          _wrapApp(
            MobileFileViewerScreen(
              connection: conn,
              threadId: 'thread-1',
              path: 'docs/README.md',
              initialLine: 3,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(GptMarkdown), findsNothing);
        expect(
          find.byKey(const ValueKey('file-viewer-line-3')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'renders project image with InteractiveViewer and opens fullscreen preview',
      (tester) async {
        final encoded = base64Encode(_samplePngBytes);
        final host = _FakeHost(
          onReadFile: (params) async => MobileFileChunk(
            path: 'assets/logo.png',
            mode: 'image',
            totalSize: _samplePngBytes.length,
            binary: true,
            truncated: false,
            mimeType: 'image/png',
            dataBase64: encoded,
            width: 1,
            height: 1,
          ),
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            MobileFileViewerScreen(
              connection: conn,
              threadId: 'thread-1',
              path: 'assets/logo.png',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byType(InteractiveViewer), findsOneWidget);
        expect(find.byType(Image), findsOneWidget);
        expect(find.textContaining('1 × 1'), findsOneWidget);

        // 点击全屏预览打开黑底 ImageViewerPage。
        await tester.tap(find.byKey(MobileFileViewerScreen.fullscreenImageKey));
        await tester.pumpAndSettle();
        expect(find.byType(ImageViewerPage), findsOneWidget);
      },
    );

    testWidgets('shows friendly notice for binary files without garbled text', (
      tester,
    ) async {
      final host = _FakeHost(
        onReadFile: (_) async => const MobileFileChunk(
          path: 'bin/tool.wasm',
          mode: 'binary',
          totalSize: 4096,
          binary: true,
          truncated: false,
        ),
      );
      final conn = _WorkbenchConnection(host: host);

      await tester.pumpWidget(
        _wrapApp(
          MobileFileViewerScreen(
            connection: conn,
            threadId: 'thread-1',
            path: 'bin/tool.wasm',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('二进制文件暂不支持文本预览'), findsOneWidget);
      expect(find.text('4 KB'), findsOneWidget);
    });
  });

  group('时间线内直达只读源码', () {
    testWidgets(
      'tapping @file:line mention, Read tool row, Edit chip and SummaryGroup chip opens MobileFileViewerScreen',
      (tester) async {
        final openedPaths = <String>[];
        final host = _FakeHost(
          onReadFile: (params) async {
            final path = params['path'] as String;
            openedPaths.add(path);
            if (path.startsWith('/')) {
              throw const MobileRpcFailure(
                MobileRpcProblem(
                  code: 'INVALID_PARAMS',
                  message: 'absolute path not allowed',
                ),
              );
            }
            final body = [
              for (var i = 1; i <= 50; i++) 'line $i in $path',
            ].join('\n');
            return MobileFileChunk(
              path: path,
              mode: 'text',
              totalSize: body.length,
              binary: false,
              truncated: false,
              text: body,
              eol: 'lf',
              languageHint: 'dart',
            );
          },
        );
        final timeline = TimelineSnapshot(
          events: const [
            MobileTimelineEvent(
              seq: 1,
              runId: 'r1',
              kind: MobileTimelineKind.runStarted,
              text: '请看 @lib/main.dart:42 的实现逻辑。',
              createdAt: '2026-11-25T10:00:00Z',
            ),
            MobileTimelineEvent(
              seq: 2,
              runId: 'r1',
              kind: MobileTimelineKind.toolStarted,
              itemId: 'read-1',
              name: 'Read',
              text: '{"file_path":"lib/reader.dart"}',
              createdAt: '2026-11-25T10:00:01Z',
            ),
            MobileTimelineEvent(
              seq: 3,
              runId: 'r1',
              kind: MobileTimelineKind.toolCompleted,
              itemId: 'read-1',
              name: 'Read',
              text: 'ok',
              createdAt: '2026-11-25T10:00:02Z',
            ),
            MobileTimelineEvent(
              seq: 4,
              runId: 'r1',
              kind: MobileTimelineKind.messageAssistant,
              text: '中间说明',
              createdAt: '2026-11-25T10:00:03Z',
            ),
            MobileTimelineEvent(
              seq: 5,
              runId: 'r1',
              kind: MobileTimelineKind.toolStarted,
              itemId: 'e1',
              name: 'Edit',
              text:
                  '{"file_path":"lib/alpha.dart","old_string":"a","new_string":"b"}',
              createdAt: '2026-11-25T10:00:04Z',
            ),
            MobileTimelineEvent(
              seq: 6,
              runId: 'r1',
              kind: MobileTimelineKind.toolCompleted,
              itemId: 'e1',
              name: 'Edit',
              text: '',
              createdAt: '2026-11-25T10:00:04Z',
            ),
            MobileTimelineEvent(
              seq: 7,
              runId: 'r1',
              kind: MobileTimelineKind.toolStarted,
              itemId: 'e2',
              name: 'Edit',
              text:
                  '{"file_path":"lib/beta.dart","old_string":"a","new_string":"b"}',
              createdAt: '2026-11-25T10:00:05Z',
            ),
            MobileTimelineEvent(
              seq: 8,
              runId: 'r1',
              kind: MobileTimelineKind.toolCompleted,
              itemId: 'e2',
              name: 'Edit',
              text: '',
              createdAt: '2026-11-25T10:00:05Z',
            ),
            MobileTimelineEvent(
              seq: 9,
              runId: 'r1',
              kind: MobileTimelineKind.messageAssistant,
              text: '第二段说明',
              createdAt: '2026-11-25T10:00:06Z',
            ),
            MobileTimelineEvent(
              seq: 10,
              runId: 'r1',
              kind: MobileTimelineKind.toolStarted,
              itemId: 'read-outside',
              name: 'Read',
              text: '{"file_path":"/etc/hosts"}',
              createdAt: '2026-11-25T10:00:07Z',
            ),
            MobileTimelineEvent(
              seq: 11,
              runId: 'r1',
              kind: MobileTimelineKind.toolCompleted,
              itemId: 'read-outside',
              name: 'Read',
              text: 'ok',
              createdAt: '2026-11-25T10:00:08Z',
            ),
          ],
          through: 11,
          cursor: 11,
          nextBefore: null,
          live: null,
        );
        final conn = _WorkbenchConnection(host: host, timeline: timeline);

        await tester.pumpWidget(
          _wrapApp(
            Scaffold(
              body: TimelinePane(
                connection: conn,
                threadId: 'thread-1',
                online: true,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 1. 点击用户气泡中的 @lib/main.dart:42 直达源码第 42 行。
        await tester.tap(find.text('main.dart:42'));
        await tester.pumpAndSettle();
        expect(find.byType(MobileFileViewerScreen), findsOneWidget);
        expect(find.text('lib/main.dart'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('file-viewer-line-42')),
          findsOneWidget,
        );
        await tester.tap(find.byTooltip('返回'));
        await tester.pumpAndSettle();

        // 2. 点击独立 Read 工具行中的文件 chip 直达 lib/reader.dart。
        await tester.tap(find.text('reader.dart'));
        await tester.pumpAndSettle();
        expect(find.byType(MobileFileViewerScreen), findsOneWidget);
        expect(find.text('lib/reader.dart'), findsOneWidget);
        await tester.tap(find.byTooltip('返回'));
        await tester.pumpAndSettle();

        // 3. 点击归组摘要中的文件 chip（alpha.dart）直达 lib/alpha.dart。
        await tester.tap(find.text('alpha.dart'));
        await tester.pumpAndSettle();
        expect(find.byType(MobileFileViewerScreen), findsOneWidget);
        expect(find.text('lib/alpha.dart'), findsOneWidget);
        await tester.tap(find.byTooltip('返回'));
        await tester.pumpAndSettle();

        // 4. 点击项目外绝对路径 /etc/hosts，由 Host 拦截并展示清晰中文提示，不崩溃。
        await tester.tap(find.text('hosts'));
        await tester.pumpAndSettle();
        expect(find.byType(MobileFileViewerScreen), findsOneWidget);
        expect(find.text('该文件不在当前项目目录内，无法预览。'), findsOneWidget);
        expect(openedPaths, contains('/etc/hosts'));
        expect(tester.takeException(), isNull);
      },
    );
  });

  group('PR Tab：PR 详情与全部非 PR 状态', () {
    testWidgets(
      'renders ok PR detail with badges, diff stats, review, checks, open-browser and copy-link actions',
      (tester) async {
        final openedUris = <Uri>[];
        String? copiedClipboardText;
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, (call) async {
              if (call.method == 'Clipboard.setData') {
                final args = call.arguments as Map<dynamic, dynamic>;
                copiedClipboardText = args['text'] as String?;
              }
              return null;
            });
        addTearDown(
          () => TestDefaultBinaryMessengerBinding
              .instance
              .defaultBinaryMessenger
              .setMockMethodCallHandler(SystemChannels.platform, null),
        );

        final host = _FakeHost(
          onPrStatus: (_) async => const MobilePrStatusResult(
            status: 'ok',
            branch: 'feat/mobile-workbench',
            pr: MobilePullRequestInfo(
              number: 151,
              title: '手机端只读工作台 UI',
              state: 'OPEN',
              isDraft: false,
              url: 'https://github.com/pigcode/pigcode/pull/151',
              headRefName: 'feat/mobile-workbench',
              baseRefName: 'main',
              additions: 420,
              deletions: 38,
              changedFiles: 9,
              reviewDecision: 'APPROVED',
              checksSummary: MobilePrChecksSummary(
                total: 5,
                passed: 3,
                failed: 1,
                pending: 1,
              ),
            ),
          ),
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            Scaffold(
              body: PrStatusTab(
                connection: conn,
                threadId: 'thread-1',
                openExternalUrl: (uri) async {
                  openedUris.add(uri);
                  return true;
                },
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('OPEN'), findsOneWidget);
        expect(find.text('#151'), findsOneWidget);
        expect(find.text('手机端只读工作台 UI'), findsOneWidget);
        expect(find.text('feat/mobile-workbench'), findsOneWidget);
        expect(find.text('main'), findsOneWidget);
        expect(find.text('+420'), findsOneWidget);
        expect(find.text('-38'), findsOneWidget);
        expect(find.text('· 9 个文件'), findsOneWidget);
        expect(find.text('已批准'), findsOneWidget);
        expect(find.text('3 通过'), findsOneWidget);
        expect(find.text('1 失败'), findsOneWidget);
        expect(find.text('1 运行中'), findsOneWidget);

        await tester.tap(find.byKey(PrStatusTab.openBrowserButtonKey));
        await tester.pumpAndSettle();
        expect(openedUris, [
          Uri.parse('https://github.com/pigcode/pigcode/pull/151'),
        ]);

        await tester.tap(find.byKey(PrStatusTab.copyLinkButtonKey));
        await tester.pumpAndSettle();
        expect(
          copiedClipboardText,
          'https://github.com/pigcode/pigcode/pull/151',
        );
        expect(find.text('已复制 PR 链接'), findsOneWidget);
      },
    );

    for (final testCase in const [
      (status: 'no-pr', branch: 'feat/no-pr-branch', expectedText: '尚未创建 PR'),
      (status: 'not-git', branch: null, expectedText: '当前项目不是 Git 仓库'),
      (status: 'no-remote', branch: 'main', expectedText: '未配置 GitHub 远端'),
      (
        status: 'gh-unavailable',
        branch: 'main',
        expectedText: '电脑未安装 GitHub CLI (gh)',
      ),
      (
        status: 'gh-unauthenticated',
        branch: 'main',
        expectedText: 'gh auth login',
      ),
    ]) {
      testWidgets('renders non-PR status ${testCase.status}', (tester) async {
        final host = _FakeHost(
          onPrStatus: (_) async => MobilePrStatusResult(
            status: testCase.status,
            branch: testCase.branch,
          ),
        );
        final conn = _WorkbenchConnection(host: host);

        await tester.pumpWidget(
          _wrapApp(
            Scaffold(
              body: PrStatusTab(connection: conn, threadId: 'thread-1'),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.textContaining(testCase.expectedText), findsWidgets);
        if (testCase.branch != null) {
          expect(find.text(testCase.branch!), findsOneWidget);
        }
      });
    }
  });
}
