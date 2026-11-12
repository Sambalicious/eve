/**
 * Synthetic fixtures for the EPIC-0012 live check. Every name, employer and number is invented.
 * No real person's data. Keywords stand in for the output of discovery's extraction step (not under test).
 */
import type { StoredSection } from "../../src/db/schema.js"

export type Fixture = Readonly<{
  label: string
  note: string
  roleTitle: string
  company: string
  postingText: string
  keywords: ReadonlyArray<Readonly<{ name: string; quote: string }>>
  forwardStatements: readonly string[]
  sections: StoredSection[]
}>

let counter = 0
const fid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`
const fact = (text: string) => ({ id: fid(), text, sourceQuote: null })
const section = (kind: StoredSection["kind"], title: string, organization: string | null, period: string | null, facts: string[]): StoredSection => ({
  id: fid(), kind, title, organization, period, sourceQuote: null, facts: facts.map(fact),
})

export const FIXTURES: Fixture[] = [
  {
    label: "f1-sustainability-to-climate-finance",
    note: "Hired as Sustainability Consultant, work is mostly energy and climate finance; applying to Climate Finance Analyst.",
    roleTitle: "Climate Finance Analyst",
    company: "Meridian Capital Partners",
    postingText: [
      "Climate Finance Analyst at Meridian Capital Partners",
      "Meridian Capital Partners is an investment firm that finances renewable energy and energy efficiency projects across Europe.",
      "You will build financial models for renewable energy investments, support investment analysis for our climate funds and prepare reports for lenders and investors.",
      "Requirements: strong financial modelling in Excel, Python for data analysis, experience in climate finance or energy finance, and clear writing.",
      "Nice to have: ESG reporting, knowledge of carbon markets, Power BI dashboards.",
    ].join("\n"),
    keywords: [
      { name: "financial modelling", quote: "strong financial modelling in Excel" },
      { name: "Excel", quote: "financial modelling in Excel" },
      { name: "Python", quote: "Python for data analysis" },
      { name: "climate finance", quote: "experience in climate finance or energy finance" },
      { name: "investment analysis", quote: "support investment analysis for our climate funds" },
      { name: "renewable energy", quote: "financial models for renewable energy investments" },
      { name: "ESG reporting", quote: "ESG reporting" },
      { name: "carbon markets", quote: "knowledge of carbon markets" },
      { name: "Power BI", quote: "Power BI dashboards" },
    ],
    forwardStatements: [],
    sections: [
      section("experience", "Sustainability Consultant", "Greenfield Advisory", "2021-2024", [
        "Built financial models in Excel for 6 wind and solar projects totalling 240 MW, which clients used for investment decisions.",
        "Prepared financing reports for lenders on energy efficiency retrofits, helping 4 clients secure 3.8M in funding.",
        "Advised 12 industrial clients on cutting energy costs, with an average saving of 18%.",
        "Tracked client emissions and energy spend with Python and Power BI.",
        "Mentored two junior consultants.",
      ]),
      section("experience", "Energy Analyst", "Brightfield Utilities", "2018-2021", [
        "Forecast quarterly electricity demand for a region of 300,000 customers using SQL and Python.",
        "Cut monthly reporting time from 5 days to 2 days by automating spreadsheets.",
      ]),
      section("education", "BSc Economics", "Northvale University", "2014-2018", ["Graduated with first class honours."]),
      section("skills", "Skills", null, null, ["Excel, Python, SQL, Power BI"]),
    ],
  },
  {
    label: "f2-title-held",
    note: "Profile genuinely holds the posting title Data Analyst; headline should print.",
    roleTitle: "Data Analyst",
    company: "Castlebrook Logistics",
    postingText: [
      "Data Analyst at Castlebrook Logistics",
      "Castlebrook Logistics moves freight for retailers across the region.",
      "You will write SQL queries, build dashboards in Tableau and report on delivery performance to operations managers.",
      "Requirements: SQL, Tableau, Python, stakeholder reporting, data cleaning.",
    ].join("\n"),
    keywords: [
      { name: "SQL", quote: "write SQL queries" },
      { name: "Tableau", quote: "dashboards in Tableau" },
      { name: "Python", quote: "SQL, Tableau, Python" },
      { name: "stakeholder reporting", quote: "stakeholder reporting" },
      { name: "data cleaning", quote: "data cleaning" },
    ],
    forwardStatements: [],
    sections: [
      section("experience", "Data Analyst", "Orchard Retail Group", "2020-2024", [
        "Wrote SQL queries against a 40 million row sales table to find slow-moving stock.",
        "Built 15 Tableau dashboards used weekly by store managers.",
        "Cleaned supplier data with Python, cutting duplicate records by 35%.",
        "Reported delivery performance to 8 regional managers each month.",
      ]),
      section("experience", "Junior Analyst", "Orchard Retail Group", "2018-2020", ["Prepared weekly sales reports for the finance team."]),
      section("education", "BSc Statistics", "Eastmoor University", "2014-2018", ["Final project on demand forecasting."]),
      section("skills", "Skills", null, null, ["SQL, Tableau, Python, Excel"]),
    ],
  },
  {
    label: "f3-company-direction",
    note: "Posting states time-bound ambitions (net zero by 2035, 2030 agenda); company-direction path runs.",
    roleTitle: "Emissions Reporting Specialist",
    company: "Verdant Grid",
    postingText: [
      "Emissions Reporting Specialist at Verdant Grid",
      "Verdant Grid runs electricity networks. Our 2030 Climate Agenda sets out how we will halve operational emissions by 2030 and reach net zero by 2035 across all operations.",
      "You will collect emissions data from our sites, run the carbon accounting process and prepare our annual sustainability report.",
      "Requirements: carbon accounting, GHG Protocol, data analysis in Excel, sustainability reporting.",
    ].join("\n"),
    keywords: [
      { name: "carbon accounting", quote: "run the carbon accounting process" },
      { name: "GHG Protocol", quote: "carbon accounting, GHG Protocol" },
      { name: "Excel", quote: "data analysis in Excel" },
      { name: "sustainability reporting", quote: "sustainability reporting" },
    ],
    forwardStatements: [
      "halve operational emissions by 2030 and reach net zero by 2035 across all operations",
    ],
    sections: [
      section("experience", "Environmental Data Analyst", "Hollin Water Services", "2019-2024", [
        "Collected energy and fuel data from 22 treatment sites and calculated annual emissions in Excel.",
        "Applied the GHG Protocol to report scope 1 and scope 2 emissions for the company.",
        "Wrote the annual sustainability section of the company report, read by 1,200 customers.",
        "Cut data collection errors by 40% with a standard site template.",
      ]),
      section("education", "BSc Environmental Science", "Marlowe University", "2015-2019", ["Dissertation on river pollution monitoring."]),
      section("skills", "Skills", null, null, ["Excel, GHG Protocol, data analysis"]),
    ],
  },
  {
    label: "f4-skill-gaps-heavy-keywords",
    note: "Posting asks for CFA, Tableau, Bloomberg Terminal and repeats its keywords; candidate has none of those three.",
    roleTitle: "Investment Analyst",
    company: "Ashgrove Asset Management",
    postingText: [
      "Investment Analyst at Ashgrove Asset Management",
      "Ashgrove Asset Management manages pension portfolios. As an Investment Analyst you will do portfolio analytics every day: portfolio analytics reports, portfolio analytics reviews and portfolio analytics for the investment committee.",
      "Financial modelling is central: financial modelling of companies, financial modelling of bonds and financial modelling for risk. You will use the Bloomberg Terminal and build Tableau dashboards.",
      "Requirements: CFA charterholder or candidate, Bloomberg Terminal, Tableau, financial modelling, portfolio analytics, Excel, risk reporting.",
    ].join("\n"),
    keywords: [
      { name: "portfolio analytics", quote: "portfolio analytics every day" },
      { name: "financial modelling", quote: "Financial modelling is central" },
      { name: "Bloomberg Terminal", quote: "use the Bloomberg Terminal" },
      { name: "Tableau", quote: "build Tableau dashboards" },
      { name: "CFA", quote: "CFA charterholder or candidate" },
      { name: "Excel", quote: "portfolio analytics, Excel, risk reporting" },
      { name: "risk reporting", quote: "risk reporting" },
    ],
    forwardStatements: [],
    sections: [
      section("experience", "Financial Analyst", "Dunmore Insurance", "2019-2024", [
        "Built financial models in Excel for the pricing of 5 insurance products.",
        "Produced monthly portfolio reports for the finance director covering 2.1 billion in assets.",
        "Reduced month-end close time from 8 days to 5 days by redesigning the reporting steps.",
        "Prepared risk reports for the board each quarter.",
      ]),
      section("education", "BA Accounting and Finance", "Linfield University", "2015-2019", ["Graduated with an upper second class degree."]),
      section("skills", "Skills", null, null, ["Excel, financial modelling, SQL"]),
    ],
  },
  {
    label: "f5-health-and-safety-officer",
    note: "'and' title posting; candidate holds exactly that title at a previous employer.",
    roleTitle: "Health and Safety Officer",
    company: "Kestrel Construction",
    postingText: [
      "Health and Safety Officer at Kestrel Construction",
      "Kestrel Construction builds housing across the north. You will run site inspections, investigate incidents and train site teams on safe working.",
      "Requirements: site inspections, incident investigation, risk assessments, NEBOSH General Certificate, safety training.",
    ].join("\n"),
    keywords: [
      { name: "site inspections", quote: "run site inspections" },
      { name: "incident investigation", quote: "incident investigation" },
      { name: "risk assessments", quote: "risk assessments" },
      { name: "NEBOSH", quote: "NEBOSH General Certificate" },
      { name: "safety training", quote: "safety training" },
    ],
    forwardStatements: [],
    sections: [
      section("experience", "Health and Safety Officer", "Rowan Builders", "2020-2024", [
        "Carried out 3 site inspections a week across 6 building sites.",
        "Investigated 14 incidents and wrote the reports for the site manager.",
        "Wrote risk assessments for new work methods on every project.",
        "Trained 120 site workers on safe working at height.",
      ]),
      section("education", "NVQ Level 3 Construction Site Supervision", "Highfield College", "2017-2019", ["Completed with merit."]),
      section("skills", "Skills", null, null, ["Risk assessment, incident reporting, safety inspections"]),
    ],
  },
]
