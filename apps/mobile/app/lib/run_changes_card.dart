import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'run_diff_screen.dart';
import 'theme_colors.dart';
import 'timeline/timeline_tokens.dart';

class RunChangesCard extends StatefulWidget {
  const RunChangesCard({
    super.key,
    required this.online,
    required this.loadFiles,
    required this.loadDiff,
    this.savedPaths = const [],
    this.checkpointRevision,
  });

  final bool online;
  final RunChangeListLoader loadFiles;
  final RunPatchLoader loadDiff;
  final List<String> savedPaths;
  final int? checkpointRevision;

  @override
  State<RunChangesCard> createState() => _RunChangesCardState();
}

class _RunChangesCardState extends State<RunChangesCard> {
  Future<MobileRunChangesPage>? _files;

  @override
  void initState() {
    super.initState();
    if (widget.online) _files = widget.loadFiles(0);
  }

  @override
  void didUpdateWidget(covariant RunChangesCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.online &&
        (!oldWidget.online ||
            oldWidget.checkpointRevision != widget.checkpointRevision)) {
      _files = widget.loadFiles(0);
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<MobileRunChangesPage>(
    future: _files,
    builder: (context, result) {
      final initial =
          result.data ??
          MobileRunChangesPage(
            diffAvailable: false,
            files: [
              for (final path in widget.savedPaths)
                MobileRunChangedFile(path: path),
            ],
          );
      if (initial.files.isEmpty && initial.diffAvailable) {
        return const SizedBox.shrink();
      }
      if (result.connectionState == ConnectionState.waiting &&
          initial.files.isEmpty) {
        return const SizedBox.shrink();
      }
      if (result.hasError && widget.online && initial.files.isEmpty) {
        return Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => setState(() => _files = widget.loadFiles(0)),
            child: const Text('重试读取本轮改动'),
          ),
        );
      }
      final colors = Theme.of(context).brightness == Brightness.dark
          ? pigcodeDark
          : pigcodeLight;
      var added = 0;
      var removed = 0;
      for (final file in initial.files) {
        added += file.added ?? 0;
        removed += file.removed ?? 0;
      }
      final noteStyle = TimelineType.metaStyle(colors.timelineFaint);
      return Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        decoration: BoxDecoration(
          color: colors.timelineCard,
          border: Border.all(color: colors.timelineBorder),
          borderRadius: BorderRadius.circular(TimelineRadius.panel),
        ),
        clipBehavior: Clip.antiAlias,
        child: Tooltip(
          message: '查看本轮改动',
          child: InkWell(
            onTap: () => RunDiffScreen.open(
              context,
              initial: initial,
              loadFiles: widget.online ? widget.loadFiles : null,
              loadDiff: widget.online ? widget.loadDiff : null,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  height: 40,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: TimelineSpace.x6,
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.description_outlined,
                          size: TimelineIcon.row,
                          color: colors.timelineSubtle,
                        ),
                        const SizedBox(width: TimelineSpace.x4),
                        Expanded(
                          child: Text(
                            '本轮改动',
                            style: TimelineType.contentStyle(
                              colors.foreground,
                              weight: FontWeight.w500,
                            ),
                          ),
                        ),
                        if (added > 0)
                          Text(
                            '+$added',
                            style: TimelineType.metaStyle(colors.diffAdded),
                          ),
                        if (added > 0 && removed > 0)
                          const SizedBox(width: TimelineSpace.x2),
                        if (removed > 0)
                          Text(
                            '-$removed',
                            style: TimelineType.metaStyle(colors.diffRemoved),
                          ),
                        const SizedBox(width: TimelineSpace.x1),
                        Icon(
                          Icons.chevron_right,
                          size: TimelineIcon.control,
                          color: colors.timelineDecoration,
                        ),
                      ],
                    ),
                  ),
                ),
                if (initial.files.isNotEmpty)
                  Container(
                    decoration: BoxDecoration(
                      border: Border(
                        top: BorderSide(color: colors.timelineBorder),
                      ),
                    ),
                    child: Column(
                      children: [
                        for (final (index, file)
                            in initial.files.take(4).indexed)
                          _ChangeRow(file: file, separated: index > 0),
                      ],
                    ),
                  ),
                if (initial.sharedWorktree == true)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      TimelineSpace.x6,
                      TimelineSpace.x2,
                      TimelineSpace.x6,
                      TimelineSpace.x4,
                    ),
                    child: Text('共享工作树中的改动无法按轮区分', style: noteStyle),
                  )
                else if (initial.files.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      TimelineSpace.x6,
                      TimelineSpace.x2,
                      TimelineSpace.x6,
                      TimelineSpace.x4,
                    ),
                    child: Text('检查点不可用', style: noteStyle),
                  ),
                if (result.hasError && widget.online)
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: TextButton(
                      onPressed: () =>
                          setState(() => _files = widget.loadFiles(0)),
                      child: const Text('重试读取本轮改动'),
                    ),
                  ),
                if (initial.files.length > 4 || initial.nextOffset != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      TimelineSpace.x6,
                      TimelineSpace.x1,
                      TimelineSpace.x6,
                      TimelineSpace.x4,
                    ),
                    child: Text('查看全部文件', style: noteStyle),
                  ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

class _ChangeRow extends StatelessWidget {
  const _ChangeRow({required this.file, this.separated = false});

  final MobileRunChangedFile file;
  final bool separated;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final slash = file.path.lastIndexOf('/');
    final name = slash >= 0 ? file.path.substring(slash + 1) : file.path;
    final parent = slash >= 0 ? file.path.substring(0, slash) : '';
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: TimelineSpace.x4,
        vertical: TimelineSpace.x3,
      ),
      decoration: BoxDecoration(
        color: Color.alphaBlend(
          colors.background.withValues(alpha: .5),
          colors.timelineCard,
        ),
        border: separated
            ? Border(top: BorderSide(color: colors.timelineDivider))
            : null,
      ),
      child: Row(
        children: [
          Icon(
            Icons.insert_drive_file_outlined,
            size: TimelineIcon.row,
            color: colors.timelineSubtle,
          ),
          const SizedBox(width: TimelineSpace.x3),
          Expanded(
            child: Row(
              children: [
                Flexible(
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.contentStyle(
                      colors.foreground,
                      weight: FontWeight.w500,
                    ),
                  ),
                ),
                if (parent.isNotEmpty) ...[
                  const SizedBox(width: TimelineSpace.x3),
                  Flexible(
                    child: Text(
                      parent,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.metaStyle(colors.timelineFaint),
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (file.added case final added? when added > 0)
            Text('+$added', style: TimelineType.metaStyle(colors.diffAdded)),
          if (file.removed case final removed? when removed > 0) ...[
            const SizedBox(width: TimelineSpace.x2),
            Text(
              '-$removed',
              style: TimelineType.metaStyle(colors.diffRemoved),
            ),
          ],
        ],
      ),
    );
  }
}
