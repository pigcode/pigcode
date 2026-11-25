import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/composer/composer_tokens.dart';
import 'package:pigcode_mobile/composer/mobile_composer_card.dart';
import 'package:pigcode_mobile/new_thread_draft.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_mobile/run_composer_state.dart';
import 'package:pigcode_mobile/theme_colors.dart';
import 'package:pigcode_mobile/workspace_icon.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

class _DraftHost implements HostRequests {
  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    switch (method) {
      case MobileDraftMethods.options:
        return const MobileDraftOptions(
          defaultInstanceId: 'default',
          instances: [
            MobileDraftInstance(
              instanceId: 'default',
              label: '默认开发实例',
              agentName: 'Claude Code',
              permissionModes: [
                MobileDraftPermission.approvalRequired,
                MobileDraftPermission.autoAcceptEdits,
                MobileDraftPermission.fullAccess,
              ],
              defaultPermissionMode: MobileDraftPermission.approvalRequired,
            ),
          ],
        ).toJson();
      case MobileDraftMethods.models:
        return const MobileDraftModels(
          models: [
            MobileDraftModel(id: 'sonnet', label: 'Claude Sonnet 4.5'),
            MobileDraftModel(id: 'opus', label: 'Claude Opus 4.5'),
          ],
          defaultModelId: 'sonnet',
        ).toJson();
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _DraftConnection implements MobileConnection {
  _DraftConnection(_DraftHost host) : drafts = MobileDraftCommands(host);

  @override
  final MobileDraftCommands drafts;

  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 9)).replaceAll('=', ''),
    name: '测试电脑',
  );

  @override
  String get deviceId => 'fixture-phone';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

BoxDecoration _cardDecoration(WidgetTester tester) {
  final container = tester.widget<AnimatedContainer>(
    find.byKey(MobileComposerCard.cardKey),
  );
  return container.decoration! as BoxDecoration;
}

BoxDecoration _actionCircleDecoration(WidgetTester tester, Finder button) {
  final box = tester.widget<DecoratedBox>(
    find.descendant(of: button, matching: find.byType(DecoratedBox)).first,
  );
  return box.decoration as BoxDecoration;
}

Color? _actionIconColor(WidgetTester tester, Finder button) {
  final icon = find.descendant(
    of: button,
    matching: find.byType(WorkspaceIcon),
  );
  return IconTheme.of(tester.element(icon)).color;
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('MobileComposerCard', () {
    for (final brightness in Brightness.values) {
      testWidgets(
        'uses expanded two-row layout, foreground action colors, and deepened focus border (${brightness.name})',
        (tester) async {
          final colors = brightness == Brightness.dark
              ? pigcodeDark
              : pigcodeLight;
          final controller = TextEditingController(text: '测试消息');
          final focusNode = FocusNode();
          addTearDown(() {
            controller.dispose();
            focusNode.dispose();
          });

          await tester.pumpWidget(
            MaterialApp(
              theme: pigcodeTheme(
                brightness,
              ).copyWith(platform: TargetPlatform.iOS),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: MobileComposerCard(
                    controller: controller,
                    focusNode: focusNode,
                    inputKey: const ValueKey('card-input'),
                    hintText: '回复…',
                    leading: const MobileComposerChip(
                      label: '添加',
                      tooltip: '添加内容',
                    ),
                    trailing: const MobileComposerChip(
                      label: '模型',
                      tooltip: '模型选择',
                    ),
                    actions: [
                      MobileComposerActionButton(
                        tooltip: '停止',
                        glyph: WorkspaceGlyph.stop,
                        onPressed: () {},
                      ),
                      MobileComposerActionButton(
                        tooltip: '发送',
                        glyph: WorkspaceGlyph.arrowUp,
                        onPressed: () {},
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();

          expect(find.byKey(MobileComposerCard.frameKey), findsNothing);
          expect(
            _cardDecoration(tester).border?.top.color,
            colors.border,
          );

          final inputRect = tester.getRect(find.byKey(const ValueKey('card-input')));
          final leadingRect = tester.getRect(find.byTooltip('添加内容'));
          final trailingRect = tester.getRect(find.byTooltip('模型选择'));
          final sendRect = tester.getRect(find.byTooltip('发送'));
          expect(inputRect.bottom, lessThanOrEqualTo(sendRect.top));
          expect(inputRect.center.dy, lessThan(leadingRect.center.dy));
          expect(inputRect.center.dy, lessThan(trailingRect.center.dy));
          expect(inputRect.center.dy, lessThan(sendRect.center.dy));
          expect(leadingRect.left, lessThan(trailingRect.left));
          expect(trailingRect.right, lessThanOrEqualTo(sendRect.left));

          final sendButton = find.byWidgetPredicate(
            (widget) => widget is IconButton && widget.tooltip == '发送',
          );
          final stopButton = find.byWidgetPredicate(
            (widget) => widget is IconButton && widget.tooltip == '停止',
          );
          expect(
            _actionCircleDecoration(tester, sendButton).color,
            colors.foreground,
          );
          expect(_actionIconColor(tester, sendButton), colors.background);
          expect(
            _actionCircleDecoration(tester, stopButton).color,
            colors.foreground,
          );
          expect(_actionIconColor(tester, stopButton), colors.background);

          focusNode.requestFocus();
          await tester.pumpAndSettle();
          expect(
            _cardDecoration(tester).border?.top.color,
            colors.strongBorder,
          );

          focusNode.unfocus();
          await tester.pumpAndSettle();
          expect(
            _cardDecoration(tester).border?.top.color,
            colors.border,
          );
        },
      );
    }

    testWidgets('wraps header and card in composer-frame with offline sunken fill', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: pigcodeTheme(
            Brightness.light,
          ).copyWith(platform: TargetPlatform.iOS),
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: MobileComposerCard(
                controller: controller,
                inputKey: const ValueKey('offline-input'),
                hintText: '离线输入',
                offline: true,
                header: const MobileComposerChip(
                  label: '主项目',
                  tooltip: '顶部项目',
                  icon: WorkspaceGlyph.folder,
                  variant: MobileComposerChipVariant.header,
                ),
                actions: const [
                  MobileComposerActionButton(
                    tooltip: '发送',
                    glyph: WorkspaceGlyph.arrowUp,
                    offline: true,
                    onPressed: null,
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final frame = tester.widget<DecoratedBox>(
        find.byKey(MobileComposerCard.frameKey),
      );
      final frameDecoration = frame.decoration as BoxDecoration;
      expect(frameDecoration.color, pigcodeLight.field);
      expect(frameDecoration.border?.top.width, ComposerBorder.frame);

      final cardDecoration = _cardDecoration(tester);
      final expectedOfflineFill = Color.alphaBlend(
        pigcodeLight.surfaceSunken,
        pigcodeLight.background,
      );
      expect(cardDecoration.color, expectedOfflineFill);

      final sendButton = find.byWidgetPredicate(
        (widget) => widget is IconButton && widget.tooltip == '发送',
      );
      expect(
        _actionCircleDecoration(tester, sendButton).color,
        Color.alphaBlend(pigcodeLight.selected, expectedOfflineFill),
      );
      expect(_actionIconColor(tester, sendButton), pigcodeLight.faint);

      final headerRect = tester.getRect(find.byTooltip('顶部项目'));
      final cardRect = tester.getRect(find.byKey(MobileComposerCard.cardKey));
      expect(headerRect.bottom, lessThanOrEqualTo(cardRect.top));
    });
  });

  group('RunComposerView unified composer', () {
    testWidgets(
      'places input above bottom toolbar, uses foreground send/stop fill, and exposes leading/trailing slots',
      (tester) async {
        final draft = TextEditingController(text: '准备发送');
        addTearDown(draft.dispose);

        await tester.pumpWidget(
          MaterialApp(
            theme: pigcodeTheme(
              Brightness.light,
            ).copyWith(platform: TargetPlatform.iOS),
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: RunComposerView(
                  draft: draft,
                  online: true,
                  stoppableRunId: 'run-1',
                  allowQueue: true,
                  state: const RunComposerState(),
                  storageError: false,
                  onRetryLoad: () {},
                  onSend: (_) {},
                  onStop: (_) {},
                  onCheck: (_) {},
                  onRetry: (_) {},
                  leading: const MobileComposerChip(
                    label: '附件',
                    tooltip: '附加入口',
                  ),
                  trailing: const MobileComposerChip(
                    label: 'Sonnet',
                    tooltip: '模型入口',
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(MobileComposerCard.frameKey), findsNothing);
        final input = find.byKey(const ValueKey('run-composer-input'));
        final send = find.byWidgetPredicate(
          (widget) => widget is IconButton && widget.tooltip == '发送消息',
        );
        final stop = find.byWidgetPredicate(
          (widget) => widget is IconButton && widget.tooltip == '停止本轮运行',
        );

        expect(
          tester.getCenter(input).dy,
          lessThan(tester.getCenter(send).dy),
        );
        expect(
          tester.getCenter(input).dy,
          lessThan(tester.getCenter(stop).dy),
        );
        expect(
          _actionCircleDecoration(tester, send).color,
          pigcodeLight.foreground,
        );
        expect(_actionIconColor(tester, send), pigcodeLight.background);
        expect(
          _actionCircleDecoration(tester, stop).color,
          pigcodeLight.foreground,
        );
        expect(_actionIconColor(tester, stop), pigcodeLight.background);
        expect(find.byTooltip('附加入口'), findsOneWidget);
        expect(find.byTooltip('模型入口'), findsOneWidget);

        await tester.tap(input);
        await tester.pumpAndSettle();
        expect(
          _cardDecoration(tester).border?.top.color,
          pigcodeLight.strongBorder,
        );
      },
    );
  });

  group('NewThreadDraft unified composer', () {
    for (final platform in const [TargetPlatform.iOS, TargetPlatform.android]) {
      testWidgets(
        'renders project header in composer-frame and bottom toolbar controls without overflow on 360px (${platform.name})',
        (tester) async {
          final minTouch = platform == TargetPlatform.android ? 48.0 : 44.0;
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = const Size(360, 720);
          addTearDown(tester.view.reset);

          final phone = _DraftConnection(_DraftHost());
          await tester.pumpWidget(
            ProviderScope(
              child: MaterialApp(
                theme: pigcodeTheme(
                  Brightness.light,
                ).copyWith(platform: platform),
                home: Scaffold(
                  body: NewThreadDraft(
                    connection: phone,
                    projects: const [
                      MobileProjectSummary(
                        id: 'one',
                        name: '主项目工作区很长的名字测试截断',
                      ),
                    ],
                    projectId: 'one',
                    online: true,
                    onAccepted: (_) {},
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          expect(find.byKey(MobileComposerCard.frameKey), findsOneWidget);
          final project = find.byTooltip('草稿项目');
          final input = find.byKey(const ValueKey('first-message-input'));
          final instance = find.byTooltip('草稿 Agent 实例');
          final model = find.byTooltip('草稿模型');
          final permission = find.byTooltip('草稿权限');
          final send = find.byWidgetPredicate(
            (widget) => widget is IconButton && widget.tooltip == '发送首条消息',
          );
          final cardRect = tester.getRect(find.byKey(MobileComposerCard.cardKey));

          // 项目条贴合在抬起卡片上方
          expect(tester.getRect(project).bottom, lessThanOrEqualTo(cardRect.top));
          expect(tester.getCenter(project).dy, lessThan(tester.getCenter(input).dy));

          // 实例、模型、权限与发送键全部收进输入区下方的底栏同一行
          final inputCenterY = tester.getCenter(input).dy;
          final sendCenterY = tester.getCenter(send).dy;
          expect(sendCenterY, greaterThan(inputCenterY));
          expect(tester.getCenter(instance).dy, closeTo(sendCenterY, 2));
          expect(tester.getCenter(model).dy, closeTo(sendCenterY, 2));
          expect(tester.getCenter(permission).dy, closeTo(sendCenterY, 2));

          // 所有可点控件触区满足平台规范
          for (final target in [project, instance, model, permission, send]) {
            final size = tester.getSize(target);
            expect(size.height, greaterThanOrEqualTo(minTouch));
            expect(size.width, greaterThanOrEqualTo(minTouch));
          }

          // 输入文字后发送键使用前景色底/背景色图标，且输入框聚焦时卡片边框加深
          await tester.tap(input);
          await tester.enterText(input, '第一条测试消息');
          await tester.pumpAndSettle();
          expect(
            _cardDecoration(tester).border?.top.color,
            pigcodeLight.strongBorder,
          );
          expect(
            _actionCircleDecoration(tester, send).color,
            pigcodeLight.foreground,
          );
          expect(_actionIconColor(tester, send), pigcodeLight.background);
        },
      );
    }
  });
}
