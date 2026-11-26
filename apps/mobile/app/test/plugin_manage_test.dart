import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/manage/manage_utils.dart';
import 'package:pigcode_mobile/manage/plugin_detail_sheet.dart';
import 'package:pigcode_mobile/manage/plugin_manage_screen.dart';

class _PluginManageHost implements HostRequests {
  final List<({String method, Map<String, Object?> params})> calls = [];
  bool failConflictOnEnable = false;

  List<Map<String, dynamic>> plugins = [
    {
      'id': 'builtin.claude',
      'name': 'agent-claude',
      'displayName': 'Claude Code',
      'description': 'Anthropic 官方编码 Agent',
      'version': '1.0.0',
      'kind': 'agent',
      'enabled': true,
      'builtin': true,
      'apiVersion': 1,
      'permissions': <String>['process.spawn'],
      'provides': <String>['agent.claude'],
      'conflict': null,
      'error': null,
      'originKind': 'builtin',
      'marketplaceId': null,
      'marketplacePluginName': null,
      'originLabel': null,
      'canUpdate': false,
    },
    {
      'id': 'ui.demo',
      'name': 'demo-ui',
      'displayName': 'Demo UI',
      'description': 'English description',
      'version': '1.0.0',
      'kind': 'ui',
      'enabled': true,
      'builtin': false,
      'apiVersion': 1,
      'permissions': <String>['workspace.read', 'network.fetch'],
      'provides': <String>['ui.panel.demo'],
      'conflict': null,
      'error': null,
      'originKind': 'marketplace',
      'marketplaceId': 'pigcode',
      'marketplacePluginName': 'demo-ui',
      'originLabel': 'demo-ui@pigcode',
      'canUpdate': true,
    },
    {
      'id': 'cap.git-auth',
      'name': 'git-auth',
      'displayName': 'Git Auth Helper',
      'description': '凭据同步能力',
      'version': '0.8.0',
      'kind': 'capability',
      'enabled': false,
      'builtin': false,
      'apiVersion': 1,
      'permissions': <String>['keychain.read'],
      'provides': <String>['service.git-auth'],
      'conflict': '服务 service.git-auth 已被其他插件占用',
      'error': null,
      'originKind': 'npm',
      'marketplaceId': null,
      'marketplacePluginName': null,
      'originLabel': 'npm:git-auth',
      'canUpdate': true,
    },
    {
      'id': 'bundle.broken',
      'name': 'broken-pack',
      'displayName': 'Broken Bundle',
      'description': '组合扩展包',
      'version': '0.2.0',
      'kind': 'bundle',
      'enabled': true,
      'builtin': false,
      'apiVersion': 1,
      'permissions': <String>[],
      'provides': <String>[],
      'conflict': null,
      'error': '入口模块加载失败',
      'originKind': 'local',
      'marketplaceId': null,
      'marketplacePluginName': null,
      'originLabel': '本地目录',
      'canUpdate': false,
    },
  ];

  List<Map<String, dynamic>> marketplaces = [
    {
      'id': 'pigcode',
      'official': true,
      'displayName': 'Pigcode 官方市场',
      'description': '官方精选与社区插件',
      'owner': 'Pigcode',
      'sourceType': 'url',
      'sourceLabel': 'https://marketplace.pigcode.dev/marketplace.json',
      'sourceUrl': 'https://github.com/pigcode/marketplace',
      'enabled': true,
      'lastUpdated': '2026-11-26T00:00:00.000Z',
      'error': null,
      'plugins': [
        {
          'name': 'demo-ui',
          'displayName': 'Demo UI',
          'description': 'English description',
          'version': '1.2.0',
          'category': 'productivity',
          'iconUrl': null,
          'homepage': 'https://pigcode.dev',
          'author': 'Pigcode Team',
          'publisherType': 'official',
          'displayNameI18n': {'zh-CN': '演示界面插件', 'en': 'Demo UI'},
          'descriptionI18n': {'zh-CN': '官方界面增强工具', 'en': 'English description'},
          'sourceLabel': 'pigcode/demo-ui',
        },
        {
          'name': 'new-tool',
          'displayName': 'New Tool',
          'description': 'Useful official utility',
          'version': '2.0.0',
          'category': 'developer-tools',
          'iconUrl': null,
          'homepage': null,
          'author': 'Pigcode Team',
          'publisherType': 'official',
          'displayNameI18n': {'zh-CN': '官方效率工具', 'en': 'New Tool'},
          'descriptionI18n': {
            'zh-CN': '一键生成发布清单',
            'en': 'Useful official utility',
          },
          'sourceLabel': 'pigcode/new-tool',
        },
        {
          'name': 'community-theme',
          'displayName': 'Community Theme',
          'description': 'Community contributed theme pack',
          'version': '1.1.0',
          'category': 'ui',
          'iconUrl': null,
          'homepage': null,
          'author': 'Alice',
          'publisherType': 'community',
          'displayNameI18n': {'zh-CN': '社区配色主题'},
          'descriptionI18n': {'zh-CN': '社区维护的高对比主题'},
          'sourceLabel': 'community/theme',
        },
      ],
    },
    {
      'id': 'team-internal',
      'official': false,
      'displayName': '团队私有市场',
      'description': '内部工具集',
      'owner': 'Team',
      'sourceType': 'git',
      'sourceLabel': 'git@internal/plugins.git',
      'sourceUrl': null,
      'enabled': true,
      'lastUpdated': '2026-11-26T00:00:00.000Z',
      'error': null,
      'plugins': [
        {
          'name': 'deploy-bot',
          'displayName': '发布助手',
          'description': '内部灰度发布插件',
          'version': '3.0.1',
          'category': 'ops',
          'iconUrl': null,
          'homepage': null,
          'author': 'Infra',
          'publisherType': null,
          'sourceLabel': 'team-internal/deploy-bot',
        },
      ],
    },
    {
      'id': 'broken-personal',
      'official': false,
      'displayName': '离线私有源',
      'description': null,
      'owner': null,
      'sourceType': 'url',
      'sourceLabel': 'https://broken.example.com/market.json',
      'sourceUrl': null,
      'enabled': true,
      'lastUpdated': null,
      'error': '拉取索引超时',
      'plugins': <Map<String, dynamic>>[],
    },
  ];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobilePluginMethods.list:
        return {'plugins': plugins, 'truncated': false};
      case MobilePluginMethods.marketplaces:
      case MobilePluginMethods.refreshMarketplaces:
        return {'marketplaces': marketplaces, 'truncated': false};
      case MobilePluginMethods.setEnabled:
        final id = params['id'] as String;
        final enabled = params['enabled'] as bool;
        if (failConflictOnEnable && id == 'cap.git-auth' && enabled) {
          throw const MobileRpcFailure(
            MobileRpcProblem(
              code: 'PLUGIN_CONFLICT',
              message: '服务 service.git-auth 已被其他插件占用',
              retryable: false,
            ),
          );
        }
        final idx = plugins.indexWhere((p) => p['id'] == id);
        final updated = Map<String, dynamic>.from(plugins[idx])
          ..['enabled'] = enabled;
        plugins = [
          for (var i = 0; i < plugins.length; i++)
            i == idx ? updated : plugins[i],
        ];
        return {'plugin': updated};
      case MobilePluginMethods.update:
        final id = params['id'] as String;
        final idx = plugins.indexWhere((p) => p['id'] == id);
        final updated = Map<String, dynamic>.from(plugins[idx])
          ..['version'] = '1.2.0';
        plugins = [
          for (var i = 0; i < plugins.length; i++)
            i == idx ? updated : plugins[i],
        ];
        return {'plugin': updated};
      case MobilePluginMethods.uninstall:
        final id = params['id'] as String;
        plugins = plugins.where((p) => p['id'] != id).toList();
        return {'uninstalled': true};
      case MobilePluginMethods.installFromMarketplace:
        final marketId = params['marketplace'] as String;
        final name = params['name'] as String;
        final market = marketplaces.firstWhere((m) => m['id'] == marketId);
        final entry = (market['plugins'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((e) => e['name'] == name);
        final created = <String, dynamic>{
          'id': 'market.$name',
          'name': name,
          'displayName': entry['displayName'] ?? name,
          'description': entry['description'],
          'version': entry['version'] ?? '1.0.0',
          'kind': 'capability',
          'enabled': true,
          'builtin': false,
          'apiVersion': 1,
          'permissions': <String>['workspace.read'],
          'provides': <String>[],
          'conflict': null,
          'error': null,
          'originKind': 'marketplace',
          'marketplaceId': marketId,
          'marketplacePluginName': name,
          'originLabel': '$name@$marketId',
          'canUpdate': true,
        };
        plugins = [...plugins, created];
        return {'plugin': created};
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _FakePluginConnection implements MobileConnection {
  _FakePluginConnection(HostRequests host, {this.supportsPluginManage = true})
    : plugins = MobilePluginManageClient(
        host,
        supportsPluginManage: supportsPluginManage,
      );

  @override
  String get computerName => 'StudioMac';
  @override
  final bool supportsPluginManage;
  @override
  final MobilePluginManageClient plugins;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _wrap(Widget home, {Brightness brightness = Brightness.light}) =>
    MaterialApp(theme: pigcodeTheme(brightness), home: home);

void main() {
  testWidgets(
    'Installed tab groups by kind in order, shows badges/errors, filters by search, toggles switch, and reports PLUGIN_CONFLICT',
    (tester) async {
      final host = _PluginManageHost()..failConflictOnEnable = true;
      final conn = _FakePluginConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(PluginManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // Verify concurrent initial fetches.
      expect(
        host.calls.any((c) => c.method == MobilePluginMethods.list),
        isTrue,
      );
      expect(
        host.calls.any((c) => c.method == MobilePluginMethods.marketplaces),
        isTrue,
      );

      // Verify group headings appear in order: Agent -> 界面 -> 能力 -> 组合包.
      final agentY = tester.getTopLeft(find.text('Agent')).dy;
      final uiY = tester.getTopLeft(find.text('界面')).dy;
      expect(agentY, lessThan(uiY));

      // Verify badges, localized name from official marketplace, and update badge.
      expect(find.text('Claude Code'), findsOneWidget);
      expect(find.text('内置'), findsOneWidget);
      expect(find.text('演示界面插件'), findsOneWidget);
      expect(find.text('有更新'), findsOneWidget);

      // Scroll down to verify capability conflict and bundle error cards.
      final listScrollable = find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.text('组合包'),
        200,
        scrollable: listScrollable,
      );
      await tester.pumpAndSettle();
      final capY = tester.getTopLeft(find.text('能力')).dy;
      final bundleY = tester.getTopLeft(find.text('组合包')).dy;
      expect(capY, lessThan(bundleY));
      expect(
        find.textContaining('服务 service.git-auth 已被其他插件占用'),
        findsOneWidget,
      );
      expect(find.textContaining('入口模块加载失败'), findsOneWidget);

      // Toggle conflicting capability plugin -> PLUGIN_CONFLICT SnackBar shown.
      await tester.ensureVisible(
        find.byKey(PluginManageScreen.pluginToggleKey('cap.git-auth')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(PluginManageScreen.pluginToggleKey('cap.git-auth')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('服务 service.git-auth 已被其他插件占用'), findsWidgets);

      // Refresh button in Installed tab refreshes list without refreshMarketplaces.
      host.calls.clear();
      await tester.tap(find.byKey(PluginManageScreen.refreshButtonKey));
      await tester.pumpAndSettle();
      expect(
        host.calls.any((c) => c.method == MobilePluginMethods.list),
        isTrue,
      );
      expect(
        host.calls.any(
          (c) => c.method == MobilePluginMethods.refreshMarketplaces,
        ),
        isFalse,
      );

      // Search filters by package name and description.
      await tester.enterText(
        find.byKey(PluginManageScreen.searchInputKey),
        'demo-ui',
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(PluginManageScreen.pluginCardKey('ui.demo')),
        findsOneWidget,
      );
      expect(
        find.byKey(PluginManageScreen.pluginCardKey('builtin.claude')),
        findsNothing,
      );

      // Toggle UI plugin off.
      await tester.tap(
        find.byKey(PluginManageScreen.pluginToggleKey('ui.demo')),
      );
      await tester.pumpAndSettle();
      expect(
        host.calls.any(
          (c) =>
              c.method == MobilePluginMethods.setEnabled &&
              c.params['id'] == 'ui.demo' &&
              c.params['enabled'] == false,
        ),
        isTrue,
      );
      final switchWidget = tester.widget<Switch>(
        find.byKey(PluginManageScreen.pluginToggleKey('ui.demo')),
      );
      expect(switchWidget.value, isFalse);

      // Clear search restores full list.
      await tester.tap(find.byKey(PluginManageScreen.searchClearKey));
      await tester.pumpAndSettle();
      expect(
        find.byKey(PluginManageScreen.pluginCardKey('builtin.claude')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'Installed detail sheet hides uninstall for builtin, updates & uninstalls third-party with confirmation',
    (tester) async {
      final host = _PluginManageHost();
      final conn = _FakePluginConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(PluginManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // 1. Open builtin plugin detail sheet.
      await tester.tap(
        find.byKey(PluginManageScreen.pluginCardKey('builtin.claude')),
      );
      await tester.pumpAndSettle();

      expect(find.text('process.spawn'), findsOneWidget);
      expect(find.text('agent.claude'), findsOneWidget);
      expect(find.byKey(PluginDetailSheet.uninstallButtonKey), findsNothing);
      expect(find.byKey(PluginDetailSheet.updateButtonKey), findsNothing);
      expect(find.text('内置插件不能卸载，如需关闭请在列表中停用'), findsOneWidget);

      // Dismiss sheet.
      await tester.tap(find.byTooltip('关闭弹层'));
      await tester.pumpAndSettle();

      // 2. Open third-party updatable plugin detail sheet -> update plugin.
      await tester.tap(find.byKey(PluginManageScreen.pluginCardKey('ui.demo')));
      await tester.pumpAndSettle();

      expect(find.text('workspace.read'), findsOneWidget);
      expect(find.text('network.fetch'), findsOneWidget);
      expect(find.text('ui.panel.demo'), findsOneWidget);
      expect(find.text('demo-ui@pigcode'), findsOneWidget);
      expect(find.byKey(PluginDetailSheet.updateButtonKey), findsOneWidget);
      expect(find.textContaining('v1.2.0'), findsWidgets);
      expect(find.byKey(PluginDetailSheet.uninstallButtonKey), findsOneWidget);

      await tester.ensureVisible(find.byKey(PluginDetailSheet.updateButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(PluginDetailSheet.updateButtonKey));
      await tester.pumpAndSettle();

      expect(
        host.calls.any(
          (c) =>
              c.method == MobilePluginMethods.update &&
              c.params['id'] == 'ui.demo',
        ),
        isTrue,
      );
      expect(find.text('有更新'), findsNothing);
      expect(find.text('v1.2.0'), findsOneWidget);

      // 3. Re-open third-party detail sheet -> uninstall with two-step dialog.
      await tester.tap(find.byKey(PluginManageScreen.pluginCardKey('ui.demo')));
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(PluginDetailSheet.uninstallButtonKey),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(PluginDetailSheet.uninstallButtonKey));
      await tester.pumpAndSettle();

      expect(find.text('卸载插件？'), findsOneWidget);
      expect(find.text('卸载后将移除插件文件；如果它是当前默认 Agent，将自动恢复为自动选择'), findsOneWidget);

      // Cancel first -> plugin still remains.
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(find.byKey(PluginDetailSheet.uninstallButtonKey), findsOneWidget);

      // Confirm uninstall -> removes plugin and closes sheet.
      await tester.tap(find.byKey(PluginDetailSheet.uninstallButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(PluginDetailSheet.uninstallConfirmKey));
      await tester.pumpAndSettle();

      expect(
        host.calls.any(
          (c) =>
              c.method == MobilePluginMethods.uninstall &&
              c.params['id'] == 'ui.demo',
        ),
        isTrue,
      );
      expect(
        find.byKey(PluginManageScreen.pluginCardKey('ui.demo')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'Marketplace tab filters official/community/personal, handles per-market error, refreshes, and installs plugin',
    (tester) async {
      final host = _PluginManageHost();
      final conn = _FakePluginConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(PluginManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // Switch to Marketplace tab.
      await tester.tap(find.byKey(PluginManageScreen.marketplaceTabKey));
      await tester.pumpAndSettle();

      // Official filter active by default: official entries shown, community & personal hidden.
      expect(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('pigcode', 'demo-ui'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('pigcode', 'new-tool'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('pigcode', 'community-theme'),
        ),
        findsNothing,
      );
      expect(find.text('添加自定义市场源或本地路径安装请在电脑端操作'), findsOneWidget);

      // Switch to Community filter.
      await tester.tap(find.byKey(PluginManageScreen.marketFilterCommunityKey));
      await tester.pumpAndSettle();
      expect(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('pigcode', 'community-theme'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('pigcode', 'new-tool'),
        ),
        findsNothing,
      );

      // Switch to Personal market filter: shows healthy market and soft error on failing market.
      await tester.tap(find.byKey(PluginManageScreen.marketFilterPersonalKey));
      await tester.pumpAndSettle();
      expect(find.text('团队私有市场'), findsOneWidget);
      expect(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('team-internal', 'deploy-bot'),
        ),
        findsOneWidget,
      );
      expect(find.text('离线私有源'), findsOneWidget);
      expect(find.textContaining('拉取索引超时'), findsOneWidget);

      // Refresh button in Marketplace tab triggers refreshMarketplaces + list.
      host.calls.clear();
      await tester.tap(find.byKey(PluginManageScreen.refreshButtonKey));
      await tester.pumpAndSettle();
      expect(
        host.calls.any(
          (c) => c.method == MobilePluginMethods.refreshMarketplaces,
        ),
        isTrue,
      );
      expect(
        host.calls.any((c) => c.method == MobilePluginMethods.list),
        isTrue,
      );

      // Back to Official filter and install 'new-tool'.
      await tester.tap(find.byKey(PluginManageScreen.marketFilterOfficialKey));
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(PluginManageScreen.marketInstallButtonKey('new-tool')),
      );
      await tester.pumpAndSettle();

      expect(
        host.calls.any(
          (c) =>
              c.method == MobilePluginMethods.installFromMarketplace &&
              c.params['marketplace'] == 'pigcode' &&
              c.params['name'] == 'new-tool',
        ),
        isTrue,
      );
      expect(find.text('已安装 官方效率工具'), findsOneWidget);
      expect(
        find.byKey(PluginManageScreen.marketInstallButtonKey('new-tool')),
        findsNothing,
      );
      // Card now shows muted '已安装' badge.
      expect(
        find.descendant(
          of: find.byKey(
            PluginManageScreen.marketPluginCardKey('pigcode', 'new-tool'),
          ),
          matching: find.text('已安装'),
        ),
        findsOneWidget,
      );

      // Open marketplace detail sheet for a community plugin and install from sheet.
      await tester.tap(find.byKey(PluginManageScreen.marketFilterCommunityKey));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(
          PluginManageScreen.marketPluginCardKey('pigcode', 'community-theme'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byType(PluginDetailSheet),
          matching: find.text('Alice'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(PluginDetailSheet),
          matching: find.text('社区维护的高对比主题'),
        ),
        findsOneWidget,
      );
      expect(find.byKey(PluginDetailSheet.installButtonKey), findsOneWidget);

      await tester.ensureVisible(
        find.byKey(PluginDetailSheet.installButtonKey),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(PluginDetailSheet.installButtonKey));
      await tester.pumpAndSettle();
      expect(
        host.calls.any(
          (c) =>
              c.method == MobilePluginMethods.installFromMarketplace &&
              c.params['marketplace'] == 'pigcode' &&
              c.params['name'] == 'community-theme',
        ),
        isTrue,
      );
    },
  );

  testWidgets(
    'Offline state shows ManageOfflineBanner, disables all write controls, and recovers on reconnect',
    (tester) async {
      final host1 = _PluginManageHost();
      final host2 = _PluginManageHost();
      final conn1 = _FakePluginConnection(host1);
      final conn2 = _FakePluginConnection(host2);
      final notifier = ValueNotifier<MobileConnection?>(conn1);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(
          PluginManageScreen(connectionListenable: notifier),
          brightness: Brightness.dark,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsNothing);

      // Go offline.
      notifier.value = null;
      await tester.pump();

      expect(find.byKey(ManageOfflineBanner.bannerKey), findsOneWidget);

      // Refresh button disabled.
      final refreshBtn = tester.widget<IconButton>(
        find.byKey(PluginManageScreen.refreshButtonKey),
      );
      expect(refreshBtn.onPressed, isNull);

      // Switch disabled.
      final toggleSwitch = tester.widget<Switch>(
        find.byKey(PluginManageScreen.pluginToggleKey('ui.demo')),
      );
      expect(toggleSwitch.onChanged, isNull);

      // Marketplace install/update buttons disabled.
      await tester.tap(find.byKey(PluginManageScreen.marketplaceTabKey));
      await tester.pumpAndSettle();
      final installBtn = tester.widget<FilledButton>(
        find.byKey(PluginManageScreen.marketInstallButtonKey('new-tool')),
      );
      expect(installBtn.onPressed, isNull);
      final updateBtn = tester.widget<FilledButton>(
        find.byKey(PluginManageScreen.marketUpdateButtonKey('demo-ui')),
      );
      expect(updateBtn.onPressed, isNull);

      // Reconnect with new connection -> banner clears, host2 reloads, controls re-enable.
      notifier.value = conn2;
      await tester.pumpAndSettle();

      expect(find.byKey(ManageOfflineBanner.bannerKey), findsNothing);
      expect(
        host2.calls.any((c) => c.method == MobilePluginMethods.list),
        isTrue,
      );
      expect(
        host2.calls.any((c) => c.method == MobilePluginMethods.marketplaces),
        isTrue,
      );
      final recoveredInstallBtn = tester.widget<FilledButton>(
        find.byKey(PluginManageScreen.marketInstallButtonKey('new-tool')),
      );
      expect(recoveredInstallBtn.onPressed, isNotNull);
    },
  );
}
