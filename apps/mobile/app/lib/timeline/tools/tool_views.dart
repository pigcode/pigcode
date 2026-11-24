import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../../theme_colors.dart';
import '../../timeline_widgets.dart';
import '../../timeline_work.dart';
import '../timeline_tokens.dart';
import '../tool_row.dart';

/// 单个工具调用的行和展开内容。按工具族选择摘要、图标和详情。
class TimelineToolView extends StatefulWidget {
  const TimelineToolView({
    super.key,
    required this.item,
    required this.ended,
    required this.content,
    this.showIcon = true,
    this.onOpenDetails,
  });

  final TimelineWork item;
  final bool ended;
  final TimelineContentLoader content;
  final bool showIcon;
  final VoidCallback? onOpenDetails;

  @override
  State<TimelineToolView> createState() => _TimelineToolViewState();
}

class _TimelineToolViewState extends State<TimelineToolView> {
  bool _expanded = false;

  TimelineWork get item => widget.item;
  TimelineToolKind get kind => timelineToolKind(item);
  bool get running => item.output == null && !widget.ended;
  bool get failed => item.output?.failed == true;
  bool get stopped => widget.ended && item.output == null;

  String get _name => (item.output?.name ?? item.event.name ?? '').trim();

  String get _action {
    if (failed) return '执行失败';
    if (stopped) return '已停止';
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
    TimelineToolKind.read => Icons.description_outlined,
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

  ({int added, int removed})? get _diff =>
      kind == TimelineToolKind.edit ? timelineEditStats(item) : null;

  bool get _expandable =>
      item.input != null ||
      item.output != null ||
      kind == TimelineToolKind.command ||
      kind == TimelineToolKind.edit;

  @override
  Widget build(BuildContext context) {
    final detail = timelineToolDetail(item, kind);
    if (kind == TimelineToolKind.plan) {
      return TimelinePlanCard(item: item, content: widget.content);
    }
    return TimelineToolRow(
      icon: _icon,
      action: _action,
      detail: detail,
      diff: _diff,
      status: _status,
      running: running,
      failed: failed,
      showIcon: widget.showIcon,
      expandable: _expandable,
      expanded: _expanded,
      onTap: _expandable
          ? () => setState(() => _expanded = !_expanded)
          : widget.onOpenDetails,
      child: _expanded ? _details(context) : null,
    );
  }

  Widget _details(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final input = item.input?.text?.trim();
    final output = timelineStripAnsi(timelineToolOutput(item) ?? '').trim();
    final sections = <Widget>[];
    if (kind == TimelineToolKind.command) {
      final command = timelineCommand(item);
      if (command != null && command.isNotEmpty) {
        sections.add(
          TimelineToolSection(
            label: '命令',
            text: command,
            prefix: r'$',
            maxHeight: 160,
          ),
        );
      }
      sections.add(
        TimelineToolSection(
          label: '输出',
          text: output.isEmpty ? (running ? '等待输出…' : '（没有输出）') : output,
          maxHeight: 240,
        ),
      );
    } else if (kind == TimelineToolKind.edit) {
      final diff = _editDiff();
      if (diff != null) {
        sections.add(diff);
      } else if (output.isNotEmpty) {
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
    if (item.input?.truncated == true || item.output?.truncated == true) {
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

  Widget? _editDiff() {
    final record = timelineToolRecord(item);
    final oldText =
        (record['old_string'] ?? record['oldString']) as String? ??
        (record['old'] as String?);
    final newText =
        (record['new_string'] ?? record['newString']) as String? ??
        (record['content'] as String?);
    final edits = record['edits'] ?? record['changes'];
    if (oldText != null || newText != null) {
      return _InlineDiff(oldText: oldText, newText: newText);
    }
    if (edits is List) {
      final rows = <Widget>[];
      for (final entry in edits.whereType<Map>()) {
        final path =
            (entry['file_path'] ?? entry['path'] ?? entry['filePath'])
                as String?;
        final oldValue = (entry['old_string'] ?? entry['oldString']) as String?;
        final newValue = (entry['new_string'] ?? entry['newString']) as String?;
        if (oldValue == null && newValue == null) continue;
        if (rows.isNotEmpty) rows.add(const SizedBox(height: TimelineSpace.x4));
        if (path != null) {
          rows.add(
            Text(
              path,
              style: TimelineType.smallStyle(
                Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          );
          rows.add(const SizedBox(height: TimelineSpace.x1));
        }
        rows.add(_InlineDiff(oldText: oldValue, newText: newValue));
      }
      return rows.isEmpty
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: rows,
            );
    }
    final patch = record['patch'];
    if (patch is String && patch.trim().isNotEmpty) {
      return _InlineDiff(patch: patch);
    }
    return null;
  }
}

/// 编辑工具的紧凑内联 diff：保留上下文，新增/删除行用符号和底色区分。
class _InlineDiff extends StatelessWidget {
  const _InlineDiff({this.oldText, this.newText, this.patch});

  final String? oldText;
  final String? newText;
  final String? patch;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final lines = <(String, int)>[];
    if (patch != null) {
      for (final line in patch!.split('\n')) {
        if (line.startsWith('***') || line.startsWith('@@')) continue;
        if (line.startsWith('+')) {
          lines.add((line, 1));
        } else if (line.startsWith('-')) {
          lines.add((line, -1));
        } else if (line.trim().isNotEmpty) {
          lines.add((line, 0));
        }
      }
    } else {
      for (final line in (oldText ?? '').split('\n')) {
        lines.add(('-$line', -1));
      }
      for (final line in (newText ?? '').split('\n')) {
        lines.add(('+$line', 1));
      }
    }
    if (lines.isEmpty) return const SizedBox.shrink();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 280),
      child: SingleChildScrollView(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final (line, kind) in lines)
                Container(
                  color: kind > 0
                      ? colors.diffAddedBackground
                      : kind < 0
                      ? colors.diffRemovedBackground
                      : null,
                  padding: const EdgeInsets.symmetric(
                    horizontal: TimelineSpace.x2,
                  ),
                  child: Text(
                    line,
                    style: TimelineType.codeStyle(
                      kind > 0
                          ? colors.diffAdded
                          : kind < 0
                          ? colors.diffRemoved
                          : colors.timelineSubtle,
                    ).copyWith(height: 1.6),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 计划卡：ExitPlanMode 交出的计划正文，默认限高，可原地展开。
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
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(TimelineSpace.x7),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.divider),
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
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
              IconButton(
                tooltip: '复制计划',
                onPressed: text.isEmpty ? null : () => _copy(context, text),
                icon: const Icon(Icons.copy_rounded, size: 14),
                color: colors.timelineFaint,
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
          const SizedBox(height: TimelineSpace.x2),
          AnimatedSize(
            duration: const Duration(milliseconds: 260),
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: _expanded ? double.infinity : 256,
              ),
              child: ClipRect(
                child: TimelineAnswer(text: text, padding: EdgeInsets.zero),
              ),
            ),
          ),
          if (!_expanded)
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton(
                onPressed: () => setState(() => _expanded = true),
                child: const Text('查看完整计划'),
              ),
            ),
          if (widget.item.input?.truncated == true)
            Align(
              alignment: AlignmentDirectional.centerStart,
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
