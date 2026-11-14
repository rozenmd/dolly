/** Private, disposable dependency archives; never a workspace recovery source. */
export const dependencyCacheBucket = {
  name: "dolly-dependency-cache",
  locationHint: "weur",
  publicAccess: false,
} as const;

export const dependencyCacheExpiry = {
  id: "expire-dependency-cache-after-7-days",
  enabled: true,
  prefix: "",
  deleteObjectsTransition: {
    condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 },
  },
} as const;
