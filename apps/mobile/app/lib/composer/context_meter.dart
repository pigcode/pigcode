import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../mobile_sheet.dart';
import '../timeline/timeline_tokens.dart';
import 'composer_tokens.dart';

/// token 数简写（完全对齐桌面 `context-meter.tsx`）：
/// `<1000` 原样，`<10k` 一位小数去 `.0` 加 `k`，`<999500` 取整加 `k`，其余一位小数去 `.0` 加 `m`。
String formatContextTokens(num value) {
  if (!value.isFinite || value < 0) return '0';
  if (value < 1000) return '${value.round()}';
  if (value < 10000) {
    final text = (value / 1000).toStringAsFixed(1);
    return '${text.endsWith('.0') ? text.substring(0, text.length - 2) : text}k';
  }
  if (value < 999500) return '${(value / 1000).round()}k';
  final text = (value / 1000000).toStringAsFixed(1);
  return '${text.endsWith('.0') ? text.substring(0, text.length - 2) : text}m';
}

enum ContextUsageLevel { ok, high, full }

typedef ContextLevelInfo = ({double ratio, ContextUsageLevel level});

/// 上下文占用等级与比例（对齐桌面 `contextLevel`）：
/// 优先使用 `autoCompactTokens`，其次 `maxTokens`；无上限时返回 `null`。
/// `>= 0.95` 为满载警示（`full`），`>= 0.80` 为偏高提醒（`high`），其余为常规（`ok`）。
ContextLevelInfo? computeContextLevel(MobileContextUsage usage) {
  final limit = usage.autoCompactTokens ?? usage.maxTokens;
  if (limit == null || limit <= 0) return null;
  final ratio = (usage.usedTokens / limit).clamp(0.0, 1.0);
  final level = ratio >= 0.95
      ? ContextUsageLevel.full
      : ratio >= 0.80
      ? ContextUsageLevel.high
      : ContextUsageLevel.ok;
  return (ratio: ratio, level: level);
}

int? contextUsagePercent(MobileContextUsage usage) {
  final maxTokens = usage.maxTokens;
  if (maxTokens == null || maxTokens <= 0) return null;
  return ((usage.usedTokens / maxTokens) * 100).round();
}

String contextUsageSummary(MobileContextUsage usage) {
  final used = formatContextTokens(usage.usedTokens);
  final maxTokens = usage.maxTokens;
  final percent = contextUsagePercent(usage);
  if (maxTokens != null && percent != null) {
    return '已用 $used / ${formatContextTokens(maxTokens)}（$percent%）';
  }
  return '已用 $used（上限未知）';
}

String? contextUsageCompactSummary(MobileContextUsage usage) {
  final compact = usage.autoCompactTokens;
  if (compact == null) return null;
  final remaining = math.max(0, compact - usage.usedTokens);
  return '到 ${formatContextTokens(compact)} 自动压缩，还剩 ${formatContextTokens(remaining)}';
}

/// 手机端输入框底栏的上下文占用圆环，点按后展示详情弹层。
class MobileContextMeter extends StatelessWidget {
  const MobileContextMeter({
    super.key,
    required this.usage,
    this.onTap,
  });

  static const ringKey = ValueKey('composer-context-meter-ring');

  final MobileContextUsage usage;
  final VoidCallback? onTap;

  Color _levelColor(Brightness brightness, ContextUsageLevel level) =>
      switch (level) {
        ContextUsageLevel.ok => ComposerSurface.contextRingOk(brightness),
        ContextUsageLevel.high => ComposerSurface.contextRingHigh(brightness),
        ContextUsageLevel.full => ComposerSurface.contextRingFull(brightness),
      };

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final level = computeContextLevel(usage);
    final summary = contextUsageSummary(usage);
    final compact = contextUsageCompactSummary(usage);
    final semanticsLabel = [
      '上下文占用',
      summary,
      ?compact,
    ].join('，');
    final touch = timelineTouchHeight(context);
    final trackColor = ComposerSurface.contextRingTrack(brightness);
    final fillColor = level == null ? null : _levelColor(brightness, level.level);

    return Tooltip(
      message: '上下文占用',
      child: Semantics(
        button: true,
        label: semanticsLabel,
        child: SizedBox.square(
          dimension: touch,
          child: InkWell(
            onTap: onTap ?? () => showMobileContextUsageSheet(context, usage),
            customBorder: const CircleBorder(),
            child: Center(
              child: CustomPaint(
                key: ringKey,
                size: const Size.square(ComposerControl.contextMeterCanvas),
                painter: ContextMeterRingPainter(
                  trackColor: trackColor,
                  fillColor: fillColor,
                  ratio: level?.ratio,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class ContextMeterRingPainter extends CustomPainter {
  const ContextMeterRingPainter({
    required this.trackColor,
    required this.fillColor,
    required this.ratio,
  });

  final Color trackColor;
  final Color? fillColor;
  final double? ratio;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(
      ComposerControl.contextMeterRadius,
      (size.shortestSide - ComposerBorder.meterStroke) / 2,
    );
    final trackPaint = Paint()
      ..color = trackColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = ComposerBorder.meterStroke;
    canvas.drawCircle(center, radius, trackPaint);

    final sweepRatio = ratio;
    final progressColor = fillColor;
    if (sweepRatio == null || progressColor == null || sweepRatio <= 0) return;

    final fillPaint = Paint()
      ..color = progressColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = ComposerBorder.meterStroke
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      math.pi * 2 * sweepRatio,
      false,
      fillPaint,
    );
  }

  @override
  bool shouldRepaint(ContextMeterRingPainter oldDelegate) =>
      oldDelegate.trackColor != trackColor ||
      oldDelegate.fillColor != fillColor ||
      oldDelegate.ratio != ratio;
}

/// 点按上下文占用圆环后弹出的详情底部弹层。
Future<void> showMobileContextUsageSheet(
  BuildContext context,
  MobileContextUsage usage,
) => showMobileSheet<void>(
  context,
  title: '上下文占用',
  content: (sheetContext) => SliverToBoxAdapter(
    child: _ContextUsageDetailBody(usage: usage),
  ),
);

class _ContextUsageDetailBody extends StatelessWidget {
  const _ContextUsageDetailBody({required this.usage});

  final MobileContextUsage usage;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final level = computeContextLevel(usage);
    final summary = contextUsageSummary(usage);
    final compact = contextUsageCompactSummary(usage);
    final percent = contextUsagePercent(usage);
    final remaining = usage.autoCompactTokens == null
        ? null
        : math.max(0, usage.autoCompactTokens! - usage.usedTokens);
    final barColor = switch (level?.level) {
      ContextUsageLevel.full => ComposerSurface.contextRingFull(brightness),
      ContextUsageLevel.high => ComposerSurface.contextRingHigh(brightness),
      ContextUsageLevel.ok || null => ComposerSurface.contextRingOk(brightness),
    };

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: ComposerSpace.contextDetailGap,
      children: [
        Container(
          padding: ComposerSpace.contextCardPadding,
          decoration: BoxDecoration(
            color: colors.field,
            borderRadius: BorderRadius.circular(ComposerRadius.panel),
            border: Border.all(
              color: colors.divider,
              width: ComposerBorder.hairline,
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: ComposerSpace.contextDetailRowGap,
            children: [
              Text(
                summary,
                style: ComposerType.contextHeadline(colors.foreground),
              ),
              if (level != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(ComposerRadius.full),
                  child: SizedBox(
                    height: ComposerControl.contextProgressBarHeight,
                    child: LayoutBuilder(
                      builder: (context, constraints) => Stack(
                        children: [
                          Positioned.fill(
                            child: ColoredBox(color: colors.switchTrack),
                          ),
                          Positioned(
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: constraints.maxWidth * level.ratio,
                            child: ColoredBox(color: barColor),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              if (compact != null)
                Text(
                  compact,
                  style: ComposerType.contextDetail(colors.secondaryText),
                ),
            ],
          ),
        ),
        Column(
          mainAxisSize: MainAxisSize.min,
          spacing: ComposerSpace.contextDetailRowGap,
          children: [
            _MetricRow(
              label: '已用上下文',
              value: formatContextTokens(usage.usedTokens),
            ),
            if (usage.maxTokens case final maxTokens?)
              _MetricRow(
                label: '上下文上限',
                value: percent == null
                    ? formatContextTokens(maxTokens)
                    : '${formatContextTokens(maxTokens)}（$percent%）',
              ),
            if (usage.autoCompactTokens case final autoCompact?) ...[
              _MetricRow(
                label: '自动压缩阈值',
                value: formatContextTokens(autoCompact),
              ),
              _MetricRow(
                label: '距离自动压缩剩余',
                value: formatContextTokens(remaining!),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = ComposerSurface.palette(Theme.of(context).brightness);
    return Row(
      children: [
        Expanded(
          child: Text(label, style: ComposerType.contextDetail(colors.muted)),
        ),
        Text(value, style: ComposerType.contextDetail(colors.foreground)),
      ],
    );
  }
}
