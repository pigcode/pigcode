import 'dart:async';

import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'shimmer_text.dart';
import 'timeline_tokens.dart';

/// 按偏移分片读取完整思考正文的返回页。
typedef ReasoningContentPage = ({String text, int? nextOffset});

/// 分片加载完整思考正文的回调。
typedef ReasoningContentLoader =
    Future<ReasoningContentPage> Function(int? offset);

/// 思考块（桌面 `ReasoningBlock`）：Brain 图标、「正在思考」（扫光 + 尾句渐隐）或「思考」，
/// 展开后最多 240px 高纯文本并支持流式跟随；超长截断时在展开后原地自动续载完整正文；
/// 独立时带左细线，在摘要组内直接复用组导线。
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
    this.onLoadFull,
  });

  final String text;
  final bool streaming;
  final bool shimmer;
  final bool truncated;
  final bool showIcon;
  final bool compact;
  final VoidCallback? onTap;
  final ReasoningContentLoader? onLoadFull;

  @override
  State<TimelineReasoningBlock> createState() => _TimelineReasoningBlockState();
}

class _TimelineReasoningBlockState extends State<TimelineReasoningBlock> {
  static const _maxFullPages = 64;

  final _scroll = ScrollController();
  bool _expanded = false;
  bool _following = true;
  bool _autoJumping = false;
  String? _fullText;
  int? _nextOffset;
  bool _loadedComplete = false;
  bool _loadingFull = false;
  bool _loadFailed = false;
  int _loadGeneration = 0;

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
    final resetNeeded =
        oldWidget.streaming != widget.streaming ||
        (!widget.truncated && oldWidget.truncated) ||
        (!widget.streaming && oldWidget.text != widget.text);
    if (resetNeeded) {
      _loadGeneration++;
      _fullText = null;
      _nextOffset = null;
      _loadedComplete = false;
      _loadingFull = false;
      _loadFailed = false;
    }
    if (_expanded &&
        widget.truncated &&
        widget.onLoadFull != null &&
        !_loadedComplete &&
        !_loadingFull &&
        (!oldWidget.truncated || oldWidget.onLoadFull == null || resetNeeded)) {
      unawaited(_loadFullContent());
    }
    if (_expanded &&
        widget.streaming &&
        _following &&
        widget.text != oldWidget.text) {
      _jumpToBottom();
    }
  }

  Future<void> _loadFullContent() async {
    final loader = widget.onLoadFull;
    if (loader == null || _loadingFull || _loadedComplete) return;
    final generation = ++_loadGeneration;
    setState(() {
      _loadingFull = true;
      _loadFailed = false;
    });
    var buffer = _fullText ?? '';
    var offset = _nextOffset;
    var pages = 0;
    try {
      while (pages < _maxFullPages) {
        pages++;
        final page = await loader(offset);
        if (!mounted || generation != _loadGeneration) return;
        buffer += page.text;
        offset = page.nextOffset;
        final done = offset == null;
        setState(() {
          _fullText = buffer;
          _nextOffset = offset;
          if (done) {
            _loadedComplete = true;
            _loadingFull = false;
          }
        });
        if (_following && widget.streaming) _jumpToBottom();
        if (done) return;
      }
      if (mounted && generation == _loadGeneration) {
        setState(() => _loadingFull = false);
      }
    } catch (_) {
      if (mounted && generation == _loadGeneration) {
        setState(() {
          _loadingFull = false;
          _loadFailed = true;
        });
      }
    }
  }

  void _toggleExpanded() {
    setState(() => _expanded = !_expanded);
    if (_expanded) {
      if (widget.truncated &&
          widget.onLoadFull != null &&
          !_loadedComplete &&
          !_loadingFull) {
        unawaited(_loadFullContent());
      }
      if (widget.streaming) _jumpToBottom();
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

    final displayText = (_fullText ?? widget.text).trim();
    final bodyContent = ConstrainedBox(
      constraints: const BoxConstraints(
        maxHeight: TimelineToolCard.reasoningMaxHeight,
      ),
      child: SingleChildScrollView(
        controller: _scroll,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              displayText,
              style: TimelineType.contentStyle(colors.timelineFaint),
            ),
            if (_loadingFull)
              Padding(
                padding: const EdgeInsets.only(top: TimelineSpace.x3),
                child: Text(
                  '正在加载完整思考…',
                  style: TimelineType.metaStyle(colors.timelineFaint),
                ),
              )
            else if (_loadFailed)
              Padding(
                padding: const EdgeInsets.only(top: TimelineSpace.x3),
                child: InkWell(
                  onTap: () => unawaited(_loadFullContent()),
                  borderRadius: BorderRadius.circular(TimelineRadius.xs),
                  child: Text(
                    '完整思考加载失败，点击重试',
                    style: TimelineType.metaStyle(colors.timelineSubtle)
                        .copyWith(
                          decoration: TextDecoration.underline,
                          decorationStyle: TextDecorationStyle.dotted,
                          decorationColor: colors.timelineSubtle,
                        ),
                  ),
                ),
              )
            else if (widget.truncated &&
                !_loadedComplete &&
                widget.onLoadFull == null)
              Padding(
                padding: const EdgeInsets.only(top: TimelineSpace.x3),
                child: Text(
                  '电脑离线，仅展示预览内容',
                  style: TimelineType.metaStyle(colors.timelineFaint),
                ),
              ),
          ],
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
            onTap: widget.onTap ?? _toggleExpanded,
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
      ],
    );
  }
}
