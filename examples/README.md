# Examples

These are the examples in this folder: 20 in all, one folder each. Every value in them is made up. The Python and Node.js examples run on your machine with no API key and no network call. The GitHub Action and Promptfoo examples are configuration files that you use in your own workflow or test setup.

Run each command from the example's folder. Examples that pin zn-gate list it in their `requirements.txt` or `package.json`. The pins are exact, so an example behaves the same on your machine as it did when it was written.

## Python

| Example | What it shows | Command |
|---|---|---|
| [python-basic](python-basic/) | Check a prompt with `evaluate`, and block a tool call with the `guard` decorator. | `python main.py` |

## Python agent frameworks

Each of these guards the tools of an agent built with a framework. Most check the tool's output before the model reads it, so a page that tries to give the model orders is replaced by a notice and a secret in it is hidden. The model in each example is a scripted stand-in, so no model call is made.

| Example | Framework | What it shows | Command |
|---|---|---|---|
| [ag2-agent](ag2-agent/) | AG2 | Checks a tool call before it runs and the tool's output before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [crewai-agent](crewai-agent/) | CrewAI | Checks what a tool returns before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [dspy-agent](dspy-agent/) | DSPy | Guards the tools of a `ReAct` agent: blocks a call for an SSH key and checks the output of each tool. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [google-adk-agent](google-adk-agent/) | Google ADK | Checks what a tool returns before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [haystack-agent](haystack-agent/) | Haystack | Guards the arguments and the output of a tool. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [langchain-agent](langchain-agent/) | LangChain and LangGraph | Wraps tools so a blocked call does not run, and a callback handler stops the whole run on a block. | `python agent_guard.py` |
| [llamaindex-agent](llamaindex-agent/) | LlamaIndex | Checks what a tool returns before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [openai-agents-sdk](openai-agents-sdk/) | OpenAI Agents SDK (Python) | Checks what a tool returns before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [pydantic-ai-agent](pydantic-ai-agent/) | Pydantic AI | Checks what a tool returns before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [semantic-kernel-agent](semantic-kernel-agent/) | Microsoft Semantic Kernel | Protects the functions of a plugin, both their output and the arguments the model chose. | `pip install -r requirements.txt`, then `python agent_guard.py` |
| [smolagents-agent](smolagents-agent/) | smolagents | Checks what a tool returns before the model reads it. | `pip install -r requirements.txt`, then `python agent_guard.py` |

## Node.js

| Example | What it shows | Command |
|---|---|---|
| [node-basic](node-basic/) | Inspects a prompt with `evaluate` and cleans a tool result with `sanitizeToolResult`, using the Node.js package. | `node index.js` |
| [custom-rules](custom-rules/) | Loads project rules from a `.znrules` file in the project root. | `node demo.js` |

## JavaScript agent frameworks

| Example | Framework | What it shows | Command |
|---|---|---|---|
| [langchain-js](langchain-js/) | LangChain.js and LangGraph.js | Blocks a dangerous tool call and scrubs what a tool returns. Runs offline, with a scripted chat model. | `npm ci`, then `npm start` |
| [mastra-agent](mastra-agent/) | Mastra | Puts zn-gate around the tools of a Mastra agent: a checked call, and a checked result. | `npm install`, then `npm start` |
| [openai-agents-js](openai-agents-js/) | OpenAI Agents SDK (JavaScript) | Blocks a dangerous tool call and scrubs what a tool returns. | `npm install`, then `npm start` |
| [vercel-ai-sdk](vercel-ai-sdk/) | Vercel AI SDK | Puts zn-gate around the tools of an agent built with the Vercel AI SDK. | `npm install`, then `npm start` |

## Test suite and CI

| Example | What it shows | Command |
|---|---|---|
| [promptfoo](promptfoo/) | A Promptfoo config (`promptfooconfig.yaml`) that runs zn-gate's deterministic guardrail checks against benign and attack prompts. | The example gives no command. Run it with Promptfoo from this folder. |
| [github-action](github-action/) | Four workflow files for pull requests: an audit of agent configs, a scan of prompts and tools, and a hardened layout for running a coding agent in CI. | Copy the file you need into `.github/workflows/` of your repository. The example gives no command. |

The files in `github-action/` are: [workflow.yml](github-action/workflow.yml) (scan prompts and tools), [audit-minimal.yml](github-action/audit-minimal.yml) and [audit-workflow.yml](github-action/audit-workflow.yml) (audit agent configs), and [agent-in-ci.yml](github-action/agent-in-ci.yml) (run an agent without exposing secrets to pull requests from forks). See also [the GitHub Action guide](../docs/github-action.md).

## Docs

Step-by-step walkthroughs, with fake values, are in [docs/examples](../docs/examples/README.md).
