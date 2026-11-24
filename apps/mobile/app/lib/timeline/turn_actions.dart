import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';
import 'relative_time.dart';
import 'timeline_tokens.dart';

/// 回答和用户气泡下方的操作栏：复制 + 相对时间。
class TimelineTurnActions extends StatefulWidget {
  const TimelineTurnActions({
    super.key,
    required this.text,
    this.createdAt,
    this.copyLabel = '复制',
  });

  final String text;
  final String? createdAt;
  final String copyLabel;

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
    _reset = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final time = timelineRelativeTime(widget.createdAt);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: _copy,
          tooltip: _copied ? '已复制' : widget.copyLabel,
          icon: Icon(
            _copied ? Icons.check_rounded : Icons.copy_rounded,
            size: TimelineIcon.meta,
            color: _copied ? colors.readyMark : colors.timelineFaint,
          ),
          color: colors.timelineFaint,
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(
            minWidth: TimelineControl.touch,
            minHeight: TimelineControl.touch,
          ),
          visualDensity: VisualDensity.compact,
        ),
        if (time.isNotEmpty)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: TimelineSpace.x1),
            child: Text(
              time,
              style: TimelineType.smallStyle(colors.timelineFaint),
            ),
          ),
      ],
    );
  }
}
