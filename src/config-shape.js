"use strict";

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function setOwn(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const key of Object.keys(value)) setOwn(out, key, cloneValue(value[key]));
  return out;
}

function pathFor(parent, key) {
  return parent ? parent + "." + key : key;
}

function normalizeObject(defaults, userConfig, path, recoveredPaths) {
  const out = cloneValue(defaults);
  if (!isPlainObject(userConfig)) return out;

  for (const key of Object.keys(userConfig)) {
    const userValue = userConfig[key];
    if (hasOwn(defaults, key) && isPlainObject(defaults[key])) {
      if (isPlainObject(userValue)) {
        setOwn(out, key, normalizeObject(defaults[key], userValue, pathFor(path, key), recoveredPaths));
      } else if (userValue !== undefined) {
        recoveredPaths.push(pathFor(path, key));
      }
    } else if (userValue !== undefined) {
      // Unknown fields and scalar defaults retain the existing permissive behavior.
      setOwn(out, key, cloneValue(userValue));
    }
  }
  return out;
}

function mergeUnknown(baseValue, patchValue) {
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) return cloneValue(patchValue);

  const out = cloneValue(baseValue);
  for (const key of Object.keys(patchValue)) {
    const value = patchValue[key];
    if (value === undefined) continue;
    if (isPlainObject(out[key]) && isPlainObject(value)) {
      setOwn(out, key, mergeUnknown(out[key], value));
    } else {
      setOwn(out, key, cloneValue(value));
    }
  }
  return out;
}

function mergePatchObject(defaults, base, patch, path, recoveredPaths) {
  const out = isPlainObject(base) ? cloneValue(base) : cloneValue(defaults);
  if (!isPlainObject(patch)) return out;

  for (const key of Object.keys(patch)) {
    const patchValue = patch[key];
    if (hasOwn(defaults, key) && isPlainObject(defaults[key])) {
      if (isPlainObject(patchValue)) {
        const current = isPlainObject(out[key]) ? out[key] : defaults[key];
        setOwn(out, key, mergePatchObject(defaults[key], current, patchValue, pathFor(path, key), recoveredPaths));
      } else if (patchValue !== undefined) {
        // An invalid object-shaped patch is ignored so the live object survives.
        recoveredPaths.push(pathFor(path, key));
      }
    } else if (patchValue !== undefined) {
      setOwn(out, key, isPlainObject(out[key]) && isPlainObject(patchValue)
        ? mergeUnknown(out[key], patchValue)
        : cloneValue(patchValue));
    }
  }
  return out;
}

/**
 * Normalize a parsed config using the object shape present in defaults.
 * The returned value owns every mutable nested value.
 */
function normalizeConfigShape(defaults, userConfig) {
  if (!isPlainObject(userConfig)) {
    return { value: cloneValue(defaults), recoveredPaths: [], topLevelInvalid: true };
  }

  const recoveredPaths = [];
  const value = normalizeObject(defaults, userConfig, "", recoveredPaths);
  return { value, recoveredPaths, topLevelInvalid: false };
}

/**
 * Apply a save patch while using defaults as the only source of object shape.
 * Invalid values for object-shaped default nodes are ignored.
 */
function mergeConfigPatch(defaults, baseConfig, patch) {
  const recoveredPaths = [];
  const value = mergePatchObject(defaults, baseConfig, patch, "", recoveredPaths);
  return { value, recoveredPaths };
}

module.exports = { isPlainObject, normalizeConfigShape, mergeConfigPatch };
