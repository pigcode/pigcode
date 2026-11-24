import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';

/// 思考块：Brain 图标、「正在思考 / 思考」、展开后的正文；流式时在行尾露出最新一句。
class TimelineReasoningBlock extends StatefulWidget {
  const TimelineReasoningBlock({
    super.key,
    required this.text,
    this.streaming = false,
    this.truncated = false,
    this.onOpenFull,
  });

  final String text;
  final bool streaming;
  final bool truncated;
  final VoidCallback? onOpenFull;

  @override
  State<TimelineReasoningBlock> createState() => _TimelineReasoningBlockState();
}

class _TimelineReasoningBlockState extends State<TimelineReasoningBlock> {
  bool _expanded = false;

  String get _peek {
    final lines = widget.text
        .split('\n')
        .map((line) => line.trim())
        .where((line) => line.isNotEmpty)
        .toList();
    return lines.isEmpty ? '' : lines.last;
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final label = widget.streaming ? '正在思考' : '思考';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() => _expanded = !_expanded),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: touch),
            child: Row(
              children: [
                SizedBox(
                  width: TimelineIcon.row,
                  height: TimelineIcon.row,
                  child: Icon(
                    Icons.psychology_outlined,
                    size: TimelineIcon.row,
                    color: colors.timelineSubtle,
                  ),
                ),
                const SizedBox(width: TimelineSpace.x4),
                Text(
                  label,
                  style: TimelineType.contentStyle(colors.timelineSubtle),
                ),
                if (widget.streaming && !_expanded && _peek.isNotEmpty) ...[
                  const SizedBox(width: TimelineSpace.x4),
                  Expanded(
                    child: Text(
                      _peek,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.end,
                      style: TimelineType.metaStyle(colors.timelineFaint),
                    ),
                  ),
                ] else
                  const Spacer(),
                Icon(
                  _expanded
                      ? Icons.keyboard_arrow_down
                      : Icons.keyboard_arrow_right,
                  size: TimelineIcon.control,
                  color: colors.timelineFaint,
                ),
              ],
            ),
          ),
        ),
        if (_expanded)
          Padding(
            padding: const EdgeInsetsDirectional.only(
              start: TimelineIcon.row + TimelineSpace.x4,
              top: TimelineSpace.x2,
            ),
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: BorderDirectional(
                  start: BorderSide(color: colors.divider),
                ),
              ),
              child: Padding(
                padding: const EdgeInsetsDirectional.only(
                  start: TimelineSpace.x6,
                ),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 240),
                  child: SingleChildScrollView(
                    child: Text(
                      widget.text,
                      style: TimelineType.contentStyle(colors.timelineSubtle),
                    ),
                  ),
                ),
              ),
            ),
          ),
        if (widget.truncated)
          Padding(
            padding: const EdgeInsetsDirectional.only(
              start: TimelineIcon.row + TimelineSpace.x4,
            ),
            child: TextButton(
              onPressed: widget.onOpenFull,
              child: const Text('查看完整过程'),
            ),
          ),
      ],
    );
  }
}
