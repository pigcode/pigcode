import 'dart:async';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:test/test.dart';

const time = '2026-11-22T10:00:00.000Z';

class _Rpc implements HostRequests {
  final events = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final recovery = Completer<Object?>();
  final calls = <String>[];

  @override
  Stream<Map<String, dynamic>> get notifications => events.stream;

  Map<String, Object?> run(int revision, String text) => {
    'runId': 'current',
    'startedAt': time,
    'revision': revision,
    'text': text,
    'textTruncated': false,
    'reasoning': '',
    'reasoningTruncated': false,
    'tools': [],
    'pending': [],
  };

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add(method);
    return switch (method) {
      MobileTimelineMethods.subscribe => {
        'page': {
          'events': [
            {
              'seq': 20,
              'runId': 'current',
              'kind': 'run.started',
              'createdAt': time,
            },
          ],
          'through': 20,
          'nextBefore': 20,
        },
        'live': run(1, '甲'),
      },
      MobileTimelineMethods.history => {
        'events': [
          {
            'seq': 2,
            'runId': 'older',
            'kind': 'run.completed',
            'createdAt': time,
          },
        ],
        'through': 20,
      },
      MobileTimelineMethods.live => await recovery.future,
      MobileTimelineMethods.unsubscribe => {'ok': true},
      _ => throw StateError(method),
    };
  }

  void delta(int revision, String text) => events.add({
    'jsonrpc': '2.0',
    'method': MobileTimelineMethods.delta,
    'params': {
      'threadId': 'thread',
      'runId': 'current',
      'revision': revision,
      'kind': 'text',
      'text': text,
    },
  });
}

Map<String, Object?> _event(int seq, String kind) => {
  'seq': seq,
  'runId': 'current',
  'kind': kind,
  'createdAt': time,
};

class _ResumedRpc extends _Rpc {
  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    if (method == MobileTimelineMethods.subscribe) {
      expect(params, {'threadId': 'thread', 'after': 20});
      return {
        'resumed': true,
        'page': {
          'events': [_event(20, 'run.started'), _event(23, 'reasoning')],
          'through': 31,
          'nextAfter': 27,
        },
      };
    }
    if (method == MobileTimelineMethods.catchUp) {
      expect(params, {'threadId': 'thread', 'after': 27, 'through': 31});
      void notice(int seq, int previous) => events.add({
        'method': MobileTimelineMethods.event,
        'params': {
          'threadId': 'thread',
          'previousSeq': previous,
          'event': _event(seq, 'run.interrupted'),
        },
      });
      notice(31, 27);
      notice(35, 31);
      return {
        'events': [_event(23, 'reasoning'), _event(31, 'run.interrupted')],
        'through': 31,
      };
    }
    return super.call(method, params);
  }
}

void main() {
  test(
    'reconnect fills a pinned gap and preserves the loaded history',
    () async {
      final oldRpc = _Rpc();
      final old = await MobileTimeline.open(oldRpc, 'thread');
      await old.loadEarlier();
      final before = old.snapshot!;
      oldRpc.delta(3, '旧连接的迟到响应');
      await old.close();

      final newRpc = _ResumedRpc();
      final resumed = await MobileTimeline.open(
        newRpc,
        'thread',
        previous: before,
        canResume: true,
      );
      oldRpc.recovery.complete({'live': oldRpc.run(3, '迟到'), 'through': 20});
      await Future<void>.delayed(Duration.zero);
      expect(old.snapshot, same(before));
      final after = resumed.snapshot!;
      expect(after.events.map((event) => event.seq), [2, 20, 23, 31, 35]);
      expect(after.cursor, 35);
      expect(after.through, before.through);
      expect(after.nextBefore, before.nextBefore);
      expect(after.live, isNull);
      await resumed.close();
      await oldRpc.events.close();
      await newRpc.events.close();
    },
  );

  test(
    'a delta gap refreshes only the active run and replays buffered text',
    () async {
      final rpc = _Rpc();
      final timeline = await MobileTimeline.open(rpc, 'thread');
      await timeline.loadEarlier();
      final updated = timeline.updates.firstWhere(
        (snapshot) => snapshot.live?.revision == 4,
      );
      rpc.delta(3, '丙');
      rpc.delta(4, '丁');
      rpc.recovery.complete({'live': rpc.run(3, '甲乙丙'), 'through': 20});
      final snapshot = await updated;
      expect(snapshot.events.map((event) => event.seq), [2, 20]);
      expect(snapshot.through, 20);
      expect(snapshot.nextBefore, isNull);
      expect(snapshot.live?.text, '甲乙丙丁');
      expect(rpc.calls, [
        MobileTimelineMethods.subscribe,
        MobileTimelineMethods.history,
        MobileTimelineMethods.live,
      ]);
      await timeline.close();
      await rpc.events.close();
    },
  );
}
