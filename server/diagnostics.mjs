const messages = Object.freeze({
  quota: '当前 Codex 额度或调用频率受限，请稍后重试。',
  auth: 'Codex 登录已失效，请重新登录后重试。',
  network: '与 Codex 的连接中断或超时，请稍后重试。',
  schema: '本次输出格式未被 Codex 接受，需要调整后重试。',
  model: '当前模型不支持这组设置，请刷新模型并调整思考强度或 Fast 模式。',
  context: '本次内容超过模型容量，请缩短提示或减少选材数量。',
  upstream: 'Codex 服务暂时不可用，请稍后重试。',
  unknown: 'Codex 未能完成请求，请稍后重试。'
});

function responseStatus(text) {
  // Bare numbers and paths such as /users/login-401/ are not HTTP evidence.
  const patterns = [
    /\bHTTP(?:\/\d(?:\.\d)?)?(?:\s+error)?\s*[:=]?\s+([45]\d{2})\b/gi,
    /\b(?:unexpected\s+)?["']?status(?:[ _]code)?["']?\s*[:=]?\s*["']?([45]\d{2})\b/gi,
    /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Request Timeout|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/gi
  ];
  const matches = patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => ({ index: match.index, value: Number(match[1]) })));
  matches.sort((a, b) => a.index - b.index);
  return matches.at(-1)?.value;
}

// This boundary deliberately returns only fixed labels and messages. CLI stderr
// may contain paths, credentials, prompts or fetched text and must never persist.
export function classifyCodexFailure(detail) {
  const raw = typeof detail === 'string' ? detail : detail instanceof Error ? detail.message : '';
  const text = raw.slice(-65536).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const httpStatus = responseStatus(text);
  const result = code => ({ code, message: messages[code], ...(httpStatus === undefined ? {} : { httpStatus }) });

  // Context exhaustion often contains "exceeded" but is not an account limit.
  if (/\bcontext_length_exceeded\b|\b(?:maximum|max)\s+context\s+(?:length|size)|\bcontext\s+(?:length|window|size)\s+(?:was\s+|is\s+)?(?:exceeded|exhausted|too\s+(?:large|long))|\b(?:exceeded|exceeds)\s+(?:the\s+|this\s+model(?:'s)?\s+)?(?:maximum\s+|available\s+)?context\b|\b(?:input|prompt)\s+(?:is\s+|was\s+)?too\s+(?:long|large)\b/i.test(text)) return result('context');

  if (/\b(?:invalid_json_schema|invalid_schema|output_schema_error)\b|\b(?:invalid|unsupported|malformed)\s+(?:JSON\s+)?schema\b|\b(?:output[_ -]schema|response_format|text\.format(?:\.schema)?)\b[^\n]{0,100}\b(?:invalid|unsupported|not supported|not permitted|not allowed|must|required|missing)\b|\b(?:invalid|unsupported|unknown|unrecognized)\s+(?:parameter|argument|value)\b[^\n]{0,70}\b(?:output[_ -]schema|response_format|text\.format(?:\.schema)?)\b/i.test(text)) return result('schema');

  if (/\b(?:model_not_found|unsupported_model|invalid_model|unsupported_reasoning_effort|unsupported_service_tier)\b|\b(?:model|service[_ .-]tier|reasoning[_ .-]effort|fast mode)\b[^\n]{0,100}\b(?:not supported|unsupported|invalid|unknown|unrecognized|not found|does not exist|not available|unavailable|not allowed)\b|\b(?:unsupported|invalid|unknown|unrecognized)\b[^\n]{0,70}\b(?:model|service[_ .-]tier|reasoning[_ .-]effort|fast mode)\b/i.test(text)) return result('model');

  if (httpStatus === 429 || /\b(?:insufficient_quota|quota_exceeded|usage_limit_reached|usage_limit_exceeded|rate_limit_exceeded|rate_limit_error|billing_hard_limit_reached|too_many_requests)\b|\b(?:quota|usage limit|rate limit|request limit|billing limit)\b[^\n]{0,60}\b(?:exceeded|reached|exhausted|limited)\b|\b(?:hit|reached|exceeded|exhausted)\s+(?:your\s+|the\s+)?(?:usage limit|rate limit|request limit|quota|billing limit)\b|\btoo many requests\b/i.test(text)) return result('quota');

  if (httpStatus === 401 || /\b(?:invalid_api_key|authentication_error|not_authenticated|token_expired|invalid_grant)\b|(?:^|[\s"'=:])unauthorized(?:$|[\s.,;:"'])|\b(?:authentication|authorization)\s+(?:failed|required)\b|\binvalid\s+(?:API\s+key|authentication\s+token|access\s+token)\b|\b(?:access\s+token|refresh\s+token|session)\s+(?:has\s+)?expired\b|\brefresh token\b[^\n]{0,100}\b(?:already used|could not be refreshed|is invalid)\b|\bnot logged in\b|\blogin required\b|\blog in again\b|\bplease\s+(?:run|use)\s+(?:codex\s+)?login\b/i.test(text)) return result('auth');

  if ((httpStatus >= 500 && httpStatus <= 599) || /\b(?:server_error|internal_server_error)\b|\b(?:service|server)\s+(?:is\s+)?(?:temporarily\s+)?(?:unavailable|overloaded)\b/i.test(text)) return result('upstream');

  if (httpStatus === 408 || /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|stream_error|connection_error|network_error|request_timeout|stream_timeout)\b|\b(?:stream|connection|websocket|network|transport)\s+(?:was\s+|is\s+)?(?:disconnected|reset|refused|closed|aborted|broken|lost|timed out|timeout|error|failed)\b|\b(?:request|response|stream)\s+(?:has\s+)?timed out\b|\b(?:request|response|stream|connection)\s+(?:idle\s+)?timeout\b|\bdeadline exceeded\b|\berror sending request\b|\bfailed to (?:read|receive) (?:the )?(?:response|stream)\b|\b(?:connection|stream|network) retries (?:exceeded|exhausted)\b|\b(?:exceeded|exhausted) (?:connection|stream|network) retries\b|\bDNS (?:resolution|lookup) failed\b/i.test(text)) return result('network');

  return result('unknown');
}
