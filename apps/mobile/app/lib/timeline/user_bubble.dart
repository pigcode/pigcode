import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';
import 'turn_actions.dart';

/// 用户消息气泡（桌面 `.turn-user` + `.msg-user`）：
/// 右对齐、最大 560px、8/12 内衬、r12、0.5px 边；超过 120 折叠并 70%→100% 渐隐，
/// 折叠时底部居中悬浮 28×24 胶囊展开按钮，展开后排在正文下方；支持 `@文件` 引用标签。
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
  bool _expanded = false;

  @override
  void didUpdateWidget(TimelineUserBubble oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) _expanded = false;
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

  List<_MentionToken> _parseMentions(String text) {
    final tokens = <_MentionToken>[];
    final pattern = RegExp(r'(^|\s)@([^\s@]+)');
    final trailingPattern = RegExp(
      r'[,.;:!?，。；：！？、)）\]】"'
      "'"
      r'”’]+$',
    );
    var cursor = 0;
    for (final match in pattern.allMatches(text)) {
      final start = match.start + (match.group(1)?.length ?? 0);
      if (start > cursor) {
        tokens.add(_MentionToken.plain(text.substring(cursor, start)));
      }
      final raw = match.group(2)!;
      final trailing = trailingPattern.stringMatch(raw);
      final path = trailing == null
          ? raw
          : raw.substring(0, raw.length - trailing.length);
      if (path.isEmpty ||
          !(path.contains('/') || RegExp(r'\.[\w-]+$').hasMatch(path))) {
        tokens.add(_MentionToken.plain(text.substring(start, match.end)));
      } else {
        tokens.add(_MentionToken.file(path));
        if (trailing != null) tokens.add(_MentionToken.plain(trailing));
      }
      cursor = match.end;
    }
    if (cursor < text.length) {
      tokens.add(_MentionToken.plain(text.substring(cursor)));
    }
    return tokens;
  }

  TextSpan _buildMeasureSpan(
    List<_MentionToken> tokens,
    TextStyle base,
    Color mentionColor,
  ) => TextSpan(
    style: base,
    children: [
      for (final token in tokens)
        if (token.path case final path?)
          TextSpan(
            text: '  ${_fileName(path)}',
            style: TextStyle(color: mentionColor, fontWeight: FontWeight.w500),
          )
        else
          TextSpan(text: token.text),
    ],
  );

  TextSpan _buildDisplaySpan(
    List<_MentionToken> tokens,
    TextStyle base,
    Color mentionColor,
  ) => TextSpan(
    style: base,
    children: [
      for (final token in tokens)
        if (token.path case final path?)
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: _MentionChip(
              path: path,
              color: mentionColor,
              style: base,
              onTap: () => _openMention(path),
            ),
          )
        else
          TextSpan(text: token.text),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final base = TimelineType.contentStyle(
      colors.foreground,
    ).copyWith(leadingDistribution: TextLeadingDistribution.even);
    final tokens = _parseMentions(widget.text);
    final measureSpan = _buildMeasureSpan(tokens, base, colors.timelineFile);
    final displaySpan = _buildDisplaySpan(tokens, base, colors.timelineFile);

    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: TimelineSpace.bubbleMaxWidth,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            LayoutBuilder(
              builder: (context, constraints) {
                final maxTextWidth =
                    (constraints.maxWidth - TimelineSpace.bubble.horizontal)
                        .clamp(0.0, double.infinity);
                final painter = TextPainter(
                  text: measureSpan,
                  textDirection: Directionality.of(context),
                  textScaler: MediaQuery.textScalerOf(context),
                  maxLines: null,
                )..layout(maxWidth: maxTextWidth);
                final overflows =
                    painter.height >
                    TimelineSpace.userCollapse +
                        TimelineSpace.userCollapseTolerance;
                painter.dispose();

                final clamped = overflows && !_expanded;
                final rawText = Text.rich(displaySpan);
                final constrained = ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: clamped
                        ? TimelineSpace.userCollapse
                        : double.infinity,
                  ),
                  child: ClipRect(
                    child: clamped
                        ? ShaderMask(
                            blendMode: BlendMode.dstIn,
                            shaderCallback: (bounds) => const LinearGradient(
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                              colors: [
                                Colors.white,
                                Colors.white,
                                Colors.transparent,
                              ],
                              stops: [0, TimelineSpace.userFadeStop, 1],
                            ).createShader(bounds),
                            child: rawText,
                          )
                        : rawText,
                  ),
                );
                final body = MediaQuery.disableAnimationsOf(context)
                    ? constrained
                    : AnimatedSize(
                        duration: TimelineMotion.slower,
                        curve: TimelineMotion.ease,
                        alignment: Alignment.topCenter,
                        child: constrained,
                      );

                return DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.timelineUser,
                    border: Border.all(
                      color: colors.timelineBorder,
                      width: TimelineBorder.hair,
                    ),
                    borderRadius: BorderRadius.circular(TimelineRadius.panel),
                  ),
                  child: Stack(
                    children: [
                      Padding(
                        padding: TimelineSpace.bubble,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            body,
                            if (overflows && _expanded) ...[
                              const SizedBox(height: TimelineSpace.x4),
                              Center(
                                child: _toggle(
                                  background: colors.background,
                                  border: colors.timelineBorder,
                                  foreground: colors.foreground,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (clamped)
                        Positioned(
                          left: 0,
                          right: 0,
                          bottom: TimelineSpace.x4,
                          child: Center(
                            child: _toggle(
                              background: colors.background,
                              border: colors.timelineBorder,
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
            const SizedBox(height: TimelineSpace.x2),
            TimelineTurnActions(
              text: widget.text,
              createdAt: widget.createdAt,
              kind: TimelineTurnActionKind.user,
            ),
          ],
        ),
      ),
    );
  }

  Widget _toggle({
    required Color background,
    required Color border,
    required Color foreground,
  }) => Tooltip(
    message: _expanded ? '收起' : '展开',
    child: Semantics(
      button: true,
      expanded: _expanded,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _expanded = !_expanded),
        child: Container(
          width: TimelineControl.md,
          height: TimelineControl.sm,
          decoration: BoxDecoration(
            color: background,
            border: Border.all(color: border, width: TimelineBorder.regular),
            borderRadius: BorderRadius.circular(TimelineRadius.full),
            boxShadow: TimelineShadow.sm,
          ),
          alignment: Alignment.center,
          child: Icon(
            _expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
            size: TimelineIcon.row,
            color: foreground,
          ),
        ),
      ),
    ),
  );
}

class _MentionToken {
  const _MentionToken.plain(this.text) : path = null;
  const _MentionToken.file(this.path) : text = '';

  final String text;
  final String? path;
}

String _fileName(String path) {
  final normalized = path.replaceAll('\\', '/');
  final trimmed = normalized.endsWith('/')
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
  return trimmed.split('/').last;
}

/// 桌面 `.mention-file`：15px 图标 + 4px 间距 + 文件名（w500，`--file-node-fg`）。
class _MentionChip extends StatelessWidget {
  const _MentionChip({
    required this.path,
    required this.color,
    required this.style,
    required this.onTap,
  });

  final String path;
  final Color color;
  final TextStyle style;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final directory = path.endsWith('/');
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: TimelineSpace.x1),
      child: GestureDetector(
        onTap: onTap,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              directory
                  ? Icons.folder_outlined
                  : Icons.insert_drive_file_outlined,
              size: TimelineIcon.row,
              color: color,
            ),
            const SizedBox(width: TimelineSpace.x2),
            Text(
              _fileName(path),
              style: style.copyWith(color: color, fontWeight: FontWeight.w500),
            ),
          ],
        ),
      ),
    );
  }
}
