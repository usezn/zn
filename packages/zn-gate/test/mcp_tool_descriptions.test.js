'use strict';

// The MCP tool descriptions and parameter descriptions are read by agents and by
// tool-poisoning scanners. zn-gate's own local rules must not block any of them,
// and only the documented advisories may appear, so a wording change cannot
// quietly turn our own descriptions into a finding.

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/mcp');
const rules = require('../lib/rules');

// Advisory-tier hits we accept on purpose, per tool. analyze_prompt is the
// prompt-injection tool, so its description names jailbreaks.
const ACCEPTED_ADVISORIES = { analyze_prompt: ['pi:jailbreak'] };

function descriptionsOf(tool) {
  const out = [['tool description', tool.description]];
  for (const [name, schema] of Object.entries((tool.inputSchema && tool.inputSchema.properties) || {})) {
    out.push([`parameter ${name}`, schema.description]);
  }
  return out;
}

test('no MCP tool or parameter description is blocked by zn-gate local rules', () => {
  for (const tool of gate.TOOLS) {
    for (const [label, text] of descriptionsOf(tool)) {
      assert.ok(typeof text === 'string' && text.length > 0, `${tool.name} ${label} has a description`);
      const r = rules.evaluate(text);
      assert.notEqual(r.verdict, 'block', `${tool.name} ${label} is blocked by rule ${r.rule}`);
    }
  }
});

test('MCP descriptions carry no advisory beyond the accepted ones', () => {
  for (const tool of gate.TOOLS) {
    const accepted = ACCEPTED_ADVISORIES[tool.name] || [];
    for (const [label, text] of descriptionsOf(tool)) {
      const r = rules.evaluate(text);
      if (!r.advisory) continue;
      assert.ok(accepted.includes(r.advisory.rule), `${tool.name} ${label} raises advisory ${r.advisory.rule}`);
    }
  }
});
