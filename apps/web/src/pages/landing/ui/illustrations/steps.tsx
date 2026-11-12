import type { ReactNode } from "react"

import { Illustration } from "./illustration"

// I-STEP-1 to 5 (design-spec r3): a 96-unit disc, then the step's object.
// F = --illo-fill, F2 = --illo-fill-2, S = --illo-stroke, A = --illo-accent, P = --illo-paper.
const ns = { vectorEffect: "non-scaling-stroke" } as const

function Spot({ step, children }: { step: number; children: ReactNode }) {
  return (
    <Illustration name={`step illo-step-${step}`} width={96} height={96}>
      <circle cx="48" cy="48" r="44" className="f" />
      {children}
    </Illustration>
  )
}

/** Find postings: three posting cards and a magnifier. */
function Step1() {
  return (
    <Spot step={1}>
      <rect x="20" y="28" width="44" height="12" rx="3" className="f2" />
      <rect x="26" y="44" width="44" height="12" rx="3" className="p s" {...ns} />
      <rect x="20" y="60" width="44" height="12" rx="3" className="f2" />
      <circle cx="68" cy="40" r="10" className="a20 s" {...ns} />
      <path d="M75 47l5 5" className="s" {...ns} />
    </Spot>
  )
}

/** Check Eligibility and Match: a rules card with two ticks, a dash and a meter. */
function Step2() {
  return (
    <Spot step={2}>
      <rect x="22" y="18" width="52" height="60" rx="6" className="p s" {...ns} />
      {[34, 48, 62].map((y) => (
        <rect key={y} x="38" y={y - 2} width="22" height="4" rx="2" className="f2" />
      ))}
      <circle cx="31" cy="34" r="3" className="s" {...ns} />
      <circle cx="31" cy="48" r="3" className="s" {...ns} />
      <circle cx="31" cy="62" r="3" className="s" {...ns} />
      <path d="M29.6 34l1 1 2-2M29.6 48l1 1 2-2M29.8 62h2.4" className="s" {...ns} />
      <path d="M64 72v-4M68 72v-7" className="s" {...ns} />
      <path d="M72 72v-10" className="sa" {...ns} />
    </Spot>
  )
}

/** Write Tailored Documents: two sheets, the front one with a highlighted line. */
function Step3() {
  return (
    <Spot step={3}>
      <rect x="18" y="24" width="40" height="52" rx="4" className="f2" />
      <path d="M24 36h22M24 44h18M24 52h22" className="s o5" {...ns} />
      <rect x="38" y="20" width="40" height="52" rx="4" className="p s" {...ns} />
      <path d="M45 31h26M45 47h22M45 55h26" className="s" {...ns} />
      <path d="M45 39h20" className="sa" {...ns} />
      <path d="M30 60c2 10 10 12 15-21" className="s" {...ns} />
    </Spot>
  )
}

/** Apply: a form card with a filled button and a dashed stamp. */
function Step4() {
  return (
    <Spot step={4}>
      <rect x="22" y="20" width="52" height="58" rx="6" className="p s" {...ns} />
      <rect x="30" y="30" width="36" height="8" rx="3" className="f2" />
      <rect x="30" y="44" width="36" height="8" rx="3" className="f2" />
      <rect x="30" y="64" width="24" height="8" rx="3" className="sf" />
      <circle cx="70" cy="66" r="14" className="p s" strokeDasharray="3 3" {...ns} />
      <path d="M64 66l4 4 8-8" className="sa" {...ns} />
    </Spot>
  )
}

/** Report by email: an open envelope with a letter rising out and a counter. */
function Step5() {
  return (
    <Spot step={5}>
      <rect x="28" y="24" width="40" height="30" rx="3" className="p s" {...ns} />
      <path d="M34 33h22M34 40h16" className="s" {...ns} />
      <rect x="57" y="38" width="5" height="5" rx="1" className="f2" />
      <path d="M20 46v28a4 4 0 0 0 4 4h48a4 4 0 0 0 4-4V46" className="f2 s" {...ns} />
      <path d="M20 46l28 18 28-18" className="s" {...ns} />
      <circle cx="74" cy="30" r="7" className="af" />
      <path d="M73 27.5l1.4-1v7" className="sp" {...ns} />
    </Spot>
  )
}

const STEPS = [Step1, Step2, Step3, Step4, Step5] as const

/** The spot illustration for step `index` (0 to 4). */
export function StepIllustration({ index }: { index: number }) {
  const Step = STEPS[index]
  return Step ? <Step /> : null
}
