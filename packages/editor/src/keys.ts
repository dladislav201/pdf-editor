/**
 * The key of a shortcut as on a Latin keyboard: with a Ukrainian or other
 * layout, ⌘Z reports "я" as its key, but its code is still "KeyZ".
 */
export function shortcutKey(event: KeyboardEvent): string {
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
}
