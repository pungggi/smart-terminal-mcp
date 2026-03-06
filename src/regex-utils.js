const MAX_REGEX_LENGTH = 500;
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*?{]/;

/**
 * Compile a user-supplied regex with basic safety checks.
 * @param {string} pattern
 * @param {string} [fieldName='pattern']
 * @returns {RegExp}
 */
export function compileUserRegex(pattern, fieldName = 'pattern') {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new Error(`${fieldName} is too long.`);
  }

  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    throw new Error(`Unsafe regex pattern in ${fieldName}.`);
  }

  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid regex pattern in ${fieldName}: ${error.message}`);
  }
}