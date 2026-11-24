import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';
import 'turn_actions.dart';

/// 用户消息气泡：右对齐、超过 120 折叠并渐隐，支持 @文件 引用。
class TimelineUserBubble extends StatefulWidget {
  const TimelineUserBubble({
    super.key,
    required this.text,
    this.createdAt,
    this.truncated = false,
    this.onOpenFull,
    this.onMention,
  });

  final String text;
  final String? createdAt;
  final bool truncated;
  final VoidCallback? onOpenFull;
  final Future<void> Function(String path)? onMention;

  @override
  State<TimelineUserBubble> createState() => _TimelineUserBubbleState();
}

class _TimelineUserBubbleState extends State<TimelineUserBubble> {
  final _recognizers = <TapGestureRecognizer>[];
  bool _expanded = false;

  @override
  void dispose() {
    _disposeRecognizers();
    super.dispose();
  }

  void _disposeRecognizers() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();
  }

  Future<void> _openMention(String path) async {
    if (widget.onMention case final open?) {
      await open(path);
      return;
    }
    await Clipboard.setData(ClipboardData(text: path));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('已复制 $path')));
  }

  TextSpan _span(Color mentionColor, TextStyle style) {
    _disposeRecognizers();
    final spans = <InlineSpan>[];
    final pattern = RegExp(r'(^|\s)@([^\s@]+)');
    var cursor = 0;
    for (final match in pattern.allMatches(widget.text)) {
      final start = match.start + (match.group(1)?.length ?? 0);
      if (start > cursor) {
        spans.add(TextSpan(text: widget.text.substring(cursor, start)));
      }
      final token = match.group(2)!;
      final trailing = RegExp(
        r'[,.;:!?，。；：！？、)）\]】"'
        "'"
        r'”’]+$',
      ).stringMatch(token);
      final path = trailing == null
          ? token
          : token.substring(0, token.length - trailing.length);
      if (path.isEmpty ||
          !(path.contains('/') || RegExp(r'\.[\w-]+$').hasMatch(path))) {
        spans.add(TextSpan(text: match.group(0)));
      } else {
        final recognizer = TapGestureRecognizer()
          ..onTap = () => _openMention(path);
        _recognizers.add(recognizer);
        spans.add(
          TextSpan(
            text: '@$path',
            style: TextStyle(color: mentionColor, fontWeight: FontWeight.w500),
            recognizer: recognizer,
          ),
        );
        if (trailing != null) spans.add(TextSpan(text: trailing));
      }
      cursor = match.end;
    }
    if (cursor < widget.text.length) {
      spans.add(TextSpan(text: widget.text.substring(cursor)));
    }
    return TextSpan(style: style, children: spans);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final base = TimelineType.contentStyle(colors.foreground).copyWith(
      leadingDistribution: TextLeadingDistribution.even,
      letterSpacing: theme.platform == TargetPlatform.iOS ? -.45 : 0,
    );
    final span = _span(colors.timelineFile, base);

    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            LayoutBuilder(
              builder: (context, constraints) {
                final painter =
                    TextPainter(
                      text: span,
                      textDirection: Directionality.of(context),
                      textScaler: MediaQuery.textScalerOf(context),
                      maxLines: null,
                    )..layout(
                      maxWidth:
                          constraints.maxWidth -
                          TimelineSpace.bubble.horizontal,
                    );
                final overflows =
                    painter.height > TimelineSpace.userCollapse + 1;
                painter.dispose();
                return DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.timelineUser,
                    border: Border.all(color: colors.border, width: .5),
                    borderRadius: BorderRadius.circular(TimelineRadius.panel),
                  ),
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Padding(
                        padding: EdgeInsets.fromLTRB(
                          TimelineSpace.bubble.left,
                          TimelineSpace.bubble.top,
                          TimelineSpace.bubble.right,
                          TimelineSpace.bubble.bottom +
                              (overflows && !_expanded ? 12 : 0),
                        ),
                        child: AnimatedSize(
                          duration: const Duration(milliseconds: 260),
                          curve: Curves.easeOutCubic,
                          alignment: Alignment.topCenter,
                          child: ConstrainedBox(
                            constraints: BoxConstraints(
                              maxHeight: _expanded
                                  ? double.infinity
                                  : TimelineSpace.userCollapse,
                            ),
                            child: ClipRect(
                              child: ShaderMask(
                                blendMode: BlendMode.dstIn,
                                shaderCallback: (bounds) {
                                  if (_expanded) {
                                    return const LinearGradient(
                                      colors: [Colors.white, Colors.white],
                                    ).createShader(bounds);
                                  }
                                  return const LinearGradient(
                                    begin: Alignment.topCenter,
                                    end: Alignment.bottomCenter,
                                    colors: [
                                      Colors.white,
                                      Colors.white,
                                      Colors.transparent,
                                    ],
                                    stops: [0, .7, 1],
                                  ).createShader(bounds);
                                },
                                child: Text.rich(span),
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (overflows)
                        Positioned(
                          left: 0,
                          right: 0,
                          bottom: 2,
                          child: Center(
                            child: _toggle(
                              surface: colors.surface,
                              border: colors.border,
                              foreground: colors.foreground,
                            ),
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
            if (widget.truncated)
              TextButton(
                onPressed: widget.onOpenFull,
                child: const Text('查看完整正文'),
              ),
            TimelineTurnActions(text: widget.text, createdAt: widget.createdAt),
          ],
        ),
      ),
    );
  }

  Widget _toggle({
    required Color surface,
    required Color border,
    required Color foreground,
  }) => Material(
    color: surface,
    shape: CircleBorder(side: BorderSide(color: border, width: .5)),
    elevation: 1,
    child: InkWell(
      customBorder: const CircleBorder(),
      onTap: () => setState(() => _expanded = !_expanded),
      child: SizedBox(
        width: TimelineControl.md,
        height: TimelineControl.md,
        child: Icon(
          _expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
          size: TimelineIcon.control,
          color: foreground,
        ),
      ),
    ),
  );
}
