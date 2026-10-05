"""Config script validation against a firmware version's methods.json.

Mirrors static/schema.js exactly (same JSON Schema subset, same messages);
both are checked against tests/script_vectors.json.
"""

from typing import Any

TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer()),
}


def check_schema(value: Any, schema: dict, path: str) -> list[str]:
    """Errors for `value` against the subset: type, properties, required, additionalProperties, minimum, maximum, enum."""
    errors = []
    t = schema.get("type")
    if t and not TYPES[t](value):
        return [f"{path or 'params'}: must be {'an' if t in ('object', 'array', 'integer') else 'a'} {t}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {', '.join(map(str, schema['enum']))}")
    if "minimum" in schema and TYPES["number"](value) and value < schema["minimum"]:
        errors.append(f"{path}: must be at least {schema['minimum']:g}")
    if "maximum" in schema and TYPES["number"](value) and value > schema["maximum"]:
        errors.append(f"{path}: must be at most {schema['maximum']:g}")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path + '.' if path else ''}{key}: required")
        for key, v in value.items():
            sub = f"{path}.{key}" if path else key
            if key in props:
                errors += check_schema(v, props[key], sub)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{sub}: unknown setting")
    return errors


def validate_script(script: Any, methods: dict, shared: bool = True) -> list[str]:
    """Errors for a config script ({"calls": [{"method", "params"?}, ...]}); [] if valid.

    shared: the script is a saved config (used on many nodes), so per-device
    methods such as board.set_id are refused.
    """
    if not isinstance(script, dict) or not isinstance(script.get("calls"), list):
        return ['script must be an object with a "calls" list']
    if not script["calls"]:
        return ["script has no calls"]
    errors = []
    table = methods.get("methods", {})
    for i, call in enumerate(script["calls"], 1):
        where = f"call {i}"
        if not isinstance(call, dict) or not isinstance(call.get("method"), str):
            errors.append(f'{where}: must be an object with a "method" string')
            continue
        name = call["method"]
        where = f"call {i} ({name})"
        extra = set(call) - {"method", "params"}
        if extra:
            errors.append(f"{where}: unexpected key {sorted(extra)[0]}")
        m = table.get(name)
        if m is None:
            errors.append(f"{where}: unknown method")
            continue
        if m.get("script") is False:
            errors.append(f"{where}: not allowed in a config script")
            continue
        if shared and m.get("per_device"):
            errors.append(f"{where}: per-device method; set it on the node, not in a shared config")
            continue
        schema = m.get("params")
        if schema is None:
            if call.get("params") not in (None, {}, []):
                errors.append(f"{where}: takes no params")
            continue
        errors += [f"{where}: {e}" for e in check_schema(call.get("params", {}), schema, "")]
    return errors
