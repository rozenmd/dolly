/** Shared by Alchemy provisioning and the Worker's R2 binding. WEUR is a location hint. */
export const screenshotsBucket = {
  name: "dolly-screenshots",
  locationHint: "weur",
  publicAccess: false,
} as const;
