import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'composer_tokens.dart';

/// 解析形如 `#RRGGBB` 的实例强调色；格式非法时返回 `null`。
Color? parseAgentAccentColor(String? hex) {
  if (hex == null || hex.length != 7 || !hex.startsWith('#')) return null;
  final value = int.tryParse(hex.substring(1), radix: 16);
  if (value == null) return null;
  return Color(0xFF000000 | value);
}

final _wideScriptPattern = RegExp(
  r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]',
);
final _wordSplitPattern = RegExp(
  r'[^0-9A-Za-z\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+',
);

/// 对齐桌面端 `entityMark(id, name)`：
/// 多个词取前两词首字母，单个词取前两字母；汉字/假名/谚文开头取首字。
String agentEntityInitials(String id, String name) {
  List<String> split(String text) =>
      text.split(_wordSplitPattern).where((part) => part.isNotEmpty).toList();
  final nameWords = split(name);
  final words = nameWords.isNotEmpty ? nameWords : split(id);
  final first = (words.isNotEmpty ? words.first : '?').runes.toList();
  final lead = String.fromCharCode(first.isNotEmpty ? first.first : 0x3F);
  if (_wideScriptPattern.hasMatch(lead)) return lead;
  final second = words.length > 1
      ? String.fromCharCode(words[1].runes.first)
      : first.length > 1
      ? String.fromCharCode(first[1])
      : '';
  final upper = '$lead$second'.toUpperCase();
  return upper.runes.length > 2
      ? String.fromCharCodes(upper.runes.take(2))
      : upper;
}

/// 手机端 Agent 图标：对齐桌面 `AgentIcon`，支持 `claude`、`codex`、`antigravity`
/// 品牌矢量标志与通用缩写头像，并在右下角渲染自定义实例 `accentColor` 圆点或缩写角标。
class AgentBadgeIcon extends StatelessWidget {
  const AgentBadgeIcon({
    super.key,
    required this.agentId,
    required this.name,
    this.instanceId,
    this.accentColor,
    this.size = ComposerControl.agentIconMd,
    this.ringColor,
  });

  final String agentId;
  final String name;
  final String? instanceId;
  final String? accentColor;
  final double size;
  final Color? ringColor;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final normalizedBrand = _brandOf(agentId);
    final effectiveInstance = instanceId ?? agentId;
    final parsedAccent = parseAgentAccentColor(accentColor);
    final badge = effectiveInstance != agentId
        ? agentEntityInitials(effectiveInstance, name)
        : null;
    final ring = ringColor ?? colors.surface;

    final Widget mark = switch (normalizedBrand) {
      _AgentBrand.claude => CustomPaint(
        size: Size.square(size),
        painter: const _ClaudeMarkPainter(ComposerSurface.brandClaude),
      ),
      _AgentBrand.codex => CustomPaint(
        size: Size.square(size),
        painter: _CodexMarkPainter(colors.foreground),
      ),
      _AgentBrand.antigravity => CustomPaint(
        size: Size.square(size),
        painter: const _AntigravityMarkPainter(),
      ),
      null => _InitialsAvatar(
        initials: agentEntityInitials(effectiveInstance, name),
        size: size,
        background: colors.field,
        borderColor: colors.border,
        foreground: colors.secondaryText,
      ),
    };

    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            mark,
            if (parsedAccent != null)
              Positioned(
                right: ComposerControl.agentAccentOffset,
                bottom: ComposerControl.agentAccentOffset,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: parsedAccent,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: ring,
                      width: ComposerBorder.indicator,
                    ),
                  ),
                  child: const SizedBox.square(
                    dimension: ComposerControl.agentAccentDot,
                  ),
                ),
              )
            else if (badge != null && normalizedBrand != null)
              Positioned(
                right: ComposerControl.agentBadgeOffset,
                bottom: ComposerControl.agentBadgeOffset,
                child: Container(
                  constraints: const BoxConstraints(
                    minWidth: ComposerControl.agentBadgeSize,
                  ),
                  height: ComposerControl.agentBadgeSize,
                  padding: const EdgeInsets.symmetric(
                    horizontal: ComposerControl.agentBadgePadding,
                  ),
                  decoration: BoxDecoration(
                    color: colors.muted,
                    borderRadius: BorderRadius.circular(ComposerRadius.full),
                    border: Border.all(
                      color: ring,
                      width: ComposerBorder.indicator,
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    badge,
                    style: TextStyle(
                      fontSize: ComposerControl.agentBadgeFontSize,
                      fontWeight: FontWeight.w600,
                      height: 1,
                      color: colors.surface,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

enum _AgentBrand { claude, codex, antigravity }

_AgentBrand? _brandOf(String agentId) => switch (agentId.toLowerCase()) {
  'claude' || 'claude-code' => _AgentBrand.claude,
  'codex' || 'openai' => _AgentBrand.codex,
  'antigravity' => _AgentBrand.antigravity,
  _ => null,
};

class _InitialsAvatar extends StatelessWidget {
  const _InitialsAvatar({
    required this.initials,
    required this.size,
    required this.background,
    required this.borderColor,
    required this.foreground,
  });

  final String initials;
  final double size;
  final Color background;
  final Color borderColor;
  final Color foreground;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(size * ComposerRadius.avatarRatio),
      border: Border.all(color: borderColor, width: ComposerBorder.hairline),
    ),
    child: SizedBox.square(
      dimension: size,
      child: Center(
        child: Text(
          initials,
          maxLines: 1,
          textScaler: TextScaler.noScaling,
          style: TextStyle(
            fontSize: size * ComposerControl.agentAvatarFontRatio,
            fontWeight: FontWeight.w600,
            height: 1,
            color: foreground,
          ),
        ),
      ),
    ),
  );
}

/// Anthropic 星芒矢量标志。
class _ClaudeMarkPainter extends CustomPainter {
  const _ClaudeMarkPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.shortestSide * 0.46;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.shortestSide * 0.11
      ..strokeCap = StrokeCap.round;
    const rays = 12;
    for (var i = 0; i < rays; i++) {
      final angle = (math.pi * 2 / rays) * i - math.pi / 2;
      final inner = i.isEven ? radius * 0.18 : radius * 0.24;
      final outer = i.isEven ? radius : radius * 0.88;
      canvas.drawLine(
        Offset(
          center.dx + math.cos(angle) * inner,
          center.dy + math.sin(angle) * inner,
        ),
        Offset(
          center.dx + math.cos(angle) * outer,
          center.dy + math.sin(angle) * outer,
        ),
        paint,
      );
    }
    canvas.drawCircle(center, radius * 0.2, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_ClaudeMarkPainter oldDelegate) =>
      oldDelegate.color != color;
}

/// OpenAI 六瓣环形矢量标志。
class _CodexMarkPainter extends CustomPainter {
  const _CodexMarkPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final ringRadius = size.shortestSide * 0.25;
    final petalOffset = size.shortestSide * 0.19;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.shortestSide * 0.105
      ..strokeJoin = StrokeJoin.round;
    const petals = 6;
    for (var i = 0; i < petals; i++) {
      final angle = (math.pi * 2 / petals) * i - math.pi / 2;
      final petalCenter = Offset(
        center.dx + math.cos(angle) * petalOffset,
        center.dy + math.sin(angle) * petalOffset,
      );
      canvas.drawArc(
        Rect.fromCircle(center: petalCenter, radius: ringRadius),
        angle - math.pi * 0.72,
        math.pi * 1.15,
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_CodexMarkPainter oldDelegate) =>
      oldDelegate.color != color;
}

/// Antigravity 彩色矢量标志。
class _AntigravityMarkPainter extends CustomPainter {
  const _AntigravityMarkPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final strokeWidth = size.shortestSide * 0.16;
    final leftPaint = Paint()
      ..color = ComposerSurface.brandAntigravityBlue
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final topPaint = Paint()
      ..color = ComposerSurface.brandAntigravityRed
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    final rightPaint = Paint()
      ..color = ComposerSurface.brandAntigravityGreen
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    final accentPaint = Paint()
      ..color = ComposerSurface.brandAntigravityYellow
      ..style = PaintingStyle.fill;

    canvas.drawLine(
      Offset(w * 0.22, h * 0.80),
      Offset(w * 0.50, h * 0.18),
      leftPaint,
    );
    canvas.drawLine(
      Offset(w * 0.50, h * 0.18),
      Offset(w * 0.78, h * 0.80),
      rightPaint,
    );
    canvas.drawArc(
      Rect.fromLTWH(w * 0.26, h * 0.44, w * 0.48, h * 0.32),
      math.pi * 1.1,
      math.pi * 0.8,
      false,
      topPaint,
    );
    canvas.drawCircle(
      Offset(w * 0.50, h * 0.20),
      strokeWidth * 0.45,
      accentPaint,
    );
  }

  @override
  bool shouldRepaint(_AntigravityMarkPainter oldDelegate) => false;
}
