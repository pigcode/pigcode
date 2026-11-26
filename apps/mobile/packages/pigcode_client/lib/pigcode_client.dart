import 'dart:io';
import 'dart:typed_data';

import 'package:pigcode_transport/pigcode_transport.dart';
import 'composer_commands.dart';
import 'host_rpc.dart';
import 'draft_commands.dart';
import 'mention_commands.dart';
import 'pending_requests.dart';
import 'queued_messages.dart';
import 'reminder_models.dart';
import 'run_changes.dart';
import 'run_commands.dart';
import 'sidebar.dart';
import 'sidebar_models.dart';
import 'src/agent_manage.dart';
import 'src/attachments.dart';
import 'src/computer_summary.dart';
import 'src/plugin_manage.dart';
import 'src/preview.dart';
import 'src/project_manage.dart';
import 'src/schedule_manage.dart';
import 'src/terminal.dart';
import 'src/workbench.dart';
import 'src/workbench_write.dart';
import 'timeline.dart';

export 'host_rpc.dart' show MobileRpcFailure;
export 'command_models.dart';
export 'composer_commands.dart';
export 'composer_models.dart';
export 'draft_commands.dart';
export 'draft_models.dart';
export 'mention_commands.dart';
export 'mention_models.dart';
export 'run_change_models.dart';
export 'run_changes.dart';
export 'run_commands.dart';
export 'pending_requests.dart';
export 'request_models.dart';
export 'queued_messages.dart';
export 'queue_models.dart';
export 'reminder_models.dart';
export 'sidebar.dart';
export 'sidebar_models.dart';
export 'src/agent_manage.dart';
export 'src/attachments.dart';
export 'src/computer_summary.dart';
export 'src/plugin_manage.dart';
export 'src/preview.dart';
export 'src/project_manage.dart';
export 'src/schedule_manage.dart';
export 'src/terminal.dart';
export 'src/workbench.dart';
export 'src/workbench_write.dart';
export 'timeline.dart';
export 'timeline_turns.dart';
export 'timeline_models.dart';

const mobileProtocolVersion = 1;
const mobileClientFeatures = <String>[
  'connection.status',
  'relay.saveReceipt',
  'sidebar.read',
  'sidebar.write',
  'sidebar.presentation',
  'timeline.read',
  'timeline.resume',
  'changes.read',
  'connection.revocation',
  'reminders.status',
  'reminders.apns',
  'run.write',
  'request.write',
  'draft.write',
  'queue.write',
  'composer.controls',
  'composer.mentions',
  'composer.attachments',
  'workbench.read',
  'workbench.write',
  'preview.tunnel',
  'terminal',
  'projects.manage',
  'agents.manage',
  'schedules.manage',
  'plugins.manage',
  'computer.summary',
];

class MobileConnection {
  MobileConnection._(
    this._link,
    this.computerId,
    this.computerName,
    this.computer,
    this._acceptsRelayReceipt,
    this.supportsSidebar,
    this.supportsSidebarCommands,
    this.supportsTimeline,
    this.supportsRunCommands,
    this.supportsRequestCommands,
    this.supportsDraftCommands,
    this.supportsQueueCommands,
    this.supportsTimelineResume,
    this.supportsRunChanges,
    this.supportsComposerControls,
    this.supportsComposerMentions,
    this.supportsAttachments,
    this.supportsWorkbenchRead,
    this.supportsWorkbenchWrite,
    this.supportsPreviewTunnel,
    this.supportsTerminal,
    this.supportsProjectManage,
    this.supportsAgentManage,
    this.supportsScheduleManage,
    this.supportsPluginManage,
    this.supportsComputerSummary,
    this._reportsReminderSettings,
    this._registersApns,
    this.deviceId,
  ) : _rpc = HostRpc(_link);

  final SecureLink _link;
  final String computerId;
  final String computerName;
  final ComputerProfile computer;
  final bool _acceptsRelayReceipt;
  final bool supportsSidebar;
  final bool supportsSidebarCommands;
  final bool supportsTimeline;
  final bool supportsRunCommands;
  final bool supportsRequestCommands;
  final bool supportsDraftCommands;
  final bool supportsQueueCommands;
  final bool supportsTimelineResume;
  final bool supportsRunChanges;
  final bool supportsComposerControls;
  final bool supportsComposerMentions;
  final bool supportsAttachments;
  final bool supportsWorkbenchRead;
  final bool supportsWorkbenchWrite;
  final bool supportsPreviewTunnel;
  final bool supportsTerminal;
  final bool supportsProjectManage;
  final bool supportsAgentManage;
  final bool supportsScheduleManage;
  final bool supportsPluginManage;
  final bool supportsComputerSummary;
  final bool _reportsReminderSettings;
  final bool _registersApns;
  final String deviceId;
  late final MobileRunCommands runCommands = MobileRunCommands(_rpc);
  late final MobileSidebarCommands sidebarCommands = MobileSidebarCommands(
    _rpc,
  );
  late final MobileRunChanges changes = MobileRunChanges(_rpc);
  late final MobileDraftCommands drafts = MobileDraftCommands(_rpc);
  late final MobileComposerCommands composer = MobileComposerCommands(_rpc);
  late final MobileMentionCommands mentions = MobileMentionCommands(_rpc);
  late final MobileAttachmentCommands attachments = MobileAttachmentCommands(
    _rpc,
    supportsAttachments: supportsAttachments,
  );
  late final MobileWorkbenchCommands workbench = MobileWorkbenchCommands(
    _rpc,
    supportsWorkbenchRead: supportsWorkbenchRead,
  );
  late final MobileWorkbenchWriteClient workbenchWrite =
      MobileWorkbenchWriteClient(
        _rpc,
        supportsWorkbenchWrite: supportsWorkbenchWrite,
      );
  late final MobilePreviewCommands preview = MobilePreviewCommands(
    _rpc,
    supportsPreviewTunnel: supportsPreviewTunnel,
  );
  late final MobileTerminalClient terminal = MobileTerminalClient(
    _rpc,
    supportsTerminal: supportsTerminal,
  );
  late final MobileProjectManageClient projects = MobileProjectManageClient(
    _rpc,
    supportsProjectManage: supportsProjectManage,
  );
  late final MobileAgentManageClient agents = MobileAgentManageClient(
    _rpc,
    supportsAgentManage: supportsAgentManage,
  );
  late final MobileScheduleManageClient schedules = MobileScheduleManageClient(
    _rpc,
    supportsScheduleManage: supportsScheduleManage,
  );
  late final MobilePluginManageClient plugins = MobilePluginManageClient(
    _rpc,
    supportsPluginManage: supportsPluginManage,
  );
  late final MobileSummaryClient summary = MobileSummaryClient(
    _rpc,
    supportsComputerSummary: supportsComputerSummary,
    computerId: computerId,
    computerName: computerName,
  );
  late final MobileQueueCommands queue = MobileQueueCommands(_rpc);
  late final MobilePendingRequests pendingRequests = MobilePendingRequests(
    _rpc,
  );
  final HostRpc _rpc;
  Future<MobileSidebar>? _sidebar;
  Future<MobileTimeline>? _timeline;
  String? _selectedThread;

  Future<MobileAttachmentRef> uploadAttachment({
    required Uint8List bytes,
    required String mimeType,
    String? fileName,
    int? width,
    int? height,
    void Function(MobileAttachmentUploadProgress)? onProgress,
    MobileAttachmentCancelToken? cancelToken,
  }) => attachments.uploadAttachment(
    bytes: bytes,
    mimeType: mimeType,
    fileName: fileName,
    width: width,
    height: height,
    onProgress: onProgress,
    cancelToken: cancelToken,
  );

  Future<MobileAttachmentReadData> readAttachmentThumb(
    String attachmentId, {
    String? threadId,
  }) => attachments.readAttachmentThumb(attachmentId, threadId: threadId);

  Future<MobileAttachmentReadData> readAttachmentFull(
    String attachmentId, {
    String? threadId,
    void Function(int received, int total)? onProgress,
  }) => attachments.readAttachmentFull(
    attachmentId,
    threadId: threadId,
    onProgress: onProgress,
  );

  Future<MobileDirectoryListing> listDirectory({
    required String threadId,
    String path = '',
    int offset = 0,
    int? limit,
  }) => workbench.listDirectory(
    threadId: threadId,
    path: path,
    offset: offset,
    limit: limit,
  );

  Future<MobileFileChunk> readFile({
    required String threadId,
    required String path,
    int offset = 0,
    int? length,
    String mode = 'auto',
    String variant = 'full',
  }) => workbench.readFile(
    threadId: threadId,
    path: path,
    offset: offset,
    length: length,
    mode: mode,
    variant: variant,
  );

  Future<MobileFileImageData> readFileImage({
    required String threadId,
    required String path,
    String variant = 'full',
    void Function(int received, int total)? onProgress,
  }) => workbench.readFileImage(
    threadId: threadId,
    path: path,
    variant: variant,
    onProgress: onProgress,
  );

  Future<MobileSearchResult> searchFiles({
    required String threadId,
    required String query,
    String? glob,
    int? limit,
  }) => workbench.searchFiles(
    threadId: threadId,
    query: query,
    glob: glob,
    limit: limit,
  );

  Future<MobilePrStatusResult> getPrStatus({required String threadId}) =>
      workbench.getPrStatus(threadId: threadId);

  Future<MobilePreviewStatus> getPreviewStatus({String? threadId}) =>
      preview.getStatus(threadId: threadId);

  Future<MobilePreviewFetchResponse> fetchPreview({
    required String url,
    String method = 'GET',
    Map<String, String>? headers,
    Uint8List? bodyBytes,
    String? requestId,
  }) => preview.fetch(
    url: url,
    method: method,
    headers: headers,
    bodyBytes: bodyBytes,
    requestId: requestId,
  );

  Future<MobilePreviewBodyChunk> readPreviewBody({
    required String bodyStreamId,
    required int offset,
    int? length,
  }) => preview.readBody(
    bodyStreamId: bodyStreamId,
    offset: offset,
    length: length,
  );

  Future<void> closePreviewBody(String bodyStreamId) =>
      preview.closeBody(bodyStreamId);

  Stream<Uint8List> streamPreviewBody(
    String bodyStreamId, {
    int chunkBytes = mobilePreviewChunkBytes,
  }) => preview.streamBody(bodyStreamId, chunkBytes: chunkBytes);

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

  Future<void> get done => _rpc.done;
  bool get revoked => _rpc.revoked;

  Future<void> reportReminderSettings(MobileReminderSettings settings) async {
    if (_reportsReminderSettings) {
      final report = settings.toJson();
      if (settings.apns == null) report.remove('apns');
      if (_registersApns) {
        final result = await _rpc.call(MobileReminderMethods.configure, report);
        if (result is! Map || result['saved'] != true) {
          throw const ConnectionFailure('reminders-not-saved');
        }
        return;
      }
      report.remove('apns');
      await _link.send({'type': MobileReminderMethods.report, ...report});
    }
  }

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
    handshake: {'type': 'device.connect', 'revocationNotice': true},
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
        'features': mobileClientFeatures,
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
        status.computerId,
        status.computerName,
        computer.withRelayRevision(revision),
        (welcome['features'] as List).contains('relay.saveReceipt'),
        (welcome['features'] as List).contains('sidebar.read'),
        (welcome['features'] as List).contains('sidebar.write'),
        (welcome['features'] as List).contains('timeline.read'),
        (welcome['features'] as List).contains('run.write'),
        (welcome['features'] as List).contains('request.write'),
        (welcome['features'] as List).contains('draft.write'),
        (welcome['features'] as List).contains('queue.write'),
        (welcome['features'] as List).contains('timeline.resume'),
        (welcome['features'] as List).contains('changes.read'),
        (welcome['features'] as List).contains('composer.controls'),
        (welcome['features'] as List).contains('composer.mentions'),
        (welcome['features'] as List).contains('composer.attachments'),
        (welcome['features'] as List).contains('workbench.read'),
        (welcome['features'] as List).contains('workbench.write'),
        (welcome['features'] as List).contains('preview.tunnel'),
        (welcome['features'] as List).contains('terminal'),
        (welcome['features'] as List).contains('projects.manage'),
        (welcome['features'] as List).contains('agents.manage'),
        (welcome['features'] as List).contains('schedules.manage'),
        (welcome['features'] as List).contains('plugins.manage'),
        (welcome['features'] as List).contains('computer.summary'),
        (welcome['features'] as List).contains('reminders.status'),
        (welcome['features'] as List).contains('reminders.apns'),
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
