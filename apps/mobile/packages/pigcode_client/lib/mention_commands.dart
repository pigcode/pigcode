import 'host_rpc.dart';
import 'mention_models.dart';

class MobileMentionCommands {
  const MobileMentionCommands(this._rpc);

  final HostRequests _rpc;

  Future<MobileSearchPathsResult> searchPaths({
    String? threadId,
    String? projectId,
    String query = '',
    int? limit,
    bool? refresh,
  }) async {
    if ((threadId == null) == (projectId == null)) {
      throw ArgumentError('Provide exactly one of threadId or projectId');
    }
    if (threadId != null && threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    if (projectId != null && projectId.isEmpty) {
      throw ArgumentError.value(projectId, 'projectId', 'Must not be empty');
    }
    if (query.length > mobileSearchPathsQueryLimit) {
      throw ArgumentError.value(
        query,
        'query',
        'Must be at most $mobileSearchPathsQueryLimit characters',
      );
    }
    if (limit != null && (limit < 1 || limit > mobileSearchPathsMaxLimit)) {
      throw RangeError.range(limit, 1, mobileSearchPathsMaxLimit, 'limit');
    }
    final result = await _rpc.call(
      MobileMentionMethods.searchPaths,
      MobileSearchPathsParams(
        threadId: threadId,
        projectId: projectId,
        query: query,
        limit: limit,
        refresh: refresh,
      ).toJson(),
    );
    return MobileSearchPathsResult.fromJson(result as Map<String, dynamic>);
  }

  Future<MobileAgentCommandsResult> agentCommands({
    required String instanceId,
    String? threadId,
    String? projectId,
    bool? refresh,
  }) async {
    if (instanceId.isEmpty) {
      throw ArgumentError.value(instanceId, 'instanceId', 'Must not be empty');
    }
    if (threadId != null && threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    if (projectId != null && projectId.isEmpty) {
      throw ArgumentError.value(projectId, 'projectId', 'Must not be empty');
    }
    if (threadId != null && projectId != null) {
      throw ArgumentError('threadId and projectId cannot both be set');
    }
    final result = await _rpc.call(
      MobileMentionMethods.agentCommands,
      MobileAgentCommandsParams(
        instanceId: instanceId,
        threadId: threadId,
        projectId: projectId,
        refresh: refresh,
      ).toJson(),
    );
    return MobileAgentCommandsResult.fromJson(result as Map<String, dynamic>);
  }
}
