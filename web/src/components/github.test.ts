import { expect, it } from "vite-plus/test";
import { guessIngress, ingressHook } from "./github";

it("guesses the ingress Worker only beside a workers.dev dolly", () => {
  expect(guessIngress("dolly.example.workers.dev")).toBe(
    "https://dolly-ingress.example.workers.dev",
  );
  expect(guessIngress("dolly.example.com")).toBe("");
  expect(guessIngress("other.example.workers.dev")).toBe("");
  expect(guessIngress("localhost")).toBe("");
  expect(ingressHook(guessIngress("dolly.example.workers.dev"))).toBe(
    "https://dolly-ingress.example.workers.dev/hooks/github",
  );
});
