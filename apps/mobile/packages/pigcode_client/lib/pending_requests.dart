import 'command_models.dart';
import 'host_rpc.dart';
import 'request_models.dart';

class MobilePendingRequests {
  MobilePendingRequests(this._rpc);

  final HostRequests _rpc;

  Future<MobileRequestDetails> details(MobileRequestTarget target) async {
    final value = await _rpc.call(
      MobileRequestMethods.details,
      target.toJson(),
    );
    final result = MobileRequestDetails.fromJson(value as Map<String, dynamic>);
    if (result.threadId != target.threadId ||
        result.runId != target.runId ||
        result.requestId != target.requestId ||
        (result.approval == null) == (result.questions == null)) {
      throw const FormatException('Unexpected request details');
    }
    return result;
  }

  Future<MobileRequestReceipt> approve(MobileApproveParams params) =>
      _send(MobileRequestMethod.runRespondApproval, params.toJson());

  Future<MobileRequestReceipt> answer(MobileAnswerParams params) =>
      _send(MobileRequestMethod.runAnswerQuestion, params.toJson());

  Future<MobileRequestReceipt?> receipt(String commandId) async {
    final value = await _rpc.call(
      MobileCommandMethods.receipt,
      MobileReceiptParams(commandId: commandId).toJson(),
    );
    final result = MobileRequestReceiptResult.fromJson(
      value as Map<String, dynamic>,
    ).receipt;
    if (result != null && result.commandId != commandId) {
      throw const FormatException('Unexpected request receipt');
    }
    return result;
  }

  Future<MobileRequestReceipt> _send(
    MobileRequestMethod method,
    Map<String, Object?> params,
  ) async {
    final value = await _rpc.call(method.wire, params);
    final receipt = MobileRequestReceipt.fromJson(
      value as Map<String, dynamic>,
    );
    if (receipt.commandId != params['commandId'] ||
        receipt.threadId != params['threadId'] ||
        receipt.runId != params['runId'] ||
        receipt.requestId != params['requestId'] ||
        receipt.method != method) {
      throw const FormatException('Unexpected request receipt');
    }
    return receipt;
  }
}
