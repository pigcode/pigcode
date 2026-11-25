import 'package:pigcode_client/pigcode_client.dart';

/// 持久化在本地草稿中的单条待发附件记录。
/// 只保存安全的文件名（位于 `<attachment_cache>/<computerHash>/drafts/`），
/// 避免 iOS 容器路径变更导致草稿副本失效。
final class DraftAttachmentRecord {
  const DraftAttachmentRecord({
    required this.localId,
    required this.fileName,
    required this.mimeType,
    required this.sizeBytes,
    required this.status,
    this.width,
    this.height,
    this.draftFileName,
    this.remoteRef,
  });

  final String localId;
  final String fileName;
  final String mimeType;
  final int sizeBytes;
  final String status;
  final int? width;
  final int? height;
  final String? draftFileName;
  final MobileAttachmentRef? remoteRef;

  factory DraftAttachmentRecord.fromJson(Map<String, dynamic> json) {
    final localId = json['localId'] as String;
    final fileName = json['fileName'] as String;
    final mimeType = json['mimeType'] as String;
    final sizeBytes = json['sizeBytes'] as int;
    final status = json['status'] as String? ?? 'localOffline';
    final width = json['width'] as int?;
    final height = json['height'] as int?;
    final draftFileName = json['draftFileName'] as String?;
    final rawRef = json['remoteRef'];
    final remoteRef = rawRef is Map<String, dynamic>
        ? MobileAttachmentRef.fromJson(rawRef)
        : null;
    return DraftAttachmentRecord(
      localId: localId,
      fileName: fileName,
      mimeType: mimeType,
      sizeBytes: sizeBytes,
      status: status,
      width: width,
      height: height,
      draftFileName: draftFileName,
      remoteRef: remoteRef,
    );
  }

  Map<String, Object?> toJson() => {
    'localId': localId,
    'fileName': fileName,
    'mimeType': mimeType,
    'sizeBytes': sizeBytes,
    'status': status,
    'width': ?width,
    'height': ?height,
    'draftFileName': ?draftFileName,
    'remoteRef': ?remoteRef?.toJson(),
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DraftAttachmentRecord &&
          localId == other.localId &&
          fileName == other.fileName &&
          mimeType == other.mimeType &&
          sizeBytes == other.sizeBytes &&
          status == other.status &&
          width == other.width &&
          height == other.height &&
          draftFileName == other.draftFileName &&
          remoteRef == other.remoteRef;

  @override
  int get hashCode => Object.hash(
    localId,
    fileName,
    mimeType,
    sizeBytes,
    status,
    width,
    height,
    draftFileName,
    remoteRef,
  );
}

List<DraftAttachmentRecord> decodeDraftAttachmentRecords(Object? raw) {
  if (raw is! List) return const [];
  final result = <DraftAttachmentRecord>[];
  for (final item in raw) {
    if (item is! Map<String, dynamic>) continue;
    try {
      result.add(DraftAttachmentRecord.fromJson(item));
    } catch (_) {
      // 跳过已损坏的单条草稿附件记录，不影响其余草稿恢复。
    }
  }
  return List<DraftAttachmentRecord>.unmodifiable(result);
}
