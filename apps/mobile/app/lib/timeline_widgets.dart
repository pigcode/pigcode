import 'dart:async';

import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:re_highlight/languages/all.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/atom-one-dark.dart';
import 'package:re_highlight/styles/atom-one-light.dart';

import 'mobile_sheet.dart';
import 'theme_colors.dart';
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

Widget _codeBlock(BuildContext context, String name, String code, bool closed) {
  final theme = Theme.of(context);
  final dark = theme.brightness == Brightness.dark;
  final base = TextStyle(
    fontFamily: 'monospace',
    fontSize: 12,
    height: 1.58,
    color: theme.colorScheme.onSurface,
  );
  final language = name.trim().toLowerCase();
  TextSpan? span;
  if (language.isNotEmpty && _highlight.getLanguage(language) != null) {
    final renderer = TextSpanRenderer(
      base,
      dark ? atomOneDarkTheme : atomOneLightTheme,
    );
    _highlight.highlight(code: code, language: language).render(renderer);
    span = renderer.span;
  }
  return Container(
    width: double.infinity,
    margin: const EdgeInsets.symmetric(vertical: 6),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(10),
    ),
    child: SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Text.rich(span ?? TextSpan(text: code, style: base)),
    ),
  );
}

Widget _markdown(BuildContext context, String value) {
  final theme = Theme.of(context);
  final colors = theme.colorScheme;
  final body = theme.textTheme.bodyMedium;
  return GptMarkdown(
    value,
    style: body?.copyWith(
      height: 1.6,
      letterSpacing: theme.platform == TargetPlatform.android
          ? (body.fontSize ?? 15) * .025
          : null,
    ),
    inlineCodeStyle: InlineCodeStyle(
      color: colors.onSurface,
      backgroundColor: colors.surfaceContainerHighest,
      borderColor: colors.outlineVariant,
      borderWidth: .5,
    ),
    codeBuilder: _codeBlock,
    imageBuilder: (_, _, _, _) => const Text('图片'),
    onLinkTap: (_, _) {},
  );
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
    this.followed = false,
    this.touchAbove = false,
    this.expanded,
    this.onTap,
  });

  final String label;
  final WorkspaceGlyph? glyph;
  final String? detail;
  final bool file;
  final bool running;
  final bool failed;
  final bool followed;
  final bool touchAbove;
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
    final overhang = timelineWorkTouchOverhang(context);
    final row = Padding(
      padding: EdgeInsets.only(
        top: touchAbove ? overhang : 0,
        bottom: followed ? 16 : 0,
      ),
      child: content,
    );
    if (onTap == null) return row;
    return Semantics(
      expanded: expanded,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(6),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: 40 + overhang),
            child: Align(
              alignment: AlignmentDirectional.topStart,
              heightFactor: 1,
              child: row,
            ),
          ),
        ),
      ),
    );
  }
}

// 原型的活动行高 24，后续行距 16。多出的点按高度可以放进上方留白。
double timelineWorkTouchOverhang(BuildContext context) =>
    Theme.of(context).platform == TargetPlatform.android ? 8 : 4;

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
