import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';

import '../../theme_colors.dart';
import '../timeline_tokens.dart';

/// 一张表格的原始内容：第一行是表头，其余是数据行。
class TimelineTableData {
  const TimelineTableData({required this.rows, required this.alignments});

  final List<List<String>> rows;
  final List<TextAlign> alignments;

  /// gpt_markdown 内置表格解析后的兜底；单元格里的行内标记已被去掉。
  factory TimelineTableData.fromCustom(List<CustomTableRow> rows) {
    final alignments = rows.isEmpty
        ? const <TextAlign>[]
        : rows.first.fields.map((field) => field.alignment).toList();
    return TimelineTableData(
      rows: [
        for (final row in rows) [for (final field in row.fields) field.data],
      ],
      alignments: alignments,
    );
  }

  /// 从原始表块解析，保留单元格里的反引号、粗体和链接标记。
  static TimelineTableData? parse(String body) {
    final lines = body
        .split('\n')
        .map((line) => line.trim())
        .where((line) => line.isNotEmpty)
        .toList();
    if (lines.length < 2) return null;

    List<String> cells(String line) {
      var value = line.trim();
      if (value.startsWith('|')) value = value.substring(1);
      if (value.endsWith('|')) value = value.substring(0, value.length - 1);
      return value.split('|').map((cell) => cell.trim()).toList();
    }

    final header = cells(lines[0]);
    final separator = cells(lines[1]);
    if (header.isEmpty || separator.length != header.length) return null;
    final alignments = <TextAlign>[];
    for (final cell in separator) {
      final value = cell.replaceAll(' ', '');
      if (!RegExp(r'^:?-{3,}:?$').hasMatch(value)) return null;
      final left = value.startsWith(':');
      final right = value.endsWith(':');
      alignments.add(
        left && right
            ? TextAlign.center
            : right
            ? TextAlign.right
            : TextAlign.left,
      );
    }
    final rows = <List<String>>[header];
    for (final line in lines.skip(2)) {
      var values = cells(line);
      if (values.length < header.length) {
        values = [...values, ...List.filled(header.length - values.length, '')];
      } else if (values.length > header.length) {
        values = values.sublist(0, header.length);
      }
      rows.add(values);
    }
    return TimelineTableData(rows: rows, alignments: alignments);
  }
}

/// 在 gpt_markdown 的内置表格规则之前接住以 `|` 开头的表块，
/// 这样单元格里的行内代码和链接不会被提前去掉。
class TimelineTableSyntax extends MarkdownBlockSyntax {
  const TimelineTableSyntax();

  @override
  String get type => 'timeline.table';

  @override
  String get prefix => '|';

  @override
  MarkdownBlockMatch? parse(List<String> lines, int startLine) {
    if (!lines[startLine].trimLeft().startsWith('|')) return null;
    var end = startLine;
    while (end < lines.length && lines[end].trimLeft().startsWith('|')) {
      end++;
    }
    if (end - startLine < 2) return null;
    final body = lines.sublist(startLine, end).join('\n');
    if (TimelineTableData.parse(body) == null) return null;
    return MarkdownBlockMatch(
      node: MdCustomBlock(type: type, body: body),
      endLine: end,
    );
  }
}

Widget timelineTableBlock(
  BuildContext context,
  MdCustomBlock node,
  GptMarkdownConfig config,
) {
  final data = TimelineTableData.parse(node.body);
  if (data == null) return const SizedBox.shrink();
  return TimelineMarkdownTable(
    data: data,
    textStyle: config.style ?? const TextStyle(),
    config: config,
  );
}

/// Markdown 表格：桌面 `.md-table` 的手机实现。
/// 外层 1px 边、r12，内容在边框内横向滚动；单元格 8/12 内衬、min 64/max 28rem、仅水平分隔线。
class TimelineMarkdownTable extends StatelessWidget {
  const TimelineMarkdownTable({
    super.key,
    required this.data,
    required this.textStyle,
    required this.config,
  });

  final TimelineTableData data;
  final TextStyle textStyle;
  final GptMarkdownConfig config;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final cellStyle = textStyle.copyWith(
      fontSize: TimelineType.content,
      height: TimelineType.contentHeight,
      letterSpacing: 0,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(
        vertical: TimelineMarkdown.blockMargin,
      ),
      child: Container(
        width: double.infinity,
        decoration: BoxDecoration(
          border: Border.all(
            color: colors.timelineBorder,
            width: TimelineBorder.regular,
          ),
          borderRadius: BorderRadius.circular(TimelineRadius.panel),
        ),
        clipBehavior: Clip.antiAlias,
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: constraints.maxWidth),
              child: Table(
                defaultColumnWidth: const IntrinsicColumnWidth(flex: 1),
                defaultVerticalAlignment: TableCellVerticalAlignment.top,
                border: TableBorder(
                  horizontalInside: BorderSide(
                    color: colors.timelineBorder,
                    width: TimelineBorder.regular,
                  ),
                ),
                children: [
                  for (final (index, row) in data.rows.indexed)
                    TableRow(
                      children: [
                        for (final (column, value) in row.indexed)
                          _cell(
                            context,
                            index == 0,
                            value,
                            column < data.alignments.length
                                ? data.alignments[column]
                                : TextAlign.left,
                            cellStyle,
                            colors,
                          ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _cell(
    BuildContext context,
    bool header,
    String value,
    TextAlign align,
    TextStyle cellStyle,
    dynamic colors,
  ) {
    final alignment = switch (align) {
      TextAlign.center => Alignment.center,
      TextAlign.right => Alignment.centerRight,
      _ => Alignment.centerLeft,
    };
    final style = cellStyle.copyWith(
      color: header ? colors.timelineFaint : colors.foreground,
      fontWeight: header ? FontWeight.w400 : null,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: TimelineSpace.x6,
        vertical: TimelineSpace.x4,
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minWidth: TimelineMarkdown.tableCellMinWidth,
          maxWidth: TimelineMarkdown.tableCellMaxWidth,
        ),
        child: Align(
          alignment: alignment,
          child: Text.rich(
            _cellSpan(value.trim(), style, colors),
            style: style,
          ),
        ),
      ),
    );
  }

  InlineSpan _cellSpan(String text, TextStyle base, dynamic colors) {
    final pattern = RegExp(r'(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))');
    final spans = <InlineSpan>[];
    var cursor = 0;
    for (final match in pattern.allMatches(text)) {
      if (match.start > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, match.start)));
      }
      final token = match.group(0)!;
      if (token.startsWith('`') && token.endsWith('`')) {
        spans.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Container(
              margin: TimelineMarkdown.inlineCodeMargin,
              padding: TimelineMarkdown.inlineCodePadding,
              decoration: BoxDecoration(
                color: colors.timelineInlineCode,
                borderRadius: BorderRadius.circular(TimelineRadius.small),
              ),
              child: Text(
                token.substring(1, token.length - 1),
                style: TimelineType.codeStyle(colors.foreground).copyWith(
                  fontSize: TimelineType.meta,
                  height: TimelineType.inlineCodeHeight,
                ),
              ),
            ),
          ),
        );
      } else if (token.startsWith('**') && token.endsWith('**')) {
        spans.add(
          TextSpan(
            text: token.substring(2, token.length - 2),
            style: base.copyWith(fontWeight: FontWeight.w500),
          ),
        );
      } else {
        final link = RegExp(r'\[([^\]]+)\]\(([^)]+)\)').firstMatch(token);
        spans.add(
          TextSpan(
            text: link?.group(1) ?? token,
            style: base.copyWith(
              color: colors.link,
              fontWeight: FontWeight.w500,
            ),
          ),
        );
      }
      cursor = match.end;
    }
    if (cursor < text.length) {
      spans.add(TextSpan(text: text.substring(cursor)));
    }
    return TextSpan(children: spans);
  }
}
