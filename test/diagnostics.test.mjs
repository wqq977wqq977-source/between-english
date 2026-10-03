import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodexFailure } from '../server/diagnostics.mjs';

test('classifies connection loss and stream timeouts without guessing an HTTP status', () => {
  for (const detail of [
    'stream disconnected before completion: error sending request for url (https://example.test/responses)\nReconnecting... 5/5',
    'Connection reset by peer; connection retries exhausted',
    'stream timeout after receiving response headers',
    'stream idle timeout',
    'stream_error',
    'request timed out',
    'deadline exceeded while reading response',
    'WebSocket error: transport closed',
    'failed to read the response stream',
    'connect ECONNREFUSED 127.0.0.1:8080',
    'getaddrinfo ENOTFOUND example.test',
    'DNS resolution failed'
  ]) {
    const result = classifyCodexFailure(detail);
    assert.equal(result.code, 'network', detail);
    assert.equal(result.httpStatus, undefined);
  }
  assert.deepEqual(classifyCodexFailure('HTTP/2 408 Request Timeout'), { code: 'network', message: '与 Codex 的连接中断或超时，请稍后重试。', httpStatus: 408 });
});

test('classifies explicit account limits and authentication failures', () => {
  for (const detail of ['HTTP 429 Too Many Requests', 'unexpected status 429', '{"status_code":429,"error":{"code":"rate_limit_exceeded"}}', '{"status":"429"}']) {
    assert.equal(classifyCodexFailure(detail).code, 'quota');
    assert.equal(classifyCodexFailure(detail).httpStatus, 429);
  }
  for (const detail of ['You have hit your usage limit.', 'insufficient_quota', 'Quota exceeded', 'Rate limit reached for requests']) assert.equal(classifyCodexFailure(detail).code, 'quota');
  for (const detail of ['unexpected status 401 Unauthorized', '{"status":401,"error":"Unauthorized"}', '\u001b[31mHTTP/1.1 401\u001b[0m', 'HTTP error: 401']) {
    assert.equal(classifyCodexFailure(detail).code, 'auth');
    assert.equal(classifyCodexFailure(detail).httpStatus, 401);
  }
  for (const detail of ['authentication failed', 'invalid_api_key', 'refresh token has expired', 'Your refresh token could not be refreshed because your refresh token was already used.', 'Please run codex login']) assert.equal(classifyCodexFailure(detail).code, 'auth');
});

test('distinguishes format, model settings and context limits from account quotas', () => {
  for (const detail of [
    'HTTP 400 Bad Request: Invalid schema for response_format codex_output_schema',
    'status code: 400: text.format.schema is missing required fields',
    'invalid_json_schema',
    'unsupported parameter: response_format'
  ]) assert.equal(classifyCodexFailure(detail).code, 'schema', detail);
  for (const detail of [
    'HTTP 404: model_not_found',
    'model does not exist or you do not have access to it',
    'Unsupported value: high is not supported with this model',
    'Unsupported parameter: reasoning_effort',
    'reasoning.effort: ultra is not supported',
    'service_tier is not available for this model',
    'Invalid value for service tier',
    'Fast mode is not allowed'
  ]) assert.equal(classifyCodexFailure(detail).code, 'model', detail);
  for (const detail of [
    'context_length_exceeded',
    'This model maximum context length is 100000 tokens; requested 110000.',
    'context window exhausted',
    'The input is too long.',
    'Prompt too large',
    'Request exceeds the available context window',
    'HTTP 400 Bad Request: context length exceeded'
  ]) assert.equal(classifyCodexFailure(detail).code, 'context', detail);
});

test('identifies explicit upstream outages and does not blame unknown errors on login or network', () => {
  assert.deepEqual(classifyCodexFailure('unexpected status 503 Service Unavailable; retrying after error sending request'), { code: 'upstream', message: 'Codex 服务暂时不可用，请稍后重试。', httpStatus: 503 });
  assert.equal(classifyCodexFailure('internal_server_error').code, 'upstream');
  for (const detail of [
    'Codex request failed',
    'Failed to open /Users/login/.codex/auth.json',
    'Could not read /private/tmp/login-401/example.toml',
    'loading schema /models/output-schema.json',
    'Exceeded expected line count in local log',
    'Reconnecting... 5/5',
    'retry limit exceeded',
    '403 Forbidden',
    '',
    null,
    { message: 'not a supported diagnostic input' }
  ]) {
    const result = classifyCodexFailure(detail);
    assert.equal(result.code, 'unknown', JSON.stringify(detail));
    assert.equal(result.message, 'Codex 未能完成请求，请稍后重试。');
  }
});

test('never returns raw details, credentials, prompts or source locations', () => {
  const secret = 'sk-test-private-secret';
  const result = classifyCodexFailure(new Error(`HTTP 401 Unauthorized Authorization: Bearer ${secret}; prompt: confidential article; /Users/private/account.json`));
  assert.deepEqual(Object.keys(result).sort(), ['code', 'httpStatus', 'message']);
  assert.equal(result.code, 'auth');
  for (const privateValue of [secret, 'confidential', '/Users/private', 'Bearer', 'account.json']) assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.equal(classifyCodexFailure('trace id: 401, requested model: gpt-401').httpStatus, undefined);
});
