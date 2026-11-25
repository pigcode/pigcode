import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/foundation.dart'
    show TargetPlatform, ValueListenable, defaultTargetPlatform, visibleForTesting;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show PlatformViewHitTestBehavior;
import 'package:flutter/services.dart';

import 'theme_colors.dart';

/// iOS 26+ 原生 `UIGlassEffect` 能力探测与实时监听（响应系统「降低透明度」开关变化）。
class MobileNativeGlass {
  MobileNativeGlass._();

  static final instance = MobileNativeGlass._();

  static const _channel = MethodChannel('pigcode/liquid-glass');
  static const viewType = 'pigcode/liquid-glass-surface';

  final ValueNotifier<bool> _supported = ValueNotifier<bool>(false);
  bool _initialized = false;

  ValueListenable<bool> get supported => _supported;

  void ensureInitialized() {
    if (_initialized) return;
    _initialized = true;
    if (defaultTargetPlatform != TargetPlatform.iOS) return;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'availabilityChanged' && call.arguments is bool) {
        _supported.value = call.arguments as bool;
      }
    });
    unawaited(
      _channel
          .invokeMethod<bool>('isSupported')
          .then<void>(
            (value) {
              if (value != null) _supported.value = value;
            },
            onError: (Object _) {
              _supported.value = false;
            },
          ),
    );
  }

  @visibleForTesting
  void setSupportedForTest(bool value) {
    _initialized = true;
    _supported.value = value;
  }
}

/// 悬浮液态玻璃壳（用于顶栏圆钮/胶囊、回底圆钮与底部悬浮输入卡片）：
/// - 在支持 iOS 26+ 原生液态玻璃的设备上，底层直接承载苹果原生 `UIVisualEffectView(effect: UIGlassEffect)`，
///   呈现真实的光学折射透镜、高光边缘与动态响应（与系统导航栏 / 原生 App 一致）；
/// - 在 iOS 13~18、Android、测试环境或系统开启「高对比度/降低透明度」时，自动无缝回退至清透毛玻璃或实色表面。
class MobileGlassSurface extends StatefulWidget {
  const MobileGlassSurface({
    super.key,
    required this.child,
    this.borderRadius = const BorderRadius.all(Radius.circular(999)),
    this.blurSigma = 14,
    this.shadows,
    this.borderColorOverride,
    this.tintOpacity,
    this.useNativeGlass = true,
    this.clipBehavior = Clip.antiAlias,
  });

  final Widget child;
  final BorderRadius borderRadius;
  final double blurSigma;
  final List<BoxShadow>? shadows;
  final Color? borderColorOverride;
  final double? tintOpacity;
  final bool useNativeGlass;
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

  bool get _isCapsule =>
      borderRadius.topLeft.x >= 500 && borderRadius.bottomRight.x >= 500;

  @override
  State<MobileGlassSurface> createState() => _MobileGlassSurfaceState();
}

class _MobileGlassSurfaceState extends State<MobileGlassSurface> {
  @override
  void initState() {
    super.initState();
    MobileNativeGlass.instance.ensureInitialized();
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final dark = brightness == Brightness.dark;
    final colors = dark ? pigcodeDark : pigcodeLight;
    final highContrast = MediaQuery.highContrastOf(context);
    final effectiveShadows =
        widget.shadows ?? MobileGlassSurface.defaultShadows(brightness);

    if (highContrast) {
      return DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surfaceRaised,
          borderRadius: widget.borderRadius,
          border: Border.all(
            color: widget.borderColorOverride ?? colors.strongBorder,
            width: 1,
          ),
          boxShadow: effectiveShadows,
        ),
        child: ClipRRect(
          borderRadius: widget.borderRadius,
          clipBehavior: widget.clipBehavior,
          child: widget.child,
        ),
      );
    }

    return ValueListenableBuilder<bool>(
      valueListenable: MobileNativeGlass.instance.supported,
      builder: (context, nativeSupported, child) {
        if (nativeSupported && widget.useNativeGlass) {
          return Stack(
            fit: StackFit.passthrough,
            clipBehavior: Clip.none,
            children: [
              Positioned.fill(
                child: IgnorePointer(
                  child: _NativeLiquidGlassBackdrop(
                    shape: widget._isCapsule ? 'capsule' : 'roundedRect',
                    radius: widget.borderRadius.topLeft.x,
                    dark: dark,
                  ),
                ),
              ),
              child!,
            ],
          );
        }

        // 旧版 iOS / Android / 视觉基线回退：保持清透的半透玻璃质感（避免 80% 乳白遮住穿透内容）。
        final topAlpha = widget.tintOpacity ?? (dark ? 0.56 : 0.62);
        final bottomAlpha = (topAlpha - 0.14).clamp(0.32, 0.85);
        final baseColor = dark
            ? const Color(0xFF2E2E32)
            : const Color(0xFFFFFFFF);

        return DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: widget.borderRadius,
            boxShadow: effectiveShadows,
          ),
          child: ClipRRect(
            borderRadius: widget.borderRadius,
            clipBehavior: widget.clipBehavior,
            child: BackdropFilter(
              filter: ImageFilter.blur(
                sigmaX: widget.blurSigma,
                sigmaY: widget.blurSigma,
              ),
              child: CustomPaint(
                foregroundPainter: _SpecularGlassRimPainter(
                  borderRadius: widget.borderRadius,
                  dark: dark,
                  outerBorderColor:
                      widget.borderColorOverride ??
                      (dark
                          ? const Color(0x33FFFFFF)
                          : const Color(0x1F18181B)),
                ),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    borderRadius: widget.borderRadius,
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
      },
      child: widget.child,
    );
  }
}

class _NativeLiquidGlassBackdrop extends StatefulWidget {
  const _NativeLiquidGlassBackdrop({
    required this.shape,
    required this.radius,
    required this.dark,
  });

  final String shape;
  final double radius;
  final bool dark;

  @override
  State<_NativeLiquidGlassBackdrop> createState() =>
      _NativeLiquidGlassBackdropState();
}

class _NativeLiquidGlassBackdropState
    extends State<_NativeLiquidGlassBackdrop> {
  MethodChannel? _viewChannel;

  Map<String, Object> get _params => {
    'shape': widget.shape,
    'radius': widget.radius,
    'dark': widget.dark,
    'style': 'regular',
  };

  @override
  void didUpdateWidget(covariant _NativeLiquidGlassBackdrop oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.shape != widget.shape ||
        oldWidget.radius != widget.radius ||
        oldWidget.dark != widget.dark) {
      unawaited(
        _viewChannel
            ?.invokeMethod<void>('update', _params)
            .catchError((Object _) {}),
      );
    }
  }

  @override
  Widget build(BuildContext context) => UiKitView(
    viewType: MobileNativeGlass.viewType,
    hitTestBehavior: PlatformViewHitTestBehavior.transparent,
    creationParams: _params,
    creationParamsCodec: const StandardMessageCodec(),
    onPlatformViewCreated: (viewId) {
      _viewChannel = MethodChannel('${MobileNativeGlass.viewType}/$viewId');
    },
  );
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

/// 顶栏背后的轻柔渐隐遮罩：
/// 只在最上方状态栏区域轻度柔化避免与系统时钟打架，顶栏悬浮胶囊背后保持足够通透，
/// 让滚动正文清晰进入 `UIGlassEffect` 透镜产生真实折射与边缘光晕。
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
    final blurHeight = statusBarHeight > 0 ? statusBarHeight + 8 : 0.0;

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
                    filter: ImageFilter.blur(sigmaX: 6, sigmaY: 6),
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
                    bg.withValues(alpha: 0.86),
                    bg.withValues(alpha: 0.44),
                    bg.withValues(alpha: 0.14),
                    bg.withValues(alpha: 0.0),
                  ],
                  stops: const [0.0, 0.36, 0.70, 1.0],
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
                bg.withValues(alpha: 0.45),
                bg.withValues(alpha: 0.86),
              ],
              stops: const [0.0, 0.5, 1.0],
            ),
          ),
        ),
      ),
    );
  }
}
