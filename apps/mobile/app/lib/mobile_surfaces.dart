import 'package:flutter/material.dart';

import 'theme_colors.dart';

const mobileComposerTextStyle = TextStyle(fontSize: 16, height: 1.375);

// 在方案 D 的侧栏背景与实际会话行上共同校准 Flutter 的阴影。
BoxShadow mobileDrawerShadow(Brightness brightness) =>
    brightness == Brightness.dark
    ? const BoxShadow(
        color: Color(0x1D141414),
        blurRadius: 31.19,
        spreadRadius: -.24,
        offset: Offset(-10.9, 0),
      )
    : const BoxShadow(
        color: Color(0x1E171717),
        blurRadius: 31.19,
        spreadRadius: -.24,
        offset: Offset(-11.25, 0),
      );

const mobileSheetShadow = BoxShadow(
  color: Color(0x2218181B),
  blurRadius: 31.61,
  offset: Offset(0, -13.5),
);

BoxDecoration mobileComposerSurface(
  Brightness brightness, {
  bool offline = false,
}) {
  final dark = brightness == Brightness.dark;
  final colors = dark ? pigcodeDark : pigcodeLight;
  return BoxDecoration(
    color: offline
        ? Color.alphaBlend(colors.surfaceSunken, colors.background)
        : colors.surface,
    borderRadius: BorderRadius.circular(22),
    border: Border.all(color: colors.strongBorder),
    // 参数以方案 D 在 3× 视口中的阴影渐变为准。
    boxShadow: [
      dark
          ? const BoxShadow(
              color: Color(0x1E000000),
              offset: Offset(0, 1.77),
              blurRadius: 11.83,
              spreadRadius: .61,
            )
          : const BoxShadow(
              color: Color(0x0F151515),
              offset: Offset(0, 2.18),
              blurRadius: 7.92,
              spreadRadius: .24,
            ),
    ],
  );
}

BoxDecoration mobileRaisedSurface(
  Brightness brightness, {
  BorderRadius radius = const BorderRadius.all(Radius.circular(999)),
  Color? fill,
}) {
  final dark = brightness == Brightness.dark;
  final colors = dark ? pigcodeDark : pigcodeLight;
  return BoxDecoration(
    color: fill ?? colors.surface,
    borderRadius: radius,
    boxShadow: [
      BoxShadow(
        color: dark ? const Color(0x4D000000) : const Color(0x0D151515),
        offset: const Offset(0, 1),
        blurRadius: dark ? 2.43 : .65,
        spreadRadius: dark ? 0 : .04,
      ),
      BoxShadow(color: colors.border, spreadRadius: .5),
    ],
  );
}
