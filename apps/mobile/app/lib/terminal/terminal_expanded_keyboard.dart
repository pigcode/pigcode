import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';
import 'terminal_shortcut_bar.dart';

/// 仿 UU 远程交互设计的终端扩展键盘面板：
/// - 在不呼出系统输入法的情况下，提供完整高频编程符号、Ctrl/Alt 组合键、
///   F1-F12 功能键、Home/End/PgUp/PgDn，以及支持长按连发的倒 T 形十字方向键。
class TerminalExpandedKeyboard extends StatefulWidget {
  static const panelKey = ValueKey('terminal-expanded-keyboard');
  static const fnToggleKey = ValueKey('terminal-expanded-fn-toggle');
  static const systemKeyboardKey = ValueKey('terminal-expanded-system');
  static const collapseKey = ValueKey('terminal-expanded-collapse');
  static const shiftTabKey = ValueKey('terminal-expanded-shift-tab');
  static const ctrlKey = ValueKey('terminal-expanded-ctrl');
  static const altKey = ValueKey('terminal-expanded-alt');
  static const enterKey = ValueKey('terminal-expanded-enter');
  static const backspaceKey = ValueKey('terminal-expanded-backspace');
  static const crossUpKey = ValueKey('terminal-cross-up');
  static const crossDownKey = ValueKey('terminal-cross-down');
  static const crossLeftKey = ValueKey('terminal-cross-left');
  static const crossRightKey = ValueKey('terminal-cross-right');

  final TerminalModifierMode ctrlMode;
  final TerminalModifierMode altMode;
  final bool enabled;
  final VoidCallback onCycleCtrl;
  final VoidCallback onLockCtrl;
  final VoidCallback onCycleAlt;
  final VoidCallback onLockAlt;
  final ValueChanged<String> onSendChar;
  final ValueChanged<String> onSendRaw;
  final VoidCallback onPaste;
  final VoidCallback onSwitchToSystemKeyboard;
  final VoidCallback onCollapse;

  const TerminalExpandedKeyboard({
    super.key,
    required this.ctrlMode,
    required this.altMode,
    required this.enabled,
    required this.onCycleCtrl,
    required this.onLockCtrl,
    required this.onCycleAlt,
    required this.onLockAlt,
    required this.onSendChar,
    required this.onSendRaw,
    required this.onPaste,
    required this.onSwitchToSystemKeyboard,
    required this.onCollapse,
  });

  @override
  State<TerminalExpandedKeyboard> createState() =>
      _TerminalExpandedKeyboardState();
}

class _TerminalExpandedKeyboardState extends State<TerminalExpandedKeyboard> {
  bool _showFunctionKeys = false;

  static const _symbolRow1 = [
    '/',
    '-',
    '_',
    '|',
    '~',
    '&',
    '>',
    '<',
    '=',
    '*',
    '\$',
  ];

  static const _symbolRow2 = [
    '\\',
    '"',
    "'",
    '`',
    ';',
    ':',
    '(',
    ')',
    '[',
    ']',
    '{',
  ];

  static const _fnKeys = [
    ('F1', '\x1bOP'),
    ('F2', '\x1bOQ'),
    ('F3', '\x1bOR'),
    ('F4', '\x1bOS'),
    ('F5', '\x1b[15~'),
    ('F6', '\x1b[17~'),
    ('F7', '\x1b[18~'),
    ('F8', '\x1b[19~'),
    ('F9', '\x1b[20~'),
    ('F10', '\x1b[21~'),
    ('F11', '\x1b[23~'),
    ('F12', '\x1b[24~'),
  ];

  static const _comboKeys = [
    ('Esc', '\x1b', false),
    ('Tab', '\t', false),
    ('⇧Tab', '\x1b[Z', false),
    ('^C', '\x03', true),
    ('^D', '\x04', false),
    ('^Z', '\x1a', false),
    ('^L', '\x0c', false),
    ('^R', '\x12', false),
    ('^A', '\x01', false),
    ('^E', '\x05', false),
  ];

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Container(
      key: TerminalExpandedKeyboard.panelKey,
      decoration: BoxDecoration(
        color: colors.window,
        border: Border(top: BorderSide(color: colors.divider)),
      ),
      padding: const EdgeInsets.fromLTRB(8, 7, 8, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // 顶部控制条：系统输入法切回、常用/F1-F12 分段切换、清屏与收起（避免与外层条重复）
          Padding(
            padding: const EdgeInsets.only(bottom: 7),
            child: Row(
              children: [
                _KeyboardKey(
                  key: TerminalExpandedKeyboard.systemKeyboardKey,
                  label: '系统键盘',
                  icon: Icons.keyboard_rounded,
                  height: 32,
                  fontSize: 12,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  enabled: widget.enabled,
                  onTap: widget.onSwitchToSystemKeyboard,
                ),
                const SizedBox(width: 6),
                _KeyboardKey(
                  key: TerminalExpandedKeyboard.fnToggleKey,
                  label: _showFunctionKeys ? '常用控制' : 'F1–F12',
                  height: 32,
                  fontSize: 12,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  highlighted: _showFunctionKeys,
                  enabled: widget.enabled,
                  onTap: () =>
                      setState(() => _showFunctionKeys = !_showFunctionKeys),
                ),
                const Spacer(),
                _KeyboardKey(
                  label: '清屏',
                  height: 32,
                  fontSize: 12,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  enabled: widget.enabled,
                  onTap: () => widget.onSendRaw('\x0c'),
                ),
                const SizedBox(width: 6),
                _KeyboardKey(
                  key: TerminalExpandedKeyboard.collapseKey,
                  label: '',
                  tooltip: '收起键盘',
                  icon: Icons.keyboard_hide_rounded,
                  width: 36,
                  height: 32,
                  enabled: true,
                  onTap: widget.onCollapse,
                ),
              ],
            ),
          ),
          // 第 1 行：高频控制/组合键 或 F1-F12 功能键
          SizedBox(
            height: 36,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                spacing: 5,
                children: _showFunctionKeys
                    ? [
                        for (final (label, seq) in _fnKeys)
                          _KeyboardKey(
                            label: label,
                            width: 44,
                            height: 36,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw(seq),
                          ),
                      ]
                    : [
                        for (final (label, seq, danger) in _comboKeys)
                          _KeyboardKey(
                            key: label == '⇧Tab'
                                ? TerminalExpandedKeyboard.shiftTabKey
                                : null,
                            label: label,
                            width: label.length >= 4 ? 56 : 44,
                            height: 36,
                            danger: danger,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw(seq),
                          ),
                      ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          // 第 2 行：终端高频编程符号 1
          _buildSymbolRow(_symbolRow1),
          const SizedBox(height: 5),
          // 第 3 行：终端高频编程符号 2
          _buildSymbolRow(_symbolRow2),
          const SizedBox(height: 8),
          // 第 4 行：左（修饰+翻页定位）、中（物理倒 T 十字方向盘）、右（粘贴/退格/回车）
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              // 左侧：修饰与定位（两排紧致网格）
              Expanded(
                flex: 5,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: _ModifierKeyCap(
                            key: TerminalExpandedKeyboard.ctrlKey,
                            label: 'Ctrl',
                            mode: widget.ctrlMode,
                            enabled: widget.enabled,
                            onTap: widget.onCycleCtrl,
                            onLongPress: widget.onLockCtrl,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Expanded(
                          child: _ModifierKeyCap(
                            key: TerminalExpandedKeyboard.altKey,
                            label: 'Alt',
                            mode: widget.altMode,
                            enabled: widget.enabled,
                            onTap: widget.onCycleAlt,
                            onLongPress: widget.onLockAlt,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: [
                        Expanded(
                          child: _KeyboardKey(
                            label: 'Home',
                            height: 38,
                            fontSize: 11.5,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw('\x1b[H'),
                          ),
                        ),
                        const SizedBox(width: 4),
                        Expanded(
                          child: _KeyboardKey(
                            label: 'End',
                            height: 38,
                            fontSize: 11.5,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw('\x1b[F'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: [
                        Expanded(
                          child: _KeyboardKey(
                            label: 'PgUp',
                            height: 36,
                            fontSize: 11,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw('\x1b[5~'),
                          ),
                        ),
                        const SizedBox(width: 4),
                        Expanded(
                          child: _KeyboardKey(
                            label: 'PgDn',
                            height: 36,
                            fontSize: 11,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw('\x1b[6~'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              // 中央：实体倒 T 十字方向盘（长按连发）
              SizedBox(
                width: 118,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _KeyboardKey(
                      key: TerminalExpandedKeyboard.crossUpKey,
                      label: '↑',
                      width: 37,
                      height: 38,
                      repeatable: true,
                      enabled: widget.enabled,
                      onTap: () => widget.onSendRaw('\x1b[A'),
                    ),
                    const SizedBox(height: 5),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      spacing: 3.5,
                      children: [
                        _KeyboardKey(
                          key: TerminalExpandedKeyboard.crossLeftKey,
                          label: '←',
                          width: 37,
                          height: 38,
                          repeatable: true,
                          enabled: widget.enabled,
                          onTap: () => widget.onSendRaw('\x1b[D'),
                        ),
                        _KeyboardKey(
                          key: TerminalExpandedKeyboard.crossDownKey,
                          label: '↓',
                          width: 37,
                          height: 38,
                          repeatable: true,
                          enabled: widget.enabled,
                          onTap: () => widget.onSendRaw('\x1b[B'),
                        ),
                        _KeyboardKey(
                          key: TerminalExpandedKeyboard.crossRightKey,
                          label: '→',
                          width: 37,
                          height: 38,
                          repeatable: true,
                          enabled: widget.enabled,
                          onTap: () => widget.onSendRaw('\x1b[C'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      spacing: 4,
                      children: [
                        _KeyboardKey(
                          label: '{',
                          width: 56,
                          height: 36,
                          fontSize: 14,
                          monospace: true,
                          enabled: widget.enabled,
                          onTap: () => widget.onSendChar('{'),
                        ),
                        _KeyboardKey(
                          label: '}',
                          width: 56,
                          height: 36,
                          fontSize: 14,
                          monospace: true,
                          enabled: widget.enabled,
                          onTap: () => widget.onSendChar('}'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              // 右侧：粘贴、长按退格、主回车键
              Expanded(
                flex: 4,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: _KeyboardKey(
                            label: '粘贴',
                            height: 38,
                            fontSize: 12,
                            enabled: widget.enabled,
                            onTap: widget.onPaste,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Expanded(
                          child: _KeyboardKey(
                            key: TerminalExpandedKeyboard.backspaceKey,
                            label: '',
                            tooltip: '退格',
                            icon: Icons.backspace_outlined,
                            height: 38,
                            repeatable: true,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendRaw('\x7f'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: [
                        Expanded(
                          child: _KeyboardKey(
                            label: 'Space',
                            height: 36,
                            fontSize: 11.5,
                            enabled: widget.enabled,
                            onTap: () => widget.onSendChar(' '),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 5),
                    SizedBox(
                      width: double.infinity,
                      child: _KeyboardKey(
                        key: TerminalExpandedKeyboard.enterKey,
                        label: '回车',
                        icon: Icons.keyboard_return_rounded,
                        height: 38,
                        primary: true,
                        fontSize: 13,
                        enabled: widget.enabled,
                        onTap: () => widget.onSendRaw('\r'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSymbolRow(List<String> symbols) {
    return Row(
      children: [
        for (var i = 0; i < symbols.length; i++) ...[
          if (i > 0) const SizedBox(width: 4),
          Expanded(
            child: _KeyboardKey(
              label: symbols[i],
              height: 36,
              fontSize: 14.5,
              monospace: true,
              enabled: widget.enabled,
              onTap: () => widget.onSendChar(symbols[i]),
            ),
          ),
        ],
      ],
    );
  }
}

class _ModifierKeyCap extends StatelessWidget {
  const _ModifierKeyCap({
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
    final bg = active ? colors.primary : colors.surface;
    final fg = active
        ? colors.onPrimary
        : (enabled ? colors.foreground : colors.faint);

    return Material(
      color: bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(9),
        side: BorderSide(
          color: locked ? colors.statusAccent : colors.border,
          width: locked ? 1.5 : 1,
        ),
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
        child: SizedBox(
          height: 38,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 3),
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                spacing: 2,
                children: [
                  Text(
                    label,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                      color: fg,
                    ),
                  ),
                  if (locked) Icon(Icons.lock_rounded, size: 10, color: fg),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _KeyboardKey extends StatefulWidget {
  const _KeyboardKey({
    super.key,
    required this.label,
    required this.height,
    required this.enabled,
    required this.onTap,
    this.width,
    this.padding,
    this.icon,
    this.tooltip,
    this.fontSize = 13,
    this.monospace = false,
    this.repeatable = false,
    this.primary = false,
    this.highlighted = false,
    this.danger = false,
  });

  final String label;
  final double? width;
  final EdgeInsetsGeometry? padding;
  final IconData? icon;
  final String? tooltip;
  final double height;
  final double fontSize;
  final bool monospace;
  final bool repeatable;
  final bool primary;
  final bool highlighted;
  final bool danger;
  final bool enabled;
  final VoidCallback onTap;

  @override
  State<_KeyboardKey> createState() => _KeyboardKeyState();
}

class _KeyboardKeyState extends State<_KeyboardKey> {
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

    final Color bg;
    final Color fg;
    final Color borderColor;
    if (widget.primary || widget.highlighted) {
      bg = widget.enabled ? colors.primary : colors.field;
      fg = widget.enabled ? colors.onPrimary : colors.faint;
      borderColor = Colors.transparent;
    } else if (widget.danger) {
      bg = colors.errorTint;
      fg = widget.enabled ? colors.error : colors.faint;
      borderColor = colors.error.withValues(alpha: 0.25);
    } else {
      bg = colors.surface;
      fg = widget.enabled ? colors.foreground : colors.faint;
      borderColor = colors.border;
    }

    final content = Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      spacing: 4,
      children: [
        if (widget.icon != null) Icon(widget.icon, size: 15, color: fg),
        if (widget.label.isNotEmpty)
          Text(
            widget.label,
            maxLines: 1,
            overflow: TextOverflow.clip,
            style: TextStyle(
              fontSize: widget.fontSize,
              fontWeight: FontWeight.w500,
              fontFamily: widget.monospace ? 'Menlo' : null,
              fontFamilyFallback: widget.monospace
                  ? const [
                      'SF Mono',
                      'JetBrains Mono',
                      'Noto Sans SC',
                      'monospace',
                    ]
                  : null,
              color: fg,
              height: 1.1,
            ),
          ),
      ],
    );

    final child = SizedBox(
      width: widget.width,
      height: widget.height,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(9),
          side: BorderSide(color: borderColor),
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
              padding:
                  widget.padding ?? const EdgeInsets.symmetric(horizontal: 2),
              child: Center(
                child: FittedBox(fit: BoxFit.scaleDown, child: content),
              ),
            ),
          ),
        ),
      ),
    );
    if (widget.tooltip != null) {
      return Tooltip(message: widget.tooltip!, child: child);
    }
    return child;
  }
}
