/** One import for the shell fallback chunk; `main.tsx` calls it at boot on app paths. */
export const loadShellFallback = () => import("./shell-fallback")
