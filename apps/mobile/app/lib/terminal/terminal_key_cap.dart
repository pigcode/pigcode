import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';

/// 支持长按连发与触觉反馈的终端实体键帽：
/// - 支持单标签、图标标签，以及上下双标键（上档符号 + 默认符号，跟随 Shift 高亮切换）。
class TerminalKeyCap extends StatefulWidget {
  const TerminalKeyCap({
    super.key,
    required this.onTap,
    this.label = '',
    this.upperLabel,
    this.upperActive = false,
    this.icon,
    this.tooltip,
    this.height = 42,
    this.fontSize = 14,
    this.monospace = false,
    this.repeatable = false,
    this.active = false,
    this.danger = false,
    this.dimmed = false,
    this.enabled = true,
  });

  final String label;
  final String? upperLabel;
  final bool upperActive;
  final IconData? icon;
  final String? tooltip;
  final double height;
  final double fontSize;
  final bool monospace;
  final bool repeatable;
  final bool active;
  final bool danger;
  final bool dimmed;
  final bool enabled;
  final VoidCallback onTap;

  @override
  State<TerminalKeyCap> createState() => _TerminalKeyCapState();
}

class _TerminalKeyCapState extends State<TerminalKeyCap> {
  static const double _dragCancelDistance = 18;

  Timer? _initialDelay;
  Timer? _repeatTimer;
  int? _activePointer;
  Offset? _downPosition;
  bool _pressed = false;
  bool _movedOut = false;
  bool _repeatFired = false;

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
      _repeatTimer = Timer.periodic(const Duration(milliseconds: 75), (_) {
        if (!mounted || !widget.enabled || _movedOut) {
          _stopRepeat();
          return;
        }
        _repeatFired = true;
        HapticFeedback.selectionClick();
        widget.onTap();
      });
    });
  }

  void _handlePointerDown(PointerDownEvent event) {
    if (!widget.enabled || _activePointer != null) return;
    _activePointer = event.pointer;
    _downPosition = event.position;
    _movedOut = false;
    _repeatFired = false;
    setState(() => _pressed = true);
    _startRepeat();
  }

  void _handlePointerMove(PointerMoveEvent event) {
    if (event.pointer != _activePointer || _downPosition == null || _movedOut) {
      return;
    }
    if ((event.position - _downPosition!).distance > _dragCancelDistance) {
      _movedOut = true;
      _stopRepeat();
      if (_pressed) setState(() => _pressed = false);
    }
  }

  void _handlePointerUp(PointerUpEvent event) {
    if (event.pointer != _activePointer) return;
    final shouldFire = widget.enabled && !_movedOut && !_repeatFired;
    _activePointer = null;
    _downPosition = null;
    _stopRepeat();
    if (_pressed) setState(() => _pressed = false);
    if (shouldFire) {
      HapticFeedback.selectionClick();
      widget.onTap();
    }
  }

  void _handlePointerCancel(PointerCancelEvent event) {
    if (event.pointer != _activePointer) return;
    _activePointer = null;
    _downPosition = null;
    _stopRepeat();
    if (_pressed) setState(() => _pressed = false);
  }

  @override
  void didUpdateWidget(covariant TerminalKeyCap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled || !widget.repeatable) {
      _stopRepeat();
    }
    if (!widget.enabled && _pressed) {
      _activePointer = null;
      _downPosition = null;
      _pressed = false;
    }
  }

  @override
  void dispose() {
    _stopRepeat();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final colors = isDark ? pigcodeDark : pigcodeLight;

    final Color bg;
    final Color fg;
    final Color borderColor;
    if (widget.active) {
      bg = widget.enabled ? colors.primary : colors.field;
      fg = widget.enabled ? colors.onPrimary : colors.faint;
      borderColor = Colors.transparent;
    } else if (_pressed) {
      bg = widget.danger
          ? colors.errorTint
          : (isDark ? colors.field : colors.panel);
      fg = widget.danger ? colors.error : colors.foreground;
      borderColor = widget.danger
          ? colors.error.withValues(alpha: 0.45)
          : colors.primary.withValues(alpha: 0.45);
    } else if (widget.danger) {
      bg = colors.errorTint;
      fg = widget.enabled ? colors.error : colors.faint;
      borderColor = colors.error.withValues(alpha: 0.25);
    } else if (widget.dimmed) {
      bg = isDark ? colors.surface : colors.field;
      fg = widget.enabled ? colors.secondaryText : colors.faint;
      borderColor = colors.border;
    } else {
      bg = colors.surfaceRaised;
      fg = widget.enabled ? colors.foreground : colors.faint;
      borderColor = colors.border;
    }

    final familyFallback = widget.monospace
        ? const ['SF Mono', 'JetBrains Mono', 'Noto Sans SC', 'monospace']
        : null;

    Widget inner;
    if (widget.upperLabel case final upper?) {
      final upperColor = widget.active
          ? fg
          : widget.upperActive
          ? fg
          : colors.muted;
      final lowerColor = widget.active
          ? fg.withValues(alpha: 0.72)
          : widget.upperActive
          ? colors.muted
          : fg;
      inner = Column(
        mainAxisAlignment: MainAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            upper,
            maxLines: 1,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: widget.upperActive
                  ? FontWeight.w600
                  : FontWeight.w400,
              fontFamily: widget.monospace ? 'Menlo' : null,
              fontFamilyFallback: familyFallback,
              color: upperColor,
              height: 1.05,
            ),
          ),
          const SizedBox(height: 1),
          Text(
            widget.label,
            maxLines: 1,
            style: TextStyle(
              fontSize: 13.5,
              fontWeight: widget.upperActive
                  ? FontWeight.w400
                  : FontWeight.w500,
              fontFamily: widget.monospace ? 'Menlo' : null,
              fontFamilyFallback: familyFallback,
              color: lowerColor,
              height: 1.05,
            ),
          ),
        ],
      );
    } else {
      inner = Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        spacing: 3,
        children: [
          if (widget.icon != null) Icon(widget.icon, size: 16, color: fg),
          if (widget.label.isNotEmpty)
            Text(
              widget.label,
              maxLines: 1,
              overflow: TextOverflow.clip,
              style: TextStyle(
                fontSize: widget.fontSize,
                fontWeight: FontWeight.w500,
                fontFamily: widget.monospace ? 'Menlo' : null,
                fontFamilyFallback: familyFallback,
                color: fg,
                height: 1.1,
              ),
            ),
        ],
      );
    }

    // 直连底层指针事件绕过 PageView 内 InkWell 的 100ms 延迟与多指手势竞争，按下瞬间即高亮。
    final cap = Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _handlePointerDown,
      onPointerMove: _handlePointerMove,
      onPointerUp: _handlePointerUp,
      onPointerCancel: _handlePointerCancel,
      child: Transform.scale(
        scale: _pressed ? 0.94 : 1.0,
        child: SizedBox(
          height: widget.height,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: borderColor),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Center(
                child: FittedBox(fit: BoxFit.scaleDown, child: inner),
              ),
            ),
          ),
        ),
      ),
    );
    if (widget.tooltip != null) {
      return Tooltip(message: widget.tooltip!, child: cap);
    }
    return cap;
  }
}
