export type PageState = 'normal' | 'soft-wall' | 'hard-block'

// Bare /recaptcha/i and /hcaptcha/i used to false-positive on FB's own static
// JS bundle, which references component names like "RecaptchaDialog.react" on
// ordinary pages unrelated to an actual challenge being shown. Require
// evidence of the real widget/script instead (the CSS class Google/hCaptcha
// mandate for rendering, or the script that loads the challenge).
const HARD_BLOCK_MARKERS = [
  /checkpoint_challenge/i,
  /recaptcha\/(api|enterprise)\.js/i,
  /g-recaptcha/i,
  /hcaptcha\.com\/1\/api\.js/i,
  /h-captcha/i,
  /verify you\W?re (a )?(human|person)/i,
  /enter the characters you see/i,
  /complete this captcha/i,
]
const LOGIN_WALL_MARKERS = [
  /login_form/i,
  /log in to continue/i,
  /you must log in/i,
  /log in to facebook/i,
]

export function detectPageState(html: string): PageState {
  if (HARD_BLOCK_MARKERS.some((re) => re.test(html))) {
    return 'hard-block'
  }
  if (LOGIN_WALL_MARKERS.some((re) => re.test(html))) {
    return 'soft-wall'
  }
  return 'normal'
}
