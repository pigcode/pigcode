import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'shimmer_text.dart';
import 'timeline_tokens.dart';

/// 思考块（桌面 `ReasoningBlock`）：Brain 图标、「正在思考」（扫光 + 尾句渐隐）或「思考」，
/// 展开后最多 240px 高纯文本并支持流式跟随；独立时带左细线，在摘要组内直接复用组导线。
class TimelineReasoningBlock extends StatefulWidget {
  const TimelineReasoningBlock({
    super.key,
    required this.text,
    this.streaming = false,
    this.shimmer = false,
    this.truncated = false,
    this.showIcon = true,
    this.compact = false,
    this.onTap,
    this.onOpenFull,
  });

  final String text;
  final bool streaming;
  final bool shimmer;
  final bool truncated;
  final bool showIcon;
  final bool compact;
  final VoidCallback? onTap;
  final VoidCallback? onOpenFull;

  @override
  State<TimelineReasoningBlock> createState() => _TimelineReasoningBlockState();
}

class _TimelineReasoningBlockState extends State<TimelineReasoningBlock> {
  final _scroll = ScrollController();
  bool _expanded = false;
  bool _following = true;
  bool _autoJumping = false;

  String get _peek {
    final lines = widget.text
        .split('\n')
        .map((line) => line.trim())
        .where((line) => line.isNotEmpty)
        .toList();
    return lines.isEmpty ? '' : lines.last;
  }

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(TimelineReasoningBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_expanded &&
        widget.streaming &&
        _following &&
        widget.text != oldWidget.text) {
      _jumpToBottom();
    }
  }

  void _onScroll() {
    if (_autoJumping || !_scroll.hasClients) return;
    final position = _scroll.position;
    _following =
        position.maxScrollExtent - position.pixels <=
        TimelineToolCard.reasoningFollowThreshold;
  }

  void _jumpToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      _autoJumping = true;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
      _autoJumping = false;
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final label = widget.streaming ? '正在思考' : '思考';
    final shimmers = widget.streaming || widget.shimmer;
    final labelStyle = TimelineType.contentStyle(colors.timelineSubtle);
    final minHeight = widget.compact ? 0.0 : timelineTouchHeight(context);

    final headRow = Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (widget.showIcon) ...[
          SizedBox(
            width: TimelineIcon.row,
            height: TimelineIcon.row,
            child: Center(
              child: Icon(
                Icons.psychology_outlined,
                size: TimelineIcon.row,
                color: colors.timelineSubtle,
              ),
            ),
          ),
          const SizedBox(width: TimelineSpace.fieldGap),
        ],
        if (shimmers)
          TimelineShimmerText(text: label, style: labelStyle)
        else
          Text(label, style: labelStyle),
        if (widget.streaming && !_expanded && _peek.isNotEmpty) ...[
          const SizedBox(width: TimelineSpace.fieldGap),
          Expanded(
            child: ShaderMask(
              blendMode: BlendMode.dstIn,
              shaderCallback: (bounds) {
                final width = bounds.width;
                final edge = width > 0
                    ? (TimelineToolCard.reasoningPeekFade / width).clamp(
                        0.0,
                        0.45,
                      )
                    : 0.0;
                return LinearGradient(
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight,
                  colors: const [Colors.transparent, Colors.white],
                  stops: [0, edge],
                ).createShader(bounds);
              },
              child: Text(
                _peek,
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.clip,
                textAlign: TextAlign.end,
                style: TimelineType.contentStyle(colors.timelineFaint),
              ),
            ),
          ),
        ],
        const SizedBox(width: TimelineSpace.fieldGap),
        AnimatedRotation(
          turns: _expanded ? 0.25 : 0,
          duration: MediaQuery.disableAnimationsOf(context)
              ? Duration.zero
              : TimelineMotion.slow,
          curve: TimelineMotion.ease,
          child: Icon(
            Icons.chevron_right,
            size: TimelineIcon.badge,
            color: colors.timelineFaint,
          ),
        ),
      ],
    );

    final bodyContent = ConstrainedBox(
      constraints: const BoxConstraints(
        maxHeight: TimelineToolCard.reasoningMaxHeight,
      ),
      child: SingleChildScrollView(
        controller: _scroll,
        child: Text(
          widget.text.trim(),
          style: TimelineType.contentStyle(colors.timelineFaint),
        ),
      ),
    );

    // 摘要组内部（!showIcon）：不重复画左导线，顶部只留 4px（`.summary-group-list .reasoning-body`）。
    final expandedBody = widget.showIcon
        ? Padding(
            padding: EdgeInsetsDirectional.only(
              start: TimelineSpace.guideIndent,
              top: timelineExpandedBodyTopGap(
                context,
                targetGap: TimelineSpace.reasoningBodyTop,
                compact: widget.compact,
              ),
              bottom: widget.compact ? 0 : timelineRowTouchOverhang(context),
            ),
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: BorderDirectional(
                  start: BorderSide(
                    color: colors.timelineBorder,
                    width: TimelineBorder.regular,
                  ),
                ),
              ),
              child: Padding(
                padding: const EdgeInsetsDirectional.only(
                  start: TimelineSpace.reasoningBodyPadding,
                ),
                child: bodyContent,
              ),
            ),
          )
        : Padding(
            padding: const EdgeInsets.only(top: TimelineSpace.x2),
            child: bodyContent,
          );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: true,
          expanded: widget.onTap != null ? false : _expanded,
          child: InkWell(
            onTap:
                widget.onTap ??
                () {
                  setState(() => _expanded = !_expanded);
                  if (_expanded && widget.streaming) _jumpToBottom();
                },
            borderRadius: BorderRadius.circular(TimelineRadius.xs),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: minHeight),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                heightFactor: 1,
                child: widget.compact
                    ? Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: TimelineSpace.x1,
                        ),
                        child: headRow,
                      )
                    : headRow,
              ),
            ),
          ),
        ),
        if (_expanded) expandedBody,
        if (widget.truncated)
          Padding(
            padding: EdgeInsetsDirectional.only(
              start: widget.showIcon
                  ? TimelineIcon.row + TimelineSpace.fieldGap
                  : 0,
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
