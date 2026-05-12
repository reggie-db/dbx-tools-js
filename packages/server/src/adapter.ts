import {
  DatabricksAdapter,
  type AgentEvent,
  type AgentInput,
  type AgentRunContext,
} from "@databricks/appkit/beta";

// Monkey-patch for `DatabricksAdapter.prototype.run` that conditionally
// disables AppKit's text-based tool-call fallback. The fallback regex
// (`/\[?([a-zA-Z_][\w.]*)\(([^)]*)\)\]?/g`) treats any `name(args)` token
// in the assistant's text as a tool invocation; that's correct for Llama
// models which emit tool calls as text, but Claude / GPT class models on
// Databricks Serving use native `tool_calls`, and the regex misfires on
// any SQL the assistant writes in its final answer (`SUM(...)`,
// `date_trunc(...)`). Every misfire dispatches an "Unknown tool" call,
// the adapter's step loop continues, and the same answer gets
// regenerated up to `maxSteps` times.
//
// The patch keys off a per-tool marker (`SKIP_TEXT_FALLBACK_KEY`) that
// the plugin stamps onto each toolkit entry's `def`. AppKit's agents
// plugin spreads `tool.def` verbatim when building the agent's tool
// index, so the marker flows through to `input.tools[i]` and is visible
// here. If no tool in `input.tools` carries the marker, the original
// `run()` (with the fallback intact) runs, leaving other adapters and
// Llama-style agents undisturbed.
//
// Caveat: the patch relies on five instance members
// (`maxSteps`, `buildTools`, `buildMessages`, `streamCompletion`,
// `executeSingleTool`) that are typed `private` in AppKit's d.ts but
// are regular runtime properties. If AppKit refactors them the patch
// needs an update.

/**
 * Property name stamped onto a tool's `def` to opt out of AppKit's
 * Python-style text-tool-call fallback when that tool is part of the
 * agent's toolset. Exported so consumers can mark their own tools as
 * "this agent uses native tool calling, never parse text".
 */
export const SKIP_TEXT_FALLBACK_KEY = "_dbxToolsSkipTextFallback" as const;

/** Type-safe shape of a marked tool definition. */
export interface SkipTextFallbackMarker {
  [SKIP_TEXT_FALLBACK_KEY]?: boolean;
}

interface _ToolCallObj {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  thoughtSignature?: unknown;
}

interface _StreamCompletionResult {
  text: string;
  toolCalls: _ToolCallObj[];
}

interface _Internals {
  maxSteps: number;
  buildTools(
    defs: AgentInput["tools"],
    nameToWire: Map<string, string>,
  ): unknown[];
  buildMessages(
    msgs: AgentInput["messages"],
    nameToWire: Map<string, string>,
  ): unknown[];
  streamCompletion(
    messages: unknown[],
    tools: unknown[],
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, _StreamCompletionResult, unknown>;
  executeSingleTool(
    tc: _ToolCallObj,
    originalName: string,
    messages: unknown[],
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown>;
}

type _RunFn = (
  this: DatabricksAdapter,
  input: AgentInput,
  context: AgentRunContext,
) => AsyncGenerator<AgentEvent, void, unknown>;

let _installed = false;

/**
 * Idempotently monkey-patch `DatabricksAdapter.prototype.run` with a
 * version that omits the Python-style text-tool-call fallback when any
 * of the agent's tools carry the {@link SKIP_TEXT_FALLBACK_KEY} marker.
 * Safe to call from multiple places (e.g. plugin `setup()`); subsequent
 * calls are no-ops.
 */
export function installAdapterPatch(): void {
  if (_installed) return;
  _installed = true;

  const proto = DatabricksAdapter.prototype as unknown as { run: _RunFn };
  const originalRun = proto.run;

  proto.run = async function* patchedRun(
    this: DatabricksAdapter,
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const skipTextFallback = input.tools.some(
      (t) =>
        (t as SkipTextFallbackMarker)[SKIP_TEXT_FALLBACK_KEY] === true,
    );
    if (!skipTextFallback) {
      yield* originalRun.call(this, input, context);
      return;
    }

    // Mirrors AppKit's run() loop verbatim except for the
    // `parseTextToolCalls(text)` fallback inside the `toolCalls.length === 0`
    // branch, which is omitted so SQL in the assistant's text doesn't get
    // matched as a tool call.
    const internals = this as unknown as _Internals;
    const nameToWire = new Map<string, string>();
    const wireToName = new Map<string, string>();
    for (const tool of input.tools) {
      const wire = tool.name.replace(/\./g, "__");
      if (wireToName.has(wire) && wireToName.get(wire) !== tool.name) {
        throw new Error(
          `Tool name collision: '${tool.name}' and '${wireToName.get(wire)}' both map to wire name '${wire}'`,
        );
      }
      nameToWire.set(tool.name, wire);
      wireToName.set(wire, tool.name);
    }

    const tools = internals.buildTools(input.tools, nameToWire);
    const messages = internals.buildMessages(input.messages, nameToWire);

    yield { type: "status", status: "running" };

    for (let step = 0; step < internals.maxSteps; step++) {
      if (context.signal?.aborted) break;
      const { text, toolCalls } = yield* internals.streamCompletion(
        messages,
        tools,
        context,
      );
      if (toolCalls.length === 0) break;
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const wireName = tc.function.name;
        const originalName = wireToName.get(wireName) ?? wireName;
        yield* internals.executeSingleTool(tc, originalName, messages, context);
      }
    }
  } as _RunFn;
}
