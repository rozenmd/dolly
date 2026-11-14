/** Only explicitly published PR evidence goes here; conversation images stay private. */
export const prScreenshotsBucket = {
  name: "dolly-pr-screenshots",
  locationHint: "weur",
  publicAccess: true,
} as const;

export const prScreenshotsExpiry = {
  id: "expire-pr-screenshots-after-30-days",
  enabled: true,
  prefix: "",
  deleteObjectsTransition: {
    condition: { type: "Age", maxAge: 30 * 24 * 60 * 60 },
  },
} as const;
