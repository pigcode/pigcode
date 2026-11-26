import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/attachments/attachment_cache.dart';
import 'package:pigcode_mobile/attachments/composer_attachment_strip.dart';
import 'package:pigcode_mobile/attachments/draft_attachment.dart';
import 'package:pigcode_mobile/attachments/image_compressor.dart';
import 'package:pigcode_mobile/computer_reconnect.dart';
import 'package:pigcode_mobile/computers.dart';
import 'package:pigcode_mobile/local_drafts.dart';
import 'package:pigcode_mobile/main.dart'
    show PigcodeApp, computerReconnectFactoryProvider;
import 'package:pigcode_mobile/mobile_reminders.dart';
import 'package:pigcode_mobile/multi_computer_summary.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_mobile/share/share_receiver.dart';
import 'package:pigcode_mobile/share/share_target_sheet.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

Uint8List _pngBytes({int r = 40, int g = 130, int b = 220}) {
  final image = img.Image(width: 24, height: 24, numChannels: 3);
  img.fill(image, color: img.ColorRgb8(r, g, b));
  return Uint8List.fromList(img.encodePng(image));
}

ComputerProfile _computer(int seed, String name) => ComputerProfile(
  address: 'wss://127.0.0.1:1/ws/v1/connect',
  token: 'share-test-token',
  computerKey: base64Url.encode(List<int>.filled(32, seed)).replaceAll('=', ''),
  name: name,
);

MobileThreadSummary _thread(
  String id,
  String title, {
  String projectId = 'proj-1',
  String updatedAt = '2026-11-25T10:00:00.000Z',
  bool archived = false,
}) => MobileThreadSummary(
  id: id,
  projectId: projectId,
  title: title,
  updatedAt: updatedAt,
  archived: archived,
  pinned: false,
  status: MobileThreadStatus.idle,
  unread: false,
);

SidebarSnapshot _sidebar(List<MobileThreadSummary> threads) => SidebarSnapshot(
  projects: const [
    MobileProjectSummary(id: 'proj-1', name: 'Pigcode'),
    MobileProjectSummary(id: 'proj-2', name: 'Relay'),
  ],
  threads: threads,
  syncedAt: DateTime.utc(2026, 11, 25, 10),
);

class _FakeShareChannel implements MobileShareChannel {
  _FakeShareChannel({this.pendingBatch});

  IncomingShareBatch? pendingBatch;
  int consumeCalls = 0;
  final cleanedBatchIds = <String>[];
  final _controller = StreamController<IncomingShareBatch>.broadcast();

  void push(IncomingShareBatch batch) {
    _controller.add(batch);
  }

  @override
  Stream<IncomingShareBatch> get batches => _controller.stream;

  @override
  Future<IncomingShareBatch?> consumePendingBatch() async {
    consumeCalls++;
    final value = pendingBatch;
    pendingBatch = null;
    return value;
  }

  @override
  Future<void> cleanupBatch(String batchId) async {
    cleanedBatchIds.add(batchId);
  }

  @override
  void dispose() {
    unawaited(_controller.close());
  }
}

class _FakeComputers extends Computers {
  _FakeComputers(this._profiles);
  final List<ComputerProfile> _profiles;

  @override
  Future<List<ComputerProfile>> build() async {
    identity = await NoiseIdentity.create(List<int>.filled(32, 9));
    deviceId = await publicKeyFingerprint(identity.publicKey);
    deviceNumber = deviceId.substring(0, 8).toUpperCase();
    return _profiles;
  }
}

class _FakeReminderBridge extends MobileReminderBridge {
  const _FakeReminderBridge();

  @override
  void watch({VoidCallback? onTap, VoidCallback? onSettingsChanged}) {}

  @override
  Future<MobileReminder?> takeTap() async => null;

  @override
  Future<MobileReminderSettings> settings() async =>
      const MobileReminderSettings(
        enabled: true,
        permission: MobileReminderPermission.granted,
      );

  @override
  Future<void> setVisible(String? computerId, String? threadId) async {}
}

class _FakeHost implements HostRequests {
  int _uploadSeq = 0;
  final uploadedIds = <String>[];
  final startCalls = <Map<String, Object?>>[];
  final draftCreateCalls = <Map<String, Object?>>[];
  final _inFlight = <String, ({String mimeType, String fileName, int size})>{};

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    switch (method) {
      case MobileAttachmentMethods.uploadStart:
        final uploadId = params['uploadId'] as String;
        _inFlight[uploadId] = (
          mimeType: params['mimeType'] as String,
          fileName: (params['fileName'] as String?) ?? 'image.png',
          size: 0,
        );
        return {'uploadId': uploadId, 'chunkBytes': mobileAttachmentChunkBytes};
      case MobileAttachmentMethods.uploadChunk:
        final uploadId = params['uploadId'] as String;
        final chunk = base64Decode(params['dataBase64'] as String);
        final prev = _inFlight[uploadId]!;
        _inFlight[uploadId] = (
          mimeType: prev.mimeType,
          fileName: prev.fileName,
          size: prev.size + chunk.length,
        );
        return {
          'uploadId': uploadId,
          'receivedBytes': prev.size + chunk.length,
        };
      case MobileAttachmentMethods.uploadFinish:
        final uploadId = params['uploadId'] as String;
        final item = _inFlight.remove(uploadId)!;
        final id = 'att-${++_uploadSeq}';
        uploadedIds.add(id);
        return {
          'attachment': MobileAttachmentRef(
            id: id,
            mimeType: item.mimeType,
            fileName: item.fileName,
            sizeBytes: item.size,
            width: 24,
            height: 24,
          ).toJson(),
        };
      case MobileAttachmentMethods.uploadCancel:
        _inFlight.remove(params['uploadId']);
        return {'ok': true};
      case MobileCommandMethods.start:
        startCalls.add(params);
        return MobileRunReceipt(
          method: MobileRunMethod.runStart,
          commandId: params['commandId'] as String,
          threadId: params['threadId'] as String,
          runId: 'run-${startCalls.length}',
        ).toJson();
      case MobileCommandMethods.receipt:
        return <String, dynamic>{};
      case QueueMethods.get:
        return QueueSnapshot(
          threadId: params['threadId'] as String,
          paused: false,
          activeRunId: null,
          messages: const [],
        ).toJson();
      case MobileDraftMethods.options:
        return const MobileDraftOptions(
          defaultInstanceId: 'codex',
          instances: [
            MobileDraftInstance(
              instanceId: 'codex',
              agentId: 'codex',
              label: 'Codex',
              agentName: 'Codex',
              permissionModes: [MobileDraftPermission.fullAccess],
              defaultPermissionMode: MobileDraftPermission.fullAccess,
              supportsImages: true,
            ),
          ],
        ).toJson();
      case MobileDraftMethods.models:
        return const MobileDraftModels(
          defaultModelId: 'gpt-5',
          models: [MobileDraftModel(id: 'gpt-5', label: 'GPT-5')],
        ).toJson();
      case MobileDraftMethods.create:
        draftCreateCalls.add(params);
        return MobileDraftReceipt(
          method: MobileDraftMethods.create,
          commandId: params['commandId'] as String,
          projectId: params['projectId'] as String,
          threadId: 'created-thread',
          title: '新会话',
          runId: 'run-new',
        ).toJson();
      default:
        return <String, dynamic>{};
    }
  }
}

class _FakeSidebar implements MobileSidebar {
  _FakeSidebar(this.snapshot);

  @override
  final SidebarSnapshot snapshot;

  @override
  Stream<SidebarSnapshot> get updates => const Stream.empty();

  @override
  Future<void> refresh() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeTimeline implements MobileTimeline {
  _FakeTimeline(this.threadId, this.snapshot);

  @override
  final String threadId;

  @override
  final TimelineSnapshot snapshot;

  @override
  Stream<TimelineSnapshot> get updates => const Stream.empty();

  @override
  Future<void> refresh() async {}

  @override
  Future<void> loadEarlier() async {}

  @override
  Future<MobileTimelineContentResult> content({
    int? seq,
    String? runId,
    String? toolId,
    required MobileTimelineContentField field,
    int? offset,
  }) => throw UnimplementedError();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeConnection implements MobileConnection {
  _FakeConnection({
    required this.computer,
    required this.host,
    required this.sidebarSnapshot,
    this.supportsAttachments = true,
  }) : runCommands = MobileRunCommands(host),
       drafts = MobileDraftCommands(host),
       composer = MobileComposerCommands(host),
       mentions = MobileMentionCommands(host),
       queue = MobileQueueCommands(host),
       attachments = MobileAttachmentCommands(
         host,
         supportsAttachments: supportsAttachments,
       );

  @override
  final ComputerProfile computer;
  final _FakeHost host;
  final SidebarSnapshot sidebarSnapshot;
  final _done = Completer<void>();

  @override
  final bool supportsAttachments;
  @override
  bool get supportsSidebar => true;
  @override
  bool get supportsSidebarCommands => false;
  @override
  bool get supportsRunCommands => true;
  @override
  bool get supportsDraftCommands => true;
  @override
  bool get supportsQueueCommands => false;
  @override
  bool get supportsRequestCommands => false;
  @override
  bool get supportsRunChanges => false;
  @override
  bool get supportsComposerControls => false;
  @override
  bool get supportsComposerMentions => false;
  @override
  String get computerName => computer.name;
  @override
  String get deviceId => 'test-device';
  @override
  Future<void> get done => _done.future;

  @override
  final MobileRunCommands runCommands;
  @override
  final MobileDraftCommands drafts;
  @override
  final MobileComposerCommands composer;
  @override
  final MobileMentionCommands mentions;
  @override
  final MobileQueueCommands queue;
  @override
  final MobileAttachmentCommands attachments;

  @override
  Future<MobileSidebar> openSidebar() async => _FakeSidebar(sidebarSnapshot);

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) async => _FakeTimeline(
    threadId,
    TimelineSnapshot(
      events: [
        MobileTimelineEvent(
          seq: 1,
          kind: MobileTimelineKind.messageAssistant,
          createdAt: '2026-11-25T10:00:00.000Z',
          text: '会话 $threadId 内容',
        ),
      ],
      through: 1,
      cursor: 1,
      nextBefore: null,
      live: null,
    ),
  );

  @override
  Future<void> reportReminderSettings(MobileReminderSettings settings) async {}

  @override
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

  @override
  Future<void> close() async {
    if (!_done.isCompleted) _done.complete();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  group('MethodChannelMobileShareChannel & ShareReceiverController', () {
    test(
      'pulls cold-start batch via consumePendingBatch and cleans up',
      () async {
        const channel = MethodChannel('pigcode/share');
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        final calls = <MethodCall>[];
        var pendingDelivered = false;
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'consumePendingBatch') {
            if (pendingDelivered) return null;
            pendingDelivered = true;
            return <String, Object?>{
              'batchId': 'cold-batch-1',
              'paths': ['/tmp/0_a.png', '/tmp/1_b.png'],
              'truncatedCount': 2,
            };
          }
          return null;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

        final container = ProviderContainer();
        addTearDown(container.dispose);

        // 触发首次读取并等待微任务拉取冷启动批次
        container.read(shareReceiverProvider);
        await Future<void>.delayed(Duration.zero);

        final batch = container.read(pendingShareBatchProvider);
        expect(batch, isNotNull);
        expect(batch!.batchId, 'cold-batch-1');
        expect(batch.paths, ['/tmp/0_a.png', '/tmp/1_b.png']);
        expect(batch.truncatedCount, 2);

        // 删除第一张图后剩余 1 张，不提前清理
        container.read(shareReceiverProvider.notifier).removeImageAt(0);
        expect(container.read(pendingShareBatchProvider)?.paths, [
          '/tmp/1_b.png',
        ]);
        expect(calls.where((c) => c.method == 'cleanupBatch'), isEmpty);

        // 删除最后一张图自动关闭并清理原生目录
        container.read(shareReceiverProvider.notifier).removeImageAt(0);
        await Future<void>.delayed(Duration.zero);
        expect(container.read(pendingShareBatchProvider), isNull);
        expect(
          calls
              .where((c) => c.method == 'cleanupBatch')
              .map((c) => (c.arguments as Map)['batchId']),
          ['cold-batch-1'],
        );
      },
    );

    test(
      'receives warm-start onShareBatch push, deduplicates, and cleans old batch',
      () async {
        const channel = MethodChannel('pigcode/share');
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        final cleaned = <String>[];
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'cleanupBatch') {
            cleaned.add((call.arguments as Map)['batchId'] as String);
          }
          return null;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

        final container = ProviderContainer();
        addTearDown(container.dispose);

        container.read(shareReceiverProvider);
        await Future<void>.delayed(Duration.zero);

        Future<void> sendNativePush(Map<String, Object?> payload) async {
          final encoded = const StandardMethodCodec().encodeMethodCall(
            MethodCall('onShareBatch', payload),
          );
          await messenger.handlePlatformMessage(channel.name, encoded, (_) {});
        }

        await sendNativePush({
          'batchId': 'warm-1',
          'paths': ['/tmp/warm_1.jpg'],
          'truncatedCount': 0,
        });
        expect(container.read(pendingShareBatchProvider)?.batchId, 'warm-1');

        // 同一 batchId 重复推送不会覆盖/重复触发
        await sendNativePush({
          'batchId': 'warm-1',
          'paths': ['/tmp/warm_1.jpg'],
          'truncatedCount': 0,
        });
        expect(cleaned, isEmpty);

        // 新的 batchId 到来时自动清理旧批次
        await sendNativePush({
          'batchId': 'warm-2',
          'paths': ['/tmp/warm_2.png'],
          'truncatedCount': 0,
        });
        expect(container.read(pendingShareBatchProvider)?.batchId, 'warm-2');
        expect(cleaned, ['warm-1']);

        // completeBatch 幂等清理
        await container
            .read(shareReceiverProvider.notifier)
            .completeBatch('warm-2');
        await container
            .read(shareReceiverProvider.notifier)
            .completeBatch('warm-2');
        expect(container.read(pendingShareBatchProvider), isNull);
        expect(cleaned, ['warm-1', 'warm-2']);
      },
    );
  });

  group('ShareTargetSheet widget behavior', () {
    testWidgets('shows unpaired guidance and opens pairing on tap', (
      tester,
    ) async {
      var pairTapped = 0;
      var closed = 0;
      final batch = IncomingShareBatch(
        batchId: 'b-unpaired',
        paths: const ['/tmp/a.png'],
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ShareTargetSheet(
              batch: batch,
              computers: const [],
              selectedComputerKey: null,
              computerInfo: null,
              onSelectComputer: (_) {},
              onRemoveImage: (_) {},
              onSelectTarget: (_) {},
              onPair: () => pairTapped++,
              onClose: () => closed++,
              thumbnailBuilder: (_, path) => Text(path),
            ),
          ),
        ),
      );

      expect(find.text('发送到 Pigcode'), findsOneWidget);
      expect(find.text('还没有配对电脑，请先扫码配对后再发送图片'), findsOneWidget);
      expect(find.text('去配对'), findsOneWidget);

      await tester.tap(find.byKey(ShareTargetSheet.pairButtonKey));
      expect(pairTapped, 1);

      await tester.tap(find.byKey(ShareTargetSheet.closeButtonKey));
      expect(closed, 1);
    });

    testWidgets(
      'pins current thread, shows new thread, sorts recent threads, and filters by search',
      (tester) async {
        final pcA = _computer(1, '主力电脑');
        final pcB = _computer(2, '办公电脑');
        final threads = [
          _thread('t-old', '修复登录问题', updatedAt: '2026-11-24T08:00:00.000Z'),
          _thread(
            't-active',
            '当前正在调试的会话',
            updatedAt: '2026-11-25T09:00:00.000Z',
          ),
          _thread(
            't-newest',
            '优化图片上传速度',
            projectId: 'proj-2',
            updatedAt: '2026-11-25T11:00:00.000Z',
          ),
          _thread(
            't-archived',
            '已归档旧会话',
            updatedAt: '2026-11-25T12:00:00.000Z',
            archived: true,
          ),
        ];

        final selectedTargets = <ShareTargetSelection>[];
        final switchedComputers = <ComputerProfile>[];
        final removedIndices = <int>[];

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ShareTargetSheet(
                batch: IncomingShareBatch(
                  batchId: 'b-list',
                  paths: const ['/tmp/1.png', '/tmp/2.png'],
                  truncatedCount: 3,
                ),
                computers: [pcA, pcB],
                selectedComputerKey: pcA.computerKey,
                computerInfo: ShareComputerTargetInfo(
                  computer: pcA,
                  connected: true,
                  supportsAttachments: true,
                  snapshot: _sidebar(threads),
                  activeThreadId: 't-active',
                ),
                onSelectComputer: switchedComputers.add,
                onRemoveImage: removedIndices.add,
                onSelectTarget: selectedTargets.add,
                onPair: () {},
                onClose: () {},
                thumbnailBuilder: (_, path) => const SizedBox.shrink(),
              ),
            ),
          ),
        );

        // 超 6 张截断提示
        expect(find.byKey(ShareTargetSheet.truncatedNoticeKey), findsOneWidget);
        expect(find.text('每条消息最多添加 6 张图片，已忽略超出部分'), findsOneWidget);

        // 多电脑切换器可见
        expect(
          find.byKey(ShareTargetSheet.computerChipKey(pcA.computerKey)),
          findsOneWidget,
        );
        expect(
          find.byKey(ShareTargetSheet.computerChipKey(pcB.computerKey)),
          findsOneWidget,
        );

        // 已归档会话不展示
        expect(find.text('已归档旧会话'), findsNothing);

        // 排序验证：当前会话置顶 -> 新建会话 -> 最新最近会话 -> 更早会话
        final currentY = tester
            .getTopLeft(find.byKey(ShareTargetSheet.currentThreadTileKey))
            .dy;
        final newThreadY = tester
            .getTopLeft(find.byKey(ShareTargetSheet.newThreadTileKey))
            .dy;
        final newestY = tester
            .getTopLeft(find.byKey(ShareTargetSheet.threadTileKey('t-newest')))
            .dy;
        final oldY = tester
            .getTopLeft(find.byKey(ShareTargetSheet.threadTileKey('t-old')))
            .dy;
        expect(currentY, lessThan(newThreadY));
        expect(newThreadY, lessThan(newestY));
        expect(newestY, lessThan(oldY));
        expect(find.text('当前会话'), findsOneWidget);
        expect(find.text('创建新会话并附带这些图片'), findsOneWidget);

        // 移除缩略图回调
        await tester.tap(find.byKey(ShareTargetSheet.removeImageKey(1)));
        expect(removedIndices, [1]);

        // 切换电脑回调
        await tester.tap(
          find.byKey(ShareTargetSheet.computerChipKey(pcB.computerKey)),
        );
        expect(switchedComputers, [pcB]);

        // 搜索过滤
        await tester.enterText(
          find.byKey(ShareTargetSheet.searchFieldKey),
          '上传',
        );
        await tester.pump();
        expect(
          find.byKey(ShareTargetSheet.threadTileKey('t-newest')),
          findsOneWidget,
        );
        expect(
          find.byKey(ShareTargetSheet.threadTileKey('t-old')),
          findsNothing,
        );
        expect(find.byKey(ShareTargetSheet.currentThreadTileKey), findsNothing);

        // 点选目标会话
        await tester.tap(
          find.byKey(ShareTargetSheet.threadTileKey('t-newest')),
        );
        expect(selectedTargets, [
          ShareTargetSelection.existingThread(
            computerKey: pcA.computerKey,
            threadId: 't-newest',
          ),
        ]);
      },
    );

    testWidgets(
      'shows upgrade banner and disables targets when connected computer lacks attachments support',
      (tester) async {
        final legacyPc = _computer(1, '旧版电脑');
        final modernPc = _computer(2, '新版电脑');
        final selectedTargets = <ShareTargetSelection>[];
        final switched = <ComputerProfile>[];

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ShareTargetSheet(
                batch: IncomingShareBatch(
                  batchId: 'b-legacy',
                  paths: const ['/tmp/1.png'],
                ),
                computers: [legacyPc, modernPc],
                selectedComputerKey: legacyPc.computerKey,
                computerInfo: ShareComputerTargetInfo(
                  computer: legacyPc,
                  connected: true,
                  supportsAttachments: false,
                  snapshot: _sidebar([_thread('t1', '旧电脑会话')]),
                  activeThreadId: 't1',
                ),
                onSelectComputer: switched.add,
                onRemoveImage: (_) {},
                onSelectTarget: selectedTargets.add,
                onPair: () {},
                onClose: () {},
                thumbnailBuilder: (_, _) => const SizedBox.shrink(),
              ),
            ),
          ),
        );

        expect(
          find.byKey(ShareTargetSheet.unsupportedBannerKey),
          findsOneWidget,
        );
        expect(find.text('这台电脑的 Pigcode 版本暂不支持发送图片，请先更新电脑端'), findsOneWidget);

        // 禁用状态下点击目标不触发选择
        await tester.tap(find.byKey(ShareTargetSheet.currentThreadTileKey));
        await tester.tap(find.byKey(ShareTargetSheet.newThreadTileKey));
        expect(selectedTargets, isEmpty);

        // 仍可切换到其他已升级电脑
        await tester.tap(
          find.byKey(ShareTargetSheet.computerChipKey(modernPc.computerKey)),
        );
        expect(switched, [modernPc]);
      },
    );
  });

  group('End-to-end PigcodeApp share handoff', () {
    Future<void> pumpApp(
      WidgetTester tester, {
      required _FakeShareChannel shareChannel,
      required List<ComputerProfile> computers,
      required Map<String, _FakeConnection> connections,
      required AttachmentCacheStore attachmentCache,
      required ImageCompressor compressor,
    }) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            mobileShareChannelProvider.overrideWithValue(shareChannel),
            mobileReminderBridgeProvider.overrideWithValue(
              const _FakeReminderBridge(),
            ),
            offlineCacheProvider.overrideWithValue(
              OfflineCacheStore(
                directory: () => Future.error(MissingPluginException()),
              ),
            ),
            computersProvider.overrideWith(() => _FakeComputers(computers)),
            attachmentCacheProvider.overrideWithValue(attachmentCache),
            imageCompressorProvider.overrideWithValue(compressor),
            computerReconnectFactoryProvider.overrideWithValue(
              (computer, identity, onChange) => ComputerReconnect(
                dial: () async => connections[computer.computerKey]!,
                observe: () async =>
                    throw const ConnectionFailure('incompatible'),
                onChange: onChange,
              ),
            ),
            multiComputerCoordinatorFactoryProvider.overrideWithValue(
              (cacheStore) => MultiComputerCoordinator(
                cacheStore: cacheStore,
                observeStatus: (_) async =>
                    throw const ConnectionFailure('incompatible'),
                fetchSummary: (_, _) async =>
                    throw const ConnectionFailure('offline'),
              ),
            ),
          ],
          child: const PigcodeApp(),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets(
      'stages shared images into currently open thread without auto-sending and cleans up batch',
      (tester) async {
        final pc = _computer(11, '主力 Mac');
        final host = _FakeHost();
        final conn = _FakeConnection(
          computer: pc,
          host: host,
          sidebarSnapshot: _sidebar([
            _thread('t-open', '当前调试会话', updatedAt: '2026-11-25T11:00:00.000Z'),
            _thread('t-other', '另一个会话', updatedAt: '2026-11-25T10:00:00.000Z'),
          ]),
        );
        final cache = AttachmentCacheStore.inMemory();
        final pngA = _pngBytes(r: 20, g: 120, b: 220);
        final pngB = _pngBytes(r: 220, g: 80, b: 60);
        final files = {'/share/0_a.png': pngA, '/share/1_b.png': pngB};
        final compressor = ImageCompressor(
          runInIsolate: false,
          fileReader: (path) async => files[path],
        );
        final shareChannel = _FakeShareChannel();

        await pumpApp(
          tester,
          shareChannel: shareChannel,
          computers: [pc],
          connections: {pc.computerKey: conn},
          attachmentCache: cache,
          compressor: compressor,
        );

        // 先打开主力 Mac 进入默认会话 t-open
        await tester.tap(find.text('主力 Mac'));
        await tester.pumpAndSettle();
        expect(find.text('会话 t-open 内容'), findsOneWidget);

        // 模拟热启动收到系统分享批次
        shareChannel.push(
          IncomingShareBatch(
            batchId: 'batch-live-thread',
            paths: const ['/share/0_a.png', '/share/1_b.png'],
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(ShareTargetSheet.sheetKey), findsOneWidget);
        expect(
          find.byKey(ShareTargetSheet.currentThreadTileKey),
          findsOneWidget,
        );

        // 选择当前会话
        await tester.tap(find.byKey(ShareTargetSheet.currentThreadTileKey));
        await tester.pumpAndSettle();

        // 弹窗关闭，原生临时目录已清理
        expect(find.byKey(ShareTargetSheet.sheetKey), findsNothing);
        expect(shareChannel.cleanedBatchIds, ['batch-live-thread']);

        // 目标输入框缩略图条已展示 2 张待发图片且已上传到电脑
        expect(find.byKey(ComposerAttachmentStrip.stripKey), findsOneWidget);
        expect(host.uploadedIds.length, 2);

        // 绝不自动静默发送！
        expect(host.startCalls, isEmpty);
        expect(host.draftCreateCalls, isEmpty);
      },
    );

    testWidgets(
      'stages shared images into NewThreadDraft when selecting 新建会话 without auto-creating thread',
      (tester) async {
        final pc = _computer(12, '笔记本');
        final host = _FakeHost();
        final conn = _FakeConnection(
          computer: pc,
          host: host,
          sidebarSnapshot: _sidebar([_thread('t-1', '已有会话')]),
        );
        final cache = AttachmentCacheStore.inMemory();
        final png = _pngBytes(r: 90, g: 180, b: 90);
        final compressor = ImageCompressor(
          runInIsolate: false,
          fileReader: (_) async => png,
        );
        final shareChannel = _FakeShareChannel(
          pendingBatch: IncomingShareBatch(
            batchId: 'batch-cold-draft',
            paths: const ['/share/0_draft.png'],
          ),
        );

        await pumpApp(
          tester,
          shareChannel: shareChannel,
          computers: [pc],
          connections: {pc.computerKey: conn},
          attachmentCache: cache,
          compressor: compressor,
        );

        // 冷启动自动拉取并弹出目标选择 Sheet
        expect(shareChannel.consumeCalls, greaterThanOrEqualTo(1));
        expect(find.byKey(ShareTargetSheet.sheetKey), findsOneWidget);

        // 点选「新建会话」
        await tester.tap(find.byKey(ShareTargetSheet.newThreadTileKey));
        await tester.pumpAndSettle();

        expect(find.byKey(ShareTargetSheet.sheetKey), findsNothing);
        expect(shareChannel.cleanedBatchIds, ['batch-cold-draft']);

        // 已跳转到新会话草稿，且缩略图条已显示，绝不自动调用 createDraftThread
        expect(
          find.byKey(const ValueKey('first-message-input')),
          findsOneWidget,
        );
        expect(find.byKey(ComposerAttachmentStrip.stripKey), findsOneWidget);
        expect(host.uploadedIds.length, 1);
        expect(host.draftCreateCalls, isEmpty);
        expect(host.startCalls, isEmpty);
      },
    );

    testWidgets(
      'enforces 6-image limit when merging into an existing thread draft and cleans up batch',
      (tester) async {
        final pc = _computer(13, '工作站');
        final host = _FakeHost();
        final conn = _FakeConnection(
          computer: pc,
          host: host,
          sidebarSnapshot: _sidebar([
            _thread('t-1', '第一个会话', updatedAt: '2026-11-25T11:00:00.000Z'),
            _thread(
              't-target',
              '草稿已有5图会话',
              updatedAt: '2026-11-25T10:00:00.000Z',
            ),
          ]),
        );
        final cache = AttachmentCacheStore.inMemory();
        final png = _pngBytes(r: 200, g: 120, b: 40);
        final compressor = ImageCompressor(
          runInIsolate: false,
          fileReader: (_) async => png,
        );

        // 预先在 t-target 的草稿中写入 5 张离线图片
        final store = ThreadDraftStorage(
          pc.computerKey,
          't-target',
          attachmentCache: cache,
        );
        final preExisting = <DraftAttachmentRecord>[];
        for (var i = 0; i < 5; i++) {
          final fileName = await cache.writeDraftFile(
            pc.computerKey,
            'pre-$i',
            'png',
            png,
          );
          preExisting.add(
            DraftAttachmentRecord(
              localId: 'pre-$i',
              fileName: 'pre_$i.png',
              mimeType: 'image/png',
              sizeBytes: png.length,
              width: 24,
              height: 24,
              draftFileName: fileName,
              status: 'localOffline',
            ),
          );
        }
        await store.saveAttachments(preExisting);

        final shareChannel = _FakeShareChannel();
        await pumpApp(
          tester,
          shareChannel: shareChannel,
          computers: [pc],
          connections: {pc.computerKey: conn},
          attachmentCache: cache,
          compressor: compressor,
        );

        // 先打开电脑（当前在 t-1），然后分享 3 张图到 t-target
        await tester.tap(find.text('工作站'));
        await tester.pumpAndSettle();

        shareChannel.push(
          IncomingShareBatch(
            batchId: 'batch-overflow',
            paths: const ['/share/1.png', '/share/2.png', '/share/3.png'],
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(ShareTargetSheet.threadTileKey('t-target')),
        );
        await tester.pumpAndSettle();

        // 合并后草稿恰好 6 张，提示超出部分已忽略，原生批次已清理且未自动发送
        final merged = await store.readFull();
        expect(merged.attachments.length, 6);
        expect(find.textContaining('最多添加 6 张图片'), findsOneWidget);
        expect(shareChannel.cleanedBatchIds, ['batch-overflow']);
        expect(host.startCalls, isEmpty);
      },
    );

    testWidgets(
      'cleans up batch when dismissing sheet on legacy computer without attachment support',
      (tester) async {
        final legacyPc = _computer(14, '旧版本电脑');
        final host = _FakeHost();
        final conn = _FakeConnection(
          computer: legacyPc,
          host: host,
          supportsAttachments: false,
          sidebarSnapshot: _sidebar([_thread('t-1', '旧电脑会话')]),
        );
        final cache = AttachmentCacheStore.inMemory();
        final compressor = ImageCompressor(
          runInIsolate: false,
          fileReader: (_) async => _pngBytes(),
        );
        final shareChannel = _FakeShareChannel();

        await pumpApp(
          tester,
          shareChannel: shareChannel,
          computers: [legacyPc],
          connections: {legacyPc.computerKey: conn},
          attachmentCache: cache,
          compressor: compressor,
        );

        await tester.tap(find.text('旧版本电脑'));
        await tester.pumpAndSettle();

        shareChannel.push(
          IncomingShareBatch(
            batchId: 'batch-legacy-close',
            paths: const ['/share/only.png'],
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(ShareTargetSheet.unsupportedBannerKey),
          findsOneWidget,
        );
        await tester.tap(find.byKey(ShareTargetSheet.closeButtonKey));
        await tester.pumpAndSettle();

        expect(find.byKey(ShareTargetSheet.sheetKey), findsNothing);
        expect(shareChannel.cleanedBatchIds, ['batch-legacy-close']);
        expect(host.startCalls, isEmpty);
        expect(host.draftCreateCalls, isEmpty);
      },
    );

    testWidgets(
      'switches computer inside share sheet and reflects target computer capability',
      (tester) async {
        final legacyPc = _computer(15, '旧电脑');
        final upgradedPc = _computer(16, '新电脑');
        final legacyConn = _FakeConnection(
          computer: legacyPc,
          host: _FakeHost(),
          supportsAttachments: false,
          sidebarSnapshot: _sidebar([_thread('t-old-pc', '旧电脑里的会话')]),
        );
        final upgradedHost = _FakeHost();
        final upgradedConn = _FakeConnection(
          computer: upgradedPc,
          host: upgradedHost,
          supportsAttachments: true,
          sidebarSnapshot: _sidebar([_thread('t-new-pc', '新电脑里的会话')]),
        );
        final cache = AttachmentCacheStore.inMemory();
        final compressor = ImageCompressor(
          runInIsolate: false,
          fileReader: (_) async => _pngBytes(),
        );
        final shareChannel = _FakeShareChannel();

        await pumpApp(
          tester,
          shareChannel: shareChannel,
          computers: [legacyPc, upgradedPc],
          connections: {
            legacyPc.computerKey: legacyConn,
            upgradedPc.computerKey: upgradedConn,
          },
          attachmentCache: cache,
          compressor: compressor,
        );

        // 先连上旧电脑
        await tester.tap(find.byKey(ValueKey(legacyPc.computerKey)));
        await tester.pumpAndSettle();

        shareChannel.push(
          IncomingShareBatch(
            batchId: 'batch-switch-pc',
            paths: const ['/share/switch.png'],
          ),
        );
        await tester.pumpAndSettle();

        // 当前旧电脑不支持图片
        expect(
          find.byKey(ShareTargetSheet.unsupportedBannerKey),
          findsOneWidget,
        );

        // 在弹窗内切换到新电脑后，提示消失且展示新电脑的会话列表
        await tester.tap(
          find.byKey(ShareTargetSheet.computerChipKey(upgradedPc.computerKey)),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(ShareTargetSheet.unsupportedBannerKey), findsNothing);
        expect(
          find.descendant(
            of: find.byKey(ShareTargetSheet.sheetKey),
            matching: find.text('新电脑里的会话'),
          ),
          findsOneWidget,
        );

        // 点选新电脑的会话（自动置顶为当前会话），合入成功并清理批次且未自动发送
        await tester.tap(find.byKey(ShareTargetSheet.currentThreadTileKey));
        await tester.pumpAndSettle();

        expect(shareChannel.cleanedBatchIds, ['batch-switch-pc']);
        expect(find.byKey(ComposerAttachmentStrip.stripKey), findsOneWidget);
        expect(upgradedHost.startCalls, isEmpty);
      },
    );
  });
}
