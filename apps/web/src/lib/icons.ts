/**
 * The names of the inline line icons available from `Icon.svelte`. Kept apart
 * from the component so the union can be imported by anything that needs to
 * reason about a choice of icon, while the drawing itself stays in one place.
 */
export type IconName =
  | 'menu'
  | 'search'
  | 'inbox'
  | 'pin'
  | 'bookmark'
  | 'users'
  | 'lock'
  | 'link'
  | 'check'
  | 'smile'
  | 'clock'
  | 'paperclip'
  | 'gif'
  | 'plus'
  | 'send'
  | 'close'
  | 'heart'
  | 'heart-filled'
  | 'crown'
  | 'sword'
  | 'shield'
  | 'chevron-down'
  | 'more'
  | 'poll'
  | 'calendar';
