import { createHash } from 'node:crypto';

const normalize = (value, path = '$') => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
      return [key, normalize(value[key], `${path}.${key}`)];
    }));
  }
  throw new TypeError(`${path} contains an unsupported value`);
};

export const canonicalJson = (value) => JSON.stringify(normalize(value));
export const canonicalHash = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
export const deepClone = (value) => JSON.parse(canonicalJson(value));
