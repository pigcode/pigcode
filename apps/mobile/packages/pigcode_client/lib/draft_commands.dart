import 'command_models.dart';
import 'draft_models.dart';
import 'host_rpc.dart';

class MobileDraftCommands {
  MobileDraftCommands(this._rpc);

  final HostRequests _rpc;

  Future<MobileDraftOptions> options() async {
    final value = await _rpc.call(MobileDraftMethods.options, {});
    return MobileDraftOptions.fromJson(value as Map<String, dynamic>);
  }

  Future<MobileDraftModels> models(String instanceId) async {
    final value = await _rpc.call(
      MobileDraftMethods.models,
      MobileDraftModelParams(instanceId: instanceId).toJson(),
    );
    return MobileDraftModels.fromJson(value as Map<String, dynamic>);
  }

  Future<MobileDraftReceipt> create(MobileDraftCreateParams params) async {
    final value = await _rpc.call(MobileDraftMethods.create, params.toJson());
    final receipt = MobileDraftReceipt.fromJson(value as Map<String, dynamic>);
    if (receipt.method != MobileDraftMethods.create ||
        receipt.commandId != params.commandId ||
        receipt.projectId != params.projectId) {
      throw const FormatException('Unexpected draft receipt');
    }
    return receipt;
  }

  Future<MobileDraftReceipt?> receipt(String commandId) async {
    final value = await _rpc.call(
      MobileCommandMethods.receipt,
      MobileReceiptParams(commandId: commandId).toJson(),
    );
    final receipt = MobileDraftReceiptResult.fromJson(
      value as Map<String, dynamic>,
    ).receipt;
    if (receipt != null &&
        (receipt.commandId != commandId ||
            receipt.method != MobileDraftMethods.create)) {
      throw const FormatException('Unexpected draft receipt');
    }
    return receipt;
  }
}
