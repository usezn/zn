'use strict';
/* The MCP secrets next-step hint names the .cmd forms on win32 and keeps the plain text elsewhere. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mcpNextStep } = require('../lib/mcp-secrets');

function asPlatform(value, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

test('MCP secrets hint names npx.cmd for both steps on win32', () => {
  asPlatform('win32', () => {
    const text = mcpNextStep('environment variable', 'API_KEY');
    assert.ok(text.includes('npx.cmd -y zn-gate secret set MCP_API_KEY'));
    assert.ok(text.includes('npx.cmd -y zn-gate secret allow MCP_API_KEY'));
    assert.ok(!text.includes('run zn secret allow'));
  });
});

test('MCP secrets hint is unchanged on other systems', () => {
  asPlatform('linux', () => {
    const text = mcpNextStep('argument', 'API_KEY');
    assert.ok(text.includes('run npx -y zn-gate secret set MCP_API_KEY to store the value in the local vault'));
    assert.ok(text.includes('run zn secret allow MCP_API_KEY --command <the server\'s command> so zn run may use it'));
    assert.ok(!text.includes('.cmd'));
  });
});
