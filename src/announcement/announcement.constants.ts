export const ANNOUNCEMENT_KINDS = [
  'feature',
  'improvement',
  'fix',
  'notice',
] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export const ANNOUNCEMENT_AUDIENCES = [
  'all',
  'tier',
  'selected',
  'feature',
] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/** Derived from the dates, never stored. */
export type AnnouncementStatus = 'draft' | 'scheduled' | 'live' | 'expired';

/** How many announcements the in-app bell loads. Older ones are history. */
export const TENANT_ANNOUNCEMENT_LIMIT = 50;
