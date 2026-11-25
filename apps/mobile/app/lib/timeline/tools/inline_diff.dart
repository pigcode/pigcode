import 'package:flutter/material.dart';

import '../../theme_colors.dart';
import '../timeline_tokens.dart';

/// 内联 diff：桌面 `.inline-diff` 的手机实现。
/// 1px 边、r12、`cv-card` 底；增删行带 14% 底色和左侧 3px 色条，补丁带行号时显示行号栏。
class TimelineInlineDiff extends StatelessWidget {
  const TimelineInlineDiff({super.key, this.oldText, this.newText, this.patch});

  final String? oldText;
  final String? newText;
  final String? patch;

  List<_DiffLine> get _lines {
    if (patch != null) return _parsePatch(patch!);
    final lines = <_DiffLine>[];
    for (final line in (oldText ?? '').split('\n')) {
      lines.add(_DiffLine(kind: -1, marker: '-', code: line));
    }
    for (final line in (newText ?? '').split('\n')) {
      lines.add(_DiffLine(kind: 1, marker: '+', code: line));
    }
    return lines;
  }

  List<_DiffLine> _parsePatch(String text) {
    final lines = <_DiffLine>[];
    final hunk = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@');
    int? oldNumber;
    int? newNumber;
    var seenHunk = false;
    for (final line in text.split('\n')) {
      final match = hunk.firstMatch(line);
      if (match != null) {
        if (seenHunk) {
          lines.add(const _DiffLine(kind: 2, marker: '', code: '⋯'));
        }
        seenHunk = true;
        oldNumber = int.parse(match.group(1)!);
        newNumber = int.parse(match.group(2)!);
        continue;
      }
      if (line.startsWith('diff ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('*** ') ||
          line.startsWith('\\ No newline')) {
        continue;
      }
      if (line.startsWith('+')) {
        lines.add(
          _DiffLine(
            kind: 1,
            marker: '+',
            code: line.substring(1),
            number: newNumber,
          ),
        );
        newNumber = (newNumber ?? 0) + 1;
      } else if (line.startsWith('-')) {
        lines.add(
          _DiffLine(
            kind: -1,
            marker: '-',
            code: line.substring(1),
            number: oldNumber,
          ),
        );
        oldNumber = (oldNumber ?? 0) + 1;
      } else if (line.startsWith(' ')) {
        lines.add(
          _DiffLine(
            kind: 0,
            marker: ' ',
            code: line.substring(1),
            number: oldNumber,
          ),
        );
        oldNumber = (oldNumber ?? 0) + 1;
        newNumber = (newNumber ?? 0) + 1;
      }
    }
    return lines;
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final lines = _lines;
    if (lines.isEmpty || lines.every((line) => line.code.isEmpty)) {
      return const SizedBox.shrink();
    }
    final numbered = lines.any((line) => line.number != null);
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(
        maxHeight: TimelineToolCard.inlineDiffMaxHeight,
      ),
      margin: const EdgeInsets.only(bottom: TimelineSpace.x4),
      decoration: BoxDecoration(
        color: colors.timelineCard,
        border: Border.all(
          color: colors.timelineBorder,
          width: TimelineBorder.regular,
        ),
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
      ),
      clipBehavior: Clip.antiAlias,
      child: LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: constraints.maxWidth),
              child: IntrinsicWidth(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: TimelineSpace.x2),
                    for (final line in lines)
                      _line(context, line, numbered, colors),
                    const SizedBox(height: TimelineSpace.x2),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _line(
    BuildContext context,
    _DiffLine line,
    bool numbered,
    dynamic colors,
  ) {
    final added = line.kind == 1;
    final removed = line.kind == -1;
    final color = added
        ? colors.diffAdded
        : removed
        ? colors.diffRemoved
        : colors.timelineSubtle;
    final background = added
        ? colors.diffAdded.withValues(
            alpha: TimelineToolCard.inlineDiffTintAlpha,
          )
        : removed
        ? colors.diffRemoved.withValues(
            alpha: TimelineToolCard.inlineDiffTintAlpha,
          )
        : null;
    final markerColor = line.kind == 2 ? colors.timelineFaint : color;
    return Container(
      foregroundDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: added
                ? colors.diffAdded
                : removed
                ? colors.diffRemoved
                : Colors.transparent,
            width: TimelineBorder.diffBar,
          ),
        ),
      ),
      color: background,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (numbered)
            Container(
              width: TimelineToolCard.inlineDiffGutterWidth,
              padding: const EdgeInsets.only(right: TimelineSpace.x4),
              decoration: BoxDecoration(
                border: Border(
                  right: BorderSide(
                    color: colors.timelineBorder,
                    width: TimelineBorder.regular,
                  ),
                ),
              ),
              child: Text(
                line.number?.toString() ?? '',
                textAlign: TextAlign.right,
                style: TimelineType.codeStyle(
                  line.number == null ? colors.timelineFaint : color,
                ).copyWith(fontFeatures: TimelineType.tabular),
              ),
            ),
          SizedBox(
            width: TimelineToolCard.inlineDiffMarkerWidth,
            child: Padding(
              padding: const EdgeInsets.only(left: TimelineSpace.x4),
              child: Text(line.marker, style: TimelineType.codeStyle(markerColor)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: TimelineSpace.x6),
            child: Text(
              line.code,
              softWrap: false,
              style: TimelineType.codeStyle(
                line.kind == 2 ? colors.timelineFaint : color,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DiffLine {
  const _DiffLine({
    required this.kind,
    required this.marker,
    required this.code,
    this.number,
  });

  /// 1 新增，-1 删除，0 上下文，2 省略。
  final int kind;
  final String marker;
  final String code;
  final int? number;
}
