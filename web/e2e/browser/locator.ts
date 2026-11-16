import type { Json } from "./cdp";
import type { Page } from "./page";
import { sleep } from "./page";

export type TextMatch = string | RegExp;

export type RoleOptions = { name?: TextMatch; exact?: boolean; level?: number };

type Step =
  | { kind: "css"; selector: string }
  | { kind: "role"; role: string; options: RoleOptions }
  | { kind: "label"; text: TextMatch; exact?: boolean }
  | { kind: "text"; text: TextMatch; exact?: boolean }
  | { kind: "hasText"; text: TextMatch }
  | { kind: "nth"; index: number };

type Matcher = { text?: string; regex?: string; flags?: string; exact?: boolean };

type Attempt<T> = { done: true; value: T } | { done: false; reason: string };

const matcher = (text: TextMatch, exact?: boolean): Matcher =>
  text instanceof RegExp ? { regex: text.source, flags: text.flags } : { text, exact };

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** Playwright's matching: substrings ignore case unless exact; regular expressions test as written. */
export function matches(value: string, match: Matcher) {
  const text = normalize(value);

  if (match.regex !== undefined) return new RegExp(match.regex, match.flags).test(text);
  const expected = normalize(match.text ?? "");

  return match.exact ? text === expected : text.toLowerCase().includes(expected.toLowerCase());
}

/** In-page counterpart of matches(). */
const pageMatches = `(value, match) => {
  const normalize = (text) => text.replace(/\\s+/g, " ").trim();
  const text = normalize(value);
  if (match.regex !== undefined) return new RegExp(match.regex, match.flags).test(text);
  const expected = normalize(match.text ?? "");
  return match.exact ? text === expected : text.toLowerCase().includes(expected.toLowerCase());
}`;

const documentOrder = `(nodes) => [...new Set(nodes)].sort((a, b) =>
  a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)`;

const IN_PAGE = {
  // A selector starting with a combinator (e.g. "> summary") is relative to the scope, as in Playwright.
  css: `function (selector, ...scopes) {
    const relative = /^\\s*[>+~]/.test(selector) ? ":scope " + selector : selector;
    return (${documentOrder})(scopes.flatMap((scope) => [...scope.querySelectorAll(relative)]));
  }`,
  // The deepest elements whose text matches, as Playwright's getByText.
  text: `function (match, ...scopes) {
    const matches = ${pageMatches};
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);
    const hit = (element) => !skip.has(element.tagName) && matches(element.textContent ?? "", match);
    return (${documentOrder})(scopes.flatMap((scope) =>
      [...scope.querySelectorAll("*")].filter((element) =>
        hit(element) && ![...element.children].some(hit))));
  }`,
  hasText: `function (match, ...elements) {
    const matches = ${pageMatches};
    return elements.filter((element) => matches(element.textContent ?? "", match));
  }`,
  labelled: `function (...nodes) {
    return nodes.map((node) => node instanceof Element && (
      node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby") ||
      Boolean(node.labels && node.labels.length)));
  }`,
  within: `function (count, ...nodes) {
    const scopes = nodes.slice(0, count);
    return nodes.slice(count).map((node) => scopes.some((scope) => scope !== node && scope.contains(node)));
  }`,
  visible: `function () {
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && this.checkVisibility({ visibilityProperty: true });
  }`,
};

export const VISIBLE = IN_PAGE.visible;

/** Chrome's accessibility role names; it reports ARIA img as "image". */
const chromeRoles = (role: string) => (role === "img" ? ["image", "img"] : [role]);

type AXNode = {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  properties?: { name: string; value: { value?: unknown } }[];
};

/**
 * A lazily evaluated query, re-resolved on every action and assertion attempt. Roles and
 * accessible names come from Chrome's own accessibility tree rather than an approximation.
 */
export class Locator {
  constructor(
    readonly page: Page,
    private readonly steps: Step[],
  ) {}

  private with(step: Step) {
    return new Locator(this.page, [...this.steps, step]);
  }

  locator(selector: string) {
    return this.with({ kind: "css", selector });
  }

  getByRole(role: string, options: RoleOptions = {}) {
    return this.with({ kind: "role", role, options });
  }

  getByLabel(text: TextMatch, options: { exact?: boolean } = {}) {
    return this.with({ kind: "label", text, exact: options.exact });
  }

  getByText(text: TextMatch, options: { exact?: boolean } = {}) {
    return this.with({ kind: "text", text, exact: options.exact });
  }

  filter({ hasText }: { hasText: TextMatch }) {
    return this.with({ kind: "hasText", text: hasText });
  }

  first() {
    return this.with({ kind: "nth", index: 0 });
  }

  last() {
    return this.with({ kind: "nth", index: -1 });
  }

  nth(index: number) {
    return this.with({ kind: "nth", index });
  }

  toString() {
    return this.steps
      .map((step) => {
        if (step.kind === "css") return `locator(${JSON.stringify(step.selector)})`;

        if (step.kind === "role")
          return `getByRole(${JSON.stringify(step.role)}, ${JSON.stringify({ ...step.options, name: step.options.name === undefined ? undefined : String(step.options.name) })})`;

        if (step.kind === "nth") return `nth(${step.index})`;

        return `${step.kind}(${String(step.text)})`;
      })
      .join(".");
  }

  /** Resolve to element object IDs in one object group, released by the caller. */
  async resolve(group: string) {
    const session = this.page.session;

    const root = await session.send("Runtime.evaluate", {
      expression: "document",
      objectGroup: group,
    });

    let nodes: string[] = [root.result.objectId];
    let atRoot = true;

    const call = async (
      declaration: string,
      args: { value?: Json; objectId?: string }[],
      returnByValue = false,
    ) => {
      const result = await session.send("Runtime.callFunctionOn", {
        functionDeclaration: declaration,
        objectId: root.result.objectId,
        arguments: args,
        objectGroup: group,
        returnByValue,
      });

      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? "Locator failed");

      return result.result;
    };

    const elements = async (array: { objectId?: string }) => {
      if (!array.objectId) return [];

      const { result } = await session.send<{
        result: { name: string; value?: { objectId?: string } }[];
      }>("Runtime.getProperties", { objectId: array.objectId, ownProperties: true });

      return result
        .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
        .sort((a, b) => Number(a.name) - Number(b.name))
        .map((property) => property.value!.objectId!);
    };

    const ids = (values: string[]) => values.map((objectId) => ({ objectId }));

    for (const step of this.steps) {
      if (!nodes.length) return [];

      if (step.kind === "css")
        nodes = await elements(await call(IN_PAGE.css, [{ value: step.selector }, ...ids(nodes)]));
      else if (step.kind === "text")
        nodes = await elements(
          await call(IN_PAGE.text, [{ value: matcher(step.text, step.exact) }, ...ids(nodes)]),
        );
      else if (step.kind === "hasText")
        nodes = await elements(
          await call(IN_PAGE.hasText, [{ value: matcher(step.text) }, ...ids(nodes)]),
        );
      else if (step.kind === "nth") {
        const node = nodes.at(step.index);
        nodes = node ? [node] : [];
      } else {
        const { nodes: tree } = await session.send<{ nodes: AXNode[] }>(
          "Accessibility.getFullAXTree",
        );

        const roles = step.kind === "role" ? chromeRoles(step.role) : undefined;

        const name =
          step.kind === "role"
            ? step.options.name === undefined
              ? undefined
              : matcher(step.options.name, step.options.exact)
            : matcher(step.text, step.exact);

        const level = step.kind === "role" ? step.options.level : undefined;

        const candidates = tree.filter(
          (node) =>
            !node.ignored &&
            node.backendDOMNodeId !== undefined &&
            (!roles || roles.includes(String(node.role?.value ?? ""))) &&
            (!name || matches(String(node.name?.value ?? ""), name)) &&
            (level === undefined ||
              node.properties?.find((property) => property.name === "level")?.value.value ===
                level),
        );

        let kept: string[] = [];

        for (const backendNodeId of new Set(candidates.map((node) => node.backendDOMNodeId!))) {
          const { object } = await session
            .send("DOM.resolveNode", { backendNodeId, objectGroup: group })
            .catch(() => ({ object: {} }));

          if (object.objectId) kept.push(object.objectId);
        }

        if (step.kind === "label" && kept.length) {
          const flags: boolean[] = (await call(IN_PAGE.labelled, ids(kept), true)).value;
          kept = kept.filter((_, index) => flags[index]);
        }

        if (!atRoot && kept.length) {
          const flags: boolean[] = (
            await call(IN_PAGE.within, [{ value: nodes.length }, ...ids(nodes), ...ids(kept)], true)
          ).value;

          kept = kept.filter((_, index) => flags[index]);
        }

        nodes = kept;
      }

      atRoot = false;
    }

    return atRoot ? [] : nodes;
  }

  /** Retry attempt() against freshly resolved elements until it succeeds or the timeout passes. */
  async poll<T>(
    attempt: (elements: string[]) => Promise<Attempt<T>>,
    timeout: number,
    description: string,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    let reason = "not attempted";
    let counter = 0;

    while (true) {
      const group = `locator-${counter++}`;

      try {
        const result = await attempt(await this.resolve(group));

        if (result.done) return result.value;
        reason = result.reason;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);

        if (reason.startsWith("strict mode violation")) throw error;
      } finally {
        await this.page.session
          .send("Runtime.releaseObjectGroup", { objectGroup: group })
          .catch(() => {});
      }

      if (Date.now() > deadline)
        throw new Error(`${description} timed out after ${timeout}ms: ${this}\n${reason}`);
      await sleep(100);
    }
  }

  /** Act on exactly one element, auto-waiting for it to exist. */
  private single<T>(
    description: string,
    act: (objectId: string) => Promise<Attempt<T>>,
    timeout = 10_000,
  ) {
    return this.poll<T>(
      async (elements) => {
        if (elements.length > 1)
          throw new Error(`strict mode violation: ${this} resolved to ${elements.length} elements`);

        if (!elements.length) return { done: false, reason: "no matching element" };

        return act(elements[0]);
      },
      timeout,
      description,
    );
  }

  /** @internal */
  async callOn<T>(objectId: string, declaration: string, args: Json[] = []): Promise<T> {
    const result = await this.page.session.send("Runtime.callFunctionOn", {
      functionDeclaration: declaration,
      objectId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );

    // returnByValue: the in-page function's JSON result, typed by its caller.
    const value: T = result.result.value;

    return value;
  }

  /** Wait until the element is visible, stable, enabled and (optionally) the hit target, then return its centre. */
  private async actionPoint(
    objectId: string,
    requireHit: boolean,
  ): Promise<Attempt<{ x: number; y: number }>> {
    const state = await this.callOn<{
      visible: boolean;
      stable?: boolean;
      enabled?: boolean;
      hit?: boolean;
      x?: number;
      y?: number;
    }>(
      objectId,
      `async function (requireHit) {
        if (!(${IN_PAGE.visible}).call(this)) return { visible: false };
        this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const before = JSON.stringify(this.getBoundingClientRect());
        await frame();
        await frame();
        const rect = this.getBoundingClientRect();
        if (JSON.stringify(rect) !== before) return { visible: true, stable: false };
        const enabled = this.disabled !== true && this.closest("[aria-disabled=true], fieldset:disabled") === null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y);
        const hit = !requireHit || (target !== null && (target === this || this.contains(target)));
        return { visible: true, stable: true, enabled, hit, x, y };
      }`,
      [requireHit],
    );

    if (!state.visible) return { done: false, reason: "element is not visible" };

    if (!state.stable) return { done: false, reason: "element is not stable" };

    if (!state.enabled) return { done: false, reason: "element is disabled" };

    if (!state.hit) return { done: false, reason: "another element would receive the click" };

    return { done: true, value: { x: state.x!, y: state.y! } };
  }

  async click() {
    const { x, y } = await this.single("click", (id) => this.actionPoint(id, true));
    const session = this.page.session;

    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

    for (const type of ["mousePressed", "mouseReleased"])
      await session.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
  }

  async hover() {
    const { x, y } = await this.single("hover", (id) => this.actionPoint(id, true));

    await this.page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async focus() {
    await this.single("focus", async (id) => {
      await this.callOn(id, "function () { this.focus(); }");

      return { done: true, value: undefined };
    });
  }

  /** Replace the field's value with real input events, as typing would. */
  async fill(value: string) {
    await this.single("fill", async (id) => {
      const point = await this.actionPoint(id, false);

      if (!point.done) return point;

      const editable = await this.callOn<boolean>(
        id,
        `function () {
          const field = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement;
          if ((!field && !this.isContentEditable) || this.readOnly) return false;
          this.focus();
          if (field) this.select();
          else {
            const range = document.createRange();
            range.selectNodeContents(this);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }
          return true;
        }`,
      );

      if (!editable) return { done: false, reason: "element is not editable" };

      if (value) await this.page.session.send("Input.insertText", { text: value });
      else await this.callOn(id, `function () { document.execCommand("delete"); }`);

      return { done: true, value: undefined };
    });
  }

  async press(key: string) {
    await this.focus();
    await this.page.keyboard.press(key);
  }

  /** Build the files in the page, so a remote browser needs no access to local paths. */
  async setInputFiles(
    files:
      | { name: string; mimeType: string; buffer: Buffer }
      | { name: string; mimeType: string; buffer: Buffer }[],
  ) {
    const list = (Array.isArray(files) ? files : [files]).map((file) => ({
      name: file.name,
      type: file.mimeType,
      data: file.buffer.toString("base64"),
    }));

    await this.single("setInputFiles", async (id) => {
      await this.callOn(
        id,
        `function (files) {
          const transfer = new DataTransfer();
          for (const file of files)
            transfer.items.add(new File([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
          this.files = transfer.files;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }`,
        [list],
      );

      return { done: true, value: undefined };
    });
  }

  async dispatchEvent(type: string) {
    await this.single("dispatchEvent", async (id) => {
      await this.callOn(
        id,
        `function (type) { this.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); }`,
        [type],
      );

      return { done: true, value: undefined };
    });
  }

  async evaluate<R, A extends Json = null>(
    fn: (element: HTMLElement, arg: A) => R,
    arg?: A,
  ): Promise<Awaited<R>> {
    return this.single("evaluate", async (id) => ({
      done: true,
      value: await this.callOn<Awaited<R>>(
        id,
        `function (arg) { return (${fn.toString()})(this, arg); }`,
        [arg ?? null],
      ),
    }));
  }

  async textContent() {
    return this.single("textContent", async (id) => ({
      done: true,
      value: await this.callOn<string | null>(id, "function () { return this.textContent; }"),
    }));
  }

  async inputValue() {
    return this.single("inputValue", async (id) => ({
      done: true,
      value: await this.callOn<string>(id, "function () { return this.value; }"),
    }));
  }

  async count() {
    return this.poll(async (elements) => ({ done: true, value: elements.length }), 0, "count");
  }
}
