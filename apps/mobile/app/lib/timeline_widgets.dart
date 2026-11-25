import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:re_highlight/languages/all.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/atom-one-dark.dart';
import 'package:re_highlight/styles/atom-one-light.dart';

import 'attachments/image_viewer_page.dart';
import 'mobile_sheet.dart';
import 'theme_colors.dart';
import 'timeline/timeline_tokens.dart';
import 'timeline/tools/markdown_table.dart';
import 'workspace_icon.dart';

typedef TimelineContentLoader =
    Future<MobileTimelineContentResult> Function({
      int? seq,
      String? runId,
      String? toolId,
      required MobileTimelineContentField field,
      int? offset,
    });

final _highlight = Highlight()..registerLanguages(builtinAllLanguages);

TextSpan? _highlighted(
  String name,
  String code,
  bool closed,
  Color color,
  bool dark,
) {
  final language = name.trim().toLowerCase();
  if (!closed || language.isEmpty || _highlight.getLanguage(language) == null) {
    return null;
  }
  final base = TimelineType.codeBlockStyle(color);
  final renderer = TextSpanRenderer(
    base,
    dark ? atomOneDarkTheme : atomOneLightTheme,
  );
  _highlight.highlight(code: code, language: language).render(renderer);
  return renderer.span;
}

/// 代码块（桌面 `.code-block`）：1px 边、r12、`--cv-card` 底、header padding 8/8/0/12、
/// 语言 13px lowercase 等宽、28×28 换行与复制按钮、body padding 4/12/12、12/1.6；
/// 流式未闭合的围栏先不高亮。
class TimelineCodeBlock extends StatefulWidget {
  const TimelineCodeBlock({
    super.key,
    required this.name,
    required this.code,
    required this.closed,
  });

  final String name;
  final String code;
  final bool closed;

  @override
  State<TimelineCodeBlock> createState() => _TimelineCodeBlockState();
}

class _TimelineCodeBlockState extends State<TimelineCodeBlock> {
  bool _wrap = false;
  bool _copied = false;
  Timer? _reset;

  @override
  void dispose() {
    _reset?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    _reset?.cancel();
    _reset = Timer(TimelineMotion.copyReset, () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final trimmed = widget.code.replaceFirst(RegExp(r'\n$'), '');
    final language = widget.name.trim().toLowerCase();
    final span = _highlighted(
      language,
      trimmed,
      widget.closed,
      colors.foreground,
      theme.brightness == Brightness.dark,
    );
    final text = Text.rich(
      span ??
          TextSpan(
            text: trimmed,
            style: TimelineType.codeBlockStyle(colors.foreground),
          ),
      softWrap: _wrap,
    );
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(
        vertical: TimelineMarkdown.blockMargin,
      ),
      decoration: BoxDecoration(
        color: colors.timelineCard,
        border: Border.all(
          color: colors.timelineBorder,
          width: TimelineBorder.regular,
        ),
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: TimelineMarkdown.codeHeadPadding,
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    language.isEmpty ? 'text' : language,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.metaMonoStyle(colors.timelineSubtle),
                  ),
                ),
                const SizedBox(width: TimelineSpace.x6),
                _CodeBlockButton(
                  tooltip: _wrap ? '不折行' : '自动换行',
                  icon: Icons.wrap_text,
                  pressed: _wrap,
                  onTap: () => setState(() => _wrap = !_wrap),
                ),
                const SizedBox(width: TimelineSpace.x1),
                _CodeBlockButton(
                  tooltip: _copied ? '已复制' : '复制代码',
                  icon: _copied ? Icons.check_rounded : Icons.copy_rounded,
                  highlight: _copied ? colors.readyMark : null,
                  onTap: _copy,
                ),
              ],
            ),
          ),
          Padding(
            padding: TimelineMarkdown.codeBodyPadding,
            child: _wrap
                ? text
                : SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: text,
                  ),
          ),
        ],
      ),
    );
  }
}

class _CodeBlockButton extends StatelessWidget {
  const _CodeBlockButton({
    required this.tooltip,
    required this.icon,
    required this.onTap,
    this.pressed = false,
    this.highlight,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback onTap;
  final bool pressed;
  final Color? highlight;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        toggled: pressed,
        child: Material(
          color: pressed ? colors.hover : Colors.transparent,
          borderRadius: BorderRadius.circular(TimelineRadius.block),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(TimelineRadius.block),
            child: SizedBox(
              width: TimelineControl.md,
              height: TimelineControl.md,
              child: Center(
                child: Icon(
                  icon,
                  size: TimelineIcon.btn,
                  color:
                      highlight ??
                      (pressed ? colors.foreground : colors.timelineSubtle),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

final _markdownThemes = <Brightness, GptMarkdownThemeData>{};

final _markdownBlocks = [
  MarkdownBlockComponent(
    syntax: const TimelineTableSyntax(),
    builder: timelineTableBlock,
  ),
  MarkdownBlockComponent(
    syntax: const _TimelineTaskListSyntax(),
    builder: _timelineTaskListBlock,
  ),
];

final _taskLinePattern = RegExp(r'^\s*[-*]\s+\[([ xX])\]\s+(.*)$');

class _TimelineTaskListSyntax extends MarkdownBlockSyntax {
  const _TimelineTaskListSyntax();

  @override
  String get type => 'timeline.taskList';

  @override
  String get prefix => '-';

  @override
  MarkdownBlockMatch? parse(List<String> lines, int startLine) {
    if (!_taskLinePattern.hasMatch(lines[startLine])) return null;
    var end = startLine;
    while (end < lines.length && _taskLinePattern.hasMatch(lines[end])) {
      end++;
    }
    return MarkdownBlockMatch(
      node: MdCustomBlock(
        type: type,
        body: lines.sublist(startLine, end).join('\n'),
      ),
      endLine: end,
    );
  }
}

Widget _timelineTaskListBlock(
  BuildContext context,
  MdCustomBlock node,
  GptMarkdownConfig config,
) {
  final lines = node.body.split('\n');
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      for (final (index, line) in lines.indexed)
        if (_taskLinePattern.firstMatch(line) case final match?) ...[
          if (index > 0) const SizedBox(height: TimelineMarkdown.listGap),
          _TimelineTaskCheckbox(
            checked: match.group(1)!.toLowerCase() == 'x',
            content: _markdown(context, match.group(2)!),
          ),
        ],
    ],
  );
}

GptMarkdownThemeData _markdownTheme(Brightness brightness) =>
    _markdownThemes.putIfAbsent(brightness, () {
      final palette = brightness == Brightness.dark
          ? pigcodeDark
          : pigcodeLight;
      return GptMarkdownThemeData(
        brightness: brightness,
        h1: TimelineType.headingStyle(TimelineType.heading1, FontWeight.w600),
        h2: TimelineType.headingStyle(TimelineType.heading2, FontWeight.w600),
        h3: TimelineType.headingStyle(TimelineType.heading3, FontWeight.w600),
        h4: TimelineType.headingStyle(TimelineType.heading3, FontWeight.w600),
        h5: TimelineType.headingStyle(TimelineType.heading3, FontWeight.w500),
        h6: TimelineType.headingStyle(TimelineType.heading3, FontWeight.w400),
        linkColor: palette.link,
        hrLineColor: palette.timelineBorder,
        hrLineThickness: TimelineBorder.regular,
        hrLinePadding: const EdgeInsets.symmetric(
          vertical: TimelineSpace.x2,
        ),
        autoAddDividerLineAfterH1: false,
        styleSheet: GptMarkdownStyleSheet(
          heading: const HeadingStyle(
            padding: EdgeInsets.only(top: TimelineSpace.x4),
          ),
          link: LinkStyle(
            color: palette.link,
            decoration: TextDecoration.none,
            fontWeight: FontWeight.w500,
          ),
          blockQuote: BlockQuoteStyle(
            barWidth: TimelineMarkdown.quoteBarWidth,
            barColor: palette.timelineBorder,
            padding: const EdgeInsetsDirectional.only(
              start: TimelineMarkdown.quotePadding,
            ),
            margin: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
            textStyle: TextStyle(color: palette.timelineSubtle),
          ),
          list: ListStyle(
            bulletColor: palette.timelineFaint,
            markerTextStyle: TimelineType.contentStyle(palette.timelineFaint),
            indent: TimelineSpace.x4,
            gapAfterMarker: TimelineSpace.x4,
          ),
          hr: HrStyle(
            thickness: TimelineBorder.regular,
            color: palette.timelineBorder,
            padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
          ),
        ),
      );
    });

class _TimelineTaskCheckbox extends StatelessWidget {
  const _TimelineTaskCheckbox({required this.checked, required this.content});

  final bool checked;
  final Widget content;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(
            top: TimelineMarkdown.checkboxTopOffset,
          ),
          child: Container(
            width: TimelineControl.check,
            height: TimelineControl.check,
            decoration: BoxDecoration(
              color: checked ? palette.foreground : Colors.transparent,
              border: Border.all(
                color: checked ? palette.foreground : palette.strongBorder,
                width: TimelineBorder.regular,
              ),
              borderRadius: BorderRadius.circular(TimelineRadius.xs),
            ),
            alignment: Alignment.center,
            child: checked
                ? Icon(
                    Icons.check,
                    size: TimelineIcon.check,
                    color: palette.background,
                  )
                : null,
          ),
        ),
        const SizedBox(width: TimelineSpace.fieldGap),
        Expanded(child: content),
      ],
    );
  }
}

Widget _markdown(BuildContext context, String value) {
  final theme = Theme.of(context);
  final body = theme.textTheme.bodyMedium;
  final palette = theme.brightness == Brightness.dark
      ? pigcodeDark
      : pigcodeLight;
  final inlineStyle = InlineCodeStyle(
    color: palette.foreground,
    backgroundColor: palette.timelineInlineCode,
    borderWidth: 0,
    borderRadius: const Radius.circular(TimelineRadius.small),
    padding: TimelineMarkdown.inlineCodePadding,
    fontFamilyFallback: TimelineType.monoFallback,
    fontSizeFactor: TimelineType.meta / TimelineType.content,
    fontWeight: FontWeight.w400,
  );
  return GptMarkdownTheme(
    gptThemeData: _markdownTheme(theme.brightness),
    child: GptMarkdown(
      value,
      style: body?.copyWith(
        color: palette.foreground,
        fontSize: TimelineType.content,
        height: TimelineType.contentHeight,
        letterSpacing: theme.platform == TargetPlatform.android
            ? TimelineType.content * TimelineMarkdown.letterSpacingFactor
            : null,
      ),
      inlineCodeStyle: inlineStyle,
      inlineCodeBuilder: (context, code, style, codeStyle) => TextSpan(
        children: [
          const WidgetSpan(
            child: SizedBox(width: TimelineMarkdown.inlineCodeOuterGap),
          ),
          CodeTextSpan(text: code, codeStyle: codeStyle, style: style),
          const WidgetSpan(
            child: SizedBox(width: TimelineMarkdown.inlineCodeOuterGap),
          ),
        ],
      ),
      unOrderedListBuilder: (context, child, config) => Padding(
        padding: const EdgeInsetsDirectional.only(
          start: TimelineSpace.x4,
          top: TimelineSpace.x1,
          bottom: TimelineSpace.x1,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(
                top: TimelineMarkdown.listBulletTopOffset,
              ),
              child: Container(
                width: TimelineMarkdown.listBulletSize,
                height: TimelineMarkdown.listBulletSize,
                decoration: BoxDecoration(
                  color: palette.timelineFaint,
                  shape: BoxShape.circle,
                ),
              ),
            ),
            const SizedBox(width: TimelineSpace.x4),
            Expanded(child: child),
          ],
        ),
      ),
      codeBuilder: (context, name, code, closed) =>
          TimelineCodeBlock(name: name, code: code, closed: closed),
      tableBuilder: (context, rows, textStyle, config) => TimelineMarkdownTable(
        data: TimelineTableData.fromCustom(rows),
        textStyle: textStyle,
        config: config,
      ),
      blockComponents: _markdownBlocks,
      checkboxBuilder: (context, checked, content, style) =>
          _TimelineTaskCheckbox(checked: checked, content: content),
      imageBuilder: (context, url, width, height) =>
          _MarkdownImage(url: url, width: width, height: height),
      onLinkTap: (url, title) {
        Clipboard.setData(ClipboardData(text: url));
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text('已复制链接 $url')));
      },
    ),
  );
}

/// Markdown 图片（桌面 `.md-image`）：margin 16 0、r12、1px 边、`--bg` 底、最高 360。
class _MarkdownImage extends StatelessWidget {
  const _MarkdownImage({required this.url, this.width, this.height});

  final String url;
  final double? width;
  final double? height;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final image = switch (url) {
      _ when url.startsWith('data:image/') => _dataImage(),
      _ when url.startsWith('http://') || url.startsWith('https://') =>
        Image.network(
          url,
          width: width,
          height: height,
          fit: BoxFit.contain,
          errorBuilder: (_, _, _) => _fallback(context),
          loadingBuilder: (context, child, progress) => progress == null
              ? child
              : const SizedBox(
                  height: TimelineControl.bar,
                  child: Center(
                    child: SizedBox.square(
                      dimension: TimelineIcon.control,
                      child: CircularProgressIndicator(
                        strokeWidth: TimelineSpace.x1,
                      ),
                    ),
                  ),
                ),
        ),
      _ => _fallback(context),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(
        vertical: TimelineMarkdown.blockMargin,
      ),
      child: Container(
        decoration: BoxDecoration(
          color: colors.background,
          border: Border.all(
            color: colors.timelineBorder,
            width: TimelineBorder.regular,
          ),
          borderRadius: BorderRadius.circular(TimelineRadius.panel),
        ),
        clipBehavior: Clip.antiAlias,
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            maxHeight: TimelineMarkdown.imageMaxHeight,
          ),
          child: image,
        ),
      ),
    );
  }

  Widget? _dataImage() {
    final comma = url.indexOf(',');
    if (comma < 0) return null;
    try {
      final bytes = base64Decode(url.substring(comma + 1));
      return Image.memory(
        Uint8List.fromList(bytes),
        width: width,
        height: height,
        fit: BoxFit.contain,
      );
    } on FormatException {
      return null;
    }
  }

  Widget _fallback(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Text('图片', style: TimelineType.metaStyle(colors.timelineFaint));
  }
}

class TimelineAnswer extends StatelessWidget {
  const TimelineAnswer({
    super.key,
    required this.text,
    this.streaming = false,
    this.more,
    this.padding = const EdgeInsets.symmetric(vertical: 8),
  });

  final String text;
  final bool streaming;
  final VoidCallback? more;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (streaming)
          StreamingMarkdown(text: text, isStreaming: true, builder: _markdown)
        else
          _markdown(context, text),
        if (more != null)
          TextButton(onPressed: more, child: const Text('查看完整正文')),
      ],
    ),
  );
}

class TimelineWorkLine extends StatelessWidget {
  const TimelineWorkLine({
    super.key,
    required this.label,
    this.glyph,
    this.detail,
    this.file = false,
    this.running = false,
    this.failed = false,
    this.expanded,
    this.onTap,
  });

  final String label;
  final WorkspaceGlyph? glyph;
  final String? detail;
  final bool file;
  final bool running;
  final bool failed;
  final bool? expanded;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final foreground = failed
        ? colors.error
        : running
        ? colors.foreground
        : colors.timelineSubtle;
    final content = Row(
      spacing: 8,
      children: [
        if (glyph case final glyph?)
          IconTheme(
            data: IconThemeData(color: colors.timelineSubtle),
            child: WorkspaceIcon(glyph, size: 16),
          ),
        Flexible(
          child: Text.rich(
            TextSpan(
              text: label,
              children: [
                if (detail case final description?
                    when description.isNotEmpty) ...[
                  const WidgetSpan(child: SizedBox(width: 8)),
                  if (file) ...[
                    WidgetSpan(
                      alignment: PlaceholderAlignment.middle,
                      child: IconTheme(
                        data: IconThemeData(color: colors.timelineFile),
                        child: const WorkspaceIcon(
                          WorkspaceGlyph.fileText,
                          size: 16,
                        ),
                      ),
                    ),
                    const WidgetSpan(child: SizedBox(width: 6)),
                  ],
                  TextSpan(
                    text: description,
                    style: TextStyle(
                      color: file ? colors.foreground : colors.timelineFaint,
                    ),
                  ),
                ],
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodyMedium?.copyWith(
              height: 1.6,
              color: foreground,
              leadingDistribution: TextLeadingDistribution.even,
            ),
          ),
        ),
        if (expanded == true)
          IconTheme(
            data: IconThemeData(color: colors.timelineSubtle),
            child: const WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 14),
          ),
      ],
    );
    if (onTap == null) return content;
    return Semantics(
      expanded: expanded,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(TimelineRadius.xs),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: timelineTouchHeight(context)),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              heightFactor: 1,
              child: content,
            ),
          ),
        ),
      ),
    );
  }
}

class TimelineDetails {
  const TimelineDetails({
    required this.label,
    required this.field,
    this.seq,
    this.runId,
    this.toolId,
    this.preview = '',
    this.truncated = false,
  });

  final String label;
  final MobileTimelineContentField field;
  final int? seq;
  final String? runId;
  final String? toolId;
  final String preview;
  final bool truncated;
}

void showTimelineDetails(
  BuildContext context,
  String title,
  List<TimelineDetails> sections,
  TimelineContentLoader? loader,
) {
  unawaited(
    showMobileSheet<void>(
      context,
      title: title,
      content: (_) => SliverList.list(
        children: [
          for (final section in sections)
            _DetailSection(section: section, loader: loader),
        ],
      ),
    ),
  );
}

class _DetailSection extends StatefulWidget {
  const _DetailSection({required this.section, required this.loader});
  final TimelineDetails section;
  final TimelineContentLoader? loader;

  @override
  State<_DetailSection> createState() => _DetailSectionState();
}

class _DetailSectionState extends State<_DetailSection> {
  String? _loaded;
  int? _next;
  bool _busy = false;
  bool _failed = false;

  Future<void> _load() async {
    final load = widget.loader;
    if (_busy || load == null) return;
    setState(() {
      _busy = true;
      _failed = false;
    });
    try {
      final section = widget.section;
      final result = await load(
        seq: section.seq,
        runId: section.runId,
        toolId: section.toolId,
        field: section.field,
        offset: _next,
      );
      if (mounted) {
        setState(() {
          _loaded = (_loaded ?? '') + result.text;
          _next = result.nextOffset;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canLoad =
        widget.loader != null &&
        (_next != null || (_loaded == null && widget.section.truncated));
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.section.label,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 6),
          SelectableText(_loaded ?? widget.section.preview),
          if (_failed) const Text('暂时无法读取这一段。'),
          if (canLoad)
            TextButton(
              onPressed: _busy ? null : _load,
              child: Text(_loaded == null ? '读取完整内容' : '继续读取'),
            ),
        ],
      ),
    );
  }
}

double timelineActivityTouchHeight(BuildContext context) {
  final minimum = Theme.of(context).platform == TargetPlatform.android
      ? 48.0
      : 44.0;
  final label = MediaQuery.textScalerOf(context).scale(13) + 14;
  return label > minimum ? label : minimum;
}

class TimelineActivity extends StatefulWidget {
  const TimelineActivity({super.key, required this.run});
  final MobileActiveRun run;

  @override
  State<TimelineActivity> createState() => _TimelineActivityState();
}

class _TimelineActivityState extends State<TimelineActivity> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    final started = DateTime.tryParse(run.startedAt) ?? DateTime.now();
    final seconds = DateTime.now()
        .difference(started)
        .inSeconds
        .clamp(0, 999999);
    final step = run.pending.isEmpty ? run.step ?? '运行中' : '等你处理';
    final plan = run.totalSteps == null || run.totalSteps == 0
        ? null
        : '${run.finishedSteps ?? 0}/${run.totalSteps}';
    final elapsed =
        '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    final theme = Theme.of(context);
    return Center(
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          borderRadius: BorderRadius.circular(24),
          onTap: () => showTimelineDetails(context, '本轮活动', [
            TimelineDetails(
              label: step,
              field: MobileTimelineContentField.text,
              preview: [elapsed, if (plan != null) '计划 $plan'].join(' · '),
            ),
          ], null),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: timelineActivityTouchHeight(context),
            ),
            child: Center(
              widthFactor: 1,
              heightFactor: 1,
              child: Container(
                constraints: const BoxConstraints(minHeight: 36),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        step,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      elapsed,
                      style: const TextStyle(
                        fontSize: 13,
                        fontFeatures: [FontFeature.tabularFigures()],
                      ),
                    ),
                    if (plan != null) ...[
                      const SizedBox(width: 8),
                      Text(plan, style: const TextStyle(fontSize: 13)),
                    ],
                    const SizedBox(width: 6),
                    const Icon(Icons.keyboard_arrow_up, size: 16),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 根据单张图片的原始宽高元数据计算气泡内的自适应占位尺寸，限制最大宽高防止长截图撑爆屏幕，
/// 并提前占位避免缩略图异步加载完成时触发时间线抖动。
Size computeSingleAttachmentSize({
  int? width,
  int? height,
  double maxWidth = 260,
  double maxHeight = 280,
  double minSide = 96,
}) {
  final boundedMaxWidth = maxWidth.clamp(minSide, double.infinity);
  final boundedMaxHeight = maxHeight.clamp(minSide, double.infinity);
  if (width == null || height == null || width <= 0 || height <= 0) {
    final fallbackWidth = math.min(boundedMaxWidth, 200.0);
    return Size(fallbackWidth, math.min(boundedMaxHeight, 150.0));
  }
  final aspect = (width / height).clamp(0.45, 2.2);
  var targetWidth = boundedMaxWidth;
  var targetHeight = targetWidth / aspect;
  if (targetHeight > boundedMaxHeight) {
    targetHeight = boundedMaxHeight;
    targetWidth = targetHeight * aspect;
  }
  if (targetWidth < minSide) {
    targetWidth = math.min(minSide, boundedMaxWidth);
    targetHeight = (targetWidth / aspect).clamp(minSide, boundedMaxHeight);
  }
  if (targetHeight < minSide) {
    targetHeight = math.min(minSide, boundedMaxHeight);
    targetWidth = (targetHeight * aspect).clamp(minSide, boundedMaxWidth);
  }
  return Size(targetWidth, targetHeight);
}

/// 多图消息的紧凑网格列数：1 张为 1 列，2/4 张为 2 列，3/5/6 张为 3 列。
int timelineAttachmentGridColumns(int count) {
  if (count <= 1) return 1;
  if (count == 2 || count == 4) return 2;
  return 3;
}

typedef AttachmentThumbPeeker = Uint8List? Function(String attachmentId);

/// 时间线用户气泡中的图片附件区（支持 1 张自适应宽高与 2–6 张紧凑 2/3 列圆角方格）。
class TimelineUserAttachmentGrid extends StatefulWidget {
  const TimelineUserAttachmentGrid({
    super.key,
    required this.attachments,
    this.peekThumb,
    this.loadThumb,
    this.loadFull,
  });

  static const gridKey = ValueKey('timeline-user-attachments');

  final List<MobileAttachmentRef> attachments;
  final AttachmentThumbPeeker? peekThumb;
  final AttachmentBytesLoader? loadThumb;
  final AttachmentBytesLoader? loadFull;

  @override
  State<TimelineUserAttachmentGrid> createState() =>
      _TimelineUserAttachmentGridState();
}

class _TimelineUserAttachmentGridState
    extends State<TimelineUserAttachmentGrid> {
  final _thumbs = <String, Uint8List>{};
  final _loading = <String>{};
  final _failed = <String>{};

  @override
  void initState() {
    super.initState();
    _syncLoads();
  }

  @override
  void didUpdateWidget(covariant TimelineUserAttachmentGrid oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.attachments != widget.attachments ||
        oldWidget.loadThumb != widget.loadThumb) {
      _syncLoads();
    }
  }

  void _syncLoads() {
    for (final ref in widget.attachments) {
      if (_thumbs.containsKey(ref.id)) continue;
      final mem = widget.peekThumb?.call(ref.id);
      if (mem != null && mem.isNotEmpty) {
        _thumbs[ref.id] = mem;
        _failed.remove(ref.id);
        continue;
      }
      if (widget.loadThumb != null && !_loading.contains(ref.id)) {
        unawaited(_fetchThumb(ref.id));
      }
    }
  }

  Future<void> _fetchThumb(String attachmentId) async {
    final loader = widget.loadThumb;
    if (loader == null) return;
    _loading.add(attachmentId);
    try {
      final bytes = await loader(attachmentId);
      if (!mounted) return;
      setState(() {
        _loading.remove(attachmentId);
        if (bytes != null && bytes.isNotEmpty) {
          _thumbs[attachmentId] = bytes;
          _failed.remove(attachmentId);
        } else {
          _failed.add(attachmentId);
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading.remove(attachmentId);
        _failed.add(attachmentId);
      });
    }
  }

  void _openViewer(int index) {
    final items = [
      for (final ref in widget.attachments)
        ImageViewerItem.fromRef(ref, initialBytes: _thumbs[ref.id]),
    ];
    unawaited(
      ImageViewerPage.open(
        context,
        items: items,
        initialIndex: index,
        loadThumb: widget.loadThumb,
        loadFull: widget.loadFull,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final attachments = widget.attachments;
    if (attachments.isEmpty) return const SizedBox.shrink();

    return LayoutBuilder(
      builder: (context, constraints) {
        final maxAvailable = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : 260.0;
        if (attachments.length == 1) {
          final ref = attachments.single;
          final size = computeSingleAttachmentSize(
            width: ref.width,
            height: ref.height,
            maxWidth: math.min(260.0, maxAvailable),
            maxHeight: 280.0,
          );
          return KeyedSubtree(
            key: TimelineUserAttachmentGrid.gridKey,
            child: _TimelineAttachmentCell(
              key: ValueKey('timeline-attachment-${ref.id}'),
              attachment: ref,
              width: size.width,
              height: size.height,
              bytes: _thumbs[ref.id],
              loading: _loading.contains(ref.id),
              failed: _failed.contains(ref.id),
              onTap: () => _openViewer(0),
            ),
          );
        }

        final columns = timelineAttachmentGridColumns(attachments.length);
        const gap = TimelineSpace.x2;
        final gridLimit = columns == 2 ? 224.0 : 272.0;
        final gridWidth = math.min(gridLimit, maxAvailable);
        final cellSize = ((gridWidth - gap * (columns - 1)) / columns).clamp(
          48.0,
          gridWidth,
        );

        return SizedBox(
          key: TimelineUserAttachmentGrid.gridKey,
          width: gridWidth,
          child: Wrap(
            spacing: gap,
            runSpacing: gap,
            children: [
              for (var i = 0; i < attachments.length; i++)
                _TimelineAttachmentCell(
                  key: ValueKey('timeline-attachment-${attachments[i].id}'),
                  attachment: attachments[i],
                  width: cellSize,
                  height: cellSize,
                  bytes: _thumbs[attachments[i].id],
                  loading: _loading.contains(attachments[i].id),
                  failed: _failed.contains(attachments[i].id),
                  onTap: () => _openViewer(i),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _TimelineAttachmentCell extends StatelessWidget {
  const _TimelineAttachmentCell({
    super.key,
    required this.attachment,
    required this.width,
    required this.height,
    required this.bytes,
    required this.loading,
    required this.failed,
    required this.onTap,
  });

  final MobileAttachmentRef attachment;
  final double width;
  final double height;
  final Uint8List? bytes;
  final bool loading;
  final bool failed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final radius = BorderRadius.circular(TimelineRadius.block);

    return Semantics(
      button: true,
      label: '查看图片 ${attachment.fileName}',
      child: GestureDetector(
        onTap: onTap,
        child: SizedBox(
          width: width,
          height: height,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: colors.field,
              borderRadius: radius,
              border: Border.all(
                color: colors.timelineBorder,
                width: TimelineBorder.hair,
              ),
            ),
            child: ClipRRect(
              borderRadius: radius,
              child: bytes != null
                  ? Image.memory(
                      bytes!,
                      width: width,
                      height: height,
                      fit: BoxFit.cover,
                      gaplessPlayback: true,
                      errorBuilder: (_, _, _) => Center(
                        child: IconTheme(
                          data: IconThemeData(color: colors.timelineFaint),
                          child: const WorkspaceIcon(
                            WorkspaceGlyph.image,
                            size: TimelineIcon.alert,
                          ),
                        ),
                      ),
                    )
                  : Center(
                      child: loading
                          ? SizedBox.square(
                              dimension: TimelineIcon.control,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: colors.timelineFaint,
                              ),
                            )
                          : IconTheme(
                              data: IconThemeData(
                                color: failed
                                    ? colors.timelineSubtle
                                    : colors.timelineFaint,
                              ),
                              child: const WorkspaceIcon(
                                WorkspaceGlyph.image,
                                size: TimelineIcon.alert,
                              ),
                            ),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
