import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/foundation.dart'
    show
        TargetPlatform,
        ValueListenable,
        defaultTargetPlatform,
        visibleForTesting;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show PlatformViewHitTestBehavior;
import 'package:flutter/services.dart';

import 'mobile_surfaces.dart';
import 'theme_colors.dart';
import 'workspace_icon.dart';

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
    this.darkOverride,
    this.useNativeGlass = true,
    this.clipBehavior = Clip.antiAlias,
  });

  final Widget child;
  final BorderRadius borderRadius;
  final double blurSigma;
  final List<BoxShadow>? shadows;
  final Color? borderColorOverride;
  final double? tintOpacity;
  final bool? darkOverride;
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

  String get _nativeShape {
    if (borderRadius.topLeft.x >= 500 && borderRadius.bottomRight.x >= 500) {
      return 'capsule';
    }
    if (borderRadius.topLeft.x > 0 &&
        borderRadius.bottomLeft.x == 0 &&
        borderRadius.bottomRight.x == 0) {
      return 'topRounded';
    }
    return 'roundedRect';
  }

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
    final brightness = widget.darkOverride == null
        ? Theme.of(context).brightness
        : (widget.darkOverride! ? Brightness.dark : Brightness.light);
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
                    shape: widget._nativeShape,
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
            ? const [Color(0x47FFFFFF), Color(0x14FFFFFF), Color(0x24FFFFFF)]
            : const [Color(0xEBFFFFFF), Color(0x52FFFFFF), Color(0xB8FFFFFF)],
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

/// 顶栏背后的轻柔渐隐遮罩（纯渐变、无生硬裁切模糊带）：
/// 避免 Flutter `BackdropFilter` 与上层原生 `UIGlassEffect` 平台视图产生采样接缝，
/// 顶部状态栏柔化保护系统时间，顶栏悬浮胶囊背后保持清透以呈现真实光学折射。
class MobileTopGlassVeil extends StatelessWidget {
  const MobileTopGlassVeil({super.key, required this.height, this.color});

  final double height;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final bg = color ?? colors.background;

    return IgnorePointer(
      child: SizedBox(
        height: height,
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                bg.withValues(alpha: 0.92),
                bg.withValues(alpha: 0.62),
                bg.withValues(alpha: 0.16),
                bg.withValues(alpha: 0.0),
              ],
              stops: const [0.0, 0.34, 0.72, 1.0],
            ),
          ),
        ),
      ),
    );
  }
}

/// 轻量尺寸测量包装：用于动态同步悬浮顶栏/底栏高度到穿透滚动列表的留白。
class MobileMeasureSize extends StatefulWidget {
  const MobileMeasureSize({
    super.key,
    required this.onChange,
    required this.child,
  });

  final ValueChanged<Size> onChange;
  final Widget child;

  @override
  State<MobileMeasureSize> createState() => _MobileMeasureSizeState();
}

class _MobileMeasureSizeState extends State<MobileMeasureSize> {
  Size? _lastSize;

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final box = context.findRenderObject();
      if (box is! RenderBox || !box.hasSize) return;
      final size = box.size;
      if (_lastSize != size) {
        _lastSize = size;
        widget.onChange(size);
      }
    });
    return widget.child;
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

/// 二级页面顶栏与全屏浮层共用的液态玻璃按钮壳（圆钮或胶囊，保持与主界面顶栏一致的材质与触区）。
class MobileGlassChromeButton extends StatelessWidget {
  const MobileGlassChromeButton({
    super.key,
    required this.child,
    this.padding = EdgeInsets.zero,
    this.blurSigma = 16,
    this.darkOverride,
    this.useNativeGlass = true,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double blurSigma;
  final bool? darkOverride;
  final bool useNativeGlass;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding,
    child: MobileGlassSurface(
      blurSigma: blurSigma,
      darkOverride: darkOverride,
      useNativeGlass: useNativeGlass,
      child: Material(
        type: MaterialType.transparency,
        shape: const StadiumBorder(),
        child: child,
      ),
    ),
  );
}

/// 底部弹出面板共用的液态玻璃容器（顶角大圆角 + 柔和阴影 + 高可读度半透底层）。
class MobileGlassSheetSurface extends StatelessWidget {
  const MobileGlassSheetSurface({
    super.key,
    required this.child,
    this.borderRadius = const BorderRadius.vertical(top: Radius.circular(22)),
  });

  final Widget child;
  final BorderRadius borderRadius;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return MobileGlassSurface(
      borderRadius: borderRadius,
      blurSigma: 24,
      tintOpacity: dark ? 0.80 : 0.88,
      shadows: const [mobileSheetShadow],
      child: ClipRRect(
        borderRadius: borderRadius,
        child: Material(type: MaterialType.transparency, child: child),
      ),
    );
  }
}

/// 底部弹出面板右上角统一的轻量圆形关闭按钮（避免在玻璃弹层内部叠用双层玻璃）。
class MobileSheetCloseButton extends StatelessWidget {
  const MobileSheetCloseButton({
    super.key,
    required this.onPressed,
    this.buttonKey,
    this.tooltip = '关闭弹层',
    this.touchDimension,
  });

  final VoidCallback? onPressed;
  final Key? buttonKey;
  final String tooltip;
  final double? touchDimension;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch =
        touchDimension ??
        (theme.platform == TargetPlatform.android ? 48.0 : 44.0);
    return SizedBox.square(
      dimension: touch,
      child: IconButton(
        key: buttonKey,
        tooltip: tooltip,
        color: palette.foreground,
        padding: EdgeInsets.zero,
        onPressed: onPressed,
        icon: DecoratedBox(
          decoration: BoxDecoration(
            color: palette.field,
            shape: BoxShape.circle,
          ),
          child: const SizedBox.square(
            dimension: 32,
            child: Center(child: WorkspaceIcon(WorkspaceGlyph.close, size: 18)),
          ),
        ),
      ),
    );
  }
}

/// 确认对话框共用的液态玻璃卡片（替代原生不透明 Material AlertDialog，全应用弹窗风格一致）。
class MobileGlassDialog extends StatelessWidget {
  const MobileGlassDialog({
    super.key,
    required this.title,
    required this.content,
    required this.actions,
  });

  final Widget title;
  final Widget content;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final palette = dark ? pigcodeDark : pigcodeLight;
    const radius = BorderRadius.all(Radius.circular(24));
    return Dialog(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: MobileGlassSurface(
          borderRadius: radius,
          blurSigma: 24,
          tintOpacity: dark ? 0.84 : 0.90,
          shadows: const [mobileSheetShadow],
          child: ClipRRect(
            borderRadius: radius,
            child: Material(
              type: MaterialType.transparency,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(22, 22, 22, 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DefaultTextStyle.merge(
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        color: palette.foreground,
                        height: 1.4,
                      ),
                      child: title,
                    ),
                    const SizedBox(height: 10),
                    DefaultTextStyle.merge(
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontSize: 14,
                        color: palette.secondaryText,
                        height: 1.5,
                      ),
                      child: content,
                    ),
                    const SizedBox(height: 18),
                    OverflowBar(
                      alignment: MainAxisAlignment.end,
                      overflowAlignment: OverflowBarAlignment.end,
                      spacing: 8,
                      overflowSpacing: 8,
                      children: actions,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 底部输入框或侧栏底栏背后的柔和渐变托底：让滚动内容在悬浮卡片下方自然淡出。
class MobileBottomGlassVeil extends StatelessWidget {
  const MobileBottomGlassVeil({super.key, required this.height, this.color});

  final double height;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final bg = color ?? colors.background;
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
                bg.withValues(alpha: 0.88),
              ],
              stops: const [0.0, 0.5, 1.0],
            ),
          ),
        ),
      ),
    );
  }
}
