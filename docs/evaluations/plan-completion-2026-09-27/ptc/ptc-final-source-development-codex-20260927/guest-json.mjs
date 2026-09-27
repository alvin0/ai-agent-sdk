// Runs inside QuickJS before user code. Validate before serialization can drop
// undefined fields, coerce non-finite numbers, or invoke getters/toJSON.
export const GUEST_JSON_PRELUDE = `
const __encodeArguments = (() => {
  const stringify = JSON.stringify;
  const descriptor = Object.getOwnPropertyDescriptor;
  const prototype = Object.getPrototypeOf;
  const keys = Reflect.ownKeys;
  const isArray = Array.isArray;
  const plain = Object.prototype;
  const finite = Number.isFinite;
  return (value, maxChars = 65536, failureCode = 'PROGRAM_INVALID_ARGUMENTS') => {
    let nodes = 0;
    const seen = new Set();
    const fail = () => { throw new Error(failureCode + ': value must be bounded lossless JSON'); };
    const data = (object, key) => {
      const field = descriptor(object, key);
      if (!field || !('value' in field)) fail();
      return field.value;
    };
    const encode = (input, depth) => {
      if (++nodes > 32768 || depth > 64) fail();
      if (input === null || typeof input === 'boolean' || typeof input === 'string') return stringify(input);
      if (typeof input === 'number') { if (!finite(input)) fail(); return stringify(input); }
      if (typeof input !== 'object' || seen.has(input)) fail();
      seen.add(input);
      let result;
      if (isArray(input)) {
        const length = data(input, 'length');
        if (length > 16384) fail();
        const fields = [];
        for (let index = 0; index < length; index++) fields.push(encode(data(input, String(index)), depth + 1));
        result = '[' + fields.join(',') + ']';
      } else {
        if (prototype(input) !== plain && prototype(input) !== null) fail();
        const names = keys(input);
        if (names.length > 16384) fail();
        const fields = [];
        for (const name of names) {
          if (typeof name !== 'string') fail();
          fields.push(stringify(name) + ':' + encode(data(input, name), depth + 1));
        }
        result = '{' + fields.join(',') + '}';
      }
      seen.delete(input);
      if (result.length > maxChars) {
        if (failureCode === 'NON_JSON_VALUE') throw new Error('PROGRAM_PROJECTION_TOO_LARGE: value exceeds its size limit');
        fail();
      }
      return result;
    };
    return encode(value, 0);
  };
})();
`

// VM dump uses JSON conversion for objects. Validate in the guest before dump
// can remove undefined fields or turn NaN into null.
export function encodeGuestProjection(vm, value, maxBytes) {
  const serializer = vm.evalCode(`value => __encodeArguments(value === undefined ? null : value, ${maxBytes}, 'NON_JSON_VALUE')`)
  if (serializer.error) { serializer.error.dispose(); throw new Error('NON_JSON_VALUE: serializer unavailable') }
  try {
    const encoded = vm.callFunction(serializer.value, vm.undefined, value)
    if (encoded.error) {
      const error = vm.dump(encoded.error)
      encoded.error.dispose()
      throw new Error(String(error?.message ?? 'NON_JSON_VALUE'))
    }
    try { return vm.getString(encoded.value) } finally { encoded.value.dispose() }
  } finally { serializer.value.dispose() }
}

export function projectionFailureCode(error) {
  const message = error instanceof Error ? error.message : ''
  return message.startsWith('NON_JSON_VALUE') ? 'NON_JSON_VALUE'
    : message.startsWith('PROGRAM_PROJECTION_TOO_LARGE') ? 'PROGRAM_PROJECTION_TOO_LARGE' : 'PROGRAM_FAILED'
}
