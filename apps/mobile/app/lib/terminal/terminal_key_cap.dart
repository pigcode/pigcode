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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final colors = isDark ? pigcodeDark : pigcodeLight;

    final Color bg;
    final Color fg;
    final Color borderColor;
    if (widget.active) {
      bg = widget.enabled ? colors.primary : colors.field;
      fg = widget.enabled ? colors.onPrimary : colors.faint;
      borderColor = Colors.transparent;
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

    final box = SizedBox(
      height: widget.height,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
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
      return Tooltip(message: widget.tooltip!, child: box);
    }
    return box;
  }
}
