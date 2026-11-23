import 'package:flutter/material.dart';

import 'theme_colors.dart';

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
    cardTheme: CardThemeData(color: colors.surface),
    listTileTheme: ListTileThemeData(selectedTileColor: colors.selected),
    visualDensity: VisualDensity.standard,
  );
  final text = theme.textTheme;
  const body = TextStyle(
    fontSize: 15,
    height: 1.45,
    fontWeight: FontWeight.w400,
  );
  return theme.copyWith(
    textTheme: text.copyWith(
      bodyLarge: text.bodyLarge?.merge(body),
      bodyMedium: text.bodyMedium?.merge(body),
      labelLarge: text.labelLarge?.copyWith(fontWeight: FontWeight.w500),
    ),
  );
}
