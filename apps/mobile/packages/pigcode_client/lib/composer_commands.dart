import 'composer_models.dart';
import 'draft_models.dart';
import 'host_rpc.dart';

class MobileComposerCommands {
  const MobileComposerCommands(this._rpc);

  final HostRequests _rpc;

  Future<MobileThreadComposerState> switchAgent({
    required String threadId,
    required String instanceId,
    String? modelId,
  }) async {
    final result = await _rpc.call(
      MobileComposerMethods.switchAgent,
      MobileSwitchAgentParams(
        threadId: threadId,
        instanceId: instanceId,
        modelId: modelId,
      ).toJson(),
    );
    return MobileThreadComposerState.fromJson(result as Map<String, dynamic>);
  }

  Future<MobileThreadComposerState> setPermissionMode({
    required String threadId,
    required MobileDraftPermission permissionMode,
  }) async {
    final result = await _rpc.call(
      MobileComposerMethods.setPermissionMode,
      MobileSetPermissionModeParams(
        threadId: threadId,
        permissionMode: permissionMode,
      ).toJson(),
    );
    return MobileThreadComposerState.fromJson(result as Map<String, dynamic>);
  }

  Future<MobileThreadComposerState> setPlanMode({
    required String threadId,
    required bool planMode,
  }) async {
    final result = await _rpc.call(
      MobileComposerMethods.setPlanMode,
      MobileSetPlanModeParams(threadId: threadId, planMode: planMode).toJson(),
    );
    return MobileThreadComposerState.fromJson(result as Map<String, dynamic>);
  }
}
