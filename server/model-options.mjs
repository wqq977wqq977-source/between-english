import { UserError } from './contracts.mjs';

const effortToken = /^[a-z][a-z0-9_-]{0,31}$/;

export function normalizeCodexCapabilities(entry) {
  const reasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
    ? [...new Set(entry.supportedReasoningEfforts.flatMap(option => typeof option?.reasoningEffort === 'string' && effortToken.test(option.reasoningEffort) ? [option.reasoningEffort] : []))].slice(0, 32)
    : [];
  const defaultReasoningEffort = reasoningEfforts.includes(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : '';
  // The current CLI advertises priority as Fast. Older catalogs used fast.
  // An empty advertised list means unsupported; absent metadata is unknown.
  const tiers = Array.isArray(entry.serviceTiers) ? entry.serviceTiers.map(tier => tier?.id)
    : Array.isArray(entry.additionalSpeedTiers) ? entry.additionalSpeedTiers : null;
  const supportsFast = tiers === null ? null : tiers.some(tier => tier === 'priority' || tier === 'fast');
  return { reasoningEfforts, defaultReasoningEffort, supportsFast };
}

export function validateCodexOptionValues({ reasoningEffort = '', fastMode = false } = {}) {
  if (typeof reasoningEffort !== 'string' || (reasoningEffort !== '' && !effortToken.test(reasoningEffort))) {
    throw new UserError('请选择有效的思考强度。');
  }
  if (typeof fastMode !== 'boolean') throw new UserError('请选择有效的 Fast 模式。');
  return { reasoningEffort, fastMode };
}

export function validateCodexOptions({ model = '', reasoningEffort = '', fastMode = false } = {}, catalog) {
  const options = validateCodexOptionValues({ reasoningEffort, fastMode });
  // Existing settings and manually entered models keep their default behavior.
  if (!reasoningEffort && !fastMode) return options;
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  const selected = Array.isArray(models) ? models.find(entry => model ? entry.id === model : entry.isDefault === true) : null;
  if (!selected) throw new UserError('请先获取可用模型，再选择思考强度或 Fast 模式。');
  if (reasoningEffort && !selected.reasoningEfforts?.includes(reasoningEffort)) {
    throw new UserError('当前模型不支持这个思考强度，请重新选择或刷新模型。');
  }
  if (fastMode && selected.supportsFast !== true) {
    throw new UserError(selected.supportsFast === false ? '当前模型不支持 Fast 模式。' : '请先刷新模型，确认是否支持 Fast 模式。');
  }
  return options;
}
