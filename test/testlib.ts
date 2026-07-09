import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

type Matchable = Record<string, unknown>;

function matchObject(actual: unknown, expected: Matchable, path = "value"): void {
  assert.equal(typeof actual, "object", `${path} is not an object`);
  assert.notEqual(actual, null, `${path} is null`);
  const actualObj = actual as Matchable;
  for (const [key, expectedValue] of Object.entries(expected)) {
    const nextPath = `${path}.${key}`;
    assert.ok(key in actualObj, `${nextPath} is missing`);
    const actualValue = actualObj[key];
    if (
      expectedValue &&
      typeof expectedValue === "object" &&
      !Array.isArray(expectedValue) &&
      !(expectedValue instanceof RegExp)
    ) {
      matchObject(actualValue, expectedValue as Matchable, nextPath);
    } else {
      assert.deepStrictEqual(actualValue, expectedValue, nextPath);
    }
  }
}

class Expectation<T> {
  constructor(private readonly actual: T) {}

  get not() {
    return {
      toBe: (expected: unknown) => assert.notStrictEqual(this.actual, expected),
      toMatch: (pattern: RegExp) => assert.doesNotMatch(String(this.actual), pattern),
    };
  }

  toBe(expected: unknown): void {
    assert.strictEqual(this.actual, expected);
  }

  toEqual(expected: unknown): void {
    assert.deepStrictEqual(this.actual, expected);
  }

  toMatch(pattern: RegExp): void {
    assert.match(String(this.actual), pattern);
  }

  toMatchObject(expected: Matchable): void {
    matchObject(this.actual, expected);
  }

  toBeTruthy(): void {
    assert.ok(this.actual);
  }

  toBeFalsy(): void {
    assert.ok(!this.actual);
  }

  toBeDefined(): void {
    assert.notStrictEqual(this.actual, undefined);
  }

  toBeNull(): void {
    assert.strictEqual(this.actual, null);
  }

  toBeGreaterThan(expected: number): void {
    assert.equal(typeof this.actual, "number");
    assert.ok((this.actual as number) > expected);
  }

  toHaveLength(expected: number): void {
    assert.equal((this.actual as { length?: number }).length, expected);
  }

  toHaveProperty(property: string): void {
    assert.ok(this.actual && property in Object(this.actual));
  }

  toThrow(pattern?: RegExp): void {
    assert.equal(typeof this.actual, "function");
    const fn = this.actual as () => unknown;
    if (!pattern) {
      assert.throws(fn);
      return;
    }
    assert.throws(fn, (error: unknown) => pattern.test(String((error as Error).message ?? error)));
  }
}

const originalGlobals = new Map<string, { existed: boolean; value: unknown }>();

export function expect<T>(actual: T): Expectation<T> {
  return new Expectation(actual);
}

export const vi = {
  stubGlobal(name: string, value: unknown): void {
    if (!originalGlobals.has(name)) {
      originalGlobals.set(name, {
        existed: Object.prototype.hasOwnProperty.call(globalThis, name),
        value: (globalThis as Record<string, unknown>)[name],
      });
    }
    (globalThis as Record<string, unknown>)[name] = value;
  },
  unstubAllGlobals(): void {
    for (const [name, original] of originalGlobals.entries()) {
      if (original.existed) {
        (globalThis as Record<string, unknown>)[name] = original.value;
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
    originalGlobals.clear();
  },
};

export { afterEach, describe, it };
