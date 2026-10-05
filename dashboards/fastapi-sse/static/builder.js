// Config builder model: turns a version's methods.json into form fields and edits a
// config script ({calls: [...]}) without ever losing what the JSON says. The script is
// the single source of truth; every function returns a new script (no mutation).
// Pure functions only (DOM rendering lives in app.js), so this runs under Node tests.

const clone = v => structuredClone(v);

/** Methods a shared config may call, in methods.json order. */
export function callableMethods(methods) {
  return Object.entries(methods.methods ?? {})
    .filter(([, m]) => m.script !== false && !m.per_device)
    .map(([name, m]) => ({ name, description: m.description ?? "", hasParams: m.params != null }));
}

/** A starting value for a schema: its default, else the first enum, else the minimum, else empty. */
export function defaultFor(schema) {
  if ("default" in schema) return clone(schema.default);
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "integer": case "number": return schema.minimum ?? 0;
    case "boolean": return false;
    case "string": return "";
    case "object": {
      const out = {};
      for (const [k, s] of Object.entries(schema.properties ?? {})) {
        if ((schema.required ?? []).includes(k) || "default" in s) out[k] = defaultFor(s);
        // a nested object without its own default is included when its children have defaults
        else if (s.type === "object") {
          const inner = defaultFor(s);
          if (Object.keys(inner).length) out[k] = inner;
        }
      }
      return out;
    }
    default: return null;
  }
}

/** A new call to `name`, with params filled from the schema's defaults. */
export function newCall(methods, name) {
  const m = methods.methods[name];
  if (!m?.params) return { method: name };
  return { method: name, params: defaultFor(m.params) };
}

/** Control kind for a schema node. */
export function kindOf(schema) {
  if (schema.enum) return "enum";
  if ((schema.type === "integer" || schema.type === "number") && "minimum" in schema && "maximum" in schema) return "range";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "bool";
  if (schema.type === "string") return "text";
  if (schema.type === "object") return "object";
  return "json";
}

/** Slider step: whole numbers for integers; ~100 steps for decimals, rounded to a tidy value. */
export function stepFor(schema) {
  if (schema.type === "integer") return Math.max(1, Math.round((schema.maximum - schema.minimum) / 200));
  const raw = (schema.maximum - schema.minimum) / 100;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map(x => x * p).find(x => x >= raw);
}

/**
 * Field tree for an object schema and its current value:
 * [{key, path, label, kind, schema, value, included, required, children?}]
 * `included` is whether the key is present (config.set only changes the keys you send).
 */
export function fieldsFor(schema, value = {}, path = []) {
  const required = schema.required ?? [];
  return Object.entries(schema.properties ?? {}).map(([key, s]) => {
    const p = [...path, key];
    const included = value != null && key in value;
    const kind = kindOf(s);
    const field = {
      key, path: p, label: key.replaceAll("_", " "), kind, schema: s,
      value: included ? value[key] : defaultFor(s), included, required: required.includes(key),
      description: s.description ?? "",
    };
    if (kind === "object") field.children = fieldsFor(s, included ? value[key] : {}, p);
    return field;
  });
}

/** Can the form show this call faithfully? (Otherwise the UI says "edit in JSON".) */
export function representable(call, methods) {
  const m = methods.methods?.[call?.method];
  if (!m || typeof call !== "object" || Object.keys(call).some(k => k !== "method" && k !== "params")) return false;
  if (m.params == null) return call.params === undefined || (typeof call.params === "object" && call.params !== null && !Object.keys(call.params).length);
  const fits = (value, schema) => {
    const kind = kindOf(schema);
    if (kind === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      return Object.entries(value).every(([k, v]) => schema.properties?.[k] && fits(v, schema.properties[k]));
    }
    if (kind === "enum") return schema.enum.includes(value);
    if (kind === "range" || kind === "number") return typeof value === "number";
    if (kind === "bool") return typeof value === "boolean";
    if (kind === "text") return typeof value === "string";
    return false;
  };
  return call.params === undefined || fits(call.params, m.params);
}

// ---- edits (each returns a new script) ----

export function addCall(script, call) {
  return { ...script, calls: [...script.calls, call] };
}

export function removeCall(script, i) {
  return { ...script, calls: script.calls.filter((_, j) => j !== i) };
}

export function moveCall(script, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= script.calls.length) return script;
  const calls = [...script.calls];
  [calls[i], calls[j]] = [calls[j], calls[i]];
  return { ...script, calls };
}

export function replaceCall(script, i, call) {
  return { ...script, calls: script.calls.map((c, j) => (j === i ? call : c)) };
}

/** Set params[path] = value on call i (creating parent objects). */
export function setParam(script, i, path, value) {
  const call = clone(script.calls[i]);
  call.params ??= {};
  let o = call.params;
  for (const k of path.slice(0, -1)) o = (o[k] ??= {});
  o[path.at(-1)] = value;
  return replaceCall(script, i, call);
}

/** Remove params[path] from call i, dropping parent objects that become empty. */
export function unsetParam(script, i, path) {
  const call = clone(script.calls[i]);
  const stack = [];
  let o = call.params;
  for (const k of path.slice(0, -1)) {
    if (!o?.[k]) return script;
    stack.push([o, k]);
    o = o[k];
  }
  if (!o) return script;
  delete o[path.at(-1)];
  for (let s = stack.length - 1; s >= 0; s--) {
    const [parent, k] = stack[s];
    if (Object.keys(parent[k]).length === 0) delete parent[k];
  }
  return replaceCall(script, i, call);
}
