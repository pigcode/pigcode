import 'package:flutter/material.dart';

import '../mobile_glass.dart';
import '../theme_colors.dart';

/// 当 `Ctrl` 黏滞修饰键处于激活态时，把单个 ASCII 字符转换为对应控制字符。
/// 例如：`c` / `C` → `\x03`，`d` / `D` → `\x04`，`z` / `Z` → `\x1a`。
String applyStickyCtrl(String input) {
  if (input.length != 1) return input;
  final code = input.codeUnitAt(0);
  if (code >= 0x41 && code <= 0x5A) {
    return String.fromCharCode(code - 0x40);
  }
  if (code >= 0x61 && code <= 0x7A) {
    return String.fromCharCode(code - 0x60);
  }
  return switch (input) {
    '[' => '\x1b',
    '\\' => '\x1c',
    ']' => '\x1d',
    '^' => '\x1e',
    '_' => '\x1f',
    '@' => '\x00',
    _ => input,
  };
}

/// 软键盘上方的液态玻璃终端快捷按键栏。
class TerminalShortcutBar extends StatelessWidget {
  const TerminalShortcutBar({
    super.key,
    required this.ctrlArmed,
    required this.enabled,
    required this.onToggleCtrl,
    required this.onSendSequence,
    required this.onPaste,
    required this.onHideKeyboard,
  });

  static const escKey = ValueKey('terminal-key-esc');
  static const tabKey = ValueKey('terminal-key-tab');
  static const ctrlKey = ValueKey('terminal-key-ctrl');
  static const ctrlCKey = ValueKey('terminal-key-ctrl-c');
  static const upKey = ValueKey('terminal-key-up');
  static const downKey = ValueKey('terminal-key-down');
  static const leftKey = ValueKey('terminal-key-left');
  static const rightKey = ValueKey('terminal-key-right');
  static const pasteKey = ValueKey('terminal-key-paste');
  static const clearKey = ValueKey('terminal-key-clear');
  static const hideKeyboardKey = ValueKey('terminal-key-hide-keyboard');

  final bool ctrlArmed;
  final bool enabled;
  final VoidCallback onToggleCtrl;
  final ValueChanged<String> onSendSequence;
  final VoidCallback onPaste;
  final VoidCallback onHideKeyboard;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
        child: MobileGlassSurface(
          borderRadius: BorderRadius.circular(22),
          child: SizedBox(
            height: 42,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                spacing: 6,
                children: [
                  _ShortcutChip(
                    key: escKey,
                    label: 'Esc',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x1b'),
                  ),
                  _ShortcutChip(
                    key: tabKey,
                    label: 'Tab',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\t'),
                  ),
                  _ShortcutChip(
                    key: ctrlKey,
                    label: 'Ctrl',
                    active: ctrlArmed,
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: onToggleCtrl,
                  ),
                  _ShortcutChip(
                    key: ctrlCKey,
                    label: 'Ctrl+C',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x03'),
                  ),
                  _ShortcutChip(
                    key: upKey,
                    label: '↑',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x1b[A'),
                  ),
                  _ShortcutChip(
                    key: downKey,
                    label: '↓',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x1b[B'),
                  ),
                  _ShortcutChip(
                    key: leftKey,
                    label: '←',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x1b[D'),
                  ),
                  _ShortcutChip(
                    key: rightKey,
                    label: '→',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x1b[C'),
                  ),
                  _ShortcutChip(
                    key: pasteKey,
                    label: '粘贴',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: onPaste,
                  ),
                  _ShortcutChip(
                    key: clearKey,
                    label: '清屏',
                    enabled: enabled,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: () => onSendSequence('\x0c'),
                  ),
                  _ShortcutChip(
                    key: hideKeyboardKey,
                    label: '收起',
                    enabled: true,
                    foreground: colors.foreground,
                    background: colors.background,
                    field: colors.field,
                    muted: colors.muted,
                    onTap: onHideKeyboard,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ShortcutChip extends StatelessWidget {
  const _ShortcutChip({
    super.key,
    required this.label,
    required this.enabled,
    required this.foreground,
    required this.background,
    required this.field,
    required this.muted,
    required this.onTap,
    this.active = false,
  });

  final String label;
  final bool enabled;
  final bool active;
  final Color foreground;
  final Color background;
  final Color field;
  final Color muted;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bg = active ? foreground : field.withValues(alpha: 0.72);
    final fg = active ? background : (enabled ? foreground : muted);
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: active ? FontWeight.w600 : FontWeight.w500,
              color: fg,
              height: 1.15,
            ),
          ),
        ),
      ),
    );
  }
}
