// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileRequestMethods {
  static const details = 'request.details';
  static const approve = 'run.respondApproval';
  static const answer = 'run.answerQuestion';
}

const mobileRequestAnswerBytes = 49152;

final class MobileRequestTarget {
  const MobileRequestTarget({
    required this.threadId,
    required this.runId,
    required this.requestId,
  });
  final String threadId;
  final String runId;
  final String requestId;

  factory MobileRequestTarget.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'runId', 'requestId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileRequestTarget contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty || runId.length > 128) {
      throw const FormatException('Invalid runId');
    }
    final requestId = (json['requestId'] as String);
    if (requestId.isEmpty || requestId.length > 128) {
      throw const FormatException('Invalid requestId');
    }
    return MobileRequestTarget(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'requestId': requestId,
  };
}

final class MobileApproveParams {
  const MobileApproveParams({
    required this.threadId,
    required this.runId,
    required this.requestId,
    required this.commandId,
    required this.decision,
  });
  final String threadId;
  final String runId;
  final String requestId;
  final String commandId;
  final MobileApprovalDecision decision;

  factory MobileApproveParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'runId',
        'requestId',
        'commandId',
        'decision',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileApproveParams contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty || runId.length > 128) {
      throw const FormatException('Invalid runId');
    }
    final requestId = (json['requestId'] as String);
    if (requestId.isEmpty || requestId.length > 128) {
      throw const FormatException('Invalid requestId');
    }
    final commandId = (json['commandId'] as String);
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final decision = (MobileApprovalDecision.fromWire(
      json['decision'] as String,
    ));
    return MobileApproveParams(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
      commandId: commandId,
      decision: decision,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'requestId': requestId,
    'commandId': commandId,
    'decision': decision.wire,
  };
}

final class MobileAnswerParams {
  const MobileAnswerParams({
    required this.threadId,
    required this.runId,
    required this.requestId,
    required this.commandId,
    required this.answers,
  });
  final String threadId;
  final String runId;
  final String requestId;
  final String commandId;
  final List<MobileQuestionAnswer> answers;

  factory MobileAnswerParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'runId',
        'requestId',
        'commandId',
        'answers',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileAnswerParams contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty || runId.length > 128) {
      throw const FormatException('Invalid runId');
    }
    final requestId = (json['requestId'] as String);
    if (requestId.isEmpty || requestId.length > 128) {
      throw const FormatException('Invalid requestId');
    }
    final commandId = (json['commandId'] as String);
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final answers = (List<MobileQuestionAnswer>.unmodifiable(
      (json['answers'] as List<dynamic>).map(
        (item) => MobileQuestionAnswer.fromJson(item as Map<String, dynamic>),
      ),
    ));
    return MobileAnswerParams(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
      commandId: commandId,
      answers: answers,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'requestId': requestId,
    'commandId': commandId,
    'answers': answers.map((item) => item.toJson()).toList(),
  };
}

final class MobileApproval {
  const MobileApproval({
    required this.toolName,
    this.title,
    this.description,
    this.detail,
    this.plan,
    required this.decisions,
  });
  final String toolName;
  final String? title;
  final String? description;
  final String? detail;
  final String? plan;
  final List<MobileApprovalDecision> decisions;

  factory MobileApproval.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'toolName',
        'title',
        'description',
        'detail',
        'plan',
        'decisions',
      }.contains(key),
    )) {
      throw const FormatException('MobileApproval contains an unknown field');
    }
    final toolName = (json['toolName'] as String);
    if (toolName.isEmpty) {
      throw const FormatException('Invalid toolName');
    }
    final title = json['title'] != null ? json['title'] as String : null;
    final description = json['description'] != null
        ? json['description'] as String
        : null;
    final detail = json['detail'] != null ? json['detail'] as String : null;
    final plan = json['plan'] != null ? json['plan'] as String : null;
    final decisions = (List<MobileApprovalDecision>.unmodifiable(
      (json['decisions'] as List<dynamic>).map(
        (item) => MobileApprovalDecision.fromWire(item as String),
      ),
    ));
    return MobileApproval(
      toolName: toolName,
      title: title,
      description: description,
      detail: detail,
      plan: plan,
      decisions: decisions,
    );
  }

  Map<String, Object?> toJson() => {
    'toolName': toolName,
    'title': ?title,
    'description': ?description,
    'detail': ?detail,
    'plan': ?plan,
    'decisions': decisions.map((item) => item.wire).toList(),
  };
}

enum MobileApprovalDecision {
  allowOnce('allow-once'),
  allowForSession('allow-for-session'),
  deny('deny');

  const MobileApprovalDecision(this.wire);
  final String wire;

  factory MobileApprovalDecision.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileApprovalDecision');
  }
}

final class MobileQuestionOption {
  const MobileQuestionOption({required this.label, this.description});
  final String label;
  final String? description;

  factory MobileQuestionOption.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'label', 'description'}.contains(key))) {
      throw const FormatException(
        'MobileQuestionOption contains an unknown field',
      );
    }
    final label = (json['label'] as String);
    if (label.isEmpty) {
      throw const FormatException('Invalid label');
    }
    final description = json['description'] != null
        ? json['description'] as String
        : null;
    return MobileQuestionOption(label: label, description: description);
  }

  Map<String, Object?> toJson() => {
    'label': label,
    'description': ?description,
  };
}

final class MobileQuestion {
  const MobileQuestion({
    this.header,
    required this.question,
    required this.options,
    required this.multiSelect,
    required this.allowCustomAnswer,
  });
  final String? header;
  final String question;
  final List<MobileQuestionOption> options;
  final bool multiSelect;
  final bool allowCustomAnswer;

  factory MobileQuestion.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'header',
        'question',
        'options',
        'multiSelect',
        'allowCustomAnswer',
      }.contains(key),
    )) {
      throw const FormatException('MobileQuestion contains an unknown field');
    }
    final header = json['header'] != null ? json['header'] as String : null;
    final question = (json['question'] as String);
    if (question.isEmpty) {
      throw const FormatException('Invalid question');
    }
    final options = (List<MobileQuestionOption>.unmodifiable(
      (json['options'] as List<dynamic>).map(
        (item) => MobileQuestionOption.fromJson(item as Map<String, dynamic>),
      ),
    ));
    final multiSelect = (json['multiSelect'] as bool);
    final allowCustomAnswer = (json['allowCustomAnswer'] as bool);
    return MobileQuestion(
      header: header,
      question: question,
      options: options,
      multiSelect: multiSelect,
      allowCustomAnswer: allowCustomAnswer,
    );
  }

  Map<String, Object?> toJson() => {
    'header': ?header,
    'question': question,
    'options': options.map((item) => item.toJson()).toList(),
    'multiSelect': multiSelect,
    'allowCustomAnswer': allowCustomAnswer,
  };
}

final class MobileQuestionAnswer {
  const MobileQuestionAnswer({required this.selected, this.custom});
  final List<String> selected;
  final String? custom;

  factory MobileQuestionAnswer.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'selected', 'custom'}.contains(key))) {
      throw const FormatException(
        'MobileQuestionAnswer contains an unknown field',
      );
    }
    final selected = (List<String>.unmodifiable(
      (json['selected'] as List<dynamic>).map((item) => item as String),
    ));
    final custom = json['custom'] != null ? json['custom'] as String : null;
    return MobileQuestionAnswer(selected: selected, custom: custom);
  }

  Map<String, Object?> toJson() => {
    'selected': selected.toList(),
    'custom': ?custom,
  };
}

final class MobileRequestDetails {
  const MobileRequestDetails({
    required this.threadId,
    required this.runId,
    required this.requestId,
    this.approval,
    this.questions,
  });
  final String threadId;
  final String runId;
  final String requestId;
  final MobileApproval? approval;
  final List<MobileQuestion>? questions;

  factory MobileRequestDetails.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'runId',
        'requestId',
        'approval',
        'questions',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileRequestDetails contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty || runId.length > 128) {
      throw const FormatException('Invalid runId');
    }
    final requestId = (json['requestId'] as String);
    if (requestId.isEmpty || requestId.length > 128) {
      throw const FormatException('Invalid requestId');
    }
    final approval = json['approval'] != null
        ? MobileApproval.fromJson(json['approval'] as Map<String, dynamic>)
        : null;
    final questions = json['questions'] != null
        ? List<MobileQuestion>.unmodifiable(
            (json['questions'] as List<dynamic>).map(
              (item) => MobileQuestion.fromJson(item as Map<String, dynamic>),
            ),
          )
        : null;
    return MobileRequestDetails(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
      approval: approval,
      questions: questions,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'requestId': requestId,
    'approval': ?approval?.toJson(),
    'questions': ?questions?.map((item) => item.toJson()).toList(),
  };
}

enum MobileRequestState {
  applied('applied'),
  alreadyHandled('already-handled'),
  expired('expired');

  const MobileRequestState(this.wire);
  final String wire;

  factory MobileRequestState.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileRequestState');
  }
}

final class MobileRequestOutcome {
  const MobileRequestOutcome({
    required this.state,
    this.decision,
    this.answers,
    this.answersTruncated,
  });
  final MobileRequestState state;
  final MobileApprovalDecision? decision;
  final List<String>? answers;
  final bool? answersTruncated;

  factory MobileRequestOutcome.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'state',
        'decision',
        'answers',
        'answersTruncated',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileRequestOutcome contains an unknown field',
      );
    }
    final state = (MobileRequestState.fromWire(json['state'] as String));
    final decision = json['decision'] != null
        ? MobileApprovalDecision.fromWire(json['decision'] as String)
        : null;
    final answers = json['answers'] != null
        ? List<String>.unmodifiable(
            (json['answers'] as List<dynamic>).map((item) => item as String),
          )
        : null;
    final answersTruncated = json['answersTruncated'] != null
        ? json['answersTruncated'] as bool
        : null;
    return MobileRequestOutcome(
      state: state,
      decision: decision,
      answers: answers,
      answersTruncated: answersTruncated,
    );
  }

  Map<String, Object?> toJson() => {
    'state': state.wire,
    'decision': ?decision?.wire,
    'answers': ?answers?.toList(),
    'answersTruncated': ?answersTruncated,
  };
}

enum MobileRequestMethod {
  runRespondApproval('run.respondApproval'),
  runAnswerQuestion('run.answerQuestion');

  const MobileRequestMethod(this.wire);
  final String wire;

  factory MobileRequestMethod.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileRequestMethod');
  }
}

final class MobileRequestReceipt {
  const MobileRequestReceipt({
    required this.threadId,
    required this.runId,
    required this.requestId,
    required this.commandId,
    required this.method,
    required this.outcome,
  });
  final String threadId;
  final String runId;
  final String requestId;
  final String commandId;
  final MobileRequestMethod method;
  final MobileRequestOutcome outcome;

  factory MobileRequestReceipt.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'runId',
        'requestId',
        'commandId',
        'method',
        'outcome',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileRequestReceipt contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty || runId.length > 128) {
      throw const FormatException('Invalid runId');
    }
    final requestId = (json['requestId'] as String);
    if (requestId.isEmpty || requestId.length > 128) {
      throw const FormatException('Invalid requestId');
    }
    final commandId = (json['commandId'] as String);
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final method = (MobileRequestMethod.fromWire(json['method'] as String));
    final outcome = (MobileRequestOutcome.fromJson(
      json['outcome'] as Map<String, dynamic>,
    ));
    return MobileRequestReceipt(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
      commandId: commandId,
      method: method,
      outcome: outcome,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'requestId': requestId,
    'commandId': commandId,
    'method': method.wire,
    'outcome': outcome.toJson(),
  };
}

final class MobileRequestReceiptResult {
  const MobileRequestReceiptResult({this.receipt});
  final MobileRequestReceipt? receipt;

  factory MobileRequestReceiptResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'receipt'}.contains(key))) {
      throw const FormatException(
        'MobileRequestReceiptResult contains an unknown field',
      );
    }
    final receipt = json['receipt'] != null
        ? MobileRequestReceipt.fromJson(json['receipt'] as Map<String, dynamic>)
        : null;
    return MobileRequestReceiptResult(receipt: receipt);
  }

  Map<String, Object?> toJson() => {'receipt': ?receipt?.toJson()};
}
