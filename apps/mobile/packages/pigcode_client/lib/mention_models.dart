abstract final class MobileMentionMethods {
  static const searchPaths = 'workspace.searchPaths';
  static const agentCommands = 'agent.commands';
}

const mobileSearchPathsDefaultLimit = 20;
const mobileSearchPathsMaxLimit = 50;
const mobileSearchPathsQueryLimit = 256;
const mobileMentionPathLimit = 4096;
const mobileAgentCommandTextLimit = 256;
const mobileAgentCommandDescriptionLimit = 512;
const mobileAgentCommandShortLimit = 256;

enum MobilePathEntryKind {
  file('file'),
  dir('dir');

  const MobilePathEntryKind(this.wire);
  final String wire;

  factory MobilePathEntryKind.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobilePathEntryKind');
  }
}

final class MobilePathEntry {
  const MobilePathEntry({required this.path, required this.kind});

  final String path;
  final MobilePathEntryKind kind;

  factory MobilePathEntry.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'path', 'kind'}.contains(key))) {
      throw const FormatException('MobilePathEntry contains an unknown field');
    }
    final path = json['path'] as String;
    if (path.isEmpty || path.length > mobileMentionPathLimit) {
      throw const FormatException('Invalid path');
    }
    final kind = MobilePathEntryKind.fromWire(json['kind'] as String);
    return MobilePathEntry(path: path, kind: kind);
  }

  Map<String, Object?> toJson() => {'path': path, 'kind': kind.wire};
}

final class MobileSearchPathsParams {
  const MobileSearchPathsParams({
    this.threadId,
    this.projectId,
    this.query = '',
    this.limit,
    this.refresh,
  }) : assert(
         (threadId != null) != (projectId != null),
         'Provide exactly one of threadId or projectId',
       );

  final String? threadId;
  final String? projectId;
  final String query;
  final int? limit;
  final bool? refresh;

  factory MobileSearchPathsParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'projectId',
        'query',
        'limit',
        'refresh',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileSearchPathsParams contains an unknown field',
      );
    }
    final threadId = json.containsKey('threadId')
        ? json['threadId'] as String
        : null;
    if (threadId != null && threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final projectId = json.containsKey('projectId')
        ? json['projectId'] as String
        : null;
    if (projectId != null && projectId.isEmpty) {
      throw const FormatException('Invalid projectId');
    }
    if ((threadId == null) == (projectId == null)) {
      throw const FormatException(
        'MobileSearchPathsParams needs exactly one of threadId or projectId',
      );
    }
    final query = json.containsKey('query') ? json['query'] as String : '';
    if (query.length > mobileSearchPathsQueryLimit) {
      throw const FormatException('Invalid query');
    }
    final limit = json.containsKey('limit') ? json['limit'] as int : null;
    if (limit != null && (limit < 1 || limit > mobileSearchPathsMaxLimit)) {
      throw const FormatException('Invalid limit');
    }
    final refresh = json.containsKey('refresh')
        ? json['refresh'] as bool
        : null;
    return MobileSearchPathsParams(
      threadId: threadId,
      projectId: projectId,
      query: query,
      limit: limit,
      refresh: refresh,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': ?threadId,
    'projectId': ?projectId,
    'query': query,
    'limit': ?limit,
    'refresh': ?refresh,
  };
}

final class MobileSearchPathsResult {
  const MobileSearchPathsResult({
    required this.entries,
    required this.truncated,
  });

  final List<MobilePathEntry> entries;
  final bool truncated;

  factory MobileSearchPathsResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'entries', 'truncated'}.contains(key))) {
      throw const FormatException(
        'MobileSearchPathsResult contains an unknown field',
      );
    }
    final entries = List<MobilePathEntry>.unmodifiable(
      (json['entries'] as List<dynamic>).map(
        (item) => MobilePathEntry.fromJson(item as Map<String, dynamic>),
      ),
    );
    final truncated = json['truncated'] as bool;
    return MobileSearchPathsResult(entries: entries, truncated: truncated);
  }

  Map<String, Object?> toJson() => {
    'entries': entries.map((item) => item.toJson()).toList(),
    'truncated': truncated,
  };
}

enum MobileAgentCommandKind {
  command('command'),
  skill('skill');

  const MobileAgentCommandKind(this.wire);
  final String wire;

  factory MobileAgentCommandKind.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileAgentCommandKind');
  }
}

enum MobileAgentCommandSource {
  builtin('builtin'),
  custom('custom'),
  user('user'),
  project('project'),
  plugin('plugin'),
  system('system');

  const MobileAgentCommandSource(this.wire);
  final String wire;

  factory MobileAgentCommandSource.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileAgentCommandSource');
  }
}

final class MobileAgentCommand {
  const MobileAgentCommand({
    required this.name,
    required this.text,
    required this.kind,
    this.displayName,
    this.description,
    this.shortDescription,
    this.argumentHint,
    this.source,
  });

  final String name;
  final String text;
  final MobileAgentCommandKind kind;
  final String? displayName;
  final String? description;
  final String? shortDescription;
  final String? argumentHint;
  final MobileAgentCommandSource? source;

  bool get isSlashCommand => kind == MobileAgentCommandKind.command;
  bool get isSkill => kind == MobileAgentCommandKind.skill;

  factory MobileAgentCommand.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'name',
        'text',
        'kind',
        'displayName',
        'description',
        'shortDescription',
        'argumentHint',
        'source',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileAgentCommand contains an unknown field',
      );
    }
    final name = json['name'] as String;
    if (name.isEmpty || name.length > mobileAgentCommandTextLimit) {
      throw const FormatException('Invalid name');
    }
    final text = json['text'] as String;
    if (text.isEmpty || text.length > mobileAgentCommandTextLimit) {
      throw const FormatException('Invalid text');
    }
    final kind = MobileAgentCommandKind.fromWire(json['kind'] as String);
    final expectedPrefix = kind == MobileAgentCommandKind.skill ? r'$' : '/';
    if (!text.startsWith(expectedPrefix)) {
      throw const FormatException('Command text prefix does not match kind');
    }
    final displayName = json.containsKey('displayName')
        ? json['displayName'] as String
        : null;
    if (displayName != null &&
        (displayName.isEmpty ||
            displayName.length > mobileAgentCommandShortLimit)) {
      throw const FormatException('Invalid displayName');
    }
    final description = json.containsKey('description')
        ? json['description'] as String
        : null;
    if (description != null &&
        (description.isEmpty ||
            description.length > mobileAgentCommandDescriptionLimit)) {
      throw const FormatException('Invalid description');
    }
    final shortDescription = json.containsKey('shortDescription')
        ? json['shortDescription'] as String
        : null;
    if (shortDescription != null &&
        (shortDescription.isEmpty ||
            shortDescription.length > mobileAgentCommandShortLimit)) {
      throw const FormatException('Invalid shortDescription');
    }
    final argumentHint = json.containsKey('argumentHint')
        ? json['argumentHint'] as String
        : null;
    if (argumentHint != null &&
        (argumentHint.isEmpty ||
            argumentHint.length > mobileAgentCommandShortLimit)) {
      throw const FormatException('Invalid argumentHint');
    }
    final source = json.containsKey('source')
        ? MobileAgentCommandSource.fromWire(json['source'] as String)
        : null;
    return MobileAgentCommand(
      name: name,
      text: text,
      kind: kind,
      displayName: displayName,
      description: description,
      shortDescription: shortDescription,
      argumentHint: argumentHint,
      source: source,
    );
  }

  Map<String, Object?> toJson() => {
    'name': name,
    'text': text,
    'kind': kind.wire,
    'displayName': ?displayName,
    'description': ?description,
    'shortDescription': ?shortDescription,
    'argumentHint': ?argumentHint,
    'source': ?source?.wire,
  };
}

final class MobileAgentCommandsParams {
  const MobileAgentCommandsParams({
    required this.instanceId,
    this.threadId,
    this.projectId,
    this.refresh,
  }) : assert(
         threadId == null || projectId == null,
         'threadId and projectId cannot both be set',
       );

  final String instanceId;
  final String? threadId;
  final String? projectId;
  final bool? refresh;

  factory MobileAgentCommandsParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'instanceId',
        'threadId',
        'projectId',
        'refresh',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileAgentCommandsParams contains an unknown field',
      );
    }
    final instanceId = json['instanceId'] as String;
    if (instanceId.isEmpty) {
      throw const FormatException('Invalid instanceId');
    }
    final threadId = json.containsKey('threadId')
        ? json['threadId'] as String
        : null;
    if (threadId != null && threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final projectId = json.containsKey('projectId')
        ? json['projectId'] as String
        : null;
    if (projectId != null && projectId.isEmpty) {
      throw const FormatException('Invalid projectId');
    }
    if (threadId != null && projectId != null) {
      throw const FormatException('threadId and projectId cannot both be set');
    }
    final refresh = json.containsKey('refresh')
        ? json['refresh'] as bool
        : null;
    return MobileAgentCommandsParams(
      instanceId: instanceId,
      threadId: threadId,
      projectId: projectId,
      refresh: refresh,
    );
  }

  Map<String, Object?> toJson() => {
    'instanceId': instanceId,
    'threadId': ?threadId,
    'projectId': ?projectId,
    'refresh': ?refresh,
  };
}

final class MobileAgentCommandsResult {
  const MobileAgentCommandsResult({
    required this.commands,
    required this.truncated,
  });

  final List<MobileAgentCommand> commands;
  final bool truncated;

  factory MobileAgentCommandsResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'commands', 'truncated'}.contains(key),
    )) {
      throw const FormatException(
        'MobileAgentCommandsResult contains an unknown field',
      );
    }
    final commands = List<MobileAgentCommand>.unmodifiable(
      (json['commands'] as List<dynamic>).map(
        (item) => MobileAgentCommand.fromJson(item as Map<String, dynamic>),
      ),
    );
    final truncated = json['truncated'] as bool;
    return MobileAgentCommandsResult(commands: commands, truncated: truncated);
  }

  Map<String, Object?> toJson() => {
    'commands': commands.map((item) => item.toJson()).toList(),
    'truncated': truncated,
  };
}
