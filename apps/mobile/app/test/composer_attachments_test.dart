import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/attachments/attachment_cache.dart';
import 'package:pigcode_mobile/attachments/composer_attachment_strip.dart';
import 'package:pigcode_mobile/attachments/composer_attachments_controller.dart';
import 'package:pigcode_mobile/attachments/image_compressor.dart';
import 'package:pigcode_mobile/attachments/image_viewer_page.dart';
import 'package:pigcode_mobile/composer/composer_suggestion_panel.dart';
import 'package:pigcode_mobile/local_drafts.dart';
import 'package:pigcode_mobile/message_queue_panel.dart';
import 'package:pigcode_mobile/new_thread_draft.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_mobile/timeline_view.dart';
import 'package:pigcode_mobile/timeline_widgets.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

Uint8List _testPng({int width = 40, int height = 30, int r = 60, int g = 140, int b = 220}) {
  final image = img.Image(width: width, height: height, numChannels: 3);
  img.fill(image, color: img.ColorRgb8(r, g, b));
  return Uint8List.fromList(img.encodePng(image));
}

class _FakeImagePicker implements MobileImagePicker {
  List<PickedLocalImage> nextGallery = const [];
  PickedLocalImage? nextCamera;
  int? lastGalleryLimit;
  int cameraCalls = 0;

  @override
  Future<List<PickedLocalImage>> pickFromGallery({required int limit}) async {
    lastGalleryLimit = limit;
    return nextGallery;
  }

  @override
  Future<PickedLocalImage?> captureFromCamera() async {
    cameraCalls++;
    return nextCamera;
  }
}

class _AttachmentHost implements HostRequests {
  _AttachmentHost({
    this.supportsImages = true,
    this.failUploadOnce = false,
    this.chunkGate,
    this.fullReadGate,
    this.failFullReadOnce = false,
  });

  bool supportsImages;
  bool failUploadOnce;
  Completer<void>? chunkGate;
  Completer<void>? fullReadGate;
  bool failFullReadOnce;

  int _uploadSeq = 0;
  final uploadedBytesById = <String, Uint8List>{};
  final thumbBytesById = <String, Uint8List>{};
  final fullBytesById = <String, Uint8List>{};
  final cancelledUploadIds = <String>[];
  final startCalls = <Map<String, Object?>>[];
  final draftCreateCalls = <Map<String, Object?>>[];
  final readThumbCalls = <String>[];
  final readFullCalls = <String>[];

  final _inFlight = <String, ({
    String mimeType,
    String fileName,
    int? width,
    int? height,
    BytesBuilder buffer,
  })>{};

  final queuedMessages = <QueuedMessage>[];

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
          width: params['width'] as int?,
          height: params['height'] as int?,
          buffer: BytesBuilder(copy: false),
        );
        return {'uploadId': uploadId, 'chunkBytes': mobileAttachmentChunkBytes};

      case MobileAttachmentMethods.uploadChunk:
        final uploadId = params['uploadId'] as String;
        if (chunkGate != null && !chunkGate!.isCompleted) {
          await chunkGate!.future;
        }
        if (failUploadOnce) {
          failUploadOnce = false;
          throw const MobileRpcFailure(
            MobileRpcProblem(code: 'UPLOAD_FAILED', message: '上传通道中断'),
          );
        }
        final entry = _inFlight[uploadId];
        final data = base64Decode(params['dataBase64'] as String);
        entry?.buffer.add(data);
        return {'uploadId': uploadId, 'receivedBytes': entry?.buffer.length ?? 0};

      case MobileAttachmentMethods.uploadCancel:
        final uploadId = params['uploadId'] as String;
        cancelledUploadIds.add(uploadId);
        _inFlight.remove(uploadId);
        return {'ok': true};

      case MobileAttachmentMethods.uploadFinish:
        final uploadId = params['uploadId'] as String;
        final entry = _inFlight.remove(uploadId)!;
        final bytes = entry.buffer.takeBytes();
        final id = 'att-${++_uploadSeq}';
        uploadedBytesById[id] = bytes;
        thumbBytesById[id] = bytes;
        fullBytesById[id] = bytes;
        return {
          'attachment': MobileAttachmentRef(
            id: id,
            mimeType: entry.mimeType,
            fileName: entry.fileName,
            sizeBytes: bytes.length,
            width: entry.width,
            height: entry.height,
          ).toJson(),
        };

      case MobileAttachmentMethods.read:
        final attachmentId = params['attachmentId'] as String;
        final variant = params['variant'] as String;
        if (variant == 'thumb') {
          readThumbCalls.add(attachmentId);
          final bytes = thumbBytesById[attachmentId] ?? _testPng();
          return {
            'attachment': MobileAttachmentRef(
              id: attachmentId,
              mimeType: 'image/png',
              fileName: '$attachmentId.png',
              sizeBytes: bytes.length,
              width: 40,
              height: 30,
            ).toJson(),
            'mimeType': 'image/png',
            'dataBase64': base64Encode(bytes),
            'totalBytes': bytes.length,
          };
        }
        readFullCalls.add(attachmentId);
        if (fullReadGate != null && !fullReadGate!.isCompleted) {
          await fullReadGate!.future;
        }
        if (failFullReadOnce) {
          failFullReadOnce = false;
          throw const ConnectionFailure('closed');
        }
        final bytes = fullBytesById[attachmentId] ?? _testPng(width: 80, height: 60);
        return {
          'attachment': MobileAttachmentRef(
            id: attachmentId,
            mimeType: 'image/png',
            fileName: '$attachmentId.png',
            sizeBytes: bytes.length,
            width: 80,
            height: 60,
          ).toJson(),
          'mimeType': 'image/png',
          'dataBase64': base64Encode(bytes),
          'totalBytes': bytes.length,
        };

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
          activeRunId: 'active-run',
          messages: queuedMessages,
        ).toJson();

      case QueueMethods.withdraw:
        final messageId = params['messageId'] as String;
        final index = queuedMessages.indexWhere((m) => m.id == messageId);
        final item = queuedMessages.removeAt(index);
        return QueueReceipt(
          threadId: params['threadId'] as String,
          commandId: params['commandId'] as String,
          method: QueueMethod.queueWithdraw,
          effect: QueueEffect.withdrawn,
          messageId: item.id,
          text: item.text,
          attachments: item.attachments,
        ).toJson();

      case MobileDraftMethods.options:
        return MobileDraftOptions(
          defaultInstanceId: 'agent-1',
          instances: [
            MobileDraftInstance(
              instanceId: 'agent-1',
              agentId: 'codex',
              label: 'Codex',
              agentName: 'Codex',
              permissionModes: const [MobileDraftPermission.approvalRequired],
              defaultPermissionMode: MobileDraftPermission.approvalRequired,
              supportsImages: supportsImages,
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
          title: (params['text'] as String).isEmpty
              ? '图片会话'
              : params['text'] as String,
          runId: 'first-run',
        ).toJson();

      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

class _AttachmentConnection implements MobileConnection {
  _AttachmentConnection(
    this.host, {
    this.supportsAttachments = true,
    int seed = 7,
  }) : runCommands = MobileRunCommands(host),
       drafts = MobileDraftCommands(host),
       composer = MobileComposerCommands(host),
       mentions = MobileMentionCommands(host),
       queue = MobileQueueCommands(host),
       attachments = MobileAttachmentCommands(
         host,
         supportsAttachments: supportsAttachments,
       ),
       computer = ComputerProfile(
         address: 'wss://localhost/ws/v1/connect',
         token: 'fixture',
         computerKey: base64Url
             .encode(List<int>.filled(32, seed))
             .replaceAll('=', ''),
         name: '开发电脑',
       );

  final _AttachmentHost host;

  @override
  final bool supportsAttachments;
  @override
  bool get supportsComposerMentions => true;
  @override
  bool get supportsComposerControls => true;
  @override
  bool get supportsQueueCommands => true;
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
  final ComputerProfile computer;
  @override
  String get deviceId => 'test-phone';

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
  Future<MobileAttachmentReadData> readAttachmentThumb(
    String attachmentId, {
    String? threadId,
  }) => attachments.readAttachmentThumb(attachmentId, threadId: threadId);

  @override
  Future<MobileAttachmentReadData> readAttachmentFull(
    String attachmentId, {
    String? threadId,
    void Function(int received, int total)? onProgress,
  }) => attachments.readAttachmentFull(
    attachmentId,
    threadId: threadId,
    onProgress: onProgress,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AttachmentCacheStore cache;
  late _FakeImagePicker picker;
  late Map<String, Uint8List> fakeFiles;
  late ImageCompressor testCompressor;

  String addFakeFile(String name, Uint8List bytes) {
    final path = '/virtual/$name';
    fakeFiles[path] = bytes;
    return path;
  }

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    cache = AttachmentCacheStore.inMemory();
    picker = _FakeImagePicker();
    fakeFiles = <String, Uint8List>{};
    testCompressor = ImageCompressor(
      runInIsolate: false,
      fileReader: (path) async => fakeFiles[path],
    );
  });

  Widget scoped(Widget child) => ProviderScope(
    overrides: [
      attachmentCacheProvider.overrideWithValue(cache),
      imageCompressorProvider.overrideWithValue(testCompressor),
      mobileImagePickerProvider.overrideWithValue(picker),
    ],
    child: MaterialApp(home: Scaffold(body: child)),
  );

  group('+ menu & attachment capabilities', () {
    testWidgets(
      'shows gallery and camera options when computer supports attachments, and hides them on legacy computer',
      (tester) async {
        final host = _AttachmentHost();
        final modern = _AttachmentConnection(host, supportsAttachments: true);
        await tester.pumpWidget(
          scoped(
            RunComposer(
              connection: modern,
              threadId: 'thread-1',
              online: true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        expect(find.byKey(MobileComposerAttachButton.galleryOptionKey), findsOneWidget);
        expect(find.byKey(MobileComposerAttachButton.cameraOptionKey), findsOneWidget);
        expect(find.text('相册选图'), findsOneWidget);
        expect(find.text('拍照'), findsOneWidget);
        expect(find.byKey(MobileComposerAttachButton.mentionOptionKey), findsOneWidget);

        // 关闭弹窗后切换为不支持附件的旧版电脑。
        Navigator.of(tester.element(find.text('相册选图'))).pop();
        await tester.pumpAndSettle();

        final legacy = _AttachmentConnection(host, supportsAttachments: false, seed: 8);
        await tester.pumpWidget(
          scoped(
            RunComposer(
              key: const ValueKey('legacy-composer'),
              connection: legacy,
              threadId: 'thread-legacy',
              online: true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        expect(find.byKey(MobileComposerAttachButton.galleryOptionKey), findsNothing);
        expect(find.byKey(MobileComposerAttachButton.cameraOptionKey), findsNothing);
        expect(find.byKey(MobileComposerAttachButton.mentionOptionKey), findsOneWidget);
      },
    );

    testWidgets(
      'enforces 6 image limit and disables gallery/camera options when full',
      (tester) async {
        final host = _AttachmentHost();
        final conn = _AttachmentConnection(host);
        final paths = <PickedLocalImage>[];
        for (var i = 0; i < 7; i++) {
          final p = addFakeFile(
            'pic-$i.png',
            _testPng(r: 20 + i * 20),
          );
          paths.add((path: p, name: 'pic-$i.png'));
        }
        picker.nextGallery = paths;

        await tester.pumpWidget(
          scoped(
            RunComposer(
              connection: conn,
              threadId: 'thread-limit',
              online: true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(MobileComposerAttachButton.galleryOptionKey));
        await tester.pumpAndSettle();

        expect(picker.lastGalleryLimit, 6);
        expect(find.byKey(ComposerAttachmentStrip.errorBannerKey), findsOneWidget);
        expect(find.textContaining('最多添加 6 张'), findsOneWidget);
        expect(
          find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'composer-attachment-tile-',
                ),
          ),
          findsNWidgets(6),
        );

        // 达到 6 张上限后再次打开 + 菜单，相册和拍照均应显示「已达上限」且不可点。
        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        expect(find.text('已达上限'), findsNWidgets(2));
        await tester.tap(find.byKey(MobileComposerAttachButton.cameraOptionKey));
        await tester.pumpAndSettle();
        expect(picker.cameraCalls, 0);
      },
    );
  });

  group('upload progress, cancel, retry, offline draft, pure-image send & hints', () {
    testWidgets(
      'shows upload progress, cancels upload on × tap, and cleans draft file',
      (tester) async {
        final gate = Completer<void>();
        final host = _AttachmentHost(chunkGate: gate);
        final conn = _AttachmentConnection(host);
        final path = addFakeFile(
          'uploading.png',
          _testPng(),
        );
        picker.nextCamera = (path: path, name: 'uploading.png');

        await tester.pumpWidget(
          scoped(
            RunComposer(
              connection: conn,
              threadId: 'thread-cancel',
              online: true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(MobileComposerAttachButton.cameraOptionKey));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        // 上传进行中显示进度指示器。
        expect(find.byType(CircularProgressIndicator), findsOneWidget);

        // 点右上角 × 立即取消上传并移除缩略图。
        final removeFinder = find.byWidgetPredicate(
          (w) =>
              w.key is ValueKey<String> &&
              (w.key! as ValueKey<String>).value.startsWith(
                'composer-attachment-remove-',
              ),
        );
        await tester.tap(removeFinder);
        gate.complete();
        await tester.pumpAndSettle();

        expect(host.cancelledUploadIds, hasLength(1));
        expect(find.byKey(ComposerAttachmentStrip.stripKey), findsNothing);
      },
    );

    testWidgets(
      'blocks send on failed upload without clearing text, and succeeds after retry',
      (tester) async {
        final host = _AttachmentHost(failUploadOnce: true);
        final conn = _AttachmentConnection(host);
        final path = addFakeFile(
          'retry.png',
          _testPng(),
        );
        picker.nextGallery = [(path: path, name: 'retry.png')];

        await tester.pumpWidget(
          scoped(
            RunComposer(
              connection: conn,
              threadId: 'thread-retry',
              online: true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        final input = find.byKey(const ValueKey('run-composer-input'));
        await tester.enterText(input, '保留我的正文');
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(MobileComposerAttachButton.galleryOptionKey));
        await tester.pumpAndSettle();

        // 首次上传失败，展示失败遮罩与重试入口。
        final retryFinder = find.byWidgetPredicate(
          (w) =>
              w.key is ValueKey<String> &&
              (w.key! as ValueKey<String>).value.startsWith(
                'composer-attachment-retry-',
              ),
        );
        expect(retryFinder, findsOneWidget);

        // 点击发送不会提交 run.start，也不会清空文本与图片。
        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();
        expect(host.startCalls, isEmpty);
        expect(tester.widget<TextField>(input).controller!.text, '保留我的正文');

        // 点击失败图片重试上传成功后再发送。
        await tester.tap(retryFinder);
        await tester.pumpAndSettle();
        expect(retryFinder, findsNothing);

        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();
        expect(host.startCalls, hasLength(1));
        expect(host.startCalls.single['text'], '保留我的正文');
        expect(host.startCalls.single['attachmentIds'], ['att-1']);
        expect(tester.widget<TextField>(input).controller!.text, isEmpty);
      },
    );

    testWidgets(
      'supports pure-image send in RunComposer and shows unsupported-images hint when agent supportsImages is false',
      (tester) async {
        final host = _AttachmentHost(supportsImages: false);
        final conn = _AttachmentConnection(host);
        final path = addFakeFile(
          'pure.png',
          _testPng(),
        );
        picker.nextGallery = [(path: path, name: 'pure.png')];

        await tester.pumpWidget(
          scoped(
            RunComposer(
              connection: conn,
              threadId: 'thread-pure',
              online: true,
              composer: const MobileThreadComposerState(
                instanceId: 'agent-1',
                agentId: 'codex',
                modelId: 'gpt-5',
                permissionMode: MobileDraftPermission.approvalRequired,
                planMode: false,
                supportsPlanMode: false,
                supportsImages: false,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 文本为空且无图时发送按钮禁用。
        final sendBtn = find.byWidgetPredicate(
          (w) => w is IconButton && w.tooltip == '发送消息',
        );
        expect(tester.widget<IconButton>(sendBtn).onPressed, isNull);

        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(MobileComposerAttachButton.galleryOptionKey));
        await tester.pumpAndSettle();

        // 不支持原生看图的 Agent 展示降级轻提示。
        expect(
          find.byKey(ComposerAttachmentStrip.unsupportedImagesHintKey),
          findsOneWidget,
        );
        expect(find.text('当前 Agent 不支持直接看图，将以文件路径传递'), findsOneWidget);

        // 无文字纯图即可发送。
        expect(tester.widget<IconButton>(sendBtn).onPressed, isNotNull);
        await tester.tap(sendBtn);
        await tester.pumpAndSettle();

        expect(host.startCalls, hasLength(1));
        expect(host.startCalls.single['text'], '');
        expect(host.startCalls.single['attachmentIds'], ['att-1']);
      },
    );

    test(
      'stages offline attachment locally, persists draft, auto-uploads on reconnect, and sends',
      () async {
        final host = _AttachmentHost();
        final conn = _AttachmentConnection(host);
        final path = addFakeFile('offline.png', _testPng());
        final controller = ComposerAttachmentsController(
          computerKey: conn.computer.computerKey,
          cache: cache,
          compressor: testCompressor,
          connection: conn,
          online: false,
          onDraftChanged: (records) => unawaited(
            ThreadDraftStorage(
              conn.computer.computerKey,
              'thread-offline',
              attachmentCache: cache,
            ).saveAttachments(records),
          ),
        );
        addTearDown(controller.dispose);

        await controller.addLocalFiles([path]);
        expect(controller.items, hasLength(1));
        expect(
          controller.items.single.status,
          ComposerAttachmentStatus.localOffline,
        );
        expect(host.uploadedBytesById, isEmpty);

        // 等待草稿异步写入后，模拟重启新控制器从离线草稿恢复，并在恢复在线后自动补传。
        await Future<void>.delayed(const Duration(milliseconds: 20));
        final saved = await ThreadDraftStorage(
          conn.computer.computerKey,
          'thread-offline',
          attachmentCache: cache,
        ).readFull();
        expect(saved.attachments, hasLength(1));

        final restored = ComposerAttachmentsController(
          computerKey: conn.computer.computerKey,
          cache: cache,
          compressor: testCompressor,
          connection: conn,
          online: false,
        );
        addTearDown(restored.dispose);
        await restored.restoreFromDraft(saved.attachments);
        expect(restored.items, hasLength(1));
        expect(
          restored.items.single.status,
          ComposerAttachmentStatus.localOffline,
        );

        // 电脑恢复在线，触发自动补传。
        restored.updateConnection(conn, online: true);
        final ids = await restored.ensureAllUploaded();
        expect(ids, ['att-1']);
        expect(restored.items.single.status, ComposerAttachmentStatus.uploaded);
      },
    );

    testWidgets(
      'supports pure-image creation in NewThreadDraft with unsupported-images hint',
      (tester) async {
        final host = _AttachmentHost(supportsImages: false);
        final conn = _AttachmentConnection(host);
        final path = addFakeFile('draft-first.png', _testPng());
        picker.nextGallery = [(path: path, name: 'draft-first.png')];
        MobileDraftReceipt? accepted;

        await tester.pumpWidget(
          scoped(
            NewThreadDraft(
              connection: conn,
              projects: const [
                MobileProjectSummary(id: 'proj-1', name: '主项目'),
              ],
              online: true,
              onAccepted: (receipt) => accepted = receipt,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('做点什么？'), findsOneWidget);
        await tester.tap(find.byKey(MobileComposerAttachButton.buttonKey));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(MobileComposerAttachButton.galleryOptionKey));
        await tester.pumpAndSettle();

        expect(find.text('做点什么？'), findsNothing);
        expect(find.text('当前 Agent 不支持直接看图，将以文件路径传递'), findsOneWidget);

        await tester.tap(find.byTooltip('发送首条消息'));
        await tester.pumpAndSettle();

        expect(host.draftCreateCalls, hasLength(1));
        expect(host.draftCreateCalls.single['text'], '');
        expect(host.draftCreateCalls.single['attachmentIds'], ['att-1']);
        expect(accepted?.threadId, 'created-thread');
      },
    );
  });

  group('queued message summary & withdrawal restore', () {
    testWidgets(
      'displays [图片]/[N 张图片] queue summary and restores withdrawn text + attachments',
      (tester) async {
        final host = _AttachmentHost();
        final ref1 = const MobileAttachmentRef(
          id: 'q-att-1',
          mimeType: 'image/png',
          fileName: 'err.png',
          sizeBytes: 1200,
          width: 40,
          height: 30,
        );
        final ref2 = const MobileAttachmentRef(
          id: 'q-att-2',
          mimeType: 'image/png',
          fileName: 'log.png',
          sizeBytes: 1500,
          width: 40,
          height: 30,
        );
        host.thumbBytesById['q-att-1'] = _testPng(r: 200);
        host.thumbBytesById['q-att-2'] = _testPng(g: 200);
        host.queuedMessages.addAll([
          QueuedMessage(
            id: 'q-1',
            text: '',
            selected: false,
            attachments: [ref1],
          ),
          QueuedMessage(
            id: 'q-2',
            text: '看看这两张截图',
            selected: false,
            attachments: [ref1, ref2],
          ),
        ]);
        final conn = _AttachmentConnection(host);

        await tester.pumpWidget(
          scoped(
            RunComposer(
              connection: conn,
              threadId: 'thread-queue',
              online: true,
              stoppableRunId: 'active-run',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('[图片]'), findsOneWidget);
        expect(find.text('[2 张图片] 看看这两张截图'), findsOneWidget);

        // 撤回第二条图文待发消息，文本与两张图片一并还原进输入框。
        await tester.tap(find.text('撤回').at(1));
        await tester.pumpAndSettle();

        final input = find.byKey(const ValueKey('run-composer-input'));
        expect(tester.widget<TextField>(input).controller!.text, '看看这两张截图');
        expect(
          find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'composer-attachment-tile-',
                ),
          ),
          findsNWidgets(2),
        );

        // 还原的图片无需重新上传即可直接再次发送。
        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();
        expect(host.startCalls, hasLength(1));
        expect(host.startCalls.single['text'], '看看这两张截图');
        expect(host.startCalls.single['attachmentIds'], ['q-att-1', 'q-att-2']);
      },
    );

    test('formatQueuedMessageSummary formats 0/1/N attachments cleanly', () {
      const ref = MobileAttachmentRef(
        id: 'a1',
        mimeType: 'image/png',
        fileName: 'a.png',
        sizeBytes: 10,
      );
      expect(
        formatQueuedMessageSummary(
          const QueuedMessage(id: '1', text: '纯文本', selected: false),
        ),
        '纯文本',
      );
      expect(
        formatQueuedMessageSummary(
          const QueuedMessage(
            id: '2',
            text: '',
            selected: false,
            attachments: [ref],
          ),
        ),
        '[图片]',
      );
      expect(
        formatQueuedMessageSummary(
          const QueuedMessage(
            id: '3',
            text: '附说明',
            selected: false,
            attachments: [ref, ref, ref],
          ),
        ),
        '[3 张图片] 附说明',
      );
    });
  });

  group('timeline attachment grid & full-screen viewer', () {
    test('computes bounded single image aspect size and 2/3-column grid counts', () {
      final tallScreenshot = computeSingleAttachmentSize(
        width: 800,
        height: 4000,
        maxWidth: 260,
        maxHeight: 280,
      );
      expect(tallScreenshot.height, lessThanOrEqualTo(280));
      expect(tallScreenshot.width, greaterThanOrEqualTo(96));

      final widePhoto = computeSingleAttachmentSize(
        width: 1920,
        height: 1080,
        maxWidth: 260,
        maxHeight: 280,
      );
      expect(widePhoto.width, closeTo(260, 0.1));
      expect(widePhoto.height, closeTo(146.25, 0.5));

      expect(timelineAttachmentGridColumns(1), 1);
      expect(timelineAttachmentGridColumns(2), 2);
      expect(timelineAttachmentGridColumns(3), 3);
      expect(timelineAttachmentGridColumns(4), 2);
      expect(timelineAttachmentGridColumns(5), 3);
      expect(timelineAttachmentGridColumns(6), 3);
    });

    testWidgets(
      'renders 3-image user bubble grid, opens full-screen viewer at tapped index, transitions thumb -> full, swipes pages, and retries failed full load',
      (tester) async {
        final fullGate = Completer<void>();
        final host = _AttachmentHost(
          fullReadGate: fullGate,
          failFullReadOnce: true,
        );
        final thumb1 = _testPng(width: 24, height: 24, r: 220, g: 40, b: 40);
        final thumb2 = _testPng(width: 24, height: 24, r: 40, g: 220, b: 40);
        final thumb3 = _testPng(width: 24, height: 24, r: 40, g: 40, b: 220);
        final full2 = _testPng(width: 120, height: 90, r: 40, g: 220, b: 40);
        final full3 = _testPng(width: 120, height: 90, r: 40, g: 40, b: 220);

        host.thumbBytesById
          ..['img-1'] = thumb1
          ..['img-2'] = thumb2
          ..['img-3'] = thumb3;
        host.fullBytesById
          ..['img-1'] = thumb1
          ..['img-2'] = full2
          ..['img-3'] = full3;

        final conn = _AttachmentConnection(host);
        const refs = [
          MobileAttachmentRef(
            id: 'img-1',
            mimeType: 'image/png',
            fileName: 'first.png',
            sizeBytes: 100,
            width: 800,
            height: 600,
          ),
          MobileAttachmentRef(
            id: 'img-2',
            mimeType: 'image/png',
            fileName: 'second.png',
            sizeBytes: 120,
            width: 800,
            height: 600,
          ),
          MobileAttachmentRef(
            id: 'img-3',
            mimeType: 'image/png',
            fileName: 'third.png',
            sizeBytes: 140,
            width: 800,
            height: 600,
          ),
        ];

        Future<Uint8List?> loadThumb(String id) async {
          final cached = await cache.readThumb(conn.computer.computerKey, id);
          if (cached != null) return cached;
          final data = await conn.readAttachmentThumb(id, threadId: 't-1');
          await cache.writeThumb(conn.computer.computerKey, id, data.bytes);
          return data.bytes;
        }

        Future<Uint8List?> loadFull(String id) async {
          final cached = await cache.readFull(conn.computer.computerKey, id);
          if (cached != null) return cached;
          final data = await conn.readAttachmentFull(id, threadId: 't-1');
          await cache.writeFull(conn.computer.computerKey, id, data.bytes);
          return data.bytes;
        }

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: TimelineView(
                snapshot: TimelineSnapshot(
                  events: const [
                    MobileTimelineEvent(
                      seq: 1,
                      runId: 'r-1',
                      kind: MobileTimelineKind.messageUser,
                      createdAt: '2026-11-25T10:00:00Z',
                      text: '',
                      attachments: refs,
                    ),
                  ],
                  through: 1,
                  cursor: 1,
                  nextBefore: null,
                  live: null,
                ),
                online: true,
                loadEarlier: () async {},
                content: ({seq, runId, toolId, required field, offset}) async =>
                    const MobileTimelineContentResult(text: ''),
                peekAttachmentThumb: (id) =>
                    cache.peekThumbMemory(conn.computer.computerKey, id),
                loadAttachmentThumb: loadThumb,
                loadAttachmentFull: loadFull,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(TimelineUserAttachmentGrid.gridKey), findsOneWidget);
        expect(find.byKey(const ValueKey('timeline-attachment-img-1')), findsOneWidget);
        expect(find.byKey(const ValueKey('timeline-attachment-img-2')), findsOneWidget);
        expect(find.byKey(const ValueKey('timeline-attachment-img-3')), findsOneWidget);
        // 纯图消息不显示空文本复制按钮。
        expect(find.byTooltip('复制'), findsNothing);
        expect(host.readThumbCalls, containsAll(['img-1', 'img-2', 'img-3']));

        // 点击第 2 张图片，打开全屏查看器并定位到 2 / 3，先展示已缓存的缩略图。
        await tester.tap(find.byKey(const ValueKey('timeline-attachment-img-2')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));

        expect(find.byKey(ImageViewerPage.pageKey), findsOneWidget);
        expect(find.text('2 / 3'), findsOneWidget);
        expect(find.text('second.png'), findsOneWidget);
        expect(find.byKey(const ValueKey('image-viewer-thumb-img-2')), findsOneWidget);
        expect(find.text('加载原图中…'), findsOneWidget);

        // 放行首次原图请求（配置为失败一次）：缩略图保持可见，显示重试按钮。
        fullGate.complete();
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('image-viewer-thumb-img-2')), findsOneWidget);
        expect(find.byKey(ImageViewerPage.retryButtonKey), findsOneWidget);

        // 点击重试，加载高清原图成功并平滑切换为 full，且写入 attachment_cache。
        await tester.tap(find.byKey(ImageViewerPage.retryButtonKey));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('image-viewer-full-img-2')), findsOneWidget);
        expect(
          await cache.readFull(conn.computer.computerKey, 'img-2'),
          full2,
        );

        // 左右滑动切换到第 3 张，页码与文件名更新为 3 / 3 / third.png。
        await tester.fling(
          find.byKey(ImageViewerPage.pageViewKey),
          const Offset(-500, 0),
          1000,
        );
        await tester.pumpAndSettle();
        expect(find.text('3 / 3'), findsOneWidget);
        expect(find.text('third.png'), findsOneWidget);
        expect(find.byKey(const ValueKey('image-viewer-full-img-3')), findsOneWidget);

        // 点关闭按钮返回时间线。
        await tester.tap(find.byKey(ImageViewerPage.closeButtonKey));
        await tester.pumpAndSettle();
        expect(find.byKey(ImageViewerPage.pageKey), findsNothing);
      },
    );
  });
}
