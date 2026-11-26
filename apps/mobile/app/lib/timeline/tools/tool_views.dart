import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../../mobile_glass.dart';
import '../../theme_colors.dart';
import '../../timeline_widgets.dart';
import '../../timeline_work.dart';
import '../../workbench/workbench_utils.dart';
import '../timeline_tokens.dart';
import '../tool_row.dart';
import 'command_card.dart';
import 'inline_diff.dart';

/// 单个工具调用的行和展开内容。按工具族选择摘要、图标和详情。
class TimelineToolView extends StatefulWidget {
  const TimelineToolView({
    super.key,
    required this.item,
    required this.ended,
    required this.content,
    this.online = true,
    this.showIcon = true,
    this.compact = false,
    this.liveOutput,
    this.onOpenDetails,
    this.onOpenFile,
  });

  final TimelineWork item;
  final bool ended;
  final TimelineContentLoader content;
  final bool online;
  final bool showIcon;
  final bool compact;
  final String? liveOutput;
  final VoidCallback? onOpenDetails;
  final TimelineOpenFileCallback? onOpenFile;

  @override
  State<TimelineToolView> createState() => _TimelineToolViewState();
}

class _TimelineToolViewState extends State<TimelineToolView> {
  static const _maxInputPages = 64;

  bool _expanded = false;
  Object? _fullInput;
  bool _loadingInput = false;
  bool _inputLoadFailed = false;
  int _inputLoadGeneration = 0;

  @override
  void didUpdateWidget(TimelineToolView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.item.input?.seq != widget.item.input?.seq ||
        oldWidget.item.input?.text != widget.item.input?.text ||
        oldWidget.item.input?.truncated != widget.item.input?.truncated) {
      _inputLoadGeneration++;
      _fullInput = null;
      _loadingInput = false;
      _inputLoadFailed = false;
      if (_expanded && _needsFullEditInput) {
        unawaited(_loadFullEditInput());
      }
    }
  }

  bool get _needsFullEditInput =>
      kind == TimelineToolKind.edit &&
      item.input?.truncated == true &&
      _fullInput == null;

  Future<void> _loadFullEditInput() async {
    final inputEvent = item.input;
    if (!widget.online ||
        inputEvent == null ||
        _loadingInput ||
        _fullInput != null) {
      return;
    }
    final generation = ++_inputLoadGeneration;
    setState(() {
      _loadingInput = true;
      _inputLoadFailed = false;
    });
    final buffer = StringBuffer();
    int? offset;
    var pages = 0;
    try {
      while (pages < _maxInputPages) {
        pages++;
        final page = await widget.content(
          seq: inputEvent.seq,
          field: MobileTimelineContentField.input,
          offset: offset,
        );
        if (!mounted || generation != _inputLoadGeneration) return;
        buffer.write(page.text);
        offset = page.nextOffset;
        if (offset == null) break;
      }
      final raw = buffer.toString().trim();
      Object? parsed = raw;
      if (raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('"')) {
        try {
          parsed = jsonDecode(raw);
        } on FormatException {
          parsed = raw;
        }
      }
      if (mounted && generation == _inputLoadGeneration) {
        setState(() {
          _fullInput = parsed;
          _loadingInput = false;
        });
      }
    } catch (_) {
      if (mounted && generation == _inputLoadGeneration) {
        setState(() {
          _loadingInput = false;
          _inputLoadFailed = true;
        });
      }
    }
  }

  void _toggleExpanded() {
    setState(() => _expanded = !_expanded);
    if (_expanded && _needsFullEditInput) {
      unawaited(_loadFullEditInput());
    }
  }

  TimelineWork get item => widget.item;
  TimelineToolKind get kind => timelineToolKind(item);
  bool get running => item.output == null && !widget.ended;
  bool get failed => item.output?.failed == true;
  bool get stopped => widget.ended && item.output == null;

  String get _name => (item.output?.name ?? item.event.name ?? '').trim();

  String get _action {
    final prefix = running ? '正在' : '已';
    return switch (kind) {
      TimelineToolKind.read => '$prefix读取',
      TimelineToolKind.search => '$prefix搜索',
      TimelineToolKind.fetch => '$prefix抓取',
      TimelineToolKind.edit =>
        _name.toLowerCase() == 'write' ? '$prefix写入' : '$prefix编辑',
      TimelineToolKind.command => '$prefix执行',
      TimelineToolKind.browser => '$prefix执行',
      TimelineToolKind.mcp => '$prefix调用',
      TimelineToolKind.skill => '$prefix使用',
      TimelineToolKind.task => '$prefix处理',
      TimelineToolKind.plan => '计划',
      TimelineToolKind.ask => '$prefix提问',
      TimelineToolKind.other => _name.isEmpty ? '$prefix调用' : _name,
    };
  }

  IconData get _icon => switch (kind) {
    TimelineToolKind.read => Icons.search,
    TimelineToolKind.search => Icons.search,
    TimelineToolKind.fetch => Icons.public,
    TimelineToolKind.edit => Icons.edit_outlined,
    TimelineToolKind.command => Icons.terminal,
    TimelineToolKind.browser => Icons.language,
    TimelineToolKind.mcp => Icons.hub_outlined,
    TimelineToolKind.skill => Icons.auto_awesome_outlined,
    TimelineToolKind.task => Icons.task_alt_outlined,
    TimelineToolKind.plan => Icons.checklist_rounded,
    TimelineToolKind.ask => Icons.help_outline,
    TimelineToolKind.other => Icons.build_outlined,
  };

  String? get _status {
    if (failed) return '执行失败';
    if (stopped) return '已停止';
    return null;
  }

  ({int added, int removed})? get _diff {
    if (kind != TimelineToolKind.edit) return null;
    if (_fullInput != null) return timelineEditStatsFromInput(_fullInput);
    return timelineEditStats(item);
  }

  bool get _nonExpandableReadOnly =>
      kind == TimelineToolKind.read ||
      kind == TimelineToolKind.search ||
      kind == TimelineToolKind.fetch;

  bool get _expandable =>
      !_nonExpandableReadOnly &&
      (item.input != null ||
          item.output != null ||
          kind == TimelineToolKind.command ||
          kind == TimelineToolKind.edit);

  @override
  Widget build(BuildContext context) {
    final detail = timelineToolDetail(item, kind);
    if (kind == TimelineToolKind.plan) {
      return TimelinePlanCard(item: item, content: widget.content);
    }
    final detailIsFile =
        (kind == TimelineToolKind.read || kind == TimelineToolKind.edit) &&
        detail != null &&
        detail.isNotEmpty;
    final filePath = detailIsFile ? timelineToolFilePath(item, kind) : null;
    final fileLine = detailIsFile ? timelineToolFileLine(item, kind) : null;
    final openFile = widget.onOpenFile;
    final openFileTap = openFile != null && filePath != null
        ? () => unawaited(openFile(filePath, line: fileLine))
        : null;
    return TimelineToolRow(
      icon: _icon,
      action: _action,
      detail: detail,
      detailIsFile: detailIsFile,
      onDetailTap: openFileTap,
      diff: _diff,
      status: _status,
      running: running,
      failed: failed,
      detailTone: switch (kind) {
        TimelineToolKind.command => TimelineDetailTone.tertiary,
        TimelineToolKind.read ||
        TimelineToolKind.edit => TimelineDetailTone.primary,
        _ => TimelineDetailTone.secondary,
      },
      hideDetailWhenExpanded:
          kind == TimelineToolKind.command &&
          timelineCommandDescription(item) == null,
      onStatusTap: failed ? _showFailure : null,
      showIcon: widget.showIcon,
      compact: widget.compact,
      expandable: _expandable,
      expanded: _expanded,
      onTap: _nonExpandableReadOnly
          ? (kind == TimelineToolKind.read ? openFileTap : null)
          : _expandable
          ? _toggleExpanded
          : widget.onOpenDetails,
      child: _expanded ? _details(context) : null,
    );
  }

  Widget _details(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final input = item.input?.text?.trim();
    final live = timelineStripAnsi(widget.liveOutput ?? '').trim();
    final output = timelineStripAnsi(timelineToolOutput(item) ?? '').trim();
    final truncated =
        item.input?.truncated == true || item.output?.truncated == true;
    final sections = <Widget>[];
    if (kind == TimelineToolKind.command) {
      final command = timelineCommand(item) ?? '';
      final text = running ? live : output;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TimelineCommandCard(command: command, output: text, running: running),
          if (truncated)
            TextButton(
              onPressed: widget.onOpenDetails,
              child: const Text('查看完整内容'),
            ),
        ],
      );
    } else if (kind == TimelineToolKind.edit) {
      if (_loadingInput) {
        return Padding(
          padding: const EdgeInsets.only(bottom: TimelineSpace.x4),
          child: Text(
            '正在加载改动内容…',
            style: TimelineType.metaStyle(colors.timelineFaint),
          ),
        );
      }
      final diff = _editDiff();
      if (diff != null) return diff;
      if (_inputLoadFailed) {
        return Padding(
          padding: const EdgeInsets.only(bottom: TimelineSpace.x4),
          child: InkWell(
            onTap: () => unawaited(_loadFullEditInput()),
            borderRadius: BorderRadius.circular(TimelineRadius.xs),
            child: Text(
              '改动内容加载失败，点击重试',
              style: TimelineType.metaStyle(colors.timelineSubtle).copyWith(
                decoration: TextDecoration.underline,
                decorationStyle: TextDecorationStyle.dotted,
                decorationColor: colors.timelineSubtle,
              ),
            ),
          ),
        );
      }
      if (item.input?.truncated == true && !widget.online) {
        return Padding(
          padding: const EdgeInsets.only(bottom: TimelineSpace.x4),
          child: Text(
            '电脑离线，暂时无法加载完整改动',
            style: TimelineType.metaStyle(colors.timelineFaint),
          ),
        );
      }
      if (output.isNotEmpty) {
        sections.add(TimelineToolSection(label: '结果', text: output));
      }
    } else if (kind == TimelineToolKind.mcp) {
      if (output.isNotEmpty) {
        sections.add(TimelineToolSection(label: '结果', text: output));
      }
      if (input != null && input.isNotEmpty) {
        sections.add(TimelineToolSection(label: '调用参数', text: input));
      }
    } else {
      if (output.isNotEmpty) {
        sections.add(TimelineToolSection(label: '结果', text: output));
      } else if (running) {
        sections.add(
          Text('等待结果…', style: TimelineType.metaStyle(colors.timelineFaint)),
        );
      }
      if (input != null && input.isNotEmpty) {
        sections.add(TimelineToolSection(label: '参数', text: input));
      }
    }
    if (truncated) {
      sections.add(
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton(
            onPressed: widget.onOpenDetails,
            child: const Text('查看完整内容'),
          ),
        ),
      );
    }
    if (sections.isEmpty) {
      return Text(
        '没有可显示的内容。',
        style: TimelineType.metaStyle(colors.timelineFaint),
      );
    }
    return TimelineToolDetails(children: sections);
  }

  void _showFailure() {
    final output = timelineStripAnsi(
      widget.liveOutput ?? timelineToolOutput(item) ?? '',
    ).trim();
    final lines = output
        .split('\n')
        .where((line) => line.trim().isNotEmpty)
        .take(6)
        .join('\n');
    final exit = RegExp(
      r'(?:exit code|Exit code|退出码)[:： ]+(\d+)',
    ).firstMatch(output)?.group(1);
    if (!mounted) return;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: false,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      elevation: 0,
      builder: (context) => MobileGlassSheetSurface(
        child: _FailureSheet(
          command: timelineCommand(item) ?? '',
          output: lines,
          exitCode: exit,
        ),
      ),
    );
  }

  Widget? _editDiff() {
    final source = _fullInput;
    if (source is String && source.contains('*** Begin Patch')) {
      return TimelineInlineDiff(patch: source);
    }
    final record = source is Map ? source : timelineToolRecord(item);
    final oldText =
        (record['old_string'] ?? record['oldString']) as String? ??
        (record['old'] as String?);
    final newText =
        (record['new_string'] ?? record['newString']) as String? ??
        (record['content'] as String?) ??
        (record['new_source'] as String?);
    final edits = source is List
        ? source
        : (record['edits'] ?? record['changes']);
    if (oldText != null || newText != null) {
      return TimelineInlineDiff(oldText: oldText, newText: newText);
    }
    if (edits is List) {
      final colors = Theme.of(context).brightness == Brightness.dark
          ? pigcodeDark
          : pigcodeLight;
      final rows = <Widget>[];
      for (final entry in edits.whereType<Map>()) {
        final path =
            (entry['file_path'] ?? entry['path'] ?? entry['filePath'])
                as String?;
        final diffText = (entry['diff'] ?? entry['unified_diff']) as String?;
        final oldValue =
            (entry['old_string'] ?? entry['oldString'] ?? entry['old'])
                as String?;
        final newValue =
            (entry['new_string'] ??
                    entry['newString'] ??
                    entry['new'] ??
                    entry['content'])
                as String?;
        if (diffText == null && oldValue == null && newValue == null) continue;
        if (rows.isNotEmpty) rows.add(const SizedBox(height: TimelineSpace.x4));
        if (path != null) {
          rows.add(
            Text(path, style: TimelineType.smallStyle(colors.timelineSubtle)),
          );
          rows.add(const SizedBox(height: TimelineSpace.x1));
        }
        rows.add(
          diffText != null
              ? TimelineInlineDiff(patch: diffText)
              : TimelineInlineDiff(oldText: oldValue, newText: newValue),
        );
      }
      return rows.isEmpty
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: rows,
            );
    }
    final patch = record['patch'] ?? record['input'];
    if (patch is String && patch.trim().isNotEmpty) {
      return TimelineInlineDiff(patch: patch);
    }
    return null;
  }
}

/// 计划卡（桌面 `.plan-card`）：ExitPlanMode 交出的计划正文，默认 256 限高渐隐，居中胶囊展开。
class TimelinePlanCard extends StatefulWidget {
  const TimelinePlanCard({
    super.key,
    required this.item,
    required this.content,
  });

  final TimelineWork item;
  final TimelineContentLoader content;

  @override
  State<TimelinePlanCard> createState() => _TimelinePlanCardState();
}

class _TimelinePlanCardState extends State<TimelinePlanCard> {
  bool _expanded = false;

  String get _planText {
    final record = timelineToolRecord(widget.item);
    final plan = record['plan'];
    if (plan is String) return plan;
    if (plan is List) {
      return plan
          .map((entry) {
            if (entry is String) return '- $entry';
            if (entry is Map) {
              final title = entry['title'] ?? entry['step'] ?? entry['text'];
              final detail = entry['description'] ?? entry['detail'];
              if (title is String && detail is String) {
                return '- $title\n  $detail';
              }
              if (title is String) return '- $title';
            }
            return null;
          })
          .whereType<String>()
          .join('\n');
    }
    return widget.item.input?.text ?? '';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final text = _planText;
    final moreButton = Material(
      color: colors.background,
      shape: StadiumBorder(
        side: BorderSide(
          color: colors.timelineBorder,
          width: TimelineBorder.regular,
        ),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: () => setState(() => _expanded = !_expanded),
        child: Container(
          height: TimelineControl.md,
          padding: const EdgeInsets.symmetric(horizontal: TimelineSpace.x6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(TimelineRadius.full),
            boxShadow: TimelineShadow.sm,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _expanded ? '收起计划' : '查看完整计划',
                style: TimelineType.metaStyle(colors.foreground),
              ),
              const SizedBox(width: TimelineSpace.x2),
              Icon(
                _expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                size: TimelineIcon.meta,
                color: colors.foreground,
              ),
            ],
          ),
        ),
      ),
    );

    final planContent = ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: _expanded
            ? double.infinity
            : TimelineToolCard.planCollapsedHeight,
      ),
      child: ClipRect(
        child: _expanded
            ? TimelineAnswer(text: text, padding: EdgeInsets.zero)
            : ShaderMask(
                blendMode: BlendMode.dstIn,
                shaderCallback: (bounds) => const LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Colors.white, Colors.white, Colors.transparent],
                  stops: [0, TimelineSpace.planFadeStop, 1],
                ).createShader(bounds),
                child: TimelineAnswer(text: text, padding: EdgeInsets.zero),
              ),
      ),
    );
    final body = MediaQuery.disableAnimationsOf(context)
        ? planContent
        : AnimatedSize(
            duration: TimelineMotion.slower,
            curve: TimelineMotion.ease,
            alignment: Alignment.topCenter,
            child: planContent,
          );

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: TimelineSpace.x4),
      decoration: BoxDecoration(
        color: colors.timelineCard,
        border: Border.all(
          color: colors.timelineBorder,
          width: TimelineBorder.regular,
        ),
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
        boxShadow: TimelineShadow.card,
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                height: TimelineControl.bar,
                child: Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(
                    TimelineSpace.x7,
                    TimelineSpace.x7,
                    TimelineSpace.x6,
                    0,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.checklist_rounded,
                        size: TimelineIcon.row,
                        color: colors.timelineSubtle,
                      ),
                      const SizedBox(width: TimelineSpace.x4),
                      Expanded(
                        child: Text(
                          '计划',
                          style: TimelineType.contentStyle(
                            colors.foreground,
                            weight: FontWeight.w500,
                          ),
                        ),
                      ),
                      SizedBox(
                        width: TimelineControl.md,
                        height: TimelineControl.md,
                        child: IconButton(
                          tooltip: '复制计划',
                          padding: EdgeInsets.zero,
                          onPressed: text.isEmpty
                              ? null
                              : () => _copy(context, text),
                          icon: const Icon(
                            Icons.copy_rounded,
                            size: TimelineIcon.btn,
                          ),
                          color: colors.timelineSubtle,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  TimelineSpace.x7,
                  TimelineSpace.x4,
                  TimelineSpace.x7,
                  TimelineSpace.x7,
                ),
                child: body,
              ),
              if (_expanded)
                Padding(
                  padding: const EdgeInsets.only(bottom: TimelineSpace.x6),
                  child: Center(child: moreButton),
                ),
              if (widget.item.input?.truncated == true)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    start: TimelineSpace.x7,
                    bottom: TimelineSpace.x4,
                  ),
                  child: TextButton(
                    onPressed: () => showTimelineDetails(context, '完整计划', [
                      TimelineDetails(
                        label: '计划',
                        field: MobileTimelineContentField.input,
                        seq: widget.item.input!.seq,
                        preview: text,
                        truncated: true,
                      ),
                    ], widget.content),
                    child: const Text('加载完整计划'),
                  ),
                ),
            ],
          ),
          if (!_expanded)
            Positioned(
              left: 0,
              right: 0,
              bottom: TimelineSpace.x6,
              child: Center(child: moreButton),
            ),
        ],
      ),
    );
  }

  Future<void> _copy(BuildContext context, String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('已复制计划')));
  }
}

class _FailureSheet extends StatefulWidget {
  const _FailureSheet({
    required this.command,
    required this.output,
    this.exitCode,
  });

  final String command;
  final String output;
  final String? exitCode;

  @override
  State<_FailureSheet> createState() => _FailureSheetState();
}

class _FailureSheetState extends State<_FailureSheet> {
  bool _copied = false;

  Future<void> _copy() async {
    final text = [
      if (widget.exitCode != null) '退出码 ${widget.exitCode}',
      if (widget.output.isNotEmpty) widget.output,
    ].join('\n');
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) setState(() => _copied = true);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          TimelineSpace.x9,
          8,
          TimelineSpace.x9,
          TimelineSpace.x9,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: SizedBox(
                  width: 36,
                  height: 5,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.strongBorder,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ),
            ),
            Row(
              children: [
                Icon(
                  Icons.error_outline,
                  size: TimelineIcon.alert,
                  color: colors.error,
                ),
                const SizedBox(width: TimelineSpace.x4),
                Expanded(
                  child: Text(
                    '执行失败',
                    style: TimelineType.contentStyle(
                      colors.foreground,
                      weight: FontWeight.w500,
                    ),
                  ),
                ),
                TextButton.icon(
                  onPressed: _copy,
                  icon: Icon(
                    _copied ? Icons.check_rounded : Icons.copy_rounded,
                    size: TimelineIcon.meta,
                  ),
                  label: Text(_copied ? '已复制' : '复制原因'),
                ),
              ],
            ),
            if (widget.exitCode case final code?)
              Padding(
                padding: const EdgeInsets.only(top: TimelineSpace.x2),
                child: Text(
                  '退出码 $code',
                  style: TimelineType.metaStyle(colors.error),
                ),
              ),
            if (widget.output.isNotEmpty) ...[
              const SizedBox(height: TimelineSpace.x4),
              Container(
                constraints: const BoxConstraints(
                  maxHeight: TimelineToolCard.sectionMaxHeight,
                ),
                padding: TimelineToolCard.padding,
                decoration: BoxDecoration(
                  color: colors.timelinePanel,
                  border: Border.all(
                    color: colors.timelineBorder,
                    width: TimelineBorder.regular,
                  ),
                  borderRadius: BorderRadius.circular(TimelineToolCard.radius),
                ),
                child: SingleChildScrollView(
                  child: Text(
                    widget.output,
                    style: TimelineType.codeStyle(colors.timelineSubtle),
                  ),
                ),
              ),
            ],
            const SizedBox(height: TimelineSpace.x6),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('关闭'),
            ),
          ],
        ),
      ),
    );
  }
}
