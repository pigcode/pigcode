import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';
import 'terminal_key_cap.dart';

/// 一比一对齐 UU 远程布局逻辑的双屏可左右滑动 PC 终端扩展键盘：
/// - 顶部共享栏：「[ ] 组合键模式」勾选开关 + `Ctrl` / `Shift` / `Alt` / `Esc` 修饰操控键；
/// - PageView 第 1 屏（完整 PC 全键盘）：10 列双标符号行 + `1-0` 数字/上档符号行 + `Q-P` / `A-L ⌫` / `Z-M Space Enter`；
/// - PageView 第 2 屏（左滑切换）：6 列 × 5 行规律网格，集成 `Esc/Tab/~/` / 高频控制 + 3×4 `F1-F12` + `Ins/Del/Home/End/PgUp/PgDn` + `Caps` + 倒 T 方向盘；
/// - 底部双横条指示器（支持点击切页与手指左右滑动切页）。
class TerminalExpandedKeyboard extends StatefulWidget {
  const TerminalExpandedKeyboard({
    super.key,
    required this.comboMode,
    required this.ctrlActive,
    required this.shiftActive,
    required this.altActive,
    required this.capsLock,
    required this.enabled,
    required this.onToggleComboMode,
    required this.onToggleCtrl,
    required this.onToggleShift,
    required this.onToggleAlt,
    required this.onToggleCapsLock,
    required this.onSendChar,
    required this.onSendRaw,
  });

  static const panelKey = ValueKey('terminal-expanded-keyboard');
  static const pagerKey = ValueKey('terminal-expanded-pager');
  static const comboModeKey = ValueKey('terminal-expanded-combo-mode');
  static const ctrlKey = ValueKey('terminal-expanded-ctrl');
  static const shiftKey = ValueKey('terminal-expanded-shift');
  static const altKey = ValueKey('terminal-expanded-alt');
  static const capsKey = ValueKey('terminal-expanded-caps');
  static const enterKey = ValueKey('terminal-expanded-enter');
  static const backspaceKey = ValueKey('terminal-expanded-backspace');
  static const pageDot0Key = ValueKey('terminal-expanded-page-0');
  static const pageDot1Key = ValueKey('terminal-expanded-page-1');
  static const shiftTabKey = ValueKey('terminal-expanded-shift-tab');
  static const crossUpKey = ValueKey('terminal-cross-up');
  static const crossDownKey = ValueKey('terminal-cross-down');
  static const crossLeftKey = ValueKey('terminal-cross-left');
  static const crossRightKey = ValueKey('terminal-cross-right');

  final bool comboMode;
  final bool ctrlActive;
  final bool shiftActive;
  final bool altActive;
  final bool capsLock;
  final bool enabled;
  final VoidCallback onToggleComboMode;
  final VoidCallback onToggleCtrl;
  final VoidCallback onToggleShift;
  final VoidCallback onToggleAlt;
  final VoidCallback onToggleCapsLock;
  final ValueChanged<String> onSendChar;
  final ValueChanged<String> onSendRaw;

  @override
  State<TerminalExpandedKeyboard> createState() =>
      _TerminalExpandedKeyboardState();
}

class _TerminalExpandedKeyboardState extends State<TerminalExpandedKeyboard> {
  final PageController _pageController = PageController();
  int _page = 0;
  final Map<int, Offset> _swipeStarts = {};
  int? _swipePointer;
  int _swipeStartPage = 0;
  double _swipeOriginOffset = 0;
  double _lastDeltaX = 0;
  int _lastMoveMicros = 0;
  double _lastVelocityX = 0;
  bool _swipeDragging = false;

  // 第 1 屏第 1 行：UU 同款 10 列双标符号（upper = Shift 上档, lower = 默认）
  static const _dualSymbols = [
    ('_', '-'),
    ('+', '='),
    ('{', '['),
    ('}', ']'),
    ('|', '\\'),
    (':', ';'),
    ('"', "'"),
    ('<', ','),
    ('>', '.'),
    ('?', '/'),
  ];

  // 第 1 屏第 2 行：10 列数字 + Shift 上档符号
  static const _numberPairs = [
    ('!', '1'),
    ('@', '2'),
    ('#', '3'),
    ('\$', '4'),
    ('%', '5'),
    ('^', '6'),
    ('&', '7'),
    ('*', '8'),
    ('(', '9'),
    (')', '0'),
  ];

  static const _qwertyTop = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
  static const _qwertyMid = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
  static const _qwertyBot = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _goToPage(int index) {
    if (_page == index) return;
    _pageController.animateToPage(
      index,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
    );
  }

  void _handlePagerPointerDown(PointerDownEvent event) {
    _swipeStarts[event.pointer] = event.position;
  }

  void _handlePagerPointerMove(PointerMoveEvent event) {
    final start = _swipeStarts[event.pointer];
    if (start == null || !_pageController.hasClients) return;
    final pos = _pageController.position;
    final dx = event.position.dx - start.dx;
    final dy = event.position.dy - start.dy;

    if (!_swipeDragging) {
      // 仅在单指明显横向滑屏（>24px）时接管翻页，彻底避免 PageView 锁定双指快速连敲。
      if (_swipePointer == null &&
          dx.abs() > 24 &&
          dx.abs() > dy.abs() * 1.25) {
        _swipePointer = event.pointer;
        _swipeDragging = true;
        _swipeStartPage = _page;
        // 只扣掉 24px 触发阈值而非整段 dx，避免高速单帧大跨度滑动位移被归零。
        _swipeOriginOffset = pos.pixels + dx.sign * 24;
        _lastDeltaX = dx;
        _lastMoveMicros = event.timeStamp.inMicroseconds;
        _lastVelocityX = 0;
      } else {
        return;
      }
    }
    if (event.pointer != _swipePointer) return;

    final nowMicros = event.timeStamp.inMicroseconds;
    final dtSec = (nowMicros - _lastMoveMicros) / 1e6;
    if (dtSec > 0.001) {
      _lastVelocityX = (dx - _lastDeltaX) / dtSec;
    }
    _lastDeltaX = dx;
    _lastMoveMicros = nowMicros;

    pos.jumpTo(
      (_swipeOriginOffset - dx).clamp(pos.minScrollExtent, pos.maxScrollExtent),
    );
  }

  void _finishPagerSwipe(int pointer) {
    _swipeStarts.remove(pointer);
    if (pointer != _swipePointer || !_swipeDragging) return;
    _swipePointer = null;
    _swipeDragging = false;
    if (!_pageController.hasClients) return;
    final pos = _pageController.position;
    final width = pos.viewportDimension;
    final int targetPage;
    if (_lastVelocityX < -280) {
      targetPage = 1;
    } else if (_lastVelocityX > 280) {
      targetPage = 0;
    } else if (width > 0) {
      final progress = pos.pixels / width;
      targetPage = (_swipeStartPage == 0 ? progress > 0.25 : progress > 0.75)
          ? 1
          : 0;
    } else {
      targetPage = _swipeStartPage;
    }
    _pageController.animateToPage(
      targetPage,
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
    );
  }

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
      padding: const EdgeInsets.fromLTRB(6, 8, 6, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _buildModifierHeader(colors),
          const SizedBox(height: 8),
          Listener(
            onPointerDown: _handlePagerPointerDown,
            onPointerMove: _handlePagerPointerMove,
            onPointerUp: (e) => _finishPagerSwipe(e.pointer),
            onPointerCancel: (e) => _finishPagerSwipe(e.pointer),
            child: SizedBox(
              height: 224,
              child: PageView(
                key: TerminalExpandedKeyboard.pagerKey,
                controller: _pageController,
                physics: const NeverScrollableScrollPhysics(),
                onPageChanged: (index) => setState(() => _page = index),
                children: [_buildQwertyPage(), _buildFunctionAndNavPage()],
              ),
            ),
          ),
          const SizedBox(height: 8),
          _buildPageIndicator(colors),
        ],
      ),
    );
  }

  Widget _buildModifierHeader(dynamic colors) {
    return Row(
      children: [
        InkWell(
          key: TerminalExpandedKeyboard.comboModeKey,
          borderRadius: BorderRadius.circular(8),
          onTap: widget.enabled
              ? () {
                  HapticFeedback.selectionClick();
                  widget.onToggleComboMode();
                }
              : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              spacing: 6,
              children: [
                AnimatedContainer(
                  duration: const Duration(milliseconds: 140),
                  width: 17,
                  height: 17,
                  decoration: BoxDecoration(
                    color: widget.comboMode
                        ? colors.primary
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(5),
                    border: Border.all(
                      color: widget.comboMode
                          ? colors.primary
                          : colors.strongBorder,
                      width: 1.5,
                    ),
                  ),
                  child: widget.comboMode
                      ? Icon(
                          Icons.check_rounded,
                          size: 13,
                          color: colors.onPrimary,
                        )
                      : null,
                ),
                Text(
                  '组合键模式',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: widget.comboMode
                        ? colors.foreground
                        : colors.secondaryText,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Row(
            spacing: 5,
            children: [
              Expanded(
                child: TerminalKeyCap(
                  key: TerminalExpandedKeyboard.ctrlKey,
                  label: 'Ctrl',
                  height: 36,
                  fontSize: 13.5,
                  active: widget.ctrlActive,
                  dimmed: true,
                  enabled: widget.enabled,
                  onTap: widget.onToggleCtrl,
                ),
              ),
              Expanded(
                child: TerminalKeyCap(
                  key: TerminalExpandedKeyboard.shiftKey,
                  label: 'Shift',
                  height: 36,
                  fontSize: 13.5,
                  active: widget.shiftActive,
                  dimmed: true,
                  enabled: widget.enabled,
                  onTap: widget.onToggleShift,
                ),
              ),
              Expanded(
                child: TerminalKeyCap(
                  key: TerminalExpandedKeyboard.altKey,
                  label: 'Alt',
                  height: 36,
                  fontSize: 13.5,
                  active: widget.altActive,
                  dimmed: true,
                  enabled: widget.enabled,
                  onTap: widget.onToggleAlt,
                ),
              ),
              Expanded(
                child: TerminalKeyCap(
                  label: 'Esc',
                  height: 36,
                  fontSize: 13.5,
                  dimmed: true,
                  enabled: widget.enabled,
                  onTap: () => widget.onSendRaw('\x1b'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 第 1 屏：UU 远程标准 5 行 PC 全键盘（双标符号 + 1-0 + Q-P + A-L ⌫ + Z-M Space Enter）
  Widget _buildQwertyPage() {
    final uppercase = widget.shiftActive ^ widget.capsLock;
    return Column(
      mainAxisSize: MainAxisSize.min,
      spacing: 4.5,
      children: [
        // Row 1: 10 个双标常用符号
        Row(
          spacing: 3.5,
          children: [
            for (final (upper, lower) in _dualSymbols)
              Expanded(
                child: TerminalKeyCap(
                  label: lower,
                  upperLabel: upper,
                  upperActive: widget.shiftActive,
                  height: 41,
                  monospace: true,
                  enabled: widget.enabled,
                  onTap: () =>
                      widget.onSendChar(widget.shiftActive ? upper : lower),
                ),
              ),
          ],
        ),
        // Row 2: 1 - 0（Shift 激活时自动发送上方符号）
        Row(
          spacing: 3.5,
          children: [
            for (final (upper, digit) in _numberPairs)
              Expanded(
                child: TerminalKeyCap(
                  label: widget.shiftActive ? upper : digit,
                  height: 41,
                  fontSize: 15,
                  monospace: true,
                  enabled: widget.enabled,
                  onTap: () =>
                      widget.onSendChar(widget.shiftActive ? upper : digit),
                ),
              ),
          ],
        ),
        // Row 3: Q - P
        Row(
          spacing: 3.5,
          children: [
            for (final ch in _qwertyTop)
              Expanded(
                child: TerminalKeyCap(
                  label: uppercase ? ch.toUpperCase() : ch,
                  height: 41,
                  fontSize: 15.5,
                  enabled: widget.enabled,
                  onTap: () =>
                      widget.onSendChar(uppercase ? ch.toUpperCase() : ch),
                ),
              ),
          ],
        ),
        // Row 4: A - L + 退格
        Row(
          spacing: 3.5,
          children: [
            for (final ch in _qwertyMid)
              Expanded(
                child: TerminalKeyCap(
                  label: uppercase ? ch.toUpperCase() : ch,
                  height: 41,
                  fontSize: 15.5,
                  enabled: widget.enabled,
                  onTap: () =>
                      widget.onSendChar(uppercase ? ch.toUpperCase() : ch),
                ),
              ),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.backspaceKey,
                tooltip: '退格',
                icon: Icons.backspace_outlined,
                height: 41,
                dimmed: true,
                repeatable: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x7f'),
              ),
            ),
          ],
        ),
        // Row 5: Z - M + Space + Enter
        Row(
          spacing: 3.5,
          children: [
            for (final ch in _qwertyBot)
              Expanded(
                flex: 10,
                child: TerminalKeyCap(
                  label: uppercase ? ch.toUpperCase() : ch,
                  height: 41,
                  fontSize: 15.5,
                  enabled: widget.enabled,
                  onTap: () =>
                      widget.onSendChar(uppercase ? ch.toUpperCase() : ch),
                ),
              ),
            Expanded(
              flex: 15,
              child: TerminalKeyCap(
                label: 'Space',
                height: 41,
                fontSize: 12.5,
                dimmed: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendChar(' '),
              ),
            ),
            Expanded(
              flex: 15,
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.enterKey,
                label: 'Enter',
                height: 41,
                fontSize: 13,
                active: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\r'),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// 第 2 屏：一比一还原 UU 远程 6×5 功能/F键/编辑键/方向十字网格，并对终端补充高频键
  Widget _buildFunctionAndNavPage() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      spacing: 4.5,
      children: [
        // Row 1: Esc | Tab | ~ ` | ⇧Tab | ^D | ^Z
        Row(
          spacing: 4,
          children: [
            Expanded(
              child: TerminalKeyCap(
                label: 'Esc',
                height: 41,
                fontSize: 13,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1b'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                label: 'Tab',
                height: 41,
                fontSize: 13,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\t'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                label: '`',
                upperLabel: '~',
                upperActive: widget.shiftActive,
                height: 41,
                monospace: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendChar(widget.shiftActive ? '~' : '`'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.shiftTabKey,
                label: '⇧Tab',
                height: 41,
                fontSize: 12.5,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1b[Z'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                label: '^D',
                height: 41,
                fontSize: 13,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x04'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                label: '^Z',
                height: 41,
                fontSize: 13,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1a'),
              ),
            ),
          ],
        ),
        // Row 2: F1 | F2 | F3 | Ins | Home | PgUp
        Row(
          spacing: 4,
          children: [
            _fnCell('F1', '\x1bOP'),
            _fnCell('F2', '\x1bOQ'),
            _fnCell('F3', '\x1bOR'),
            _navCell('Ins', '\x1b[2~'),
            _navCell('Home', '\x1b[H'),
            _navCell('PgUp', '\x1b[5~'),
          ],
        ),
        // Row 3: F4 | F5 | F6 | Del | End | PgDn
        Row(
          spacing: 4,
          children: [
            _fnCell('F4', '\x1bOS'),
            _fnCell('F5', '\x1b[15~'),
            _fnCell('F6', '\x1b[17~'),
            _navCell('Del', '\x1b[3~', repeatable: true),
            _navCell('End', '\x1b[F'),
            _navCell('PgDn', '\x1b[6~'),
          ],
        ),
        // Row 4: F7 | F8 | F9 | Caps | ↑ | ^R
        Row(
          spacing: 4,
          children: [
            _fnCell('F7', '\x1b[18~'),
            _fnCell('F8', '\x1b[19~'),
            _fnCell('F9', '\x1b[20~'),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.capsKey,
                label: 'Caps',
                height: 41,
                fontSize: 13,
                active: widget.capsLock,
                enabled: widget.enabled,
                onTap: widget.onToggleCapsLock,
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.crossUpKey,
                label: '↑',
                height: 41,
                fontSize: 16,
                repeatable: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1b[A'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                label: '^R',
                height: 41,
                fontSize: 13,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x12'),
              ),
            ),
          ],
        ),
        // Row 5: F10 | F11 | F12 | ← | ↓ | →
        Row(
          spacing: 4,
          children: [
            _fnCell('F10', '\x1b[21~'),
            _fnCell('F11', '\x1b[23~'),
            _fnCell('F12', '\x1b[24~'),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.crossLeftKey,
                label: '←',
                height: 41,
                fontSize: 16,
                repeatable: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1b[D'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.crossDownKey,
                label: '↓',
                height: 41,
                fontSize: 16,
                repeatable: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1b[B'),
              ),
            ),
            Expanded(
              child: TerminalKeyCap(
                key: TerminalExpandedKeyboard.crossRightKey,
                label: '→',
                height: 41,
                fontSize: 16,
                repeatable: true,
                enabled: widget.enabled,
                onTap: () => widget.onSendRaw('\x1b[C'),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _fnCell(String label, String seq) => Expanded(
    child: TerminalKeyCap(
      label: label,
      height: 41,
      fontSize: 13,
      enabled: widget.enabled,
      onTap: () => widget.onSendRaw(seq),
    ),
  );

  Widget _navCell(String label, String seq, {bool repeatable = false}) =>
      Expanded(
        child: TerminalKeyCap(
          label: label,
          height: 41,
          fontSize: 12.5,
          repeatable: repeatable,
          enabled: widget.enabled,
          onTap: () => widget.onSendRaw(seq),
        ),
      );

  Widget _buildPageIndicator(dynamic colors) {
    Widget bar(Key key, int index) {
      final selected = _page == index;
      return InkWell(
        key: key,
        borderRadius: BorderRadius.circular(4),
        onTap: () => _goToPage(index),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 4),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            width: selected ? 20 : 16,
            height: 3.5,
            decoration: BoxDecoration(
              color: selected ? colors.foreground : colors.strongBorder,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        ),
      );
    }

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      spacing: 2,
      children: [
        bar(TerminalExpandedKeyboard.pageDot0Key, 0),
        bar(TerminalExpandedKeyboard.pageDot1Key, 1),
      ],
    );
  }
}
