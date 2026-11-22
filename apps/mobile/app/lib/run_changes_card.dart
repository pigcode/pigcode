import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'run_diff_screen.dart';
import 'theme_colors.dart';

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
      final theme = Theme.of(context);
      return Card(
        margin: const EdgeInsets.symmetric(vertical: 6),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: Tooltip(
          message: '查看本轮改动',
          child: InkWell(
            onTap: () => Navigator.of(context).push<void>(
              MaterialPageRoute(
                builder: (_) => RunDiffScreen(
                  initial: initial,
                  loadFiles: widget.online ? widget.loadFiles : null,
                  loadDiff: widget.online ? widget.loadDiff : null,
                ),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.difference_outlined, size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text('本轮改动', style: theme.textTheme.titleSmall),
                      ),
                      const Icon(Icons.chevron_right, size: 18),
                    ],
                  ),
                  for (final file in initial.files.take(4))
                    _ChangeRow(file: file),
                  if (initial.sharedWorktree == true)
                    Text('共享工作树中的改动无法按轮区分', style: theme.textTheme.bodySmall)
                  else if (initial.files.isEmpty)
                    Text('检查点不可用', style: theme.textTheme.bodySmall),
                  if (result.hasError && widget.online)
                    TextButton(
                      onPressed: () =>
                          setState(() => _files = widget.loadFiles(0)),
                      child: const Text('重试读取本轮改动'),
                    ),
                  if (initial.files.length > 4 || initial.nextOffset != null)
                    Text('查看全部文件', style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

class _ChangeRow extends StatelessWidget {
  const _ChangeRow({required this.file});

  final MobileRunChangedFile file;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              file.path,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (file.added case final added?)
            Text('+$added', style: TextStyle(color: colors.diffAdded)),
          if (file.removed case final removed?) ...[
            const SizedBox(width: 8),
            Text('−$removed', style: TextStyle(color: colors.diffRemoved)),
          ],
        ],
      ),
    );
  }
}
