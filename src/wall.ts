export type PageState = 'normal' | 'soft-wall' | 'hard-block'

const HARD_BLOCK_MARKERS = [
  /checkpoint_challenge/i,
  /recaptcha/i,
  /hcaptcha/i,
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
