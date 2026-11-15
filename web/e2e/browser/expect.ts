import { expect as vitestExpect } from "vite-plus/test";
import { Locator, VISIBLE } from "./locator";
import { Page, sleep } from "./page";

/** Playwright's default assertion timeout. */
const TIMEOUT = 5_000;

type Options = { timeout?: number };

type Check = (locator: Locator, elements: string[]) => Promise<{ pass: boolean; actual: string }>;

/** Evaluate on the single matching element; zero elements yields undefined, several are a strict-mode violation. */
const one = async <T>(
  locator: Locator,
  elements: string[],
  declaration: string,
  args: unknown[] = [],
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

  private async check(name: string, expected: unknown, check: Check, options: Options = {}) {
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
    expected: unknown,
    declaration: string,
    pass: (value: any) => boolean,
    options?: Options,
    args: unknown[] = [],
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

type Poller = {
  [K in "toBe" | "toEqual" | "toBeTruthy" | "toContain"]: (...args: unknown[]) => Promise<void>;
} & { not: Poller };

/** expect.poll: retry a plain Vitest matcher against fn() until it passes or times out. */
function poller(fn: () => unknown, options: Options, negated: boolean): Poller {
  const run =
    (name: string) =>
    async (...args: unknown[]) => {
      const deadline = Date.now() + (options.timeout ?? TIMEOUT);

      while (true) {
        const value = await fn();

        try {
          const assertion = vitestExpect(value) as unknown as Record<string, any>;
          (negated ? assertion.not : assertion)[name](...args);

          return;
        } catch (error) {
          if (Date.now() > deadline) throw error;
        }

        await sleep(100);
      }
    };

  return new Proxy({} as Poller, {
    get: (_, property: string) =>
      property === "not" ? poller(fn, options, !negated) : run(property),
  });
}

type Expect = {
  (target: Locator): LocatorAssertions;
  (target: Page): PageAssertions;
  <T>(target: T): ReturnType<typeof vitestExpect<T>>;
  poll(fn: () => unknown, options?: Options): Poller;
};

export const expect = Object.assign(
  (target: unknown) => {
    if (target instanceof Locator) return new LocatorAssertions(target);

    if (target instanceof Page) return new PageAssertions(target);

    return vitestExpect(target);
  },
  { poll: (fn: () => unknown, options: Options = {}) => poller(fn, options, false) },
) as Expect;
