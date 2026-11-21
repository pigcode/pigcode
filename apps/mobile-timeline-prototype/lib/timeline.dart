/// 居中锚定的时间线（参照 DSH Go）：中心线以上是打开时已有的历史，往上长，加载更早接在最上面；
/// 中心线以下是之后新来的行，流式增长只发生在这一段。所以加载历史和流式输出都不移动正在看的内容；
/// 贴底时跟着走，上翻后不打扰。
library;

import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:re_highlight/languages/all.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/atom-one-dark.dart';
import 'package:re_highlight/styles/atom-one-light.dart';

import 'session.dart';

class TimelineView extends StatefulWidget {
  const TimelineView({super.key, required this.session, required this.controller, required this.probeKey});

  final ReplaySession session;
  final ScrollController controller;

  /// 中心线上一个零高度的标记；自检用它的位置算视口有没有动。
  final GlobalKey probeKey;

  @override
  State<TimelineView> createState() => TimelineViewState();
}

class TimelineViewState extends State<TimelineView> {
  final _center = UniqueKey();
  bool pinned = true;

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_changed);
    widget.session.tick.addListener(_follow);
    widget.controller.addListener(_scrolled);
  }

  @override
  void dispose() {
    widget.session.removeListener(_changed);
    widget.session.tick.removeListener(_follow);
    widget.controller.removeListener(_scrolled);
    super.dispose();
  }

  void _scrolled() {
    final position = widget.controller.position;
    final next = position.maxScrollExtent - position.pixels < 40;
    if (next != pinned) setState(() => pinned = next);
  }

  void _changed() {
    setState(() {});
    _follow();
  }

  bool _following = false;

  /// 贴底时跟到底。懒构建的列表总高度是估出来的，排进新行后还会变（flutter/flutter#129768），
  /// 所以跳完以后连着几帧复查，直到总高度连续两帧不变。
  void _follow() {
    if (!pinned || _following) return;
    _following = true;
    double? last;
    var stable = 0;
    void check(Duration _) {
      if (!mounted || !pinned || !widget.controller.hasClients) {
        _following = false;
        return;
      }
      final position = widget.controller.position;
      final max = position.maxScrollExtent;
      if (position.pixels != max) widget.controller.jumpTo(max);
      stable = last == max ? stable + 1 : 0;
      last = max;
      if (stable >= 2) {
        _following = false;
        return;
      }
      WidgetsBinding.instance.addPostFrameCallback(check);
      WidgetsBinding.instance.scheduleFrame();
    }

    WidgetsBinding.instance.addPostFrameCallback(check);
    WidgetsBinding.instance.scheduleFrame();
  }

  void jumpToBottom() {
    setState(() => pinned = true);
    _follow();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    final above = [for (final turn in session.history) ...rowsOf(turn, expandAll: session.expandAll)];
    final below = [for (final turn in session.live) ...rowsOf(turn, expandAll: session.expandAll)];
    return Stack(
      children: [
        CustomScrollView(
          controller: widget.controller,
          center: _center,
          anchor: 1,
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) => RowView(row: above[above.length - 1 - index], session: session),
                  childCount: above.length,
                ),
              ),
            ),
            SliverToBoxAdapter(key: _center, child: SizedBox(key: widget.probeKey, height: 0)),
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              sliver: SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) => RowView(row: below[index], session: session),
                  childCount: below.length,
                ),
              ),
            ),
            const SliverToBoxAdapter(child: SizedBox(height: 24)),
          ],
        ),
        if (!pinned)
          Positioned(
            right: 16,
            bottom: 12,
            child: FloatingActionButton.small(
              heroTag: 'bottom',
              onPressed: jumpToBottom,
              child: const Icon(Icons.arrow_downward),
            ),
          ),
      ],
    );
  }
}

// ─── 行 ──────────────────────────────────────────────────

class RowView extends StatelessWidget {
  const RowView({super.key, required this.row, required this.session});

  final RowRef row;
  final ReplaySession session;

  @override
  Widget build(BuildContext context) {
    final item = row.item;
    if (row.kind == RowKind.summary) return _Summary(turn: row.turn, session: session);
    return switch (item!.kind) {
      ItemKind.user => _UserBubble(item: item),
      ItemKind.assistant => _Answer(item: item),
      ItemKind.reasoning => _Reasoning(item: item),
      ItemKind.tool => _ToolRow(item: item),
    };
  }
}

TextStyle _muted(BuildContext context) =>
    TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.55), fontSize: 14, height: 1.5);

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 20, bottom: 8, left: 48),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(color: scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(16)),
          child: ValueListenableBuilder(
            valueListenable: item.expanded,
            builder: (context, expanded, _) => GestureDetector(
              onTap: () => item.expanded.value = !expanded,
              child: Text(
                item.text.value,
                maxLines: expanded ? null : 4,
                overflow: expanded ? null : TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 15, height: 1.5),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.turn, required this.session});

  final Turn turn;
  final ReplaySession session;

  @override
  Widget build(BuildContext context) {
    final open = turn.expanded || session.expandAll;
    return InkWell(
      onTap: () => session.toggleTurn(turn),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Text('已完成 · ${turn.toolCount} 次工具调用 · ${turn.thoughtCount} 段思考', style: _muted(context)),
            Icon(open ? Icons.expand_less : Icons.chevron_right, size: 18, color: _muted(context).color),
          ],
        ),
      ),
    );
  }
}

class _Reasoning extends StatelessWidget {
  const _Reasoning({required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder(
      valueListenable: item.expanded,
      builder: (context, expanded, _) => InkWell(
        onTap: () => item.expanded.value = !expanded,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text(
            expanded ? item.text.value : '思考 · ${item.text.value.split('\n').first}',
            maxLines: expanded ? null : 1,
            overflow: expanded ? null : TextOverflow.ellipsis,
            style: _muted(context),
          ),
        ),
      ),
    );
  }
}

// ─── 回答：流式 Markdown 和代码高亮 ───────────────────────

final Highlight _highlight = Highlight()..registerLanguages(builtinAllLanguages);

Widget _codeBlock(BuildContext context, String name, String code, bool closed) {
  final dark = Theme.of(context).brightness == Brightness.dark;
  const base = TextStyle(fontFamily: 'Menlo', fontSize: 12.5, height: 1.45);
  TextSpan? span;
  final language = name.trim().toLowerCase();
  if (language.isNotEmpty && _highlight.getLanguage(language) != null) {
    final renderer = TextSpanRenderer(base, dark ? atomOneDarkTheme : atomOneLightTheme);
    _highlight.highlight(code: code, language: language).render(renderer);
    span = renderer.span;
  }
  return Container(
    width: double.infinity,
    margin: const EdgeInsets.symmetric(vertical: 6),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.6),
      borderRadius: BorderRadius.circular(10),
    ),
    child: SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Text.rich(span ?? TextSpan(text: code, style: base)),
    ),
  );
}

Widget _markdown(BuildContext context, String text) => GptMarkdown(
      text,
      style: const TextStyle(fontSize: 15, height: 1.6),
      codeBuilder: _codeBlock,
    );

class _Answer extends StatelessWidget {
  const _Answer({required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: ValueListenableBuilder(
        valueListenable: item.text,
        builder: (context, text, _) => item.streaming
            ? StreamingMarkdown(text: text, isStreaming: true, builder: _markdown)
            : _markdown(context, text),
      ),
    );
  }
}

// ─── 工具行、命令输出和 diff ─────────────────────────────

String _fileName(Object? path) => path is String ? path.split('/').last : '';

(IconData, String, String) _describe(TimelineItem item) {
  final input = item.input ?? const {};
  final running = item.running;
  switch (item.toolName) {
    case 'Read':
      return (Icons.description_outlined, running ? '正在读取' : '已读取', _fileName(input['file_path']));
    case 'Edit' || 'MultiEdit':
      return (Icons.edit_outlined, running ? '正在编辑' : '已编辑', _fileName(input['file_path']));
    case 'Write':
      return (Icons.edit_note, running ? '正在写入' : '已写入', _fileName(input['file_path']));
    case 'Bash':
      final summary = input['description'] as String? ?? (input['command'] as String? ?? '').split('\n').first;
      return (Icons.terminal, running ? '正在执行' : '已执行', summary);
    case 'Grep' || 'Glob':
      return (Icons.search, running ? '正在搜索' : '已搜索', input['pattern'] as String? ?? '');
    default:
      return (Icons.extension_outlined, running ? '正在调用' : '已调用', item.toolName ?? '');
  }
}

class _ToolRow extends StatelessWidget {
  const _ToolRow({required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    final (icon, verb, subject) = _describe(item);
    final muted = _muted(context);
    final failed = (item.exitCode ?? 0) != 0;
    return ValueListenableBuilder(
      valueListenable: item.expanded,
      builder: (context, expanded, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => item.expanded.value = !expanded,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  Icon(icon, size: 16, color: muted.color),
                  const SizedBox(width: 8),
                  Text(verb, style: muted.copyWith(color: failed ? Colors.red : null)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(subject, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted.copyWith(fontSize: 13)),
                  ),
                  if (item.running) SizedBox.square(dimension: 12, child: CircularProgressIndicator(strokeWidth: 1.5, color: muted.color)),
                ],
              ),
            ),
          ),
          if (expanded || (item.running && item.toolName == 'Bash'))
            item.toolName == 'Edit' ? _Diff(input: item.input ?? const {}) : _Output(item: item),
        ],
      ),
    );
  }
}

class _Output extends StatelessWidget {
  const _Output({required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder(
      valueListenable: item.text,
      builder: (context, text, _) {
        final lines = text.split('\n');
        final shown = lines.length > 200 ? [...lines.take(200), '…还有 ${lines.length - 200} 行'] : lines;
        return Container(
          width: double.infinity,
          margin: const EdgeInsets.only(left: 24, bottom: 6),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(shown.join('\n'), style: const TextStyle(fontFamily: 'Menlo', fontSize: 11.5, height: 1.4)),
        );
      },
    );
  }
}

/// 自己画的统一 diff：旧文本和新文本按行做最长公共子序列。
class _Diff extends StatelessWidget {
  const _Diff({required this.input});

  final Map<String, dynamic> input;

  @override
  Widget build(BuildContext context) {
    final before = (input['old_string'] as String? ?? '').split('\n');
    final after = (input['new_string'] as String? ?? '').split('\n');
    final rows = _lineDiff(before.take(400).toList(), after.take(400).toList());
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(left: 24, bottom: 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (sign, text) in rows)
            Container(
              color: sign == '+'
                  ? Colors.green.withValues(alpha: 0.14)
                  : sign == '-'
                      ? Colors.red.withValues(alpha: 0.12)
                      : null,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
              child: Text('$sign $text', style: const TextStyle(fontFamily: 'Menlo', fontSize: 11.5, height: 1.4)),
            ),
        ],
      ),
    );
  }
}

List<(String, String)> _lineDiff(List<String> a, List<String> b) {
  final lcs = List.generate(a.length + 1, (_) => List.filled(b.length + 1, 0));
  for (var i = a.length - 1; i >= 0; i--) {
    for (var j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : (lcs[i + 1][j] >= lcs[i][j + 1] ? lcs[i + 1][j] : lcs[i][j + 1]);
    }
  }
  final rows = <(String, String)>[];
  var i = 0;
  var j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] == b[j]) {
      rows.add((' ', a[i]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.add(('-', a[i++]));
    } else {
      rows.add(('+', b[j++]));
    }
  }
  while (i < a.length) {
    rows.add(('-', a[i++]));
  }
  while (j < b.length) {
    rows.add(('+', b[j++]));
  }
  return rows;
}
