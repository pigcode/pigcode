import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/composer/composer_tokens.dart';
import 'package:pigcode_mobile/composer/context_meter.dart';

void main() {
  group('formatContextTokens', () {
    const cases = <(num, String)>[
      (-1, '0'),
      (0, '0'),
      (999, '999'),
      (1000, '1k'),
      (1500, '1.5k'),
      (9999, '10k'),
      (168000, '168k'),
      (999499, '999k'),
      (999500, '1m'),
      (1000000, '1m'),
      (1250000, '1.3m'),
    ];
    for (final (value, expected) in cases) {
      test('$value -> $expected', () {
        expect(formatContextTokens(value), expected);
      });
    }
  });

  group('computeContextLevel', () {
    test('prefers autoCompactTokens over maxTokens and classifies thresholds', () {
      final high = computeContextLevel(
        const MobileContextUsage(
          usedTokens: 87000,
          maxTokens: 200000,
          autoCompactTokens: 100000,
        ),
      );
      expect(high, isNotNull);
      expect(high!.ratio, closeTo(0.87, 0.0001));
      expect(high.level, ContextUsageLevel.high);

      final ok = computeContextLevel(
        const MobileContextUsage(usedTokens: 50, maxTokens: 100),
      );
      expect(ok?.level, ContextUsageLevel.ok);

      final full = computeContextLevel(
        const MobileContextUsage(usedTokens: 96, maxTokens: 100),
      );
      expect(full?.level, ContextUsageLevel.full);

      final capped = computeContextLevel(
        const MobileContextUsage(usedTokens: 300, maxTokens: 100),
      );
      expect(capped?.ratio, 1.0);
      expect(capped?.level, ContextUsageLevel.full);

      final noLimit = computeContextLevel(
        const MobileContextUsage(usedTokens: 50),
      );
      expect(noLimit, isNull);
    });
  });

  group('MobileContextMeter widget', () {
    ContextMeterRingPainter ringPainter(WidgetTester tester) =>
        tester.widget<CustomPaint>(find.byKey(MobileContextMeter.ringKey))
            .painter! as ContextMeterRingPainter;

    testWidgets('uses ok, attention (>=80%), danger (>=95%), and track-only (no limit) colors', (
      tester,
    ) async {
      Future<void> pumpUsage(
        MobileContextUsage usage, {
        TargetPlatform platform = TargetPlatform.iOS,
      }) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: pigcodeTheme(Brightness.light).copyWith(platform: platform),
            home: Scaffold(body: Center(child: MobileContextMeter(usage: usage))),
          ),
        );
        await tester.pumpAndSettle();
      }

      // 常规色
      await pumpUsage(
        const MobileContextUsage(usedTokens: 40000, maxTokens: 200000),
      );
      expect(
        ringPainter(tester).fillColor,
        ComposerSurface.contextRingOk(Brightness.light),
      );
      expect(ringPainter(tester).ratio, closeTo(0.2, 0.001));
      expect(tester.getSize(find.byTooltip('上下文占用')).width, 44);
      expect(tester.getSize(find.byTooltip('上下文占用')).height, 44);

      // >= 80% 偏高提醒色（按自动压缩线计算）
      await pumpUsage(
        const MobileContextUsage(
          usedTokens: 85000,
          maxTokens: 200000,
          autoCompactTokens: 100000,
        ),
        platform: TargetPlatform.android,
      );
      expect(
        ringPainter(tester).fillColor,
        ComposerSurface.contextRingHigh(Brightness.light),
      );
      expect(tester.getSize(find.byTooltip('上下文占用')).width, 48);
      expect(tester.getSize(find.byTooltip('上下文占用')).height, 48);

      // >= 95% 满载警示色
      await pumpUsage(
        const MobileContextUsage(usedTokens: 192000, maxTokens: 200000),
      );
      expect(
        ringPainter(tester).fillColor,
        ComposerSurface.contextRingFull(Brightness.light),
      );

      // 无上限只画底环不画进度
      await pumpUsage(const MobileContextUsage(usedTokens: 12000));
      expect(ringPainter(tester).fillColor, isNull);
      expect(ringPainter(tester).ratio, isNull);
    });

    testWidgets('opens detail bottom sheet on tap showing used, max, percent, and auto-compact remaining', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: pigcodeTheme(Brightness.light),
          home: const Scaffold(
            body: Center(
              child: MobileContextMeter(
                usage: MobileContextUsage(
                  usedTokens: 87000,
                  maxTokens: 200000,
                  autoCompactTokens: 100000,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('上下文占用'));
      await tester.pumpAndSettle();

      expect(find.text('上下文占用'), findsOneWidget);
      expect(find.text('已用 87k / 200k（44%）'), findsOneWidget);
      expect(find.text('到 100k 自动压缩，还剩 13k'), findsOneWidget);
      expect(find.text('自动压缩阈值'), findsOneWidget);
      expect(find.text('距离自动压缩剩余'), findsOneWidget);
      expect(find.text('13k'), findsOneWidget);
    });
  });
}
