// Light, dark, or whatever the system says. The choice lives in localStorage
// under THEME_KEY; index.html reads it once before the first paint (so the
// page never flashes the other theme) and this module owns it afterwards.
export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "crucible-theme";
const systemLight = matchMedia("(prefers-color-scheme: light)");

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage blocked: follow the system.
  }
  return "system";
}

export const theme = $state<{ choice: ThemeChoice }>({ choice: stored() });

function apply(): void {
  const resolved = theme.choice === "system" ? (systemLight.matches ? "light" : "dark") : theme.choice;
  document.documentElement.dataset.theme = resolved;
}

export function chooseTheme(choice: ThemeChoice): void {
  theme.choice = choice;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  apply();
}

// The system can change under an open page (sunset, a manual switch), and
// another tab can change the stored choice.
systemLight.addEventListener("change", apply);
window.addEventListener("storage", (event) => {
  if (event.key !== THEME_KEY) return;
  theme.choice = stored();
  apply();
});
