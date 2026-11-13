import type { InlineApplicationPolicy } from "@alchemy.run/cloudflare/Access/Application";
import * as Schema from "effect/Schema";

const Hostname = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
);

const ResourceId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
);

export const AccessConfig = Schema.Struct({
  hostname: Hostname,
  teamDomain: Schema.String.check(
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/),
  ),
  emails: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/)),
  ).check(Schema.isMinLength(1)),
  serviceTokenId: ResourceId,
  applicationId: Schema.optional(ResourceId),
});

export function applicationPolicies(
  emails: ReadonlyArray<string>,
  serviceTokenId: string,
): InlineApplicationPolicy[] {
  return [
    {
      name: "Approved users",
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
    },
    {
      name: "Approved CLI token",
      decision: "non_identity",
      include: [{ serviceToken: { tokenId: serviceTokenId } }],
    },
  ];
}
