// Model seed aligned with magpie-community/plugins/packages/opendesign/models.mjs
// on 2026-11-10. Per-account live /models is authoritative when available.
export const MODELS = {
  'claude-haiku-5.5': { name: 'Claude Haiku 5.5', context: 1000000, output: 132000, input: ['image', 'file'], efforts: ['low', 'high', 'max'] },
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', context: 1048000, output: 232000, efforts: ['low', 'high', 'max'] },
  'deepseek-v4-flash-vision-exp': { name: 'DeepSeek V4 Flash Vision (exp)', context: 1048000, output: 232000, input: ['image'], efforts: ['low', 'high', 'max'] },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', context: 1048000, output: 232000, efforts: ['low', 'high', 'max'] },
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', context: 1048000, output: 232000, input: ['image'], efforts: ['low', 'high', 'max'] },
  'deepseek-v4.1-flash-eco': { name: 'DeepSeek V4.1 Flash Eco', context: 1048000, output: 232000, input: ['image'], efforts: ['low', 'high', 'max'] },
  'glm-5.3-flash': { name: 'GLM 5.3 Flash', context: 1048000, output: 232000, input: ['image', 'video'], efforts: ['low', 'high', 'max'] },
  'glm-5.3-flashx': { name: 'GLM 5.3 FlashX', context: 1000000, output: 232000, input: ['image', 'file', 'video'], efforts: ['low', 'high', 'max'] },
  'gpt-6-luna': { name: 'GPT-6 Luna', context: 1050000, output: 304000, input: ['image', 'file'], efforts: [] },
  'kimi-k2.7-code': { name: 'Kimi K2.7 Code', context: 262000, output: 262000, input: ['image'], efforts: ['low', 'high', 'max'] },
  'mimo-v2.6-flash': { name: 'MiMo V2.6 Flash', context: 1048000, output: 232000, input: ['image', 'audio', 'video'], efforts: ['low', 'high', 'max'] },
  'mimo-v2.6-pro': { name: 'MiMo V2.6 Pro', context: 1048000, output: 232000, input: ['image', 'audio', 'video'], efforts: ['low', 'high', 'max'] }
}
