/** Minimal local equivalent of @deepseek-ai/dsh-tools defineTool, so the plugin has zero runtime deps. */
function specToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const property = { type: spec.type };
    if (typeof spec.description === "string") property.description = spec.description;
    properties[key] = property;
    if (spec.required) required.push(key);
  }
  const schema = { type: "object", additionalProperties: false, properties };
  if (required.length) schema.required = required;
  return schema;
}

export function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { ...options.output, schema: specToJsonSchema(options.output?.schema) },
    execute: options.execute,
  };
}
