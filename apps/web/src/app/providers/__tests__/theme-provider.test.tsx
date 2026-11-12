import { act, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { useTheme } from "@/shared/lib/use-theme"
import { ThemeProvider } from "../theme-provider"

function Probe() {
  const { theme, setTheme } = useTheme()
  return (
    <button type="button" onClick={() => setTheme("light")}>
      {theme}
    </button>
  )
}

function renderProvider() {
  return render(
    <ThemeProvider
      storageKey="eve-theme"
      legacyStorageKey="job-assistant-theme"
    >
      <Probe />
    </ThemeProvider>
  )
}

describe("ThemeProvider storage after the Eve rename", () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.className = ""
  })

  it("keeps a theme chosen under the old key, moves it to the new key and removes the old one", () => {
    localStorage.setItem("job-assistant-theme", "dark")

    const { getByRole } = renderProvider()

    expect(getByRole("button")).toHaveTextContent("dark")
    expect(document.documentElement).toHaveClass("dark")
    expect(localStorage.getItem("eve-theme")).toBe("dark")
    expect(localStorage.getItem("job-assistant-theme")).toBeNull()
  })

  it("prefers the new key when both exist", () => {
    localStorage.setItem("eve-theme", "light")
    localStorage.setItem("job-assistant-theme", "dark")

    const { getByRole } = renderProvider()

    expect(getByRole("button")).toHaveTextContent("light")
  })

  it("ignores a stored value that isn't a theme and falls back to system", () => {
    localStorage.setItem("eve-theme", "<script>")
    localStorage.setItem("job-assistant-theme", "purple")

    const { getByRole } = renderProvider()

    expect(getByRole("button")).toHaveTextContent("system")
    expect(document.documentElement).toHaveClass("light")
  })

  it("saves a new choice under the new key", () => {
    const { getByRole } = renderProvider()

    act(() => getByRole("button").click())

    expect(localStorage.getItem("eve-theme")).toBe("light")
  })
})
