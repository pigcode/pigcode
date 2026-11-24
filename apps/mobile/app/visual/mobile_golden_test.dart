import 'dart:io';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';

import 'mobile_fixture.dart';

const _surface = ValueKey('mobile-visual-surface');
const _sans = 'Noto Sans SC';
const _platforms = TargetPlatformVariant({
  TargetPlatform.iOS,
  TargetPlatform.android,
});

class _VisualTestBinding extends AutomatedTestWidgetsFlutterBinding {
  // Match the soft shadows rendered on devices rather than painting solid offsets.
  @override
  bool get disableShadows => false;
}

void main() {
  _VisualTestBinding();

  setUpAll(() async {
    final fontPath = Platform.environment['PIGCODE_MOBILE_GOLDEN_FONT'];
    if (fontPath == null) {
      throw StateError('请通过 apps/mobile/scripts/test-visual.sh 运行截图测试。');
    }
    final sans = ByteData.sublistView(await File(fontPath).readAsBytes());
    await (FontLoader(_sans)..addFont(Future.value(sans))).load();
    final monospace = rootBundle.load(
      'packages/gpt_markdown/lib/fonts/JetBrainsMono-Regular.ttf',
    );
    // Markdown uses the package-qualified family for inline code.
    await (FontLoader('monospace')..addFont(monospace)).load();
    await (FontLoader(
      'packages/gpt_markdown/JetBrainsMono',
    )..addFont(monospace)).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  setUp(() {
    // This suite runs explicitly from visual/, outside the default test/ directory.
    // ignore: invalid_use_of_visible_for_testing_member
    FlutterSecureStorage.setMockInitialValues({});
  });

  for (final brightness in Brightness.values) {
    testWidgets('侧栏 ${brightness.name}', (tester) async {
      await _openPage(tester, brightness, workspaceFixture(running: true));
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      expect(find.text('置顶'), findsOneWidget);
      expect(find.byTooltip('设置'), findsOneWidget);
      await _matchScreen('sidebar', brightness);
    }, variant: _platforms);

    testWidgets('时间线 ${brightness.name}', (tester) async {
      await _openPage(tester, brightness, workspaceFixture(running: true));
      expect(find.text('用时 8 秒'), findsOneWidget);
      expect(find.byKey(const ValueKey('run-composer-input')), findsOneWidget);
      expect(find.text('核对会话状态'), findsOneWidget);
      await _matchScreen('timeline', brightness);
    }, variant: _platforms);

    testWidgets('新会话 ${brightness.name}', (tester) async {
      await _openPage(tester, brightness, workspaceFixture());
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.text('做点什么？'), findsOneWidget);
      expect(
        tester.getTopLeft(find.byTooltip('草稿权限')).dy,
        tester.getTopLeft(find.byTooltip('草稿项目')).dy,
      );
      final input = find.byKey(const ValueKey('first-message-input'));
      final model = find.byTooltip('草稿模型');
      expect(
        tester.getCenter(model).dy,
        greaterThan(tester.getCenter(input).dy),
      );
      await _matchScreen('new-thread', brightness);
    }, variant: _platforms);

    testWidgets('分组筛选弹层 ${brightness.name}', (tester) async {
      await _openPage(tester, brightness, workspaceFixture());
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('分组和筛选'));
      await tester.pumpAndSettle();
      expect(find.text('分组和筛选'), findsOneWidget);
      expect(find.byTooltip('关闭弹层'), findsOneWidget);
      await _matchScreen('sidebar-options', brightness);
    }, variant: _platforms);

    testWidgets('审批 ${brightness.name}', (tester) async {
      await _openPage(
        tester,
        brightness,
        workspaceFixture(pending: MobileTimelinePendingKind.approval),
      );
      expect(find.text('允许运行 Flutter 测试？'), findsOneWidget);
      expect(find.text('允许本次'), findsOneWidget);
      await _matchScreen('approval', brightness);
    }, variant: _platforms);

    testWidgets('提问 ${brightness.name}', (tester) async {
      await _openPage(
        tester,
        brightness,
        workspaceFixture(pending: MobileTimelinePendingKind.question),
      );
      await tester.tap(find.text('Android'));
      await tester.pumpAndSettle();
      expect(find.text('本次回归覆盖哪些平台？'), findsOneWidget);
      await _matchScreen('question', brightness);
    }, variant: _platforms);

    testWidgets('离线状态 ${brightness.name}', (tester) async {
      await _openPage(tester, brightness, workspaceFixture(online: false));
      expect(find.text('电脑离线').hitTestable(), findsOneWidget);
      expect(
        find.textContaining(RegExp(r'^上次同步 ')).hitTestable(),
        findsOneWidget,
      );
      expect(find.text('帮我检查一下手机端的连接提示。'), findsOneWidget);
      await _matchScreen('offline-history', brightness);
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      expect(find.text('补充验收步骤').hitTestable(), findsOneWidget);
      expect(find.text('等你处理'), findsNothing);
      await _matchScreen('offline-sidebar', brightness);
    }, variant: _platforms);

    testWidgets('全屏 diff ${brightness.name}', (tester) async {
      await _openPage(tester, brightness, workspaceFixture());
      expect(
        find.descendant(of: find.byTooltip('改动'), matching: find.text('2')),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('改动'));
      await tester.pumpAndSettle();
      expect(find.text('2 个文件'), findsOneWidget);
      expect(find.textContaining('Computer offline'), findsOneWidget);
      await _matchScreen('diff', brightness);
    }, variant: _platforms);
  }
}

Future<void> _openPage(
  WidgetTester tester,
  Brightness brightness,
  Widget page,
) async {
  final isIOS = defaultTargetPlatform == TargetPlatform.iOS;
  final safeArea = FakeViewPadding(
    top: isIOS ? 47 : 24,
    bottom: isIOS ? 34 : 24,
  );
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  tester.view.padding = safeArea;
  tester.view.viewPadding = safeArea;
  addTearDown(tester.view.reset);

  final theme = pigcodeTheme(brightness);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _surface,
      child: ProviderScope(
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          locale: const Locale('en', 'US'),
          theme: theme.copyWith(
            textTheme: theme.textTheme.apply(fontFamily: _sans),
            primaryTextTheme: theme.primaryTextTheme.apply(fontFamily: _sans),
          ),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.noScaling,
              disableAnimations: true,
              alwaysUse24HourFormat: true,
            ),
            child: child!,
          ),
          home: page,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _matchScreen(String name, Brightness brightness) => expectLater(
  find.byKey(_surface),
  matchesGoldenFile(
    'baselines/${defaultTargetPlatform.name}-${brightness.name}-$name.png',
  ),
);
