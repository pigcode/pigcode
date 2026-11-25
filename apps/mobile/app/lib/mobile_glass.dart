import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import 'theme_colors.dart';

/// 悬浮液态玻璃壳（用于顶栏圆钮/胶囊、回底圆钮与底部悬浮输入卡片）：
/// - 采用 `BackdropFilter` 实时背景模糊 + 方向性高光晶边（Specular Rim）+ 柔和投影；
/// - 兼容 iOS 13~27 与 Android，无原生版本限制；系统开启「高对比度/降低透明度」时自动退回清晰实色表面。
class MobileGlassSurface extends StatelessWidget {
  const MobileGlassSurface({
    super.key,
    required this.child,
    this.borderRadius = const BorderRadius.all(Radius.circular(999)),
    this.blurSigma = 20,
    this.shadows,
    this.borderColorOverride,
    this.tintOpacity,
    this.clipBehavior = Clip.antiAlias,
  });

  final Widget child;
  final BorderRadius borderRadius;
  final double blurSigma;
  final List<BoxShadow>? shadows;
  final Color? borderColorOverride;
  final double? tintOpacity;
  final Clip clipBehavior;

  static List<BoxShadow> defaultShadows(Brightness brightness) =>
      brightness == Brightness.dark
      ? const [
          BoxShadow(
            color: Color(0x52000000),
            offset: Offset(0, 4),
            blurRadius: 16,
          ),
          BoxShadow(
            color: Color(0x26000000),
            offset: Offset(0, 1),
            blurRadius: 3,
          ),
        ]
      : const [
          BoxShadow(
            color: Color(0x14151518),
            offset: Offset(0, 4),
            blurRadius: 16,
          ),
          BoxShadow(
            color: Color(0x0A151518),
            offset: Offset(0, 1),
            blurRadius: 2.5,
          ),
        ];

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final dark = brightness == Brightness.dark;
    final colors = dark ? pigcodeDark : pigcodeLight;
    final highContrast = MediaQuery.highContrastOf(context);
    final effectiveShadows = shadows ?? defaultShadows(brightness);

    if (highContrast) {
      return DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surfaceRaised,
          borderRadius: borderRadius,
          border: Border.all(
            color: borderColorOverride ?? colors.strongBorder,
            width: 1,
          ),
          boxShadow: effectiveShadows,
        ),
        child: ClipRRect(
          borderRadius: borderRadius,
          clipBehavior: clipBehavior,
          child: child,
        ),
      );
    }

    final topAlpha = tintOpacity ?? (dark ? 0.72 : 0.78);
    final bottomAlpha = (topAlpha - 0.12).clamp(0.45, 0.92);
    final baseColor = dark ? const Color(0xFF2E2E32) : const Color(0xFFFFFFFF);

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: borderRadius,
        boxShadow: effectiveShadows,
      ),
      child: ClipRRect(
        borderRadius: borderRadius,
        clipBehavior: clipBehavior,
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
          child: CustomPaint(
            foregroundPainter: _SpecularGlassRimPainter(
              borderRadius: borderRadius,
              dark: dark,
              outerBorderColor:
                  borderColorOverride ??
                  (dark ? const Color(0x2EFFFFFF) : const Color(0x1C18181B)),
            ),
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: borderRadius,
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    baseColor.withValues(alpha: topAlpha),
                    baseColor.withValues(alpha: bottomAlpha),
                  ],
                ),
              ),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

class _SpecularGlassRimPainter extends CustomPainter {
  const _SpecularGlassRimPainter({
    required this.borderRadius,
    required this.dark,
    required this.outerBorderColor,
  });

  final BorderRadius borderRadius;
  final bool dark;
  final Color outerBorderColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final rect = Offset.zero & size;

    // 内层高光晶边：顶部更亮、底部渐弱，模拟液态玻璃在顶光下的折射边缘。
    final innerRRect = borderRadius.toRRect(rect).deflate(0.75);
    final innerPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.0
      ..shader = LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: dark
            ? const [
                Color(0x47FFFFFF),
                Color(0x14FFFFFF),
                Color(0x24FFFFFF),
              ]
            : const [
                Color(0xEBFFFFFF),
                Color(0x52FFFFFF),
                Color(0xB8FFFFFF),
              ],
        stops: const [0.0, 0.52, 1.0],
      ).createShader(rect);
    canvas.drawRRect(innerRRect, innerPaint);

    // 外层极细轮廓线，确保浅底白玻璃也有清晰的边界轮廓。
    if (outerBorderColor.a > 0) {
      final outerRRect = borderRadius.toRRect(rect).deflate(0.25);
      final outerPaint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.5
        ..color = outerBorderColor;
      canvas.drawRRect(outerRRect, outerPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _SpecularGlassRimPainter oldDelegate) =>
      oldDelegate.borderRadius != borderRadius ||
      oldDelegate.dark != dark ||
      oldDelegate.outerBorderColor != outerBorderColor;
}

/// 顶栏背后的渐隐柔和遮罩：正文滚动穿透顶栏和状态栏时平滑淡出，
/// 状态栏区域额外叠加轻度高斯模糊，避免滚动文字与系统时间/灵动岛重叠打架。
class MobileTopGlassVeil extends StatelessWidget {
  const MobileTopGlassVeil({
    super.key,
    required this.height,
    this.statusBarHeight = 0,
  });

  final double height;
  final double statusBarHeight;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final bg = colors.background;
    final highContrast = MediaQuery.highContrastOf(context);
    final blurHeight = statusBarHeight > 0 ? statusBarHeight + 10 : 0.0;

    return IgnorePointer(
      child: SizedBox(
        height: height,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (!highContrast && blurHeight > 0)
              Positioned(
                top: 0,
                left: 0,
                right: 0,
                height: blurHeight,
                child: ClipRect(
                  child: BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                    child: const SizedBox.expand(),
                  ),
                ),
              ),
            DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    bg.withValues(alpha: 0.94),
                    bg.withValues(alpha: 0.84),
                    bg.withValues(alpha: 0.42),
                    bg.withValues(alpha: 0.0),
                  ],
                  stops: const [0.0, 0.48, 0.78, 1.0],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 向穿透滚动的内容区传递悬浮顶栏占用的安全高度，避免直接改写外层回调签名。
class MobileChromeInsets extends InheritedWidget {
  const MobileChromeInsets({
    super.key,
    required this.topInset,
    required super.child,
  });

  final double topInset;

  static double topOf(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<MobileChromeInsets>()
          ?.topInset ??
      0;

  @override
  bool updateShouldNotify(covariant MobileChromeInsets oldWidget) =>
      oldWidget.topInset != topInset;
}

/// 底部输入框背后的柔和渐变托底：让滚动消息在输入卡片下方自然淡出。
class MobileBottomGlassVeil extends StatelessWidget {
  const MobileBottomGlassVeil({super.key, required this.height});

  final double height;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final bg = colors.background;
    return IgnorePointer(
      child: SizedBox(
        height: height,
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                bg.withValues(alpha: 0.0),
                bg.withValues(alpha: 0.68),
                bg.withValues(alpha: 0.94),
              ],
              stops: const [0.0, 0.45, 1.0],
            ),
          ),
        ),
      ),
    );
  }
}
