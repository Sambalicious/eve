import { describe, expect, it, vi } from "vitest"

import { businessDevelopmentForm, preFilter } from "./pre-filters.js"

const skipped = { pass: false, reason: "not_software_role" }
const passes = { pass: true }

describe("pre-filter for non-software engineer titles (pre-filter-titles.feature)", () => {
  it.each([
    "Sales Engineer", "Senior Sales Engineer, EMEA", "Sales Engineering Manager", "Pre-Sales Engineer", "Presales Engineer",
    "Support Engineer", "Technical Support Engineer", "Customer Support Engineer", "Customer Success Engineer", "Customer Engineer",
    "Solutions Engineer", "Solution Engineer", "Field Engineer", "Field Applications Engineer", "HR Business Partner, Engineering",
    "Head of HR", "HR",
  ])("PRE-01 (8S.4): %s is skipped", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it.each([
    "Software Engineer, HR Tech", "Software Engineer, Sales Platform", "Frontend Engineer, Customer Support Tools", "Salesforce Developer",
    "Forward Deployed Engineer", "Implementation Engineer", "Solutions Architect", "Senior Frontend Engineer",
  ])("PRE-01 (8S.4): %s passes", (title) => {
    expect(preFilter({ title })).toEqual(passes)
  })

  it.each([
    "Pre Sales Engineer", "Support Engineering Lead", "Solutions Engineering Manager", "Field Application Engineer", "SALES ENGINEER",
    "Sales Engineer (Remote, Lagos)", "Senior Support Engineer \u2013 APAC", "Ingénieur Sales Engineer", "Pre\u2010Sales Engineer",
    "Customer   Success   Engineer",
  ])("PRE-02 (8S.1): %s is skipped after folding", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it.each([
    ["Head of HR, Engineering", skipped],
    ["HR Engineering Partner", skipped],
    ["Engineering HR Lead", skipped],
    ["Human Resources Engineering Manager", skipped],
    ["HR Systems Developer", passes],
    ["Human Resources Software Engineer", passes],
    ["Senior Engineer (HR)", passes],
    ["HR, Web Platform", skipped],
    ["Chrome Web Architect", passes],
    ["Three.js Web Specialist", passes],
  ] as const)("PRE-03 (8S.2): %s", (title, result) => {
    expect(preFilter({ title })).toEqual(result)
  })

  it.each([
    ["Senior Product Designer", skipped],
    ["Account Executive", skipped],
    ["Technical Recruiter", skipped],
    ["Marketing Manager", skipped],
    ["Registered Nurse", skipped],
    ["Office Manager", skipped],
    ["Backend Developer", passes],
    ["DevOps Engineer", passes],
    ["Site Reliability Engineer", passes],
    ["Staff Software Architect", passes],
    [null, passes],
    ["", passes],
    ["   ", passes],
  ] as const)("PRE-04 (8S.3): %j is unchanged", (title, result) => {
    expect(preFilter({ title })).toEqual(result)
  })
})

/**
 * Slice 8d (8d.1 to 8d.4, D8d-1 to D8d-3): software-word additions and the
 * business-development skip list, at pre-filter level. Rows are copied from
 * pre-filter-titles.feature PRE-12 to PRE-16.
 */
describe("slice 8d pre-filter pass-through (pre-filter-titles.feature PRE-12 to PRE-16)", () => {
  const PRE_12: ReadonlyArray<readonly [string, typeof passes | typeof skipped]> = [
    ["Head of Infrastructure", passes],
    ["Site Reliability Specialist", passes],
    ["Infrastructure Specialist", passes],
    ["Cloud Infrastructure Specialist", passes],
    ["DÉVELOPPEUR MOBILE", passes],
    ["Développeuse React", passes],
    ["Développeur·euse Full Stack", passes],
    ["Ingénieure développement logiciel", passes],
    ["Desarrollador Frontend Senior", passes],
    ["Desarrolladora Backend", passes],
    ["Ingeniero de Software Senior", passes],
    ["Desenvolvedora Mobile", passes],
    ["Engenheira de Software", passes],
    ["Softwareentwickler (m/w/d)", passes],
    ["Frontend-Entwickler", passes],
    ["Anwendungsentwickler (m/w/d)", passes],
    ["Programmierer", passes],
    ["Développeur commercial", skipped],
    ["Développeuse commerciale", skipped],
    ["Développeur d'affaires", skipped],
    ["Ingénieur développement commercial", skipped],
    ["Desarrollador de Negocios", skipped],
    ["Desarrolladora de ventas", skipped],
    ["Desenvolvedor de Negócios", skipped],
    ["Développeur marketing", skipped],
    ["Head of Infrastructure Sales", skipped],
    ["Infrastructure Project Manager", skipped],
    ["IT Infrastructure Manager", skipped],
    ["Data Center Technician", skipped],
    ["Ingénieur civil", skipped],
    ["Produktentwickler", skipped],
    ["Sales Engineer", skipped],
  ]

  it.each(PRE_12)("PRE-12 (8d.4): %s", (title, result) => {
    expect(preFilter({ title })).toEqual(result)
  })

  it.each([
    "Site Reliability Lead", "HEAD OF INFRASTRUCTURE", "infrastructure specialist",
    "Développeur", "DEVELOPPEUSE", "Programmeur", "Programmeuse", "Ingénieur logiciel", "Ingénieure logiciel", "Ingénieur développement", "Ingenieure developpement",
    "Desarrollador Python", "Desarrolladora", "Programador", "Programadora", "Ingeniero de software", "Ingeniera de Software",
    "DESENVOLVEDOR FULL STACK", "Desenvolvedora", "Engenheiro de Software",
    "Entwickler", "Entwicklerin", "Softwareentwicklerin", "Webentwickler", "Webentwicklerin", "Anwendungsentwicklerin", "Programmiererin", "Softwareingenieur", "Softwareingenieurin",
  ])("PRE-13 (8d.1): %s passes", (title) => {
    expect(preFilter({ title })).toEqual(passes)
  })

  it.each([
    "Développeur commercial React", "Développeuse d\u2019affaires", "Développeuse d'affaires", "Développeur daffaires", "Développement commercial",
    "Desarrollador comercial", "Desarrolladora comercial", "Desarrollador de ventas", "Desarrolladora de Negocios",
    "Desenvolvedor comercial", "Desenvolvedora comercial", "Desenvolvedor de Vendas", "Desenvolvedora de vendas", "Desenvolvedora de Negócios",
  ])("PRE-14 (8d.2): %s is skipped", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it.each([
    "Produktentwickler", "Hardwareentwickler", "Desarrolladores", "Programadores", "Infrastructure Specialists", "Infrastructure Lead", "Reliability Specialist",
  ])("PRE-15 (8d.1 whole words): %s is skipped", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it.each([
    ["Développeur marketing", skipped],
    ["Desarrolladora de marketing", skipped],
    ["Designer / Développeur", skipped],
    ["Entwickler (m/w/d) Sales", skipped],
    ["HR Entwickler", skipped],
    ["Ingénieur Sales Engineer", skipped],
    ["Softwareentwickler Vertrieb", passes],
    ["Senior Product Designer", skipped],
    ["Backend Developer", passes],
    [null, passes],
    ["", passes],
    ["   ", passes],
  ] as const)("PRE-16 (8d.3): %j", (title, result) => {
    expect(preFilter({ title })).toEqual(result)
  })

  it("PRE-22 (8d.6): every 8d.4 title is decided with no network access and no AI call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off"))
    try {
      for (const [title, result] of PRE_12) expect(preFilter({ title })).toEqual(result)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

/** Candidate scope amendment N5 (decisions-overnight-2026-10-21.md): the space form of "d'affaires" is skipped too. */
describe("slice 8d amendment N5: business development with a space for the apostrophe", () => {
  it.each(["Développeur d affaires", "Développeuse d affaires", "DEVELOPPEUR D AFFAIRES", "Développeur  d   affaires React"])("%s is skipped", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it.each(["Développeur Data", "Développeur Dart"])("%s still passes", (title) => {
    expect(preFilter({ title })).toEqual(passes)
  })
})

/**
 * PRD addendum r1, 8d.2 (CR8D-02, SEC-8D-02): the business-development check
 * runs on its own copy of the folded title with punctuation as spaces and the
 * dotless ı as i, and accepts inclusive suffixes and singular "negocio".
 * Rows copied from pre-filter-titles.feature r2, PRE-12, PRE-13 and PRE-14.
 */
describe("slice 8d r1: business-development punctuation, inclusive forms, singular negocio", () => {
  it.each([
    "Développeur(se) Frontend", "Développeur-euse Backend", "Desarrollador/a Full Stack", "Développeur e-commerce",
  ])("PRE-12 r1: %s passes", (title) => {
    expect(preFilter({ title })).toEqual(passes)
  })

  it.each([
    "Développeur d affaires", "Développeuse d affaires", "Développeur daffaires", "Développeur d\u2019affaires", "Développeur d\u02bcaffaires",
    "Développeur d\u2018affaires", "Développeur d\u2032affaires", "Développeur d`affaires", "Développeur-commercial", "Développeur·euse d'affaires",
    "Développeur(se) commercial(e)", "Développeur(e) d'affaires", "Desarrollador de negocio", "Desenvolvedor de negócio", "Desarrollador comerc\u0131al",
    "Desarrollador(a) de negocios",
  ])("PRE-12 r1: %s is skipped", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it.each([
    "Développeur(se) Full Stack", "Développeur·euse React", "Desarrollador/a Backend", "Desenvolvedor(a) Mobile", "Développeur affaires",
    "Développeur commerce", "Desarrollador de negociación", "Desenvolvedor de negociação",
  ])("PRE-13 r1 (near misses): %s passes", (title) => {
    expect(preFilter({ title })).toEqual(passes)
  })

  it.each([
    "Développeuse-commerciale", "Développeur – commercial", "Développeur (e) commercial", "Développeuse(e) d'affaires", "Développeur·se commerciale",
    "Développeur d'affaires publiques", "Desarrolladora de negocio", "Desarrollador(a) comercial", "Desenvolvedora de negócio",
    "Desenvolvedora(a) de negócios", "Desenvolvedor/a de vendas",
  ])("PRE-14 r1: %s is skipped", (title) => {
    expect(preFilter({ title })).toEqual(skipped)
  })

  it("the normalised copy is local: the shared fold and the classifier input are unchanged", async () => {
    const { foldForKeywords } = await import("./rules/rule-result.js")
    expect(foldForKeywords("Développeur-commercial")).toBe("developpeur-commercial")
    expect(foldForKeywords("Desarrollador comerc\u0131al")).toBe("desarrollador comerc\u0131al")
  })
})

/**
 * Slice 8e (prd-slice-08e-prefilter-follow-ups.md 8e.1 to 8e.7, QA3-OBS-01,
 * SEC-8D-06): the 8e.6 title table T01 to T50, asserting the "8e" column.
 * Rows are mirrored in pre-filter-titles.feature r3 (@slice-8e blocks in
 * PRE-12, PRE-13, PRE-14, PRE-16). Non-ASCII separators are escaped.
 */
describe("slice 8e: inclusive Ingénieur titles and separator classes (8e.6 table)", () => {
  const T: ReadonlyArray<readonly [string, string, typeof passes | typeof skipped]> = [
    ["T01", "Ingénieur(e) logiciel", passes],
    ["T02", "Ingénieur\u00b7e logiciel", passes],
    ["T03", "Ingénieur-e logiciel", passes],
    ["T04", "Ingénieur(e) développement", passes],
    ["T05", "Ingénieur\u00b7e développement logiciel", passes],
    ["T06", "Ingénieur-e développement", passes],
    ["T07", "INGÉNIEUR(E) LOGICIEL SENIOR", passes],
    ["T08", "Ingénieur.e logiciel", passes],
    ["T09", "Ingénieur/e développement", passes],
    ["T10", "Ingénieur logiciel", passes],
    ["T11", "Ingénieure logiciel", passes],
    ["T12", "Ingénieure développement logiciel", passes],
    ["T13", "Ingénieur(e) civil", skipped],
    ["T14", "Ingénieur\u00b7e commercial", skipped],
    ["T15", "Ingénieur(e) développement commercial", skipped],
    ["T16", "Ingénieur-e développement commercial", skipped],
    ["T17", "Ingénieur développement commercial", skipped],
    ["T18", "Développeur+commercial", skipped],
    ["T19", "Développeur~commercial", skipped],
    ["T20", "Développeur|commercial", skipped],
    ["T21", "Développeur=commercial", skipped],
    ["T22", "Développeur\u2215euse d'affaires", skipped],
    ["T23", "Desarrollador+comercial", skipped],
    ["T24", "Desenvolvedor|de vendas", skipped],
    ["T25", "Développeur d\u02b9affaires", skipped],
    ["T26", "Développeur d\u02c8affaires", skipped],
    ["T27", "Développeur d\ua78caffaires", skipped],
    ["T28", "Développeur d\u02cbaffaires", skipped],
    ["T29", "Développeuse d\ua78baffaires", skipped],
    ["T30", "Développeur d'affaires", skipped],
    ["T31", "Développeur d\u02bcaffaires", skipped],
    ["T32", "Développeur-commercial", skipped],
    ["T33", "Développeur e-commerce", passes],
    ["T34", "Développeur E-Commerce", passes],
    ["T35", "Développeur e commerce", passes],
    ["T36", "Développeur Commercetools", passes],
    ["T37", "Développeur(se) e-commerce", passes],
    ["T38", "Desarrollador comercio electrónico", passes],
    ["T39", "Développeur e+commerce", passes],
    ["T40", "Développeur commerce", passes],
    ["T41", "Développeur Business", passes],
    ["T42", "Business Developer", passes],
    ["T43", "Développeur Cial", passes],
    ["T44", "Développeur d'affaire", passes],
    ["T45", "Desarrollador, negocios", passes],
    ["T46", "Desarrollador de nuevos negocios", passes],
    ["T47", "Business Development Manager", skipped],
    ["T48", "Développeur C++", passes],
    ["T49", "Développeur C# / .NET", passes],
    ["T50", "Développeur+React", passes],
  ]

  it.each(T)("8e.6 %s: %j", (_id, title, result) => {
    expect(preFilter({ title })).toEqual(result)
  })

  it("8e.4: the remaining apostrophe-like letters U+02BA to U+02BF and U+02C9 to U+02CA separate words", () => {
    for (const cp of [0x02ba, 0x02bb, 0x02bd, 0x02be, 0x02bf, 0x02c9, 0x02ca]) {
      expect(preFilter({ title: `Développeur d${String.fromCodePoint(cp)}affaires` })).toEqual(skipped)
    }
  })

  it("8e.4: the dotless ı still folds to i and space runs still collapse", () => {
    expect(businessDevelopmentForm("desarrollador+++comerc\u0131al")).toBe("desarrollador comercial")
    expect(businessDevelopmentForm("  a \u02b9 b  ")).toBe("a b")
  })

  it("8e.5: the shared fold and the plain software lists are unchanged", async () => {
    const { foldForKeywords } = await import("./rules/rule-result.js")
    expect(foldForKeywords("Ingénieur(e) logiciel")).toBe("ingenieur(e) logiciel")
    expect(foldForKeywords("Développeur+commercial")).toBe("developpeur+commercial")
  })

  it("8e.9: every 8e.6 title is decided with no network access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off"))
    try {
      for (const [, title, result] of T) expect(preFilter({ title })).toEqual(result)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("PRE-23 (8e.7): a 200,000-character title of separators is decided in under 1 second", () => {
    const title = `Développeur ${"+".repeat(200_000)}commercial`
    const started = performance.now()
    const result = preFilter({ title })
    const elapsed = performance.now() - started
    expect(result).toEqual(skipped)
    expect(elapsed).toBeLessThan(1000)
  })
})
