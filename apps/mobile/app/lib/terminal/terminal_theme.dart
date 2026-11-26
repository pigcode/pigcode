import 'package:flutter/material.dart';
import 'package:xterm2/xterm.dart';

/// 手机端远程终端配色：直接对齐桌面 `tokens.css` 的 `--term-*` 亮/暗 16 色规范。
TerminalTheme pigcodeTerminalTheme(Brightness brightness) {
  if (brightness == Brightness.dark) {
    return const TerminalTheme(
      cursor: Color(0xFF528BFF),
      selection: Color(0x40528BFF),
      foreground: Color(0xFFE4E4E7),
      background: Color(0xFF161616),
      black: Color(0xFF2C2C38),
      red: Color(0xFFF87171),
      green: Color(0xFF4ADE80),
      yellow: Color(0xFFFBBF24),
      blue: Color(0xFF60A5FA),
      magenta: Color(0xFFC79BFF),
      cyan: Color(0xFF5CCFE0),
      white: Color(0xFFC8C8D4),
      brightBlack: Color(0xFF6B6B7D),
      brightRed: Color(0xFFFCA5A5),
      brightGreen: Color(0xFF86EFAC),
      brightYellow: Color(0xFFFDE68A),
      brightBlue: Color(0xFF9AB9FF),
      brightMagenta: Color(0xFFDAB8FF),
      brightCyan: Color(0xFF7FDEEC),
      brightWhite: Color(0xFFF4F4F8),
      searchHitBackground: Color(0x55FBBF24),
      searchHitBackgroundCurrent: Color(0x99F59E0B),
      searchHitForeground: Color(0xFF161616),
    );
  }
  return const TerminalTheme(
    cursor: Color(0xFF2563EB),
    selection: Color(0x2E2563EB),
    foreground: Color(0xFF27272A),
    background: Color(0xFFFFFFFF),
    black: Color(0xFF27272A),
    red: Color(0xFFDC2626),
    green: Color(0xFF16A34A),
    yellow: Color(0xFFB45309),
    blue: Color(0xFF2563EB),
    magenta: Color(0xFF8A3FD1),
    cyan: Color(0xFF0F7F8F),
    white: Color(0xFF6B6B7B),
    brightBlack: Color(0xFF8B8B9A),
    brightRed: Color(0xFFEF4444),
    brightGreen: Color(0xFF22C55E),
    brightYellow: Color(0xFFC27D00),
    brightBlue: Color(0xFF4B78EA),
    brightMagenta: Color(0xFFA259E6),
    brightCyan: Color(0xFF1496A8),
    brightWhite: Color(0xFF3A3A48),
    searchHitBackground: Color(0x44F59E0B),
    searchHitBackgroundCurrent: Color(0x88F59E0B),
    searchHitForeground: Color(0xFF27272A),
  );
}

TerminalStyle pigcodeTerminalStyle({double fontSize = 13}) => TerminalStyle(
  fontSize: fontSize,
  height: 1.25,
  fontFamily: 'Menlo',
  fontFamilyFallback: const ['SF Mono', 'JetBrains Mono', 'monospace'],
);
