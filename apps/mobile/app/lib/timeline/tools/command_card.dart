import 'package:flutter/material.dart';

import '../../theme_colors.dart';
import '../timeline_tokens.dart';

/// 终端命令卡：桌面 `.tool-card.cmd-card` 的手机实现。
/// 命令默认 3 行、展开 10 行；输出固定 5 行内部滚动，运行中跟随最新输出。
class TimelineCommandCard extends StatelessWidget {
  const TimelineCommandCard({
    super.key,
    required this.command,
    required this.output,
    required this.running,
  });

  final String command;
  final String output;
  final bool running;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      width: double.infinity,
      padding: TimelineToolCard.padding,
      decoration: BoxDecoration(
        color: colors.timelinePanel,
        border: Border.all(color: colors.timelineBorder),
        borderRadius: BorderRadius.circular(TimelineToolCard.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          _CommandText(command: command),
          if (output.isNotEmpty) ...[
            const SizedBox(height: TimelineToolCard.gap),
            _CommandOutput(text: output, running: running),
          ],
        ],
      ),
    );
  }
}

class _CommandText extends StatefulWidget {
  const _CommandText({required this.command});

  final String command;

  @override
  State<_CommandText> createState() => _CommandTextState();
}

class _CommandTextState extends State<_CommandText> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final style = TimelineType.codeStyle(colors.foreground);
    final promptStyle = TimelineType.codeStyle(colors.timelineSubtle);
    return LayoutBuilder(
      builder: (context, constraints) {
        const promptWidth = 8.0;
        const gap = 8.0;
        final painter = TextPainter(
          text: TextSpan(text: widget.command, style: style),
          maxLines: TimelineToolCard.commandLines,
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
        )..layout(maxWidth: constraints.maxWidth - promptWidth - gap);
        final expandable = painter.didExceedMaxLines;
        painter.dispose();
        final text = _expanded
            ? ConstrainedBox(
                constraints: const BoxConstraints(
                  maxHeight:
                      TimelineToolCard.line *
                      TimelineToolCard.commandExpandedLines,
                ),
                child: SingleChildScrollView(
                  child: Text(widget.command, style: style),
                ),
              )
            : Text(
                widget.command,
                maxLines: TimelineToolCard.commandLines,
                overflow: TextOverflow.ellipsis,
                style: style,
              );
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: promptWidth,
                  child: Text(r'$', style: promptStyle),
                ),
                const SizedBox(width: gap),
                Expanded(child: text),
              ],
            ),
            if (expandable)
              Padding(
                padding: const EdgeInsetsDirectional.only(
                  start: promptWidth + gap,
                  top: 2,
                ),
                child: TextButton.icon(
                  onPressed: () => setState(() => _expanded = !_expanded),
                  icon: Icon(
                    _expanded
                        ? Icons.keyboard_arrow_up
                        : Icons.keyboard_arrow_down,
                    size: TimelineIcon.meta,
                  ),
                  label: Text(_expanded ? '收起' : '展开'),
                  style: TextButton.styleFrom(
                    foregroundColor: colors.timelineSubtle,
                    minimumSize: const Size(0, 28),
                    padding: EdgeInsets.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    textStyle: TimelineType.metaStyle(colors.timelineSubtle),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _CommandOutput extends StatefulWidget {
  const _CommandOutput({required this.text, required this.running});

  final String text;
  final bool running;

  @override
  State<_CommandOutput> createState() => _CommandOutputState();
}

class _CommandOutputState extends State<_CommandOutput> {
  final _scroll = ScrollController();
  bool _following = true;
  bool _autoJumping = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _jumpToBottom();
  }

  @override
  void didUpdateWidget(_CommandOutput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.text != oldWidget.text && widget.running && _following) {
      _jumpToBottom();
    }
  }

  void _onScroll() {
    if (_autoJumping) return;
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    final following = position.maxScrollExtent - position.pixels < 4;
    if (following != _following) setState(() => _following = following);
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
    return ConstrainedBox(
      constraints: const BoxConstraints(
        maxHeight: TimelineToolCard.line * TimelineToolCard.outputLines,
      ),
      child: SingleChildScrollView(
        controller: _scroll,
        child: Text(
          widget.text,
          style: TimelineType.codeStyle(colors.timelineSubtle),
        ),
      ),
    );
  }
}
