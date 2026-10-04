import type { SettingsCategory } from './settingsTypes'
import { LISTING_SETTINGS } from './listingSettings'
import { WORKER_SETTINGS } from './workerSettings'

// Mirrors src/platform/settings.ts's SETTING_DEFAULTS key list - kept in
// sync by hand, same precedent as admin/logs' WORKER_DESCRIPTIONS
// (dashboard/ and the worker scripts are separate packages with no shared
// import path). defaultValue is only a display fallback for a key that
// hasn't been migrated into the settings table yet - the real fallback
// used by the workers themselves lives in SETTING_DEFAULTS.
//
// Two categories today (Workers, Listings) - per direct instruction, more
// main-nav categories (Products, ...) land here as their own settings show
// up. Discount Policy sits under Listings, not Workers, since it's a
// cross-cutting business-rule threshold, not any one worker's cadence knob.
export const SETTINGS_CATEGORIES: SettingsCategory[] = [WORKER_SETTINGS, LISTING_SETTINGS]
