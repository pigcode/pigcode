import 'dart:io';

import 'package:pigcode_transport/pigcode_transport.dart';
import 'host_rpc.dart';
import 'draft_commands.dart';
import 'pending_requests.dart';
import 'queued_messages.dart';
import 'run_changes.dart';
import 'run_commands.dart';
import 'sidebar.dart';
import 'sidebar_models.dart';
import 'timeline.dart';

export 'host_rpc.dart' show MobileRpcFailure;
export 'command_models.dart';
export 'draft_commands.dart';
export 'draft_models.dart';
export 'run_change_models.dart';
export 'run_changes.dart';
export 'run_commands.dart';
export 'pending_requests.dart';
export 'request_models.dart';
export 'queued_messages.dart';
export 'queue_models.dart';
export 'sidebar.dart';
export 'sidebar_models.dart';
export 'timeline.dart';
export 'timeline_turns.dart';
export 'timeline_models.dart';

const mobileProtocolVersion = 1;

class MobileConnection {
  MobileConnection._(
    this._link,
    this.computerName,
    this.computer,
    this._acceptsRelayReceipt,
    this.supportsSidebar,
    this.supportsTimeline,
    this.supportsRunCommands,
    this.supportsRequestCommands,
    this.supportsDraftCommands,
    this.supportsQueueCommands,
    this.supportsTimelineResume,
    this.supportsRunChanges,
    this.deviceId,
  ) : _rpc = HostRpc(_link);

  final SecureLink _link;
  final String computerName;
  final ComputerProfile computer;
  final bool _acceptsRelayReceipt;
  final bool supportsSidebar;
  final bool supportsTimeline;
  final bool supportsRunCommands;
  final bool supportsRequestCommands;
  final bool supportsDraftCommands;
  final bool supportsQueueCommands;
  final bool supportsTimelineResume;
  final bool supportsRunChanges;
  final String deviceId;
  late final MobileRunCommands runCommands = MobileRunCommands(_rpc);
  late final MobileRunChanges changes = MobileRunChanges(_rpc);
  late final MobileDraftCommands drafts = MobileDraftCommands(_rpc);
  late final MobileQueueCommands queue = MobileQueueCommands(_rpc);
  late final MobilePendingRequests pendingRequests = MobilePendingRequests(
    _rpc,
  );
  final HostRpc _rpc;
  Future<MobileSidebar>? _sidebar;
  Future<MobileTimeline>? _timeline;
  String? _selectedThread;

  Future<MobileSidebar> openSidebar() {
    if (!supportsSidebar) throw const ConnectionFailure('update-desktop');
    return _sidebar ??= MobileSidebar.open(_rpc).catchError((
      Object error,
      StackTrace stack,
    ) {
      _sidebar = null;
      Error.throwWithStackTrace(error, stack);
    });
  }

  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) {
    if (!supportsTimeline) throw const ConnectionFailure('update-desktop');
    final previous = _timeline;
    if (_selectedThread == threadId && previous != null) return previous;
    _selectedThread = threadId;
    late final Future<MobileTimeline> next;
    next = _selectTimeline(threadId, previous, resumeFrom).catchError((
      Object error,
      StackTrace stack,
    ) {
      if (identical(_timeline, next)) _timeline = null;
      Error.throwWithStackTrace(error, stack);
    });
    return _timeline = next;
  }

  Future<MobileTimeline> _selectTimeline(
    String threadId,
    Future<MobileTimeline>? previous,
    TimelineSnapshot? resumeFrom,
  ) async {
    if (previous != null) {
      try {
        await (await previous).close();
      } catch (_) {
        // A failed previous subscription has no timeline to release.
      }
    }
    return MobileTimeline.open(
      _rpc,
      threadId,
      previous: resumeFrom,
      canResume: supportsTimelineResume,
    );
  }

  Future<void> get done => _link.done;
  Future<void> close() => _link.close();

  /// Send only after the app has stored the approved profile. A later resume
  /// announces the stored revision again if the connection was interrupted.
  Future<void> announceRelaySaved() async {
    if (!_acceptsRelayReceipt) return;
    if (computer.relayRevision case final revision?) {
      try {
        await _link.send({
          'type': 'device.relaySaved',
          'relayRevision': revision,
        });
      } catch (_) {
        // The stored profile can be acknowledged again on its next connection.
      }
    }
  }

  static Future<MobileConnection> pair({
    required PairingInvite invite,
    required NoiseIdentity identity,
    required String deviceName,
    required String platform,
    required void Function(String) showVerificationCode,
    HttpClient? client,
  }) => _withDesktopConfirmation(
    invite: invite,
    identity: identity,
    client: client,
    handshake: {
      'type': 'device.pair',
      'secret': invite.secret,
      'name': deviceName,
      'platform': platform,
    },
    showVerificationCode: showVerificationCode,
  );

  static Future<MobileConnection> updateRelay({
    required ComputerProfile computer,
    required PairingInvite invite,
    required NoiseIdentity identity,
    required void Function(String) showVerificationCode,
    HttpClient? client,
  }) async {
    if (computer.computerKey != invite.computer.computerKey) {
      throw const ConnectionFailure('computer-key-changed');
    }
    return _withDesktopConfirmation(
      invite: invite,
      identity: identity,
      client: client,
      handshake: {'type': 'device.updateRelay', 'secret': invite.secret},
      showVerificationCode: showVerificationCode,
    );
  }

  static Future<MobileConnection> _withDesktopConfirmation({
    required PairingInvite invite,
    required NoiseIdentity identity,
    required Map<String, Object> handshake,
    required void Function(String) showVerificationCode,
    HttpClient? client,
  }) => _connect(
    invite.computer,
    identity,
    client: client,
    handshake: handshake,
    confirm: (link) async {
      await link.send({'type': 'device.confirm'});
      final prompt = await link.receive();
      if (prompt['type'] != 'device.check') {
        throw const ConnectionFailure('authentication-failed');
      }
      showVerificationCode(link.verificationCode);
      final remaining = invite.expiresAt.difference(DateTime.now());
      if (remaining.isNegative) throw const ConnectionFailure('expired');
      final approval = await link.receive(timeout: remaining);
      if (approval['type'] != 'device.approved') {
        throw const ConnectionFailure('authentication-failed');
      }
      return approval['relayRevision'] as String?;
    },
  );

  static Future<MobileConnection> resume(
    ComputerProfile computer,
    NoiseIdentity identity, {
    HttpClient? client,
  }) => _connect(
    computer,
    identity,
    client: client,
    handshake: {'type': 'device.connect'},
  );

  static Future<MobileConnection> _connect(
    ComputerProfile computer,
    NoiseIdentity identity, {
    required Map<String, Object> handshake,
    required HttpClient? client,
    Future<String?> Function(SecureLink)? confirm,
  }) async {
    final link = await SecureLink.connect(
      computer,
      identity,
      handshake,
      client: client,
    );
    try {
      final revision = confirm == null
          ? computer.relayRevision
          : await confirm(link);
      await link.send({
        'type': 'mobile.hello',
        'minVersion': mobileProtocolVersion,
        'maxVersion': mobileProtocolVersion,
        'features': [
          'connection.status',
          'relay.saveReceipt',
          'sidebar.read',
          'timeline.read',
          'timeline.resume',
          'changes.read',
          'run.write',
          'request.write',
          'draft.write',
          'queue.write',
        ],
      });
      final welcome = await link.receive();
      if (welcome['type'] == 'mobile.incompatible') {
        final min = welcome['minVersion'];
        final max = welcome['maxVersion'];
        if (min is int && min > mobileProtocolVersion) {
          throw const ConnectionFailure('update-phone');
        }
        if (max is int && max < mobileProtocolVersion) {
          throw const ConnectionFailure('update-desktop');
        }
      }
      if (welcome['type'] != 'mobile.welcome' ||
          welcome['version'] != mobileProtocolVersion ||
          !(welcome['features'] as List).contains('connection.status')) {
        throw const ConnectionFailure('incompatible');
      }
      await link.send({
        'jsonrpc': '2.0',
        'id': 'status',
        'method': MobileSidebarMethods.status,
        'params': const MobileStatusParams().toJson(),
      });
      final response = await link.receive();
      if (response['id'] != 'status') {
        throw const ConnectionFailure('authentication-failed');
      }
      final status = MobileStatus.fromJson(
        response['result'] as Map<String, dynamic>,
      );
      final connection = MobileConnection._(
        link,
        status.computerName,
        computer.withRelayRevision(revision),
        (welcome['features'] as List).contains('relay.saveReceipt'),
        (welcome['features'] as List).contains('sidebar.read'),
        (welcome['features'] as List).contains('timeline.read'),
        (welcome['features'] as List).contains('run.write'),
        (welcome['features'] as List).contains('request.write'),
        (welcome['features'] as List).contains('draft.write'),
        (welcome['features'] as List).contains('queue.write'),
        (welcome['features'] as List).contains('timeline.resume'),
        (welcome['features'] as List).contains('changes.read'),
        status.deviceId,
      );
      if (confirm == null) await connection.announceRelaySaved();
      return connection;
    } catch (_) {
      await link.close();
      rethrow;
    }
  }
}
