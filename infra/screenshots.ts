/** Shared by Alchemy provisioning and the Worker's R2 binding. WEUR is a location hint. */
export const screenshotsBucket = {
  name: "dolly-screenshots",
  locationHint: "weur",
  publicAccess: false,
} as const;

/** R2 age conditions use seconds. Applies to all uploaded image objects. */
export const screenshotsExpiry = {
  id: "expire-assets-after-30-days",
  enabled: true,
  prefix: "",
  deleteObjectsTransition: {
    condition: { type: "Age", maxAge: 30 * 24 * 60 * 60 },
  },
} as const;
