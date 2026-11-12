import { describe, expect, it } from "vitest"

import { normaliseTechnologyName } from "./technology-names.js"

// AC 3.5 and the alias table in architecture.md. Expected values are the table's canonical forms.
describe("normaliseTechnologyName (AC 3.5)", () => {
  it.each([
    ["React", "react"],
    ["React.js", "react"],
    ["ReactJS", "react"],
    ["REACT", "react"],
    ["Vue.js", "vue"],
    ["VueJS", "vue"],
    ["Next.js", "nextjs"],
    ["NextJS", "nextjs"],
    ["Next", "nextjs"],
    ["Next JS", "nextjs"],
    ["Nuxt.js", "nuxt"],
    ["Node", "nodejs"],
    ["Node.js", "nodejs"],
    ["NodeJS", "nodejs"],
    ["Express.js", "express"],
    ["TS", "typescript"],
    ["TYPESCRIPT", "typescript"],
    ["JS", "javascript"],
    ["ECMAScript", "javascript"],
    ["Golang", "go"],
    ["Postgres", "postgresql"],
    ["K8s", "kubernetes"],
    ["Tailwind CSS", "tailwind"],
    ["Tailwind  CSS", "tailwind"],
    ["TailwindCSS", "tailwind"],
    ["React Native", "reactnative"],
    ["RN", "reactnative"],
    ["GQL", "graphql"],
    ["Amazon Web Services", "aws"],
    ["Google Cloud", "gcp"],
    ["Google Cloud Platform", "gcp"],
    ["Ruby on Rails", "rubyonrails"],
    ["Ruby-on-Rails", "rubyonrails"],
    ["Material_UI", "materialui"],
    ["Material UI", "materialui"],
    ["  tailwindcss  ", "tailwind"],
    ["C#", "c#"],
    ["c#", "c#"],
    ["C++", "c++"],
    ["CI/CD", "ci/cd"],
  ])("%j normalises to %j", (raw, canonical) => {
    expect(normaliseTechnologyName(raw)).toBe(canonical)
  })

  it.each([
    ["Java", "JavaScript"],
    ["React", "React Native"],
    ["React", "Preact"],
    ["Angular", "AngularJS"],
    ["C", "C#"],
    ["C", "C++"],
    ["C#", "C++"],
    ["Go", "Google Cloud"],
    ["Node.js", "Deno"],
    ["TypeScript", "JavaScript"],
  ])("%j and %j stay different", (a, b) => {
    expect(normaliseTechnologyName(a)).not.toBe(normaliseTechnologyName(b))
  })
})
