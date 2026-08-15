# Agent Note: Object-rooted tool parameter projection for third-party plugins

Status: implemented

English | [中文](2026-08-15-object-rooted-tool-parameter-projection.zh.md)

## Problem

Third-party plugins that call `ctx.tools.register` directly with a flat DSL-shaped `parameters` map (`{ spec: { type, required, ... } }`) reached the DeepSeek official API in that rootless form. The official API validates every `tools[].function.parameters` as a JSON Schema whose root must declare `type: "object"`, and rejects the flat map with `Invalid schema for function '<name>': schema must be a JSON Schema of 'type: "object"', got 'type: null'`. First-party tools are unaffected because `defineTool` compiles the DSL at registration, and the `run_code` getter returns an already compiled schema — the bare `register` path was the only unprojected one.

## Decision

Compile at projection, not at registration. `ToolsRegistry.schemaOf` — the single point every wire/schema emission passes through — now runs `ensureObjectRootedParameters` on the projected parameters: values that already declare `type: "object"` pass through unchanged (defineTool output, the run_code getter), everything else is treated as the parameter DSL and compiled with `parameterSchemaSpecToJsonSchema`. Because third-party plugins routinely annotate optional properties with `required: false` (semantically identical to the DSL's true-or-absent requiredness), the projection strips `required: false` annotations recursively before compiling. Registration stays unmodified, so the language-aware `parameters` getter on `run_code` keeps its lazy runtime resolution. Neither-form input fails loud at projection with the tool name in the error.

## Consequences

- Bare-`register` plugins emit standard object-rooted schemas on every provider, including the strict DeepSeek official API; the marketplace tools (`market_search`/`market_install`/`market_installed`/`market_update`) now work over the official direct route.
- Projection failures surface per request with the offending tool name rather than silently shipping a rootless schema.
- Compilation cost per projected tool is trivial; `ensureObjectRootedParameters` short-circuits on the already-object-rooted common case.
