import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/manage/manage_utils.dart';
import 'package:pigcode_mobile/manage/project_directory_picker_screen.dart';
import 'package:pigcode_mobile/manage/project_manage_screen.dart';
import 'package:pigcode_mobile/manage/settings_hub_screen.dart';
import 'package:pigcode_mobile/sidebar_menu.dart';

class _ManageHost implements HostRequests {
  final List<({String method, Map<String, Object?> params})> calls = [];
  List<MobileManagedProject> projects = [
    const MobileManagedProject(
      id: 'pr_1',
      name: 'Pigcode',
      displayPath: '~/Documents/workspace/pigcode',
      createdAt: '2026-11-26T00:00:00.000Z',
      threadCount: 2,
    ),
  ];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileProjectMethods.list:
        return {'projects': projects.map((p) => p.toJson()).toList()};
      case MobileProjectMethods.browseDirs:
        final rel = (params['relPath'] as String?) ?? '';
        if (rel.isEmpty) {
          return const MobileProjectBrowseDirsResult(
            currentRelPath: '',
            displayPath: '~',
            parentRelPath: null,
            shortcuts: [
              MobileProjectShortcut(
                label: '主目录',
                relPath: '',
                displayPath: '~',
              ),
              MobileProjectShortcut(
                label: 'workspace',
                relPath: 'Documents/workspace',
                displayPath: '~/Documents/workspace',
              ),
            ],
            entries: [
              MobileProjectDirEntry(
                name: 'Documents',
                relPath: 'Documents',
                isGitRepo: false,
                alreadyAddedProjectId: null,
                hasChildren: true,
              ),
            ],
            truncated: false,
          ).toJson();
        }
        return MobileProjectBrowseDirsResult(
          currentRelPath: rel,
          displayPath: '~/$rel',
          parentRelPath: '',
          shortcuts: const [
            MobileProjectShortcut(label: '主目录', relPath: '', displayPath: '~'),
            MobileProjectShortcut(
              label: 'workspace',
              relPath: 'Documents/workspace',
              displayPath: '~/Documents/workspace',
            ),
          ],
          entries: [
            const MobileProjectDirEntry(
              name: 'pigcode',
              relPath: 'Documents/workspace/pigcode',
              isGitRepo: true,
              alreadyAddedProjectId: 'pr_1',
              hasChildren: true,
            ),
            const MobileProjectDirEntry(
              name: 'new-repo',
              relPath: 'Documents/workspace/new-repo',
              isGitRepo: true,
              alreadyAddedProjectId: null,
              hasChildren: false,
            ),
          ],
          truncated: false,
        ).toJson();
      case MobileProjectMethods.createDir:
        final parent = (params['parentRelPath'] as String?) ?? '';
        final name = params['name'] as String;
        final rel = parent.isEmpty ? name : '$parent/$name';
        return {
          'entry': {
            'name': name,
            'relPath': rel,
            'isGitRepo': false,
            'alreadyAddedProjectId': null,
            'hasChildren': false,
          },
        };
      case MobileProjectMethods.add:
        final rel = params['relPath'] as String;
        final name = (params['name'] as String?) ?? rel.split('/').last;
        final created = MobileManagedProject(
          id: 'pr_2',
          name: name,
          displayPath: '~/$rel',
          createdAt: '2026-11-26T02:00:00.000Z',
          threadCount: 0,
        );
        projects = [...projects, created];
        return {'project': created.toJson()};
      case MobileProjectMethods.rename:
        final id = params['projectId'] as String;
        final name = params['name'] as String;
        projects = [
          for (final p in projects)
            if (p.id == id)
              MobileManagedProject(
                id: p.id,
                name: name,
                displayPath: p.displayPath,
                createdAt: p.createdAt,
                threadCount: p.threadCount,
              )
            else
              p,
        ];
        return {'project': projects.firstWhere((p) => p.id == id).toJson()};
      case MobileProjectMethods.remove:
        final id = params['projectId'] as String;
        projects = projects.where((p) => p.id != id).toList();
        return {'removed': true, 'projectId': id};
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _FakeManageConnection implements MobileConnection {
  _FakeManageConnection(
    HostRequests host, {
    this.supportsProjectManage = true,
    this.supportsAgentManage = true,
  }) : projects = MobileProjectManageClient(
         host,
         supportsProjectManage: supportsProjectManage,
       ),
       agents = MobileAgentManageClient(
         host,
         supportsAgentManage: supportsAgentManage,
       );

  @override
  String get computerName => 'TestMac';
  @override
  final bool supportsProjectManage;
  @override
  final bool supportsAgentManage;
  @override
  final MobileProjectManageClient projects;
  @override
  final MobileAgentManageClient agents;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _app(Widget home) =>
    MaterialApp(theme: pigcodeTheme(Brightness.light), home: home);

void main() {
  testWidgets(
    'SettingsHubScreen navigates to ProjectManageScreen, adds, renames, removes, and survives reconnect',
    (tester) async {
      final host1 = _ManageHost();
      final host2 = _ManageHost();
      final conn1 = _FakeManageConnection(host1);
      final conn2 = _FakeManageConnection(host2);
      final notifier = ValueNotifier<MobileConnection?>(conn1);
      addTearDown(notifier.dispose);

      var remindersOpened = false;
      await tester.pumpWidget(
        _app(
          SettingsHubScreen(
            connectionListenable: notifier,
            computerName: 'TestMac',
            onOpenReminders: () => remindersOpened = true,
            onComputers: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Reminders row triggers callback.
      await tester.tap(find.byKey(SettingsHubScreen.remindersTileKey));
      expect(remindersOpened, isTrue);

      // Navigate into ProjectManageScreen.
      await tester.tap(find.byKey(SettingsHubScreen.projectsTileKey));
      await tester.pumpAndSettle();
      expect(find.text('Pigcode'), findsOneWidget);
      expect(
        find.textContaining('~/Documents/workspace/pigcode'),
        findsOneWidget,
      );

      // Open directory picker, tap shortcut, quick-add new-repo with custom name.
      await tester.tap(find.byKey(ProjectManageScreen.addButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(
          ProjectDirectoryPickerScreen.shortcutKey('Documents/workspace'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Git'), findsWidgets);
      expect(find.text('已添加'), findsOneWidget);

      await tester.tap(
        find.byKey(
          ProjectDirectoryPickerScreen.quickAddKey(
            'Documents/workspace/new-repo',
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('project-add-name-input')),
        '新仓库',
      );
      await tester.tap(find.byKey(const ValueKey('project-add-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('新仓库'), findsOneWidget);

      // Rename the added project.
      await tester.tap(find.byKey(ProjectManageScreen.projectTileKey('pr_2')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('重命名项目'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('project-rename-input')),
        '新仓库改名',
      );
      await tester.tap(find.byKey(const ValueKey('project-rename-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('新仓库改名'), findsOneWidget);

      // Remove project with confirmation.
      await tester.tap(find.byKey(ProjectManageScreen.projectTileKey('pr_2')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('从列表移除'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('project-remove-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('新仓库改名'), findsNothing);

      // Disconnect -> offline banner appears; reconnect -> clears & reloads via host2.
      notifier.value = null;
      await tester.pump();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsOneWidget);
      notifier.value = conn2;
      await tester.pumpAndSettle();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsNothing);
      expect(
        host2.calls.any((c) => c.method == MobileProjectMethods.list),
        isTrue,
      );
    },
  );

  testWidgets(
    'ProjectDirectoryPickerScreen supports breadcrumbs, filtering, and creating a new folder as project',
    (tester) async {
      final host = _ManageHost();
      final conn = _FakeManageConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      MobileManagedProject? result;
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: FilledButton(
                  onPressed: () async {
                    result = await ProjectDirectoryPickerScreen.open(
                      context,
                      connectionListenable: notifier,
                    );
                  },
                  child: const Text('打开'),
                ),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();

      // 进入 workspace 快捷路径后搜索过滤
      await tester.tap(
        find.byKey(
          ProjectDirectoryPickerScreen.shortcutKey('Documents/workspace'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(ProjectDirectoryPickerScreen.searchToggleButtonKey),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(ProjectDirectoryPickerScreen.searchInputKey),
        'new-repo',
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(
          ProjectDirectoryPickerScreen.entryKey('Documents/workspace/new-repo'),
        ),
        findsOneWidget,
      );
      expect(find.text('pigcode'), findsNothing);

      // 关闭筛选并点击新建文件夹，一步新建并添加为项目
      await tester.tap(
        find.byKey(ProjectDirectoryPickerScreen.searchToggleButtonKey),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(ProjectDirectoryPickerScreen.createFolderButtonKey),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('project-create-dir-input')),
        'my-new-app',
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('project-create-dir-confirm')),
      );
      await tester.pumpAndSettle();

      expect(
        host.calls.any(
          (c) =>
              c.method == MobileProjectMethods.createDir &&
              c.params['parentRelPath'] == 'Documents/workspace' &&
              c.params['name'] == 'my-new-app',
        ),
        isTrue,
      );
      expect(
        host.calls.any(
          (c) =>
              c.method == MobileProjectMethods.add &&
              c.params['relPath'] == 'Documents/workspace/my-new-app',
        ),
        isTrue,
      );
      expect(result?.displayPath, '~/Documents/workspace/my-new-app');
    },
  );

  testWidgets(
    'SidebarMenu exposes add-project button and long-press project actions',
    (tester) async {
      var addedTapped = false;
      String? renamedId;
      String? removedId;
      final focus = FocusNode();
      addTearDown(focus.dispose);

      const project = MobileProjectSummary(id: 'pr_1', name: 'AlphaRepo');
      final snapshot = SidebarSnapshot(
        projects: const [project],
        threads: const [],
        syncedAt: DateTime(2026, 11, 26),
      );

      await tester.pumpWidget(
        _app(
          SidebarMenu(
            snapshot: snapshot,
            selectedId: null,
            computerName: 'TestMac',
            online: true,
            onSelect: (_) {},
            onComputers: () {},
            focusNode: focus,
            onNewThread: (_) {},
            onAddProject: () => addedTapped = true,
            onRenameProject: (p) => renamedId = p.id,
            onRemoveProject: (p) => removedId = p.id,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(SidebarMenu.addProjectButtonKey));
      expect(addedTapped, isTrue);

      await tester.longPress(find.text('AlphaRepo'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('重命名项目'));
      await tester.pumpAndSettle();
      expect(renamedId, 'pr_1');

      await tester.longPress(find.text('AlphaRepo'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('从列表移除'));
      await tester.pumpAndSettle();
      expect(removedId, 'pr_1');
    },
  );
}
