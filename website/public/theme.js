// Runs before first paint: marks JavaScript as available and applies a saved theme choice.
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  } catch {
    // storage is unavailable (private mode): keep the system theme
  }
})();
