import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../mobile_glass.dart';
import '../theme_colors.dart';

/// 修饰键（Ctrl / Alt）的黏滞模式：仿 UU 远程「组合键模式」。
/// - [off]：未激活；
/// - [once]：单次组合有效（发送下一键后自动释放）；
/// - [locked]：锁定连发（持续生效直至再次点击解除，方便连续操作多个组合键）。
enum TerminalModifierMode { off, once, locked }

/// 根据当前 [ctrl] / [alt] 修饰键把单个 ASCII 字符转换为对应控制/Meta 转义序列。
/// 例如：`ctrl=true, 'c' -> '\x03'`；`alt=true, 'b' -> '\x1bb'`；`ctrl+alt+'c' -> '\x1b\x03'`。
String applyTerminalModifiers(
  String input, {
  bool ctrl = false,
  bool alt = false,
}) {
  if (!ctrl && !alt) return input;
  var result = ctrl ? applyStickyCtrl(input) : input;
  if (alt && result.isNotEmpty) {
    result = '\x1b$result';
  }
  return result;
}

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
    ' ' => '\x00',
    _ => input,
  };
}

/// 终端快捷控制条：支持长按连发按键、单次/锁定修饰键、切换 UU 风格扩展全键盘或折叠悬浮球。
class TerminalShortcutBar extends StatelessWidget {
  const TerminalShortcutBar({
    super.key,
    required this.ctrlMode,
    required this.altMode,
    required this.expandedOpen,
    required this.enabled,
    required this.onCycleCtrl,
    required this.onLockCtrl,
    required this.onCycleAlt,
    required this.onLockAlt,
    required this.onToggleExpanded,
    required this.onShowSystemKeyboard,
    required this.onSendSequence,
    required this.onPaste,
    required this.onCollapse,
  });

  static const escKey = ValueKey('terminal-key-esc');
  static const tabKey = ValueKey('terminal-key-tab');
  static const shiftTabKey = ValueKey('terminal-key-shift-tab');
  static const ctrlKey = ValueKey('terminal-key-ctrl');
  static const altKey = ValueKey('terminal-key-alt');
  static const ctrlCKey = ValueKey('terminal-key-ctrl-c');
  static const upKey = ValueKey('terminal-key-up');
  static const downKey = ValueKey('terminal-key-down');
  static const leftKey = ValueKey('terminal-key-left');
  static const rightKey = ValueKey('terminal-key-right');
  static const pasteKey = ValueKey('terminal-key-paste');
  static const clearKey = ValueKey('terminal-key-clear');
  static const expandKey = ValueKey('terminal-key-expand-panel');
  static const systemKeyboardKey = ValueKey('terminal-key-system-keyboard');
  static const hideKeyboardKey = ValueKey('terminal-key-hide-keyboard');

  final TerminalModifierMode ctrlMode;
  final TerminalModifierMode altMode;
  final bool expandedOpen;
  final bool enabled;
  final VoidCallback onCycleCtrl;
  final VoidCallback onLockCtrl;
  final VoidCallback onCycleAlt;
  final VoidCallback onLockAlt;
  final VoidCallback onToggleExpanded;
  final VoidCallback onShowSystemKeyboard;
  final ValueChanged<String> onSendSequence;
  final VoidCallback onPaste;
  final VoidCallback onCollapse;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;

    return Padding(
      padding: EdgeInsets.fromLTRB(10, 6, 10, expandedOpen ? 4 : 8),
      child: MobileGlassSurface(
        borderRadius: BorderRadius.circular(20),
        child: SizedBox(
          height: 44,
          child: Row(
            children: [
              const SizedBox(width: 6),
              // 左侧固定：在「PC 终端扩展键盘」与「系统键盘」间切换
              _ShortcutActionIcon(
                key: expandedOpen ? systemKeyboardKey : expandKey,
                tooltip: expandedOpen ? '切换到系统输入法' : '展开终端扩展键盘',
                icon: expandedOpen
                    ? Icons.keyboard_alt_outlined
                    : Icons.grid_view_rounded,
                active: expandedOpen,
                enabled: enabled,
                onTap: expandedOpen ? onShowSystemKeyboard : onToggleExpanded,
              ),
              Container(
                width: 1,
                height: 20,
                margin: const EdgeInsets.symmetric(horizontal: 4),
                color: colors.divider,
              ),
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 2),
                  child: Row(
                    spacing: 5,
                    children: [
                      _ShortcutChip(
                        key: escKey,
                        label: 'Esc',
                        enabled: enabled,
                        onTap: () => onSendSequence('\x1b'),
                      ),
                      _ShortcutChip(
                        key: tabKey,
                        label: 'Tab',
                        enabled: enabled,
                        onTap: () => onSendSequence('\t'),
                      ),
                      _ShortcutChip(
                        key: shiftTabKey,
                        label: '⇧Tab',
                        enabled: enabled,
                        onTap: () => onSendSequence('\x1b[Z'),
                      ),
                      _ModifierChip(
                        key: ctrlKey,
                        label: 'Ctrl',
                        mode: ctrlMode,
                        enabled: enabled,
                        onTap: onCycleCtrl,
                        onLongPress: onLockCtrl,
                      ),
                      _ModifierChip(
                        key: altKey,
                        label: 'Alt',
                        mode: altMode,
                        enabled: enabled,
                        onTap: onCycleAlt,
                        onLongPress: onLockAlt,
                      ),
                      _ShortcutChip(
                        key: ctrlCKey,
                        label: '^C',
                        accentDanger: true,
                        enabled: enabled,
                        onTap: () => onSendSequence('\x03'),
                      ),
                      _ShortcutChip(
                        key: upKey,
                        label: '↑',
                        repeatable: true,
                        enabled: enabled,
                        onTap: () => onSendSequence('\x1b[A'),
                      ),
                      _ShortcutChip(
                        key: downKey,
                        label: '↓',
                        repeatable: true,
                        enabled: enabled,
                        onTap: () => onSendSequence('\x1b[B'),
                      ),
                      _ShortcutChip(
                        key: leftKey,
                        label: '←',
                        repeatable: true,
                        enabled: enabled,
                        onTap: () => onSendSequence('\x1b[D'),
                      ),
                      _ShortcutChip(
                        key: rightKey,
                        label: '→',
                        repeatable: true,
                        enabled: enabled,
                        onTap: () => onSendSequence('\x1b[C'),
                      ),
                      _ShortcutChip(
                        key: pasteKey,
                        label: '粘贴',
                        enabled: enabled,
                        onTap: onPaste,
                      ),
                      _ShortcutChip(
                        key: clearKey,
                        label: '清屏',
                        enabled: enabled,
                        onTap: () => onSendSequence('\x0c'),
                      ),
                    ],
                  ),
                ),
              ),
              Container(
                width: 1,
                height: 20,
                margin: const EdgeInsets.symmetric(horizontal: 4),
                color: colors.divider,
              ),
              _ShortcutActionIcon(
                key: hideKeyboardKey,
                tooltip: '收起键盘与工具条',
                icon: Icons.keyboard_hide_rounded,
                active: false,
                enabled: true,
                onTap: onCollapse,
              ),
              const SizedBox(width: 6),
            ],
          ),
        ),
      ),
    );
  }
}

/// 仿 UU 远程的轻量右下角悬浮胶囊：工具栏和键盘全收起时浮出，最大化终端可视区域。
class TerminalFloatingPill extends StatelessWidget {
  const TerminalFloatingPill({
    super.key,
    required this.enabled,
    required this.onShowSystemKeyboard,
    required this.onShowExpandedKeyboard,
    required this.onSendCtrlC,
  });

  static const pillKey = ValueKey('terminal-floating-pill');
  static const openKeyboardKey = ValueKey('terminal-pill-keyboard');
  static const openExpandedKey = ValueKey('terminal-pill-expanded');

  final bool enabled;
  final VoidCallback onShowSystemKeyboard;
  final VoidCallback onShowExpandedKeyboard;
  final VoidCallback onSendCtrlC;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return MobileGlassSurface(
      key: pillKey,
      borderRadius: BorderRadius.circular(22),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _PillIconBtn(
              key: openKeyboardKey,
              tooltip: '呼出系统键盘',
              icon: Icons.keyboard_rounded,
              color: colors.foreground,
              onTap: enabled ? onShowSystemKeyboard : null,
            ),
            _PillIconBtn(
              key: openExpandedKey,
              tooltip: '终端扩展键盘',
              icon: Icons.grid_view_rounded,
              color: colors.foreground,
              onTap: enabled ? onShowExpandedKeyboard : null,
            ),
            Container(
              width: 1,
              height: 18,
              margin: const EdgeInsets.symmetric(horizontal: 3),
              color: colors.divider,
            ),
            InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: enabled
                  ? () {
                      HapticFeedback.lightImpact();
                      onSendCtrlC();
                    }
                  : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                child: Text(
                  '^C',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: enabled ? colors.error : colors.faint,
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

class _PillIconBtn extends StatelessWidget {
  const _PillIconBtn({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.color,
    this.onTap,
  });

  final String tooltip;
  final IconData icon;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: 34,
      child: IconButton(
        tooltip: tooltip,
        padding: EdgeInsets.zero,
        onPressed: onTap,
        icon: Icon(
          icon,
          size: 18,
          color: onTap == null ? color.withValues(alpha: 0.4) : color,
        ),
      ),
    );
  }
}

class _ShortcutActionIcon extends StatelessWidget {
  const _ShortcutActionIcon({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.active,
    required this.enabled,
    required this.onTap,
  });

  final String tooltip;
  final IconData icon;
  final bool active;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final bg = active ? colors.primary : Colors.transparent;
    final fg = active
        ? colors.onPrimary
        : (enabled ? colors.foreground : colors.faint);
    return Tooltip(
      message: tooltip,
      child: Material(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: enabled
              ? () {
                  HapticFeedback.selectionClick();
                  onTap();
                }
              : null,
          child: SizedBox(
            width: 34,
            height: 32,
            child: Icon(icon, size: 18, color: fg),
          ),
        ),
      ),
    );
  }
}

class _ModifierChip extends StatelessWidget {
  const _ModifierChip({
    super.key,
    required this.label,
    required this.mode,
    required this.enabled,
    required this.onTap,
    required this.onLongPress,
  });

  final String label;
  final TerminalModifierMode mode;
  final bool enabled;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final active = mode != TerminalModifierMode.off;
    final locked = mode == TerminalModifierMode.locked;
    final bg = active ? colors.primary : colors.field;
    final fg = active
        ? colors.onPrimary
        : (enabled ? colors.foreground : colors.muted);
    return Material(
      color: bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: active
            ? BorderSide(
                color: locked ? colors.statusAccent : Colors.transparent,
                width: locked ? 1.5 : 0,
              )
            : BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: enabled
            ? () {
                HapticFeedback.selectionClick();
                onTap();
              }
            : null,
        onLongPress: enabled
            ? () {
                HapticFeedback.mediumImpact();
                onLongPress();
              }
            : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            spacing: 3,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                  color: fg,
                  height: 1.15,
                ),
              ),
              if (locked) Icon(Icons.lock_rounded, size: 11, color: fg),
            ],
          ),
        ),
      ),
    );
  }
}

class _ShortcutChip extends StatefulWidget {
  const _ShortcutChip({
    super.key,
    required this.label,
    required this.enabled,
    required this.onTap,
    this.repeatable = false,
    this.accentDanger = false,
  });

  final String label;
  final bool enabled;
  final VoidCallback onTap;
  final bool repeatable;
  final bool accentDanger;

  @override
  State<_ShortcutChip> createState() => _ShortcutChipState();
}

class _ShortcutChipState extends State<_ShortcutChip> {
  Timer? _initialDelay;
  Timer? _repeatTimer;

  void _stopRepeat() {
    _initialDelay?.cancel();
    _initialDelay = null;
    _repeatTimer?.cancel();
    _repeatTimer = null;
  }

  void _startRepeat() {
    if (!widget.repeatable || !widget.enabled) return;
    _stopRepeat();
    _initialDelay = Timer(const Duration(milliseconds: 360), () {
      _repeatTimer = Timer.periodic(const Duration(milliseconds: 85), (_) {
        if (!mounted || !widget.enabled) {
          _stopRepeat();
          return;
        }
        HapticFeedback.selectionClick();
        widget.onTap();
      });
    });
  }

  @override
  void dispose() {
    _stopRepeat();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final bg = widget.accentDanger ? colors.errorTint : colors.field;
    final fg = widget.accentDanger
        ? (widget.enabled ? colors.error : colors.muted)
        : (widget.enabled ? colors.foreground : colors.muted);
    return Material(
      color: bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: widget.accentDanger
              ? colors.error.withValues(alpha: 0.25)
              : colors.border,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: GestureDetector(
        onTapDown: widget.enabled ? (_) => _startRepeat() : null,
        onTapUp: (_) => _stopRepeat(),
        onTapCancel: _stopRepeat,
        child: InkWell(
          onTap: widget.enabled
              ? () {
                  HapticFeedback.selectionClick();
                  widget.onTap();
                }
              : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
            child: Text(
              widget.label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w500,
                color: fg,
                height: 1.15,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
