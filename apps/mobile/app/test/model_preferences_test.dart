import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/composer/agent_badge_icon.dart';
import 'package:pigcode_mobile/composer/composer_catalog.dart';
import 'package:pigcode_mobile/composer/model_preferences.dart';
import 'package:pigcode_mobile/run_command_journal.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

class _JournalConnection implements MobileConnection {
  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 7)).replaceAll('=', ''),
    name: '测试电脑',
  );

  @override
  String get deviceId => 'device-1';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('ModelPreferences persistence & safety filtering', () {
    test('persists favorites, efforts, fast, and ultracode per instanceId/modelId across restarts', () async {
      final first = ProviderContainer();
      addTearDown(first.dispose);
      final notifier = first.read(modelPreferencesProvider.notifier);
      await notifier.ready;

      final opusKey = modelPreferenceKey('claude', 'opus');
      final codexKey = modelPreferenceKey('codex', 'gpt-5.4');

      await notifier.toggleFavorite(opusKey);
      await notifier.toggleFavorite(codexKey);
      await notifier.setEffort(opusKey, 'high');
      await notifier.setFast(opusKey, true);
      await notifier.setUltracode(opusKey, true);
      await notifier.setEffort(codexKey, 'xhigh');

      // 模拟应用重启：新建 ProviderContainer 从持久化存储重新读取。
      final restarted = ProviderContainer();
      addTearDown(restarted.dispose);
      await restarted.read(modelPreferencesProvider.notifier).ready;
      final loaded = restarted.read(modelPreferencesProvider);

      expect(loaded.favorites, [opusKey, codexKey]);
      expect(loaded.effortFor(opusKey), 'high');
      expect(loaded.isFast(opusKey), isTrue);
      expect(loaded.isUltracode(opusKey), isTrue);
      expect(loaded.effortFor(codexKey), 'xhigh');
      expect(loaded.isFast(codexKey), isFalse);

      // 切回默认（null）与关闭开关后会从持久化中清除对应键。
      final restartedNotifier = restarted.read(
        modelPreferencesProvider.notifier,
      );
      await restartedNotifier.setEffort(opusKey, null);
      await restartedNotifier.setFast(opusKey, false);
      await restartedNotifier.toggleFavorite(opusKey);

      final third = ProviderContainer();
      addTearDown(third.dispose);
      await third.read(modelPreferencesProvider.notifier).ready;
      final afterClear = third.read(modelPreferencesProvider);

      expect(afterClear.favorites, [codexKey]);
      expect(afterClear.effortFor(opusKey), isNull);
      expect(afterClear.isFast(opusKey), isFalse);
      expect(afterClear.isUltracode(opusKey), isTrue);
    });

    test('filters unsupported capabilities and strips all extensions for legacy computers', () {
      const fullModel = MobileDraftModel(
        id: 'opus',
        label: 'Opus',
        efforts: ['low', 'medium', 'high', 'max'],
        fast: true,
        ultracode: true,
      );
      const basicModel = MobileDraftModel(
        id: 'haiku',
        label: 'Haiku',
        efforts: [],
        fast: false,
        ultracode: false,
      );
      final opusKey = modelPreferenceKey('claude', 'opus');
      final haikuKey = modelPreferenceKey('claude', 'haiku');
      final prefs = ModelPreferences(
        efforts: {opusKey: 'high', haikuKey: 'max'},
        fast: {opusKey, haikuKey},
        ultracode: {opusKey, haikuKey},
      );

      final supported = resolveComposerRunOptions(
        supportsComposerControls: true,
        instanceId: 'claude',
        model: fullModel,
        preferences: prefs,
      );
      expect(supported.effort, 'high');
      expect(supported.fast, isTrue);
      expect(supported.ultracode, isTrue);

      // 模型不支持的能力绝不发送。
      final filtered = resolveComposerRunOptions(
        supportsComposerControls: true,
        instanceId: 'claude',
        model: basicModel,
        preferences: prefs,
      );
      expect(filtered.effort, isNull);
      expect(filtered.fast, isNull);
      expect(filtered.ultracode, isNull);

      // 旧版电脑（supportsComposerControls == false）绝不携带任何扩展字段。
      final legacy = resolveComposerRunOptions(
        supportsComposerControls: false,
        instanceId: 'claude',
        model: fullModel,
        preferences: prefs,
      );
      expect(legacy.effort, isNull);
      expect(legacy.fast, isNull);
      expect(legacy.ultracode, isNull);
    });

    test('RunCommandJournal round-trips effort, fast, ultracode, and references', () async {
      final journal = RunCommandJournal(_JournalConnection(), 'thread-1');
      const command = PendingSend(
        MobileStartRunParams(
          commandId: '00000000-0000-4000-8000-000000000042',
          threadId: 'thread-1',
          text: '带扩展参数的待确认命令',
          effort: 'xhigh',
          fast: true,
          ultracode: true,
          references: [
            MobileThreadReference(threadId: 'ref-1', title: '引用会话'),
          ],
        ),
      );
      await journal.reserve(command);

      final restored =
          await journal.read(MobileRunMethod.runStart) as PendingSend?;
      expect(restored, isNotNull);
      expect(restored!.params.effort, 'xhigh');
      expect(restored.params.fast, isTrue);
      expect(restored.params.ultracode, isTrue);
      expect(restored.params.references?.single.threadId, 'ref-1');
      expect(restored.params.references?.single.title, '引用会话');
    });

    test('maps known and unknown effort labels and agent entity initials consistently', () {
      expect(composerEffortLabel('none'), '不思考');
      expect(composerEffortLabel('minimal'), '最低');
      expect(composerEffortLabel('low'), '低');
      expect(composerEffortLabel('medium'), '中');
      expect(composerEffortLabel('high'), '高');
      expect(composerEffortLabel('xhigh'), '很高');
      expect(composerEffortLabel('max'), '最高');
      expect(composerEffortLabel('ultra'), '极限');
      expect(composerEffortLabel('turbo_max'), 'Turbo max');

      expect(agentEntityInitials('claude', 'Claude Code'), 'CC');
      expect(agentEntityInitials('codex', 'Codex'), 'CO');
      expect(agentEntityInitials('custom', '工作实例'), '工');
      expect(parseAgentAccentColor('#5279bf'), isNotNull);
      expect(parseAgentAccentColor('invalid'), isNull);
    });
  });
}
