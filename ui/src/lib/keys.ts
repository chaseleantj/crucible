// The page's own shortcuts, and when a key press is theirs to take.

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "number", "password", "tel"]);

/**
 * Whether a key press is for the page's shortcuts: not one with a modifier,
 * not one typed into a field or a select, and not while a dialog (the
 * viewer, a delete confirmation, the shortcuts sheet) or an open menu owns
 * the keyboard.
 */
export function forPage(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  return !document.querySelector("dialog[open], :popover-open");
}

/** Every shortcut, as the sheet lists them: the keys, then what they do. */
export const SHORTCUTS: { title: string; keys: { keys: string[]; action: string }[] }[] = [
  {
    title: "Results",
    keys: [
      { keys: ["j", "k"], action: "Move down or up the list" },
      { keys: ["Enter"], action: "Open the selected result" },
      { keys: ["/"], action: "Search" },
      { keys: ["x"], action: "Select or unselect the focused result" },
      { keys: ["Esc"], action: "Clear the selection" },
    ],
  },
  {
    title: "A result",
    keys: [
      { keys: ["←", "→"], action: "Previous or next page or slide, in every arm" },
      { keys: ["j", "k"], action: "Next or previous run of a series" },
      { keys: ["Esc"], action: "Back to the results" },
    ],
  },
  {
    title: "Anywhere",
    keys: [
      { keys: ["?"], action: "Show or hide these shortcuts" },
      { keys: ["Esc"], action: "Close this sheet, or the live viewer unless its page uses Esc" },
    ],
  },
];
