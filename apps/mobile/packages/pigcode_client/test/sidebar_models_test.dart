import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:test/test.dart';

void main() {
  final path = '../../../../packages/contracts/fixtures/mobile-sidebar-v1.json';
  final fixture =
      jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
  test('decodes and encodes the same sidebars as TypeScript', () {
    final projects = fixture['projectList'] as Map<String, dynamic>;
    final threads = fixture['threadList'] as Map<String, dynamic>;
    final subscribe = fixture['subscribe'] as Map<String, dynamic>;
    expect(
      MobileProjectListParams.fromJson(projects['params']).toJson(),
      projects['params'],
    );
    expect(
      decodeMobileProjectList(
        projects['result'],
      ).map((row) => row.toJson()).toList(),
      projects['result'],
    );
    expect(
      MobileThreadListParams.fromJson(threads['params']).toJson(),
      threads['params'],
    );
    expect(
      decodeMobileThreadList(
        threads['result'],
      ).map((row) => row.toJson()).toList(),
      threads['result'],
    );
    expect(
      MobileSidebarSubscribeParams.fromJson(subscribe['params']).toJson(),
      subscribe['params'],
    );
    expect(
      MobileSidebarSubscribeResult.fromJson(subscribe['result']).toJson(),
      subscribe['result'],
    );
    expect(
      MobileSidebarChanged.fromJson(fixture['changed']).toJson(),
      fixture['changed'],
    );
    expect(
      MobileRpcProblem.fromJson(fixture['problem']).toJson(),
      fixture['problem'],
    );
  });

  test('enforces paging bounds and rejects extra project details', () {
    expect(
      () => MobileThreadListParams.fromJson({'limit': 65}),
      throwsFormatException,
    );
    expect(
      () => MobileProjectSummary.fromJson({
        'id': 'pr_1',
        'name': '工作台',
        'rootPath': '/private',
      }),
      throwsFormatException,
    );
  });
}
