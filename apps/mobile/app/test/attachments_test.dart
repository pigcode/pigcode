import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:pigcode_mobile/attachments/attachment_cache.dart';
import 'package:pigcode_mobile/attachments/composer_attachments_controller.dart';
import 'package:pigcode_mobile/attachments/draft_attachment.dart';
import 'package:pigcode_mobile/attachments/image_compressor.dart';
import 'package:pigcode_mobile/computers.dart';
import 'package:pigcode_mobile/local_drafts.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:shared_preferences/shared_preferences.dart';

Uint8List _solidPng(int width, int height, {bool transparent = false}) {
  final image = img.Image(
    width: width,
    height: height,
    numChannels: transparent ? 4 : 3,
  );
  img.fill(
    image,
    color: transparent
        ? img.ColorRgba8(40, 120, 220, 255)
        : img.ColorRgb8(40, 120, 220),
  );
  if (transparent) {
    // 左上角写入半透明像素，用于验证透明 PNG 保留路径。
    image.setPixelRgba(0, 0, 255, 0, 0, 64);
    image.setPixelRgba(1, 0, 0, 255, 0, 0);
  }
  return Uint8List.fromList(img.encodePng(image));
}

Uint8List _solidJpeg(int width, int height) {
  final image = img.Image(width: width, height: height, numChannels: 3);
  img.fill(image, color: img.ColorRgb8(210, 80, 60));
  return Uint8List.fromList(img.encodeJpg(image, quality: 90));
}

Uint8List _solidGif(int width, int height) {
  final image = img.Image(width: width, height: height, numChannels: 3);
  img.fill(image, color: img.ColorRgb8(50, 180, 90));
  return Uint8List.fromList(img.encodeGif(image));
}

Uint8List _noisyJpeg(int width, int height) {
  final random = math.Random(42);
  final image = img.Image(width: width, height: height, numChannels: 3);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      image.setPixelRgb(
        x,
        y,
        random.nextInt(256),
        random.nextInt(256),
        random.nextInt(256),
      );
    }
  }
  return Uint8List.fromList(img.encodeJpg(image, quality: 95));
}

class _FakePreferences implements SharedPreferencesAsync {
  _FakePreferences({required bool installed}) : _installed = [installed];
  final List<bool> _installed;

  @override
  Future<bool?> getBool(String key) async => _installed[0];

  @override
  Future<void> setBool(String key, bool value) async {
    _installed[0] = value;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

ComputerProfile _computer(int seed) => ComputerProfile(
  address: 'wss://localhost/ws/v1/connect',
  token: 'fixture',
  computerKey: base64Url.encode(List<int>.filled(32, seed)).replaceAll('=', ''),
  name: '测试电脑 $seed',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('ImageCompressor & magic bytes', () {
    const compressor = ImageCompressor(runInIsolate: false);

    test('detects PNG, JPEG, WebP, and GIF magic bytes accurately', () {
      expect(detectImageMimeType(_solidPng(8, 8)), 'image/png');
      expect(detectImageMimeType(_solidJpeg(8, 8)), 'image/jpeg');
      expect(detectImageMimeType(_solidGif(8, 8)), 'image/gif');
      final webpHeader = Uint8List.fromList([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x20, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, // WEBP
        0x56, 0x50, 0x38, 0x20,
      ]);
      expect(detectImageMimeType(webpHeader), 'image/webp');
      expect(
        detectImageMimeType(Uint8List.fromList(utf8.encode('hello'))),
        isNull,
      );
      expect(detectImageMimeType(Uint8List(0)), isNull);
    });

    test(
      'rejects non-image payloads and corrupted images with clear Chinese error',
      () async {
        await expectLater(
          () => compressor.compressBytes(
            Uint8List.fromList(utf8.encode('not an image file')),
            fileName: 'notes.txt',
          ),
          throwsA(
            isA<ImageProcessingException>().having(
              (e) => e.message,
              'message',
              contains('不支持的图片格式'),
            ),
          ),
        );

        // 合法 PNG 魔数 + 损坏载荷
        final brokenPng = Uint8List.fromList([
          0x89,
          0x50,
          0x4E,
          0x47,
          0x0D,
          0x0A,
          0x1A,
          0x0A,
          0x00,
          0x00,
          0x00,
          0x0D,
          0xFF,
          0xFF,
          0xFF,
          0xFF,
        ]);
        await expectLater(
          () => compressor.compressBytes(brokenPng, fileName: 'broken.png'),
          throwsA(
            isA<ImageProcessingException>().having(
              (e) => e.message,
              'message',
              contains('损坏'),
            ),
          ),
        );
      },
    );

    test('passes small valid images through without re-encoding', () async {
      final png = _solidPng(320, 180);
      final processed = await compressor.compressBytes(
        png,
        fileName: '/tmp/screenshots/ui.png',
      );
      expect(processed.mimeType, 'image/png');
      expect(processed.width, 320);
      expect(processed.height, 180);
      expect(processed.fileName, 'ui.png');
      expect(processed.bytes, png);
    });

    test(
      'resizes oversized opaque image (>2048px) proportionally to JPEG',
      () async {
        final large = _solidPng(2600, 1300);
        final processed = await compressor.compressBytes(
          large,
          fileName: 'screenshot.png',
        );
        expect(processed.width, 2048);
        expect(processed.height, 1024);
        expect(processed.mimeType, 'image/jpeg');
        expect(processed.fileName, 'screenshot.jpg');
        expect(detectImageMimeType(processed.bytes), 'image/jpeg');
      },
    );

    test(
      'preserves PNG format and alpha channel for oversized transparent PNG',
      () async {
        final largeTransparent = _solidPng(2400, 1200, transparent: true);
        final processed = await compressor.compressBytes(
          largeTransparent,
          fileName: 'logo.png',
        );
        expect(processed.width, 2048);
        expect(processed.height, 1024);
        expect(processed.mimeType, 'image/png');
        expect(processed.fileName, 'logo.png');
        final decoded = img.decodePng(processed.bytes);
        expect(decoded, isNotNull);
        expect(decoded!.hasAlpha, isTrue);
      },
    );

    test(
      'rejects image when compressed bytes still exceed maxBytes limit',
      () async {
        final strictCompressor = const ImageCompressor(
          maxDimension: 2048,
          maxBytes: 1024, // 严格限制触发超限异常
          runInIsolate: false,
        );
        final noisy = _noisyJpeg(400, 400);
        await expectLater(
          () => strictCompressor.compressBytes(noisy, fileName: 'huge.jpg'),
          throwsA(
            isA<ImageProcessingException>().having(
              (e) => e.message,
              'message',
              '单张图片压缩后仍超过 4 MB',
            ),
          ),
        );
      },
    );

    test(
      'stageSharedImagesToDraft compresses, writes draft copies, and caps at 6',
      () async {
        final root = await Directory.systemTemp.createTemp(
          'pigcode-share-stage-',
        );
        addTearDown(() => root.delete(recursive: true));
        final cache = AttachmentCacheStore(directory: () async => root);

        final sourceDir = await Directory.systemTemp.createTemp(
          'pigcode-share-src-',
        );
        addTearDown(() => sourceDir.delete(recursive: true));
        final paths = <String>[];
        final sample = _solidPng(120, 80);
        for (var i = 0; i < 7; i++) {
          final file = File('${sourceDir.path}/shared-$i.png');
          await file.writeAsBytes(sample);
          paths.add(file.path);
        }

        final staged = await stageSharedImagesToDraft(
          computerKey: 'computer-share',
          paths: paths,
          cache: cache,
          compressor: compressor,
        );
        expect(staged.records, hasLength(6));
        expect(staged.error, contains('最多添加 6 张'));
        for (final record in staged.records) {
          expect(record.status, 'localOffline');
          expect(record.draftFileName, isNotNull);
          final savedBytes = await cache.readDraftFile(
            'computer-share',
            record.draftFileName!,
          );
          expect(savedBytes, isNotNull);
          expect(savedBytes, isNotEmpty);
        }
      },
    );
  });

  group('AttachmentCacheStore isolation and cleanup chain', () {
    test(
      'isolates thumbs, full, and drafts per computerKey and cleans up on computer removal',
      () async {
        final root = await Directory.systemTemp.createTemp(
          'pigcode-att-cache-',
        );
        addTearDown(() => root.delete(recursive: true));
        final cache = AttachmentCacheStore(directory: () async => root);
        final computerA = _computer(1);
        final computerB = _computer(2);
        final payloadA = _solidPng(20, 20);
        final payloadB = _solidJpeg(24, 24);

        await cache.writeThumb(computerA.computerKey, 'att-1', payloadA);
        await cache.writeFull(computerA.computerKey, 'att-1', payloadA);
        final draftA = await cache.writeDraftFile(
          computerA.computerKey,
          'local-a',
          'png',
          payloadA,
        );

        await cache.writeThumb(computerB.computerKey, 'att-1', payloadB);
        await cache.writeFull(computerB.computerKey, 'att-1', payloadB);
        final draftB = await cache.writeDraftFile(
          computerB.computerKey,
          'local-b',
          'jpg',
          payloadB,
        );

        // 确认不同电脑使用不同哈希目录，互不干扰。
        final hashA = await cache.computerHash(computerA.computerKey);
        final hashB = await cache.computerHash(computerB.computerKey);
        expect(hashA, isNot(hashB));
        expect(await cache.readThumb(computerA.computerKey, 'att-1'), payloadA);
        expect(await cache.readThumb(computerB.computerKey, 'att-1'), payloadB);
        expect(await cache.readFull(computerA.computerKey, 'att-1'), payloadA);
        expect(
          await cache.readDraftFile(computerA.computerKey, draftA),
          payloadA,
        );

        // 模拟删除电脑 / 撤销配对流程（Computers.forget）彻底清理 A 电脑，保留 B 电脑。
        final offlineDir = await Directory.systemTemp.createTemp(
          'pigcode-off-',
        );
        addTearDown(() => offlineDir.delete(recursive: true));
        final offlineCache = OfflineCacheStore(
          directory: () async => offlineDir,
        );
        final container = ProviderContainer(
          overrides: [
            attachmentCacheProvider.overrideWithValue(cache),
            offlineCacheProvider.overrideWithValue(offlineCache),
            computersProvider.overrideWith(
              () => Computers(preferences: _FakePreferences(installed: true)),
            ),
          ],
        );
        addTearDown(container.dispose);

        await container.read(computersProvider.future);
        await container.read(computersProvider.notifier).remember(computerA);
        await container.read(computersProvider.notifier).remember(computerB);
        // remember 首次添加会清理历史残留，因此重新写入测试数据后再调用 forget。
        await cache.writeThumb(computerA.computerKey, 'att-1', payloadA);
        await cache.writeFull(computerA.computerKey, 'att-1', payloadA);
        await cache.writeDraftFile(
          computerA.computerKey,
          'local-a',
          'png',
          payloadA,
        );
        await cache.writeThumb(computerB.computerKey, 'att-1', payloadB);
        await cache.writeFull(computerB.computerKey, 'att-1', payloadB);
        await cache.writeDraftFile(
          computerB.computerKey,
          'local-b',
          'jpg',
          payloadB,
        );

        final forgotten = await container
            .read(computersProvider.notifier)
            .forget(computerA);
        expect(forgotten, isTrue);

        // A 电脑的目录与内存缩略图均被彻底清除。
        expect(cache.peekThumbMemory(computerA.computerKey, 'att-1'), isNull);
        expect(await cache.readThumb(computerA.computerKey, 'att-1'), isNull);
        expect(await cache.readFull(computerA.computerKey, 'att-1'), isNull);
        expect(
          await cache.readDraftFile(computerA.computerKey, draftA),
          isNull,
        );
        expect(
          await (await cache.computerDirectory(
            computerA.computerKey,
          ))!.exists(),
          isFalse,
        );

        // B 电脑数据丝毫无损。
        expect(await cache.readThumb(computerB.computerKey, 'att-1'), payloadB);
        expect(await cache.readFull(computerB.computerKey, 'att-1'), payloadB);
        expect(
          await cache.readDraftFile(computerB.computerKey, draftB),
          payloadB,
        );
      },
    );

    test('fresh install clears all cached attachments and drafts', () async {
      final root = await Directory.systemTemp.createTemp(
        'pigcode-install-att-',
      );
      addTearDown(() async {
        if (await root.exists()) await root.delete(recursive: true);
      });
      final cache = AttachmentCacheStore(directory: () async => root);
      final offlineDir = await Directory.systemTemp.createTemp(
        'pigcode-install-off-',
      );
      addTearDown(() async {
        if (await offlineDir.exists()) await offlineDir.delete(recursive: true);
      });
      final offlineCache = OfflineCacheStore(directory: () async => offlineDir);

      final computer = _computer(9);
      await cache.writeThumb(computer.computerKey, 'stale', _solidPng(12, 12));
      await cache.writeDraftFile(
        computer.computerKey,
        'stale-draft',
        'png',
        _solidPng(12, 12),
      );

      final container = ProviderContainer(
        overrides: [
          attachmentCacheProvider.overrideWithValue(cache),
          offlineCacheProvider.overrideWithValue(offlineCache),
          computersProvider.overrideWith(
            () => Computers(preferences: _FakePreferences(installed: false)),
          ),
        ],
      );
      addTearDown(container.dispose);

      await container.read(computersProvider.future);
      expect(await root.exists(), isFalse);
      expect(cache.peekThumbMemory(computer.computerKey, 'stale'), isNull);
    });

    test(
      'ThreadDraftStorage persists attachments and deletes draft files on clearComputerDrafts',
      () async {
        final root = await Directory.systemTemp.createTemp(
          'pigcode-draft-att-',
        );
        addTearDown(() => root.delete(recursive: true));
        final cache = AttachmentCacheStore(directory: () async => root);

        final store = ThreadDraftStorage(
          'comp-1',
          'thread-1',
          attachmentCache: cache,
        );
        final draftFile = await cache.writeDraftFile(
          'comp-1',
          'loc-1',
          'png',
          _solidPng(32, 32),
        );
        await store.save('配图说明');
        await store.saveAttachments([
          DraftAttachmentRecord(
            localId: 'loc-1',
            fileName: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 123,
            width: 32,
            height: 32,
            draftFileName: draftFile,
            status: 'localOffline',
          ),
        ]);

        final restored = await ThreadDraftStorage(
          'comp-1',
          'thread-1',
          attachmentCache: cache,
        ).readFull();
        expect(restored.text, '配图说明');
        expect(restored.attachments, hasLength(1));
        expect(restored.attachments.single.draftFileName, draftFile);

        await clearComputerDrafts('comp-1', attachmentCache: cache);
        expect(await cache.readDraftFile('comp-1', draftFile), isNull);
        final afterClear = await ThreadDraftStorage(
          'comp-1',
          'thread-1',
          attachmentCache: cache,
        ).readFull();
        expect(afterClear.text, isEmpty);
        expect(afterClear.attachments, isEmpty);
      },
    );
  });
}
