import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme_colors.dart';

SystemUiOverlayStyle pigcodeSystemOverlay(Brightness brightness) {
  final style = brightness == Brightness.dark
      ? SystemUiOverlayStyle.light
      : SystemUiOverlayStyle.dark;
  return style.copyWith(
    statusBarColor: Colors.transparent,
    systemNavigationBarColor: Colors.transparent,
    systemNavigationBarDividerColor: Colors.transparent,
  );
}

ThemeData pigcodeTheme(Brightness brightness) {
  final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: colors.primary,
    onPrimary: colors.onPrimary,
    secondary: colors.primary,
    onSecondary: colors.onPrimary,
    error: colors.error,
    onError: colors.onError,
    surface: colors.surface,
    onSurface: colors.foreground,
    onSurfaceVariant: colors.secondaryText,
    surfaceContainerHighest: Color.alphaBlend(
      colors.selected,
      colors.background,
    ),
    outlineVariant: colors.divider,
  );
  final theme = ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: colors.background,
    appBarTheme: AppBarThemeData(
      backgroundColor: colors.background,
      foregroundColor: colors.foreground,
      surfaceTintColor: Colors.transparent,
      systemOverlayStyle: pigcodeSystemOverlay(brightness),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      modalBackgroundColor: colors.surface,
      modalBarrierColor: colors.scrim,
      surfaceTintColor: Colors.transparent,
      dragHandleSize: const Size(36, 5),
      dragHandleColor: colors.muted.withValues(alpha: .35),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      clipBehavior: Clip.antiAlias,
    ),
    cardTheme: CardThemeData(color: colors.surface),
    listTileTheme: ListTileThemeData(selectedTileColor: colors.selected),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      elevation: 2,
      backgroundColor: brightness == Brightness.dark
          ? const Color(0xF0262628)
          : const Color(0xF01C1C1E),
      contentTextStyle: const TextStyle(
        color: Colors.white,
        fontSize: 14,
        height: 1.4,
      ),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    visualDensity: VisualDensity.standard,
  );
  final text = theme.textTheme;
  const body = TextStyle(
    fontSize: 15,
    height: 1.45,
    fontWeight: FontWeight.w400,
    letterSpacing: 0,
  );
  return theme.copyWith(
    textTheme: text.copyWith(
      bodyLarge: text.bodyLarge?.merge(body),
      bodyMedium: text.bodyMedium?.merge(body),
      bodySmall: text.bodySmall?.copyWith(letterSpacing: 0),
      titleMedium: text.titleMedium?.copyWith(letterSpacing: 0),
      labelLarge: text.labelLarge?.copyWith(
        fontWeight: FontWeight.w500,
        letterSpacing: 0,
      ),
    ),
  );
}
