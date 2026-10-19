// The documented exception: browser.ts owns Playwright (BUY-113).
import { launchBrowser } from '../src/modules/collection/clients/browser'

export const refresh = launchBrowser
