/** 新会话草稿页的文案：按时段的问候、输入框上方的项目选择与输入框下方的建议。 */
export const newThreadZhCN = {
  "newThread.title": "{greeting}，接下来做什么？",
  "newThread.greeting.morning": "早上好",
  "newThread.greeting.noon": "中午好",
  "newThread.greeting.afternoon": "下午好",
  "newThread.greeting.evening": "晚上好",
  "newThread.greeting.night": "夜深了",
  "newThread.noProjectHint": "先添加一个项目，Pigcode 会在项目文件夹里驱动 agent 完成工作。",
  "newThread.project": "会话所在的项目",
  "newThread.pickProject": "选择项目",
  "newThread.addProject": "添加项目…",
  "newThread.noProject": "先选择或添加一个项目，再开始会话。",
  "newThread.suggestions": "可以这样开始",
  "newThread.suggest.explain": "解释项目",
  "newThread.suggest.explain.prompt":
    "介绍一下这个项目：它是做什么的、目录怎么组织、核心模块在哪里。",
  "newThread.suggest.fix": "修复问题",
  "newThread.suggest.fix.prompt": "帮我排查并修复这个问题：",
  "newThread.suggest.test": "补充测试",
  "newThread.suggest.test.prompt": "给最近改动的代码补充单元测试，并运行确认全部通过。",
  "newThread.suggest.review": "审查改动",
  "newThread.suggest.review.prompt":
    "审查当前还没提交的改动，指出可能的 bug、风险和可以改进的地方。",
} as const

export const newThreadEnUS: Record<keyof typeof newThreadZhCN, string> = {
  "newThread.title": "{greeting}. What's next?",
  "newThread.greeting.morning": "Good morning",
  "newThread.greeting.noon": "Good afternoon",
  "newThread.greeting.afternoon": "Good afternoon",
  "newThread.greeting.evening": "Good evening",
  "newThread.greeting.night": "Working late",
  "newThread.noProjectHint":
    "Add a project first. Pigcode drives the agent inside the project folder.",
  "newThread.project": "Project for this thread",
  "newThread.pickProject": "Choose a project",
  "newThread.addProject": "Add project…",
  "newThread.noProject": "Choose or add a project before starting a thread.",
  "newThread.suggestions": "Ways to start",
  "newThread.suggest.explain": "Explain the project",
  "newThread.suggest.explain.prompt":
    "Walk me through this project: what it does, how it is organized, and where the core modules live.",
  "newThread.suggest.fix": "Fix a bug",
  "newThread.suggest.fix.prompt": "Help me track down and fix this bug: ",
  "newThread.suggest.test": "Add tests",
  "newThread.suggest.test.prompt":
    "Add unit tests for the recent changes and run them to make sure they all pass.",
  "newThread.suggest.review": "Review changes",
  "newThread.suggest.review.prompt":
    "Review the uncommitted changes and point out likely bugs, risks, and possible improvements.",
}
