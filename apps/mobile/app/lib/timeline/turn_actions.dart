import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';
import 'relative_time.dart';
import 'timeline_tokens.dart';

enum TimelineTurnActionKind { reply, user }

/// 回答和用户气泡下方的操作栏（桌面 `.turn-actions` / `.turn-user-actions`）：
/// 复制图标（24×24、r6、12px 图标）+ 相对时间；图标与文字对齐桌面边缘，同时保留移动端易点触区。
class TimelineTurnActions extends StatefulWidget {
  const TimelineTurnActions({
    super.key,
    required this.text,
    this.createdAt,
    this.copyLabel = '复制',
    this.kind = TimelineTurnActionKind.reply,
    this.showCopy = true,
  });

  final String text;
  final String? createdAt;
  final String copyLabel;
  final TimelineTurnActionKind kind;
  final bool showCopy;

  @override
  State<TimelineTurnActions> createState() => _TimelineTurnActionsState();
}

class _TimelineTurnActionsState extends State<TimelineTurnActions> {
  Timer? _reset;
  bool _copied = false;

  @override
  void dispose() {
    _reset?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    if (!mounted) return;
    setState(() => _copied = true);
    _reset?.cancel();
    _reset = Timer(TimelineMotion.copyReset, () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final isUser = widget.kind == TimelineTurnActionKind.user;
    final time = timelineRelativeTime(widget.createdAt);
    final timeStyle = isUser
        ? TimelineType.microStyle(colors.muted)
        : TimelineType.metaStyle(
            colors.timelineFaint,
          ).copyWith(fontFeatures: TimelineType.tabular);

    if (!widget.showCopy && time.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: EdgeInsetsDirectional.only(end: isUser ? TimelineSpace.x2 : 0),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.showCopy)
            Tooltip(
              message: _copied ? '已复制' : widget.copyLabel,
              child: Semantics(
                button: true,
                label: _copied ? '已复制' : widget.copyLabel,
                child: InkWell(
                  onTap: _copy,
                  borderRadius: BorderRadius.circular(TimelineRadius.small),
                  child: SizedBox(
                    width: TimelineControl.sm,
                    height: TimelineControl.sm,
                    child: Center(
                      child: Icon(
                        _copied ? Icons.check_rounded : Icons.copy_rounded,
                        size: TimelineIcon.btn,
                        color: _copied
                            ? colors.readyMark
                            : colors.timelineSubtle,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (time.isNotEmpty)
            Padding(
              padding: EdgeInsetsDirectional.only(
                start: widget.showCopy ? TimelineSpace.x2 : 0,
              ),
              child: Text(time, style: timeStyle),
            ),
        ],
      ),
    );
  }
}
