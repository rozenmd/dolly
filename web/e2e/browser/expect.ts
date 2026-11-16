import { expect as vitestExpect } from "vite-plus/test";
import type { Json } from "./cdp";
import { Locator, VISIBLE } from "./locator";
import { Page, sleep } from "./page";

/** Playwright's default assertion timeout. */
const TIMEOUT = 5_000;

type Options = { timeout?: number };

/** What an assertion compares against, for its failure message. */
type Expected = string | number | RegExp | undefined;

type Check = (locator: Locator, elements: string[]) => Promise<{ pass: boolean; actual: string }>;

/** Evaluate on the single matching element; zero elements yields undefined, several are a strict-mode violation. */
const one = async <T>(
  locator: Locator,
  elements: string[],
  declaration: string,
  args: Json[] = [],
): Promise<T | undefined> => {
  if (elements.length > 1)
    throw new Error(`strict mode violation: ${locator} resolved to ${elements.length} elements`);

  if (!elements.length) return undefined;

  return locator.callOn<T>(elements[0], declaration, args);
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Playwright's text assertions are case-sensitive, with whitespace normalized. */
const textPasses = (actual: string, expected: string | RegExp, contain: boolean) => {
  if (expected instanceof RegExp) return expected.test(normalize(actual));

  return contain
    ? normalize(actual).includes(normalize(expected))
    : normalize(actual) === normalize(expected);
};

const valuePasses = (actual: string, expected: string | RegExp) =>
  expected instanceof RegExp ? expected.test(actual) : actual === expected;

class LocatorAssertions {
  constructor(
    private readonly locator: Locator,
    private readonly negated = false,
  ) {}

  get not() {
    return new LocatorAssertions(this.locator, !this.negated);
  }

  private async check(name: string, expected: Expected, check: Check, options: Options = {}) {
    const timeout = options.timeout ?? TIMEOUT;
    const label = `expect(${this.locator}).${this.negated ? "not." : ""}${name}`;
    let actual = "";

    try {
      await this.locator.poll(
        async (elements) => {
          const result = await check(this.locator, elements);
          actual = result.actual;

          return result.pass !== this.negated
            ? { done: true as const, value: undefined }
            : { done: false as const, reason: `received ${result.actual}` };
        },
        timeout,
        label,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("strict mode violation")) throw error;
      throw new Error(
        `${label}(${expected === undefined ? "" : JSON.stringify(String(expected))}) failed after ${timeout}ms\nreceived: ${actual}`,
      );
    }
  }

  private property(
    name: string,
    expected: Expected,
    declaration: string,
    pass: (value: any) => boolean,
    options?: Options,
    args: Json[] = [],
  ) {
    return this.check(
      name,
      expected,
      async (locator, elements) => {
        const value = await one<unknown>(locator, elements, declaration, args);

        if (value === undefined) return { pass: false, actual: "no element" };

        return { pass: pass(value), actual: JSON.stringify(value) };
      },
      options,
    );
  }

  toBeVisible(options?: Options) {
    return this.property("toBeVisible", undefined, VISIBLE, (shown) => shown === true, options);
  }

  toHaveCount(count: number, options?: Options) {
    return this.check(
      "toHaveCount",
      count,
      async (_, elements) => ({ pass: elements.length === count, actual: String(elements.length) }),
      options,
    );
  }

  toContainText(expected: string | RegExp, options?: Options) {
    return this.property(
      "toContainText",
      expected,
      "function () { return this.textContent ?? ''; }",
      (text) => textPasses(text, expected, true),
      options,
    );
  }

  toHaveText(expected: string | RegExp, options?: Options) {
    return this.property(
      "toHaveText",
      expected,
      "function () { return this.textContent ?? ''; }",
      (text) => textPasses(text, expected, false),
      options,
    );
  }

  toHaveValue(expected: string | RegExp, options?: Options) {
    return this.property(
      "toHaveValue",
      expected,
      "function () { return this.value; }",
      (value) => valuePasses(value, expected),
      options,
    );
  }

  toHaveAttribute(name: string, expected: string | RegExp, options?: Options) {
    return this.property(
      "toHaveAttribute",
      expected,
      "function (name) { return this.getAttribute(name) ?? false; }",
      (value) => value !== false && valuePasses(value, expected),
      options,
      [name],
    );
  }

  toHaveCSS(property: string, expected: string | RegExp, options?: Options) {
    return this.property(
      "toHaveCSS",
      expected,
      "function (property) { return getComputedStyle(this).getPropertyValue(property); }",
      (value) => valuePasses(value, expected),
      options,
      [property],
    );
  }

  toBeFocused(options?: Options) {
    return this.property(
      "toBeFocused",
      undefined,
      "function () { return document.activeElement === this; }",
      (focused) => focused === true,
      options,
    );
  }

  toBeDisabled(options?: Options) {
    return this.property(
      "toBeDisabled",
      undefined,
      `function () {
        return this.disabled === true || this.closest("[aria-disabled=true], fieldset:disabled") !== null;
      }`,
      (disabled) => disabled === true,
      options,
    );
  }

  toBeInViewport(options?: Options) {
    return this.property(
      "toBeInViewport",
      undefined,
      `function () {
        const rect = this.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < innerWidth && rect.top < innerHeight;
      }`,
      (inside) => inside === true,
      options,
    );
  }
}

class PageAssertions {
  constructor(private readonly page: Page) {}

  async toHaveURL(expected: string | RegExp, options: Options = {}) {
    const deadline = Date.now() + (options.timeout ?? TIMEOUT);

    while (true) {
      const url = this.page.url();

      if (
        expected instanceof RegExp
          ? expected.test(url)
          : url === new URL(expected, this.page.baseURL).href
      )
        return;

      if (Date.now() > deadline)
        throw new Error(`expect(page).toHaveURL(${expected}) failed\nreceived: ${url}`);
      await sleep(100);
    }
  }
}

/** expect.poll: retry a Vitest matcher against fn() until it passes or times out. */
class Poll<T> {
  constructor(
    private readonly fn: () => T | Promise<T>,
    private readonly options: Options,
    private readonly negated = false,
  ) {}

  get not() {
    return new Poll(this.fn, this.options, !this.negated);
  }

  private async retry(assert: (value: T) => void) {
    const deadline = Date.now() + (this.options.timeout ?? TIMEOUT);

    while (true) {
      const value = await this.fn();

      try {
        assert(value);

        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }

      await sleep(100);
    }
  }

  toBe(expected: T) {
    return this.retry((value) =>
      this.negated ? vitestExpect(value).not.toBe(expected) : vitestExpect(value).toBe(expected),
    );
  }

  toEqual(expected: T) {
    return this.retry((value) =>
      this.negated
        ? vitestExpect(value).not.toEqual(expected)
        : vitestExpect(value).toEqual(expected),
    );
  }
}

function assertions(target: Locator): LocatorAssertions;
function assertions(target: Page): PageAssertions;
function assertions<T>(target: T): ReturnType<typeof vitestExpect<T>>;
function assertions<T>(target: T) {
  if (target instanceof Locator) return new LocatorAssertions(target);

  if (target instanceof Page) return new PageAssertions(target);

  return vitestExpect(target);
}

export const expect = Object.assign(assertions, {
  poll: <T>(fn: () => T | Promise<T>, options: Options = {}) => new Poll(fn, options),
});
