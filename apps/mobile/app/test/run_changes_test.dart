import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/run_changes_card.dart';

void main() {
  testWidgets(
    'opens one run, reads selected patches on demand and switches files',
    (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final calls = <(String, int)>[];
      const first = 'lib/first.dart';
      const second = 'lib/second.dart';
      const start = '@@ -1 +1,2 @@\n-original\n+甲';
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RunChangesCard(
              online: true,
              loadFiles: (_) async => const MobileRunChangesPage(
                diffAvailable: true,
                files: [
                  MobileRunChangedFile(path: first, added: 2, removed: 1),
                  MobileRunChangedFile(path: second, added: 1, removed: 0),
                ],
              ),
              loadDiff: (path, offset) async {
                calls.add((path, offset));
                if (path == second) {
                  return const MobileRunDiffPage(
                    text: '@@ -1,0 +1 @@\n+second change\n',
                  );
                }
                return offset == 0
                    ? MobileRunDiffPage(text: start, nextOffset: start.length)
                    : const MobileRunDiffPage(text: '\n+乙\n');
              },
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(find.text(first), findsOneWidget);
      expect(calls, isEmpty);
      await tester.tap(find.byTooltip('查看本轮改动'));
      await tester.pumpAndSettle();
      expect(calls, [(first, 0)]);
      expect(find.text('甲'), findsOneWidget);
      await tester.tap(find.text('继续读取差异'));
      await tester.pumpAndSettle();
      expect(calls, [(first, 0), (first, start.length)]);
      expect(find.text('乙'), findsOneWidget);
      await tester.tap(find.text('second.dart'));
      await tester.pumpAndSettle();
      expect(calls.last, (second, 0));
      expect(find.text('second change'), findsOneWidget);
      final pager = find.byType(PageView);
      final body = tester.getRect(pager);
      await tester.dragFrom(
        body.centerLeft + const Offset(80, 0),
        const Offset(580, 0),
      );
      await tester.pumpAndSettle();
      expect(find.text('乙'), findsOneWidget);
      expect(calls, [(first, 0), (first, start.length), (second, 0)]);
      await tester.tap(find.byTooltip('关闭换行'));
      await tester.pumpAndSettle();
      await tester.drag(find.text(first), const Offset(-180, 0));
      await tester.pumpAndSettle();
      expect(find.text('second change'), findsOneWidget);
    },
  );

  testWidgets(
    'reloads a visible change card when the final checkpoint arrives',
    (tester) async {
      final checkpoint = ValueNotifier<int?>(null);
      addTearDown(checkpoint.dispose);
      var reads = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ValueListenableBuilder<int?>(
              valueListenable: checkpoint,
              builder: (context, revision, _) => RunChangesCard(
                online: true,
                checkpointRevision: revision,
                savedPaths: const ['note.txt'],
                loadFiles: (_) async => MobileRunChangesPage(
                  diffAvailable: ++reads > 1,
                  files: [
                    MobileRunChangedFile(
                      path: 'note.txt',
                      added: reads > 1 ? 1 : null,
                    ),
                  ],
                ),
                loadDiff: (_, _) async =>
                    const MobileRunDiffPage(text: '@@ -0,0 +1 @@\n+ready\n'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('note.txt'), findsOneWidget);
      expect(find.text('+1'), findsNothing);
      checkpoint.value = 42;
      await tester.pumpAndSettle();
      expect(find.text('+1'), findsOneWidget);
      expect(reads, 2);
    },
  );

  testWidgets('keeps the saved file list when snapshots are unavailable', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RunChangesCard(
            online: true,
            loadFiles: (_) async => const MobileRunChangesPage(
              diffAvailable: false,
              files: [MobileRunChangedFile(path: 'docs/snapshot.md')],
            ),
            loadDiff: (path, offset) async =>
                throw TestFailure('no patch for a missing checkpoint'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('docs/snapshot.md'), findsOneWidget);
    await tester.tap(find.byTooltip('查看本轮改动'));
    await tester.pumpAndSettle();
    expect(find.text('snapshot.md'), findsOneWidget);
    expect(find.text('该轮检查点不可用，无法查看差异。'), findsOneWidget);
  });
}
