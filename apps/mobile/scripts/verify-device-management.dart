import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

void report(String stage, [Map<String, Object?> details = const {}]) {
  stdout.writeln(jsonEncode({'stage': stage, ...details}));
}

Future<void> main() async {
  final context = SecurityContext(withTrustedRoots: true);
  final ca = Platform.environment['PIGCODE_RELAY_TEST_CA'];
  if (ca != null) context.setTrustedCertificates(ca);
  final client = HttpClient(context: context);
  final identities = <String, NoiseIdentity>{};
  final saved = <String, ComputerProfile>{};
  final active = <String, MobileConnection>{};
  final snapshots = <(String, String), TimelineSnapshot>{};
  final statusWatches =
      <String, (RelayStatusWatch, StreamIterator<RelayComputerStatus>)>{};

  try {
    await for (final line
        in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
      final command = jsonDecode(line) as Map<String, dynamic>;
      final phone = command['phone'] as String;
      final identity = identities[phone] ??= await NoiseIdentity.create();
      try {
        switch (command['action']) {
          case 'pair' || 'update':
            final invite = PairingInvite.parse(command['qr'] as String);
            await active.remove(phone)?.close();
            void showCode(String code) => report('code', {'code': code});
            final link = command['action'] == 'update'
                ? await MobileConnection.updateRelay(
                    computer: saved[phone]!,
                    invite: invite,
                    identity: identity,
                    showVerificationCode: showCode,
                    client: client,
                  )
                : await MobileConnection.pair(
                    invite: invite,
                    identity: identity,
                    deviceName: phone,
                    platform: phone == '个人 iPhone' ? 'ios' : 'android',
                    showVerificationCode: showCode,
                    client: client,
                  );
            active[phone] = link;
            report('ready');
          case 'save' || 'saveWithoutReceipt':
            final link = active[phone]!;
            saved[phone] = ComputerProfile.fromJson(link.computer.toJson());
            if (command['action'] == 'save') await link.announceRelaySaved();
            report('saved');
          case 'reconnect':
            await active.remove(phone)?.close();
            active[phone] = await MobileConnection.resume(
              saved[phone]!,
              identity,
              client: client,
            );
            report('ready');
          case 'watchComputer':
            final watch = await RelayStatusWatch.open(
              saved[phone]!,
              client: client,
            );
            statusWatches[phone] = (watch, StreamIterator(watch.updates));
            report('computerState', {
              'state': watch.initial.state.name,
              'lastOnlineAt': watch.initial.lastOnlineAt?.toIso8601String(),
            });
          case 'computerState':
            final (_, states) = statusWatches[phone]!;
            if (!await states.moveNext().timeout(const Duration(seconds: 12))) {
              throw StateError('status stream closed');
            }
            report('computerState', {
              'state': states.current.state.name,
              'lastOnlineAt': states.current.lastOnlineAt?.toIso8601String(),
            });
          case 'run.changes':
            final params = MobileRunChangesParams.fromJson(
              command['params'] as Map<String, dynamic>,
            );
            final page = await active[phone]!.changes.list(params);
            report('result', {'result': page.toJson()});
          case 'run.diff':
            final params = MobileRunDiffParams.fromJson(
              command['params'] as Map<String, dynamic>,
            );
            final page = await active[phone]!.changes.diff(params);
            report('result', {'result': page.toJson()});
          case 'runChangeMarkers':
            final timeline = await active[phone]!.openTimeline(
              command['threadId'] as String,
            );
            report('result', {
              'result': timeline.snapshot?.events
                  .where((event) => event.kind == MobileTimelineKind.changes)
                  .map((event) => event.runId)
                  .toList(),
            });
          case 'captureRecovery' || 'resumeRecovery':
            final threadId = command['threadId'] as String;
            final key = (phone, threadId);
            final previous = snapshots[key];
            final timeline = await active[phone]!.openTimeline(
              threadId,
              resumeFrom: previous,
            );
            if (command['action'] == 'captureRecovery')
              await timeline.loadEarlier();
            final snapshot = timeline.snapshot!;
            snapshots[key] = snapshot;
            report('recovery', {
              'through': snapshot.through,
              'cursor': snapshot.cursor,
              'events': snapshot.events.map((event) => event.seq).toList(),
              'ends': snapshot.events.reversed
                  .take(2)
                  .map((event) => event.kind.wire)
                  .toList(),
              'lastText': snapshot.events.lastOrNull?.text,
              'pending': snapshot.live?.pending.length ?? 0,
              'hasLive': snapshot.live != null,
            });
          case 'sidebar':
            final sidebar = await active[phone]!.openSidebar();
            final projectName = command['projectName'] as String?;
            final threadId = command['threadId'] as String?;
            final status = command['status'] as String?;
            bool matches(SidebarSnapshot snapshot) {
              final projectMatches =
                  projectName == null ||
                  snapshot.projects.any(
                    (project) => project.name == projectName,
                  );
              final threadMatches =
                  threadId == null ||
                  snapshot.threads.any(
                    (thread) =>
                        thread.id == threadId && thread.status.wire == status,
                  );
              return projectMatches && threadMatches;
            }
            final initial = sidebar.snapshot;
            final snapshot = initial != null && matches(initial)
                ? initial
                : await sidebar.updates
                      .firstWhere(matches)
                      .timeout(const Duration(seconds: 12));
            report('sidebar', {
              'projects': snapshot.projects
                  .map((project) => project.toJson())
                  .toList(),
              'threads': snapshot.threads
                  .map((thread) => thread.toJson())
                  .toList(),
            });
          case 'timeline':
            final threadId = command['threadId'] as String;
            final timeline = await active[phone]!.openTimeline(threadId);
            final expected = command['liveText'] as String?;
            final answer = command['answer'] as String?;
            final stoppedRunId = command['stoppedRunId'] as String?;
            final requestResult = command['requestResult'] as String?;
            bool hasStopped(TimelineSnapshot snapshot) => snapshot.events.any(
              (item) =>
                  item.runId == stoppedRunId &&
                  item.kind == MobileTimelineKind.runInterrupted,
            );
            bool matches(TimelineSnapshot snapshot) =>
                (expected == null || snapshot.live?.text == expected) &&
                (answer == null ||
                    (snapshot.live == null &&
                        snapshot.events.any((item) => item.text == answer))) &&
                (requestResult == null ||
                    snapshot.events.any(
                      (item) => item.text == requestResult,
                    )) &&
                (stoppedRunId == null || hasStopped(snapshot));
            final first = timeline.snapshot;
            final view = first != null && matches(first)
                ? first
                : await timeline.updates
                      .firstWhere(matches)
                      .timeout(const Duration(seconds: 12));
            report('timeline', {
              'bytes': utf8
                  .encode(
                    jsonEncode(
                      view.events.map((item) => item.toJson()).toList(),
                    ),
                  )
                  .length,
              'liveText': view.live?.text,
              'older': view.nextBefore != null,
              'hasAnswer':
                  answer != null &&
                  view.events.any((item) => item.text == answer),
              if (stoppedRunId != null) 'stopped': hasStopped(view),
              if (requestResult != null) 'hasRequestResult': true,
            });
          case 'pendingRequests':
            final connection = active[phone]!;
            final threadId = command['threadId'] as String;
            final timeline = await connection.openTimeline(threadId);
            final count = command['count'] as int;
            bool matches(TimelineSnapshot snapshot) =>
                (snapshot.live?.pending.length ?? 0) == count;
            final snapshot = matches(timeline.snapshot!)
                ? timeline.snapshot!
                : await timeline.updates
                      .firstWhere(matches)
                      .timeout(const Duration(seconds: 12));
            final live = snapshot.live;
            final details = <Map<String, Object?>>[];
            if (live != null) {
              for (final request in live.pending) {
                final detail = await connection.pendingRequests.details(
                  MobileRequestTarget(
                    threadId: threadId,
                    runId: live.runId,
                    requestId: request.id,
                  ),
                );
                details.add(detail.toJson());
              }
            }
            report('pending', {'requests': details});
          case 'approveRequest' || 'answerRequest':
            final api = active[phone]!.pendingRequests;
            final params = command['params'] as Map<String, dynamic>;
            final result = command['action'] == 'approveRequest'
                ? await api.approve(MobileApproveParams.fromJson(params))
                : await api.answer(MobileAnswerParams.fromJson(params));
            report('requestReceipt', {'receipt': result.toJson()});
          case 'lookupRequest':
            final receipt = await active[phone]!.pendingRequests.receipt(
              command['commandId'] as String,
            );
            report('requestReceipt', {'receipt': receipt?.toJson()});
          case 'startCommand' || 'startWithoutReply':
            final result = active[phone]!.runCommands.start(
              MobileStartRunParams(
                commandId: command['commandId'] as String,
                threadId: command['threadId'] as String,
                text: command['text'] as String,
              ),
            );
            if (command['action'] == 'startWithoutReply') {
              unawaited(result.then<void>((_) {}, onError: (Object _) {}));
              report('waiting');
            } else {
              report('command', {'receipt': (await result).toJson()});
            }
          case 'draftOptions':
            final options = await active[phone]!.drafts.options();
            report('draftOptions', {'options': options.toJson()});
          case 'draftModels':
            final models = await active[phone]!.drafts.models(
              command['instanceId'] as String,
            );
            report('draftModels', {'models': models.toJson()});
          case 'createDraft' || 'createDraftWithoutReply':
            final params = MobileDraftCreateParams.fromJson(
              command['params'] as Map<String, dynamic>,
            );
            final result = active[phone]!.drafts.create(params);
            if (command['action'] == 'createDraftWithoutReply') {
              unawaited(result.then<void>((_) {}, onError: (Object _) {}));
              report('waiting');
            } else {
              report('draftReceipt', {'receipt': (await result).toJson()});
            }
          case 'lookupDraft':
            final receipt = await active[phone]!.drafts.receipt(
              command['commandId'] as String,
            );
            report('draftReceipt', {'receipt': receipt?.toJson()});
          case 'queueSnapshot':
            final snapshot = await active[phone]!.queue.snapshot(
              command['threadId'] as String,
            );
            report('queue', {'snapshot': snapshot.toJson()});
          case 'queueAction':
            final receipt = await active[phone]!.queue.submit(
              QueueMethod.fromWire(command['method'] as String),
              command['params'] as Map<String, Object?>,
            );
            report('queueReceipt', {'receipt': receipt.toJson()});
          case 'lookupQueue':
            final receipt = await active[phone]!.queue.receipt(
              command['commandId'] as String,
            );
            report('queueReceipt', {'receipt': receipt?.toJson()});
          case 'stopCommand':
            final receipt = await active[phone]!.runCommands.interrupt(
              MobileInterruptRunParams(
                commandId: command['commandId'] as String,
                threadId: command['threadId'] as String,
                runId: command['runId'] as String,
              ),
            );
            report('command', {'receipt': receipt.toJson()});
          case 'lookupCommand':
            final receipt = await active[phone]!.runCommands.receipt(
              command['commandId'] as String,
            );
            report('command', {'receipt': receipt?.toJson()});
          case 'earlier':
            final timeline = await active[phone]!.openTimeline(
              command['threadId'] as String,
            );
            await timeline.loadEarlier();
            report('earlier', {
              'hasOldRun': timeline.snapshot?.events.any(
                (item) => item.runId == 'old',
              ),
            });
          case 'timelineContent':
            final timeline = await active[phone]!.openTimeline(
              command['threadId'] as String,
            );
            final seq = int.parse(command['seq'] as String);
            var chars = 0;
            int? offset;
            do {
              final part = await timeline.content(
                seq: seq,
                field: MobileTimelineContentField.output,
                offset: offset,
              );
              chars += part.text.length;
              offset = part.nextOffset;
            } while (offset != null);
            report('timelineContent', {'chars': chars});
          case 'disconnect':
            await active.remove(phone)?.close();
            report('closed');
          case 'closed':
            await active[phone]!.done.timeout(const Duration(seconds: 8));
            report('closed');
          case 'saved':
            report('saved', {'address': saved[phone]!.address.toString()});
          default:
            throw StateError('Unknown verification step');
        }
      } on ConnectionFailure catch (failure) {
        report('failed', {'code': failure.code});
      } on MobileRpcFailure catch (failure) {
        report('failed', {'code': failure.problem.code});
      }
    }
  } finally {
    for (final (watch, states) in statusWatches.values) {
      await watch.close();
      await states.cancel();
    }
    for (final connection in active.values) {
      await connection.close();
    }
    client.close(force: true);
  }
}
