import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'package:pigcode_client/pigcode_client.dart';

/// 手机端单张图片长边像素上限。
const mobileMaxImageDimension = 2048;

/// 读取 `connection.supportsAttachments`；在未覆写该属性的旧版桩连接上温和降级为 `false`。
bool connectionSupportsAttachments(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsAttachments;
  } on NoSuchMethodError {
    return false;
  }
}

/// 图片校验或压缩失败时抛出的业务异常，携带可直接展示给用户的中文错误文案。
final class ImageProcessingException implements Exception {
  const ImageProcessingException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// 经过魔数校验与压缩处理、可直接上传或写入本地离线草稿的图片结果。
final class ProcessedImage {
  const ProcessedImage({
    required this.bytes,
    required this.mimeType,
    required this.fileName,
    required this.width,
    required this.height,
  });

  final Uint8List bytes;
  final String mimeType;
  final String fileName;
  final int width;
  final int height;

  int get sizeBytes => bytes.length;
  String get extension => extensionForImageMimeType(mimeType);
}

/// 根据图片真实魔数识别 MIME 类型（PNG / JPEG / WebP / GIF），非支持图片返回 `null`。
String? detectImageMimeType(Uint8List bytes) {
  if (bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4E &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0D &&
      bytes[5] == 0x0A &&
      bytes[6] == 0x1A &&
      bytes[7] == 0x0A) {
    return 'image/png';
  }
  if (bytes.length >= 3 &&
      bytes[0] == 0xFF &&
      bytes[1] == 0xD8 &&
      bytes[2] == 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 &&
      bytes[0] == 0x47 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x38 &&
      (bytes[4] == 0x37 || bytes[4] == 0x39) &&
      bytes[5] == 0x61) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x46 &&
      bytes[8] == 0x57 &&
      bytes[9] == 0x45 &&
      bytes[10] == 0x42 &&
      bytes[11] == 0x50) {
    return 'image/webp';
  }
  return null;
}

/// 将图片 MIME 类型映射为规范扩展名（不含 `.`）。
String extensionForImageMimeType(String mimeType) => switch (mimeType) {
  'image/png' => 'png',
  'image/jpeg' => 'jpg',
  'image/webp' => 'webp',
  'image/gif' => 'gif',
  _ => 'jpg',
};

String _basename(String path) {
  final normalized = path.replaceAll('\\', '/');
  final index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(index + 1) : normalized;
}

String _normalizeFileName(String? rawName, String mimeType) {
  final ext = extensionForImageMimeType(mimeType);
  var base = _basename((rawName ?? '').trim());
  base = base.replaceAll(RegExp(r'[\x00-\x1F\x7F/\\]'), '_').trim();
  if (base.isEmpty || base == '.' || base == '..') {
    return 'image.$ext';
  }
  final dot = base.lastIndexOf('.');
  final stem = dot > 0 ? base.substring(0, dot) : base;
  final currentExt = dot > 0 ? base.substring(dot + 1).toLowerCase() : '';
  final matches =
      (mimeType == 'image/jpeg' &&
          (currentExt == 'jpg' || currentExt == 'jpeg')) ||
      currentExt == ext;
  final candidate = matches ? base : '$stem.$ext';
  if (candidate.length <= 255) return candidate;
  final maxStem = 255 - ext.length - 1;
  final clipped = stem.length > maxStem ? stem.substring(0, maxStem) : stem;
  return '$clipped.$ext';
}

bool _hasTransparentPixels(img.Image image) {
  if (!image.hasAlpha) return false;
  final maxAlpha = image.maxChannelValue;
  for (final pixel in image) {
    if (pixel.a < maxAlpha) return true;
  }
  return false;
}

img.Image _flattenOnWhite(img.Image source) {
  final canvas = img.Image(
    width: source.width,
    height: source.height,
    numChannels: 3,
  );
  img.fill(canvas, color: img.ColorRgb8(255, 255, 255));
  img.compositeImage(canvas, source);
  return canvas;
}

img.Image _scaleToMaxDimension(img.Image image, int maxDimension) {
  final longest = math.max(image.width, image.height);
  if (longest <= maxDimension) return image;
  final scale = maxDimension / longest;
  final width = math.max(1, (image.width * scale).round());
  final height = math.max(1, (image.height * scale).round());
  return img.copyResize(
    image,
    width: width,
    height: height,
    interpolation: img.Interpolation.linear,
  );
}

img.Image? _decodeByMime(Uint8List bytes, String mimeType) {
  try {
    return switch (mimeType) {
      'image/png' => img.decodePng(bytes),
      'image/jpeg' => img.decodeJpg(bytes),
      'image/webp' => img.decodeWebP(bytes),
      'image/gif' => img.decodeGif(bytes),
      _ => null,
    };
  } catch (_) {
    return null;
  }
}

ProcessedImage _compressSync(
  Uint8List bytes,
  String? fileName,
  int maxDimension,
  int maxBytes,
) {
  if (bytes.isEmpty) {
    throw const ImageProcessingException('图片文件为空或无法读取。');
  }
  final detectedMime = detectImageMimeType(bytes);
  if (detectedMime == null) {
    throw const ImageProcessingException(
      '不支持的图片格式，仅支持 PNG、JPEG、WebP 或 GIF。',
    );
  }
  final decoded = _decodeByMime(bytes, detectedMime);
  if (decoded == null || decoded.width <= 0 || decoded.height <= 0) {
    throw const ImageProcessingException('图片文件已损坏或无法解析。');
  }

  final needsOrientation =
      detectedMime == 'image/jpeg' &&
      decoded.exif.imageIfd.hasOrientation &&
      decoded.exif.imageIfd.orientation != 1;
  final oriented = needsOrientation ? img.bakeOrientation(decoded) : decoded;
  final longestSide = math.max(oriented.width, oriented.height);

  // 已满足尺寸与体积上限且无需旋转校正时，保留原始字节以维持最高画质（含动图 GIF）。
  if (!needsOrientation &&
      longestSide <= maxDimension &&
      bytes.length <= maxBytes) {
    return ProcessedImage(
      bytes: bytes,
      mimeType: detectedMime,
      fileName: _normalizeFileName(fileName, detectedMime),
      width: oriented.width,
      height: oriented.height,
    );
  }

  final resized = _scaleToMaxDimension(oriented, maxDimension);
  final keepTransparency =
      detectedMime == 'image/png' && _hasTransparentPixels(resized);

  if (keepTransparency) {
    final pngBytes = Uint8List.fromList(img.encodePng(resized, level: 6));
    if (pngBytes.length <= maxBytes) {
      return ProcessedImage(
        bytes: pngBytes,
        mimeType: 'image/png',
        fileName: _normalizeFileName(fileName, 'image/png'),
        width: resized.width,
        height: resized.height,
      );
    }
    // 带透明通道的 PNG 若仍超限，先按 75% / 55% 逐步缩小保留 PNG，仍超限则转高质量 JPEG。
    for (final factor in const [0.75, 0.55]) {
      final shrunk = img.copyResize(
        resized,
        width: math.max(1, (resized.width * factor).round()),
        height: math.max(1, (resized.height * factor).round()),
        interpolation: img.Interpolation.linear,
      );
      final candidate = Uint8List.fromList(img.encodePng(shrunk, level: 6));
      if (candidate.length <= maxBytes) {
        return ProcessedImage(
          bytes: candidate,
          mimeType: 'image/png',
          fileName: _normalizeFileName(fileName, 'image/png'),
          width: shrunk.width,
          height: shrunk.height,
        );
      }
    }
    final flattened = _flattenOnWhite(resized);
    for (final quality in const [88, 80, 70]) {
      final jpegBytes = Uint8List.fromList(
        img.encodeJpg(flattened, quality: quality),
      );
      if (jpegBytes.length <= maxBytes) {
        return ProcessedImage(
          bytes: jpegBytes,
          mimeType: 'image/jpeg',
          fileName: _normalizeFileName(fileName, 'image/jpeg'),
          width: flattened.width,
          height: flattened.height,
        );
      }
    }
    throw const ImageProcessingException('单张图片压缩后仍超过 4 MB');
  }

  final jpegSource = resized.hasAlpha ? _flattenOnWhite(resized) : resized;
  for (final quality in const [88, 80, 70]) {
    final jpegBytes = Uint8List.fromList(
      img.encodeJpg(jpegSource, quality: quality),
    );
    if (jpegBytes.length <= maxBytes) {
      return ProcessedImage(
        bytes: jpegBytes,
        mimeType: 'image/jpeg',
        fileName: _normalizeFileName(fileName, 'image/jpeg'),
        width: jpegSource.width,
        height: jpegSource.height,
      );
    }
  }
  throw const ImageProcessingException('单张图片压缩后仍超过 4 MB');
}

/// 统一的图片校验与压缩器（同时服务相册、拍照与系统分享）。
/// 支持在后台 Isolate 中执行解码/缩放/编码，并允许测试注入自定义处理器。
class ImageCompressor {
  const ImageCompressor({
    this.maxDimension = mobileMaxImageDimension,
    this.maxBytes = mobileMaxImageBytes,
    this.runInIsolate = true,
    this.customBytesProcessor,
    this.fileReader,
  });

  final int maxDimension;
  final int maxBytes;
  final bool runInIsolate;
  final Future<ProcessedImage> Function(Uint8List bytes, {String? fileName})?
  customBytesProcessor;
  final Future<Uint8List?> Function(String path)? fileReader;

  Future<ProcessedImage> compressBytes(
    Uint8List bytes, {
    String? fileName,
  }) async {
    if (customBytesProcessor case final custom?) {
      return custom(bytes, fileName: fileName);
    }
    final dim = maxDimension;
    final limit = maxBytes;
    if (runInIsolate) {
      return Isolate.run(() => _compressSync(bytes, fileName, dim, limit));
    }
    return _compressSync(bytes, fileName, dim, limit);
  }

  Future<ProcessedImage> compressFile(String path, {String? fileName}) async {
    final Uint8List raw;
    if (fileReader case final reader?) {
      final bytes = await reader(path);
      if (bytes == null) {
        throw const ImageProcessingException('找不到所选图片文件。');
      }
      raw = bytes;
    } else {
      final file = File(path);
      if (!await file.exists()) {
        throw const ImageProcessingException('找不到所选图片文件。');
      }
      raw = await file.readAsBytes();
    }
    final effectiveName = (fileName != null && fileName.trim().isNotEmpty)
        ? fileName
        : _basename(path);
    return compressBytes(raw, fileName: effectiveName);
  }
}

/// 选图来源返回的本地图片路径。
typedef PickedLocalImage = ({String path, String? name});

/// 相册与相机选择器抽象，便于在 Widget 测试中注入桩实现。
abstract interface class MobileImagePicker {
  Future<List<PickedLocalImage>> pickFromGallery({required int limit});
  Future<PickedLocalImage?> captureFromCamera();
}

/// 基于 `image_picker` 的默认系统选图/拍照实现。
class SystemMobileImagePicker implements MobileImagePicker {
  SystemMobileImagePicker({ImagePicker? picker})
    : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  @override
  Future<List<PickedLocalImage>> pickFromGallery({required int limit}) async {
    if (limit <= 0) return const [];
    if (limit == 1) {
      final file = await _picker.pickImage(source: ImageSource.gallery);
      if (file == null) return const [];
      return [(path: file.path, name: file.name)];
    }
    final files = await _picker.pickMultiImage(limit: limit);
    return [
      for (final file in files) (path: file.path, name: file.name),
    ];
  }

  @override
  Future<PickedLocalImage?> captureFromCamera() async {
    final file = await _picker.pickImage(source: ImageSource.camera);
    if (file == null) return null;
    return (path: file.path, name: file.name);
  }
}

final imageCompressorProvider = Provider<ImageCompressor>(
  (_) => const ImageCompressor(),
);

final mobileImagePickerProvider = Provider<MobileImagePicker>(
  (_) => SystemMobileImagePicker(),
);
