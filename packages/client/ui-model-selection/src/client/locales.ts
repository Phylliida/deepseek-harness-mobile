/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` reads identically to `trigger.fallback` today and is
 * still a separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '选择模型',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'blocked.composer': '当前模型不可用，请先选择模型',
  'empty.efforts': '当前模型未提供推理等级。',
  'subagent.trigger.label': '子代理',
  'subagent.trigger.selectAria': '选择子代理模型',
  'subagent.trigger.aria': '选择子代理模型，当前 {model}',
  'subagent.menu.aria': '子代理模型',
  'subagent.inherit': '跟随会话模型',
  'subagent.inherit.description': '委派的子代理使用会话当前模型',
  'usermodel.trigger.label': '用户模型',
  'usermodel.trigger.selectAria': '选择用户模型',
  'usermodel.trigger.aria': '选择用户模型，当前 {model}',
  'usermodel.menu.aria': '用户模型',
  'usermodel.goal.aria': '用户模型目标',
  'usermodel.goal.placeholder': '描述希望智能体完成的目标…',
  'usermodel.goal.hint': '先描述目标，再选择模型',
  'usermodel.armed': '已启用：{model}',
  'usermodel.disarm': '停用用户模型',
  'usermodel.disarm.description': '停止自动回复，恢复人工操作',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'blocked.composer': 'This model is unavailable — select one to continue',
  'empty.efforts': 'This model provides no reasoning effort levels.',
  'subagent.trigger.label': 'Subagents',
  'subagent.trigger.selectAria': 'Select subagent model',
  'subagent.trigger.aria': 'Select subagent model, current {model}',
  'subagent.menu.aria': 'Subagent model',
  'subagent.inherit': 'Inherit session model',
  'subagent.inherit.description': 'Delegated subagents use the session’s current model',
  'usermodel.trigger.label': 'User model',
  'usermodel.trigger.selectAria': 'Select user model',
  'usermodel.trigger.aria': 'Select user model, current {model}',
  'usermodel.menu.aria': 'User model',
  'usermodel.goal.aria': 'User model goal',
  'usermodel.goal.placeholder': 'Describe what the agent should accomplish…',
  'usermodel.goal.hint': 'Describe the goal, then pick a model',
  'usermodel.armed': 'Armed: {model}',
  'usermodel.disarm': 'Disarm user model',
  'usermodel.disarm.description': 'Stop automated replies; the human takes over',
} satisfies Record<ModelKey, string>
