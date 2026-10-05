// Config script validation against a firmware version's methods.json.
// Mirrors scripts.py exactly (same subset, same messages); both are checked
// against tests/script_vectors.json.

const isNum = v => typeof v === "number" && Number.isFinite(v);
const TYPES = {
  object: v => v !== null && typeof v === "object" && !Array.isArray(v),
  array: v => Array.isArray(v),
  string: v => typeof v === "string",
  boolean: v => typeof v === "boolean",
  number: isNum,
  integer: v => isNum(v) && Number.isInteger(v),
};
const article = t => (["object", "array", "integer"].includes(t) ? "an" : "a");

export function checkSchema(value, schema, path) {
  const t = schema.type;
  if (t && !TYPES[t](value)) return [`${path || "params"}: must be ${article(t)} ${t}`];
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  if ("minimum" in schema && isNum(value) && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`);
  if ("maximum" in schema && isNum(value) && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`);
  if (TYPES.object(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path ? path + "." : ""}${key}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = path ? `${path}.${key}` : key;
      if (key in props) errors.push(...checkSchema(v, props[key], sub));
      else if (schema.additionalProperties === false) errors.push(`${sub}: unknown setting`);
    }
  }
  return errors;
}

/** Errors for a config script ({calls: [{method, params?}]}); [] if valid. */
export function validateScript(script, methods, shared = true) {
  if (!TYPES.object(script) || !Array.isArray(script.calls)) return ['script must be an object with a "calls" list'];
  if (!script.calls.length) return ["script has no calls"];
  const errors = [];
  const table = methods.methods ?? {};
  script.calls.forEach((call, idx) => {
    const i = idx + 1;
    if (!TYPES.object(call) || typeof call.method !== "string") {
      errors.push(`call ${i}: must be an object with a "method" string`);
      return;
    }
    const where = `call ${i} (${call.method})`;
    const extra = Object.keys(call).filter(k => k !== "method" && k !== "params").sort();
    if (extra.length) errors.push(`${where}: unexpected key ${extra[0]}`);
    const m = table[call.method];
    if (!m) { errors.push(`${where}: unknown method`); return; }
    if (m.script === false) { errors.push(`${where}: not allowed in a config script`); return; }
    if (shared && m.per_device) { errors.push(`${where}: per-device method; set it on the node, not in a shared config`); return; }
    if (m.params == null) {
      const p = call.params;
      const empty = p == null || (Array.isArray(p) && !p.length) || (TYPES.object(p) && !Object.keys(p).length);
      if (!empty) errors.push(`${where}: takes no params`);
      return;
    }
    errors.push(...checkSchema(call.params ?? {}, m.params, "").map(e => `${where}: ${e}`));
  });
  return errors;
}

/** Methods that may appear in a script, for the editor's reference panel. */
export function scriptableMethods(methods) {
  return Object.entries(methods.methods ?? {})
    .filter(([, m]) => m.script !== false)
    .map(([name, m]) => ({ name, ...m }));
}
