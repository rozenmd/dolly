import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { AccessConfig, applicationPolicies } from "./config.ts";

const config = {
  hostname: "dolly.example.workers.dev",
  teamDomain: "example.cloudflareaccess.com",
  emails: ["owner@example.com"],
  serviceTokenId: "00000000-0000-4000-8000-000000000000",
};

const decode = Schema.decodeUnknownSync(AccessConfig);

test("accepts explicit identities and optional application adoption", () => {
  assert.deepEqual(decode(config), config);
  assert.equal(
    decode({ ...config, applicationId: config.serviceTokenId }).applicationId,
    config.serviceTokenId,
  );
});

test("rejects wildcard users, empty allowlists, URLs, paths, and missing team configuration", () => {
  for (const invalid of [
    { ...config, emails: [] },
    { ...config, emails: ["*@example.com"] },
    { ...config, emails: [""] },
    { ...config, hostname: "https://dolly.example.workers.dev" },
    { ...config, hostname: "dolly.example.workers.dev/api" },
    { ...config, hostname: "*.workers.dev" },
    { ...config, teamDomain: "" },
    { ...config, teamDomain: "example.com" },
    { ...config, serviceTokenId: "" },
    { ...config, serviceTokenId: "client-id.access" },
    { ...config, applicationId: "not-an-application-id" },
  ])
    assert.throws(() => decode(invalid));
});

test("policies allow only exact emails and Service Auth for the existing token", () => {
  assert.deepEqual(applicationPolicies(config.emails, config.serviceTokenId), [
    {
      name: "Approved users",
      decision: "allow",
      include: [{ email: { email: "owner@example.com" } }],
    },
    {
      name: "Approved CLI token",
      decision: "non_identity",
      include: [{ serviceToken: { tokenId: config.serviceTokenId } }],
    },
  ]);
});
