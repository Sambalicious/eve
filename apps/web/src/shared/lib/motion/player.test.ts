import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createPlayer, type AnimateFn, type PlannedAnimation } from "./player"

type FakeAnimation = Animation & {
  calls: string[]
  element: Element
  resolve: () => void
}

function fakeAnimate() {
  const created: FakeAnimation[] = []
  const animate: AnimateFn = (element) => {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const finished = new Promise<Animation>((ok, fail) => {
      resolve = () => ok(animation)
      reject = fail
    })
    finished.catch(() => undefined)
    const calls: string[] = []
    const animation = {
      element,
      calls,
      finished,
      resolve: () => resolve(),
      pause: () => calls.push("pause"),
      play: () => calls.push("play"),
      cancel: () => {
        calls.push("cancel")
        reject(new DOMException("cancelled", "AbortError"))
      },
      finish: () => {
        calls.push("finish")
        resolve()
      },
    } as unknown as FakeAnimation
    created.push(animation)
    return animation
  }
  return { animate, created }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createPlayer", () => {
  let root: HTMLElement
  let items: HTMLElement[]

  beforeEach(() => {
    root = document.createElement("div")
    root.innerHTML = `<div class="hf-body"><span data-a="a"></span><span data-a="b"></span></div>`
    document.body.append(root)
    items = [...root.querySelectorAll<HTMLElement>("[data-a]")]
  })
  afterEach(() => root.remove())

  const plan = (): PlannedAnimation[] =>
    items.map((element) => ({ element, keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 200, fill: "backwards" } }))

  function setup() {
    const fake = fakeAnimate()
    const states: string[] = []
    const player = createPlayer({ root, plan, animate: fake.animate, onChange: (s) => states.push(s.motion) })
    return { ...fake, player, states }
  }

  it("play creates one animation per element and marks the frame playing", () => {
    const { player, created } = setup()
    player.play()
    expect(created.map((a) => a.element)).toEqual(items)
    expect(root.dataset.motion).toBe("playing")
  })

  it("rests on the end state once every animation finished", async () => {
    const { player, created } = setup()
    player.play()
    created.forEach((a) => a.resolve())
    await flush()
    expect(root.dataset.motion).toBe("end")
  })

  it("pause reasons behave as a set: playback resumes only when all are gone", () => {
    const { player, created } = setup()
    player.play()
    player.pause("hover")
    player.pause("hidden")
    expect(root.dataset.motion).toBe("paused")
    player.resume("hover")
    expect(created[0].calls).toEqual(["pause", "pause"])
    expect(root.dataset.motion).toBe("paused")
    player.resume("hidden")
    expect(created[0].calls.at(-1)).toBe("play")
    expect(root.dataset.motion).toBe("playing")
  })

  it("reports when hover is the only pause reason, for the Paused label", () => {
    const fake = fakeAnimate()
    const hoverOnly: boolean[] = []
    const player = createPlayer({ root, plan, animate: fake.animate, onChange: (s) => hoverOnly.push(s.hoverOnly) })
    player.play()
    player.pause("hover")
    player.pause("blur")
    player.resume("blur")
    expect(hoverOnly.slice(-3)).toEqual([true, false, true])
  })

  it("replay fades the body, then cancels the old run before building the new one", async () => {
    const { player, created } = setup()
    player.play()
    const firstRun = created.slice()
    player.replay()
    expect(root.dataset.motion).toBe("rewinding")
    const fade = created.at(-1)!
    expect(fade.element).toBe(root.querySelector(".hf-body"))
    fade.resolve()
    await flush()
    for (const a of firstRun) expect(a.calls).toContain("cancel")
    expect(fade.calls).toContain("cancel")
    const secondRun = created.slice(firstRun.length + 1)
    expect(secondRun.map((a) => a.element)).toEqual(items)
    expect(root.dataset.motion).toBe("playing")
  })

  it("ignores a second replay during the fade, so runs never stack", async () => {
    const { player, created } = setup()
    player.play()
    player.replay()
    player.replay()
    player.replay()
    expect(created).toHaveLength(items.length + 1)
    created.at(-1)!.resolve()
    await flush()
    expect(created).toHaveLength(items.length * 2 + 1)
  })

  it("replay clears the hover reason but keeps hidden", async () => {
    const { player, created } = setup()
    player.play()
    player.pause("hover")
    player.pause("hidden")
    player.replay()
    created.at(-1)!.resolve()
    await flush()
    expect(root.dataset.motion).toBe("paused")
    player.resume("hidden")
    expect(root.dataset.motion).toBe("playing")
  })

  it("finish jumps every animation to its end and rests", () => {
    const { player, created } = setup()
    player.play()
    player.finish()
    for (const a of created) expect(a.calls).toContain("finish")
    expect(root.dataset.motion).toBe("end")
  })

  it("callbacks from an old run do nothing after destroy", async () => {
    const { player, created } = setup()
    player.play()
    player.destroy()
    for (const a of created) expect(a.calls).toContain("cancel")
    created.forEach((a) => a.resolve())
    await flush()
    expect(root.dataset.motion).not.toBe("end")
  })
})
