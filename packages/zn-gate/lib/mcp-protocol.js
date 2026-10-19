'use strict';

// MCP protocol versions the local servers (`zn-gate mcp` and `zn-gate secrets-mcp`) speak, and what changes on
// the wire for a stdio server between them. Spec changelogs:
//   2025-03-26  https://modelcontextprotocol.io/specification/2025-03-26/changelog  (tool annotations, batching required)
//   2025-06-18  https://modelcontextprotocol.io/specification/2025-06-18/changelog  (batching removed, tool `title`, structured output)
//   2025-11-25  https://modelcontextprotocol.io/specification/2025-11-25/changelog  (tasks, icons; nothing zn needs to change)
// Versions are ISO dates, so string comparison orders them.

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** The version to answer initialize with: the client's if supported, else the latest (the client then decides). */
function negotiateProtocolVersion(params) {
  const asked = params && params.protocolVersion;
  return typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
}

/** JSON-RPC batching is a feature of 2025-03-26 and earlier; 2025-06-18 removed it. */
function allowsBatching(version) {
  return (version || LATEST_PROTOCOL_VERSION) < '2025-06-18';
}

/** The tool definitions as valid for the negotiated version: annotations arrived in 2025-03-26, `title` in 2025-06-18. */
function toolsForVersion(tools, version) {
  const v = version || LATEST_PROTOCOL_VERSION;
  return tools.map((t) => {
    const { annotations, ...rest } = t;
    if (v < '2025-03-26') return rest;
    if (v < '2025-06-18') return t;
    return annotations && annotations.title ? { name: t.name, title: annotations.title, ...rest, annotations } : t;
  });
}

const BATCH_REJECTED = { code: -32600, message: 'Invalid Request: JSON-RPC batches are not supported from MCP 2025-06-18' };

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  allowsBatching,
  toolsForVersion,
  BATCH_REJECTED,
};
