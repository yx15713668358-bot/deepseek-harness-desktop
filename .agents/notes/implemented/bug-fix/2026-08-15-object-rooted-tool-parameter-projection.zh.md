# Agent Note: 第三方插件的对象根工具参数投影

Status: implemented

[English](2026-08-15-object-rooted-tool-parameter-projection.md) | 中文

## Problem

直接调用 `ctx.tools.register` 注册、参数为扁平 DSL 形状（`{ spec: { type, required, ... } }`）的第三方插件，会以这种无根形式到达 DeepSeek 官方 API。官方 API 把每个 `tools[].function.parameters` 都当作根必须声明 `type: "object"` 的 JSON Schema 校验，并用 `Invalid schema for function '<name>': schema must be a JSON Schema of 'type: "object"', got 'type: null'` 拒绝扁平映射。一方工具不受影响——`defineTool` 在注册时编译 DSL，`run_code` getter 也返回已编译 schema——只有裸 `register` 路径从未投影。

## Decision

在投影时编译，而非注册时。`ToolsRegistry.schemaOf` 是所有 wire/schema 发射必经的唯一投影点，现在对投影参数运行 `ensureObjectRootedParameters`：已声明 `type: "object"` 的值原样通过（defineTool 的输出、run_code getter），其余一律按参数 DSL 处理并用 `parameterSchemaSpecToJsonSchema` 编译。由于第三方插件惯用 `required: false` 标注可选属性（语义上等价于 DSL 的 true-or-absent 必填性），投影在编译前递归剥离 `required: false` 标注。注册路径保持原样，`run_code` 的语言感知 `parameters` getter 因此保留其惰性运行时解析。两种形状都不匹配的输入在投影时带工具名响亮失败。

## Consequences

- 裸 `register` 的插件在每个 provider 上（包括严格的 DeepSeek 官方 API）都发射标准对象根 schema；市场工具（`market_search`/`market_install`/`market_installed`/`market_update`）现在可走官方直连。
- 投影失败按请求浮出并携带工具名，而不是静默发送无根 schema。
- 每个投影工具的编译开销可忽略；`ensureObjectRootedParameters` 在常见的已是对象根情形下短路。
