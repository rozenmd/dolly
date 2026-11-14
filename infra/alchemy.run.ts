import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import { localState } from "alchemy/State/LocalState";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AccessConfig, applicationPolicies } from "./config.ts";
import { screenshotsBucket, screenshotsExpiry } from "./screenshots.ts";
import { dependencyCacheBucket, dependencyCacheExpiry } from "./dependency-cache.ts";
import { prScreenshotsBucket, prScreenshotsExpiry } from "./pr-screenshots.ts";

export default Alchemy.Stack(
  "DollyAccess",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    if (stage !== "prod") return yield* Effect.die(new Error("Access must use --stage prod"));

    const config = yield* Schema.decodeUnknownEffect(AccessConfig)({
      hostname: yield* Config.String("DOLLY_ACCESS_HOSTNAME"),
      teamDomain: yield* Config.String("DOLLY_ACCESS_TEAM_DOMAIN"),
      emails: (yield* Config.String("DOLLY_ACCESS_EMAILS")).split(",").map((email) => email.trim()),
      serviceTokenId: yield* Config.String("DOLLY_ACCESS_SERVICE_TOKEN_ID"),
      applicationId: yield* Config.String("DOLLY_ACCESS_APPLICATION_ID").pipe(
        Config.withDefault(undefined),
      ),
    }).pipe(Effect.orDie);

    const screenshots = yield* Cloudflare.R2.Bucket("Screenshots", {
      ...screenshotsBucket,
      lifecycleRules: [screenshotsExpiry],
    }).pipe(retain());

    const dependencyCache = yield* Cloudflare.R2.Bucket("DependencyCache", {
      ...dependencyCacheBucket,
      lifecycleRules: [dependencyCacheExpiry],
    }).pipe(retain());

    const prScreenshots = yield* Cloudflare.R2.Bucket("PrScreenshots", {
      ...prScreenshotsBucket,
      lifecycleRules: [prScreenshotsExpiry],
    }).pipe(retain());

    const pin = yield* Cloudflare.Access.IdentityProvider("EmailPin", {
      type: "onetimepin",
    }).pipe(adopt(true), retain());

    const application = yield* Cloudflare.Access.Application("Dolly", {
      applicationId: config.applicationId,
      type: "self_hosted",
      name: "Dolly",
      domain: config.hostname,
      sessionDuration: "24h",
      allowedIdps: [pin.identityProviderId],
      httpOnlyCookieAttribute: true,
      policies: applicationPolicies(config.emails, config.serviceTokenId),
    }).pipe(adopt(config.applicationId !== undefined), retain());

    return {
      SCREENSHOTS_BUCKET: screenshots.bucketName,
      PR_SCREENSHOTS_BUCKET: prScreenshots.bucketName,
      PR_SCREENSHOTS_URL: prScreenshots.publicDomain.pipe(
        Output.map((domain) => {
          if (!domain) throw new Error("PR screenshot bucket has no public domain");

          return `https://${domain}`;
        }),
      ),
      DEPENDENCY_CACHE_BUCKET: dependencyCache.bucketName,
      ACCESS_AUD: application.aud,
      ACCESS_TEAM_DOMAIN: config.teamDomain,
      hostname: config.hostname,
    };
  }),
);
