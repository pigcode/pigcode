import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/workbench/file_browser_tab.dart';
import 'package:pigcode_mobile/workbench/file_viewer_screen.dart';

class _WriteHost implements HostRequests {
  _WriteHost({
    this.onListDirectory,
    this.onReadFile,
    this.onWriteFile,
    this.onDeletePath,
    this.onListWorktrees,
    this.onSwitchWorktree,
  });

  final Future<MobileDirectoryListing> Function(Map<String, Object?> params)?
  onListDirectory;
  final Future<MobileFileChunk> Function(Map<String, Object?> params)?
  onReadFile;
  final Future<MobileWriteFileResult> Function(Map<String, Object?> params)?
  onWriteFile;
  final Future<MobileDeletePathResult> Function(Map<String, Object?> params)?
  onDeletePath;
  final Future<MobileWorktreeListResult> Function(Map<String, Object?> params)?
  onListWorktrees;
  final Future<MobileWorktreeItem> Function(Map<String, Object?> params)?
  onSwitchWorktree;

  final List<({String method, Map<String, Object?> params})> calls = [];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileWorkbenchMethods.list:
        if (onListDirectory != null) {
          return (await onListDirectory!(params)).toJson();
        }
        return const MobileDirectoryListing(
          path: '',
          entries: [],
          truncated: false,
        ).toJson();
      case MobileWorkbenchMethods.readFile:
        if (onReadFile != null) {
          return (await onReadFile!(params)).toJson();
        }
        return const MobileFileChunk(
          path: 'main.dart',
          mode: 'text',
          totalSize: 12,
          binary: false,
          truncated: false,
          text: 'hello world\n',
          eol: 'lf',
          mtimeMs: 1000.0,
        ).toJson();
      case MobileWorkbenchWriteMethods.writeFile:
        if (onWriteFile != null) {
          return (await onWriteFile!(params)).toJson();
        }
        return const MobileWriteFileResult(
          path: 'main.dart',
          size: 14,
          mtimeMs: 2000.0,
        ).toJson();
      case MobileWorkbenchWriteMethods.createFile:
        return MobileCreateFileResult(
          path: (params['path'] as String?) ?? 'new.dart',
          size: 0,
          mtimeMs: 3000.0,
        ).toJson();
      case MobileWorkbenchWriteMethods.renamePath:
        return MobileRenamePathResult(
          oldPath: (params['oldPath'] as String?) ?? '',
          newPath: (params['newPath'] as String?) ?? '',
        ).toJson();
      case MobileWorkbenchWriteMethods.deletePath:
        if (onDeletePath != null) {
          return (await onDeletePath!(params)).toJson();
        }
        return MobileDeletePathResult(
          path: (params['path'] as String?) ?? '',
          deleted: true,
        ).toJson();
      case MobileWorkbenchWriteMethods.worktreeList:
        if (onListWorktrees != null) {
          return (await onListWorktrees!(params)).toJson();
        }
        return const MobileWorktreeListResult(
          worktrees: [],
          mainActive: true,
        ).toJson();
      case MobileWorkbenchWriteMethods.worktreeSwitch:
        if (onSwitchWorktree != null) {
          return {'worktree': (await onSwitchWorktree!(params)).toJson()};
        }
        return const {
          'worktree': {
            'id': 'wt-1',
            'name': 'wt-1',
            'branch': 'feat/x',
            'active': true,
          },
        };
      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

class _FakeWriteConnection implements MobileConnection {
  _FakeWriteConnection(
    HostRequests rpc, {
    this.supportsWorkbenchWrite = true,
  }) : workbench = MobileWorkbenchCommands(rpc, supportsWorkbenchRead: true),
       workbenchWrite = MobileWorkbenchWriteClient(
         rpc,
         supportsWorkbenchWrite: supportsWorkbenchWrite,
       );

  @override
  final bool supportsWorkbenchWrite;

  @override
  bool get supportsWorkbenchRead => true;

  @override
  final MobileWorkbenchCommands workbench;

  @override
  final MobileWorkbenchWriteClient workbenchWrite;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _app(Widget child) => MaterialApp(
  theme: pigcodeTheme(Brightness.light),
  home: child,
);

void main() {
  testWidgets(
    'edits and saves text file with expectedMtimeMs and guards unsaved back navigation',
    (tester) async {
      var changedCount = 0;
      final host = _WriteHost(
        onReadFile: (_) async => const MobileFileChunk(
          path: 'lib/app.dart',
          mode: 'text',
          totalSize: 12,
          binary: false,
          truncated: false,
          text: 'line1\r\nline2',
          eol: 'crlf',
          mtimeMs: 1234.5,
        ),
        onWriteFile: (params) async {
          expect(params['expectedMtimeMs'], 1234.5);
          expect(params['eol'], 'crlf');
          expect(params['text'], 'line1\nupdated');
          return const MobileWriteFileResult(
            path: 'lib/app.dart',
            size: 14,
            mtimeMs: 2234.5,
          );
        },
      );
      final conn = _FakeWriteConnection(host);

      await tester.pumpWidget(
        _app(
          MobileFileViewerScreen(
            connection: conn,
            threadId: 'th_1',
            path: 'lib/app.dart',
            onFileChanged: () => changedCount++,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(MobileFileViewerScreen.editButtonKey));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(MobileFileViewerScreen.editorInputKey),
        'line1\nupdated',
      );
      await tester.pump();
      expect(find.textContaining('未保存'), findsOneWidget);

      await tester.tap(find.byKey(MobileFileViewerScreen.cancelEditButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('放弃未保存的修改？'), findsOneWidget);
      await tester.tap(find.text('继续编辑'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(MobileFileViewerScreen.saveButtonKey));
      await tester.pumpAndSettle();
      expect(changedCount, 1);
      expect(find.text('已保存'), findsOneWidget);
      expect(find.byKey(MobileFileViewerScreen.editorInputKey), findsNothing);
    },
  );

  testWidgets(
    'resolves WORKBENCH_FILE_CONFLICT via force overwrite and reload',
    (tester) async {
      var failWithConflict = true;
      var readCount = 0;
      final host = _WriteHost(
        onReadFile: (_) async {
          readCount++;
          return MobileFileChunk(
            path: 'note.txt',
            mode: 'text',
            totalSize: 5,
            binary: false,
            truncated: false,
            text: readCount == 1 ? 'v1' : 'v2 from disk',
            eol: 'lf',
            mtimeMs: readCount == 1 ? 100.0 : 500.0,
          );
        },
        onWriteFile: (params) async {
          if (failWithConflict && params.containsKey('expectedMtimeMs')) {
            throw const MobileRpcFailure(
              MobileRpcProblem(
                code: 'WORKBENCH_FILE_CONFLICT',
                message: 'File changed on disk',
              ),
            );
          }
          return const MobileWriteFileResult(
            path: 'note.txt',
            size: 8,
            mtimeMs: 600.0,
          );
        },
      );
      final conn = _FakeWriteConnection(host);

      await tester.pumpWidget(
        _app(
          MobileFileViewerScreen(
            connection: conn,
            threadId: 'th_1',
            path: 'note.txt',
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(MobileFileViewerScreen.editButtonKey));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(MobileFileViewerScreen.editorInputKey),
        'local edit',
      );
      await tester.pump();
      await tester.tap(find.byKey(MobileFileViewerScreen.saveButtonKey));
      await tester.pumpAndSettle();

      expect(find.text('文件已被修改'), findsOneWidget);
      await tester.tap(find.text('重新加载'));
      await tester.pumpAndSettle();
      expect(find.text('已重新加载电脑端最新内容'), findsOneWidget);
      expect(find.textContaining('v2 from disk'), findsOneWidget);

      await tester.tap(find.byKey(MobileFileViewerScreen.editButtonKey));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(MobileFileViewerScreen.editorInputKey),
        'override',
      );
      await tester.pump();
      await tester.tap(find.byKey(MobileFileViewerScreen.saveButtonKey));
      await tester.pumpAndSettle();

      expect(find.text('文件已被修改'), findsOneWidget);
      await tester.tap(find.text('强制覆盖'));
      await tester.pumpAndSettle();
      final writes = host.calls
          .where((c) => c.method == MobileWorkbenchWriteMethods.writeFile)
          .toList();
      expect(writes.last.params.containsKey('expectedMtimeMs'), isFalse);
    },
  );

  testWidgets(
    'keeps viewer and browser read-only for truncated files or legacy computers',
    (tester) async {
      final host = _WriteHost(
        onReadFile: (_) async => const MobileFileChunk(
          path: 'big.log',
          mode: 'text',
          totalSize: 2 * 1024 * 1024,
          binary: false,
          truncated: true,
          text: 'head',
          eol: 'lf',
          mtimeMs: 100.0,
        ),
      );

      await tester.pumpWidget(
        _app(
          MobileFileViewerScreen(
            connection: _FakeWriteConnection(host, supportsWorkbenchWrite: true),
            threadId: 'th_1',
            path: 'big.log',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(MobileFileViewerScreen.editButtonKey), findsNothing);

      await tester.pumpWidget(
        _app(
          Scaffold(
            body: FileBrowserTab(
              connection: _FakeWriteConnection(
                _WriteHost(),
                supportsWorkbenchWrite: false,
              ),
              threadId: 'th_1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(FileBrowserTab.createFileButtonKey), findsNothing);
      expect(find.byKey(FileBrowserTab.worktreeBarKey), findsNothing);
    },
  );

  testWidgets(
    'supports createFile, renamePath, recursive deletePath, and worktree quick bar',
    (tester) async {
      var deletedRecursive = false;
      var switchedId = '';
      final host = _WriteHost(
        onListWorktrees: (_) async => const MobileWorktreeListResult(
          worktrees: [
            MobileWorktreeItem(
              id: 'wt-1',
              name: 'wt-feat',
              branch: 'feat/wt',
              active: false,
            ),
          ],
          mainActive: true,
        ),
        onSwitchWorktree: (params) async {
          switchedId = params['worktreeId'] as String;
          return const MobileWorktreeItem(
            id: 'wt-1',
            name: 'wt-feat',
            branch: 'feat/wt',
            active: true,
          );
        },
        onListDirectory: (_) async => const MobileDirectoryListing(
          path: '',
          entries: [
            MobileDirectoryEntry(path: 'docs', name: 'docs', kind: 'directory'),
            MobileDirectoryEntry(
              path: 'a.txt',
              name: 'a.txt',
              kind: 'file',
              size: 10,
            ),
          ],
          truncated: false,
        ),
        onDeletePath: (params) async {
          if (params['path'] == 'docs' && params['recursive'] != true) {
            throw const MobileRpcFailure(
              MobileRpcProblem(
                code: 'WORKBENCH_DIR_NOT_EMPTY',
                message: 'Directory not empty',
              ),
            );
          }
          if (params['path'] == 'docs' && params['recursive'] == true) {
            deletedRecursive = true;
          }
          return MobileDeletePathResult(
            path: params['path'] as String,
            deleted: true,
          );
        },
      );
      final conn = _FakeWriteConnection(host);
      var mutatedCount = 0;

      await tester.pumpWidget(
        _app(
          Scaffold(
            body: FileBrowserTab(
              connection: conn,
              threadId: 'th_1',
              onWorkspaceMutated: () => mutatedCount++,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Worktree quick switch.
      expect(find.byKey(FileBrowserTab.worktreeBarKey), findsOneWidget);
      await tester.tap(find.byKey(FileBrowserTab.worktreeBarKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('feat/wt'));
      await tester.pumpAndSettle();
      expect(switchedId, 'wt-1');
      expect(mutatedCount, 1);

      // Rename a.txt.
      await tester.tap(find.byKey(FileBrowserTab.entryMoreKey('a.txt')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('重命名 / 移动'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'b.txt');
      await tester.tap(find.text('确认'));
      await tester.pumpAndSettle();
      expect(
        host.calls.any(
          (c) =>
              c.method == MobileWorkbenchWriteMethods.renamePath &&
              c.params['oldPath'] == 'a.txt' &&
              c.params['newPath'] == 'b.txt',
        ),
        isTrue,
      );

      // Non-empty directory delete -> confirm recursive.
      await tester.tap(find.byKey(FileBrowserTab.entryMoreKey('docs')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '删除'));
      await tester.pumpAndSettle();
      expect(find.text('确认递归删除非空目录？'), findsOneWidget);
      await tester.tap(find.text('全部删除'));
      await tester.pumpAndSettle();
      expect(deletedRecursive, isTrue);

      // Create file -> opens editor directly.
      await tester.tap(find.byKey(FileBrowserTab.createFileButtonKey));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'new.txt');
      await tester.tap(find.text('创建并编辑'));
      await tester.pumpAndSettle();
      expect(find.byKey(MobileFileViewerScreen.editorInputKey), findsOneWidget);
    },
  );
}
