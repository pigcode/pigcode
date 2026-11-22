import 'dart:convert';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:uuid/uuid.dart';

import 'mobile_command_journal.dart';

class RequestSubmission implements JournalCommand {
  RequestSubmission._(this.method, this.params, this.sendVia);

  factory RequestSubmission.approve(
    MobileRequestTarget target,
    MobileApprovalDecision decision,
  ) => RequestSubmission._approval(
    MobileApproveParams(
      threadId: target.threadId,
      runId: target.runId,
      requestId: target.requestId,
      commandId: const Uuid().v4(),
      decision: decision,
    ),
  );

  factory RequestSubmission.answer(
    MobileRequestTarget target,
    List<MobileQuestionAnswer> answers,
  ) => RequestSubmission._answer(
    MobileAnswerParams(
      threadId: target.threadId,
      runId: target.runId,
      requestId: target.requestId,
      commandId: const Uuid().v4(),
      answers: List.unmodifiable(answers),
    ),
  );

  factory RequestSubmission._approval(MobileApproveParams params) =>
      RequestSubmission._(
        MobileRequestMethod.runRespondApproval,
        params.toJson(),
        (api) => api.approve(params),
      );

  factory RequestSubmission._answer(MobileAnswerParams params) =>
      RequestSubmission._(
        MobileRequestMethod.runAnswerQuestion,
        params.toJson(),
        (api) => api.answer(params),
      );

  static const slotPrefix = 'request.';
  final MobileRequestMethod method;
  final Map<String, Object?> params;
  final Future<MobileRequestReceipt> Function(MobilePendingRequests) sendVia;

  String get requestId => params['requestId'] as String;
  bool get fitsTransport =>
      method != MobileRequestMethod.runAnswerQuestion ||
      utf8.encode(jsonEncode(params['answers'])).length <=
          mobileRequestAnswerBytes;
  @override
  String get commandId => params['commandId'] as String;
  @override
  String get slot => '$slotPrefix${base64Url.encode(utf8.encode(requestId))}';

  @override
  Map<String, Object?> toJson() => {'method': method.wire, 'params': params};

  bool matches(MobileRequestReceipt receipt) =>
      receipt.method == method &&
      receipt.commandId == commandId &&
      receipt.threadId == params['threadId'] &&
      receipt.runId == params['runId'] &&
      receipt.requestId == requestId;

  static RequestSubmission decode(String slot, Map<String, dynamic> data) {
    final params = data['params'] as Map<String, dynamic>;
    final value = switch (MobileRequestMethod.fromWire(
      data['method'] as String,
    )) {
      MobileRequestMethod.runRespondApproval => RequestSubmission._approval(
        MobileApproveParams.fromJson(params),
      ),
      MobileRequestMethod.runAnswerQuestion => RequestSubmission._answer(
        MobileAnswerParams.fromJson(params),
      ),
    };
    if (value.slot != slot) {
      throw const FormatException('Unexpected saved request');
    }
    return value;
  }
}
