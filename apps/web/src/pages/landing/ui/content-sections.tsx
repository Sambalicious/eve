import type { CSSProperties } from "react"
import {
  Building,
  ClipboardList,
  FileExclamationPoint,
  IdCard,
  LogIn,
  MailCheck,
  MessageCircleQuestionMark,
  ShieldQuestionMark,
  Signature,
} from "lucide-react"

import { landingCopy } from "../model/copy"
import { LimitsIllustration, StepIllustration, StopsIllustration } from "./illustrations"

const i = (index: number) => ({ "--i": index }) as CSSProperties

/** Section 3: five verb-first steps in ruled columns at 1280, rows below (design-spec r1 2.3 to 2.5). */
export function StepsSection() {
  const c = landingCopy.steps
  return (
    <section aria-labelledby="steps-title" data-reveal="steps" className="landing-section">
      <div className="landing-container landing-ruled">
        <h2 id="steps-title" className="landing-h2 reveal-item" style={i(0)}>
          {c.title}
        </h2>
        <ol className="landing-steps">
          {c.items.map((step, index) => (
            <li key={step.title} className="landing-step reveal-item" style={i(index + 1)}>
              <StepIllustration index={index} />
              <span className="landing-step-number" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="landing-h3">{step.title}</h3>
                <p className="landing-small">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/** Icons from design-spec r1 3.1 (C-LAND-STOPS-1 to 9), decorative. */
const STOP_ICONS = [
  MessageCircleQuestionMark,
  LogIn,
  MailCheck,
  ShieldQuestionMark,
  ClipboardList,
  Signature,
  IdCard,
  Building,
  FileExclamationPoint,
] as const

/** Section 4: the nine Blocked reasons and the closing promise. */
export function StopsSection() {
  const c = landingCopy.stops
  return (
    <section aria-labelledby="stops-title" data-reveal="stops" data-ground="tint" className="landing-section">
      <div className="landing-container landing-ruled landing-stops-wrap">
        <div className="reveal-item landing-stops-head" style={i(0)}>
          <h2 id="stops-title" className="landing-h2">
            {c.title}
          </h2>
          <p className="landing-intro">{c.intro}</p>
        </div>
        <div className="reveal-item landing-stops-art" style={i(0)}>
          <StopsIllustration />
        </div>
        <ul className="landing-stops reveal-item" style={i(1)}>
          {c.reasons.map((reason, index) => {
            const Icon = STOP_ICONS[index]
            return (
              <li key={reason} className="landing-stop">
                <span className="landing-stop-disc" aria-hidden="true">
                  <Icon aria-hidden="true" focusable="false" />
                </span>
                <span className="landing-small">{reason}</span>
              </li>
            )
          })}
        </ul>
        <p className="landing-stops-close reveal-item" style={i(2)}>
          {c.close}
        </p>
      </div>
    </section>
  )
}

/** Section 5: five limits as a `dl`, split layout at 1280. */
export function LimitsSection() {
  const c = landingCopy.limits
  return (
    <section aria-labelledby="limits-title" data-reveal="limits" className="landing-section">
      <div className="landing-container landing-ruled landing-limits">
        <div className="reveal-item" style={i(0)}>
          <h2 id="limits-title" className="landing-h2">
            {c.title}
          </h2>
          <p className="landing-intro">{c.intro}</p>
          <div className="landing-limits-art">
            <LimitsIllustration />
          </div>
        </div>
        <dl className="landing-limits-list reveal-item" style={i(1)}>
          {c.items.map((item) => (
            <div key={item.term} className="landing-limit">
              <dt className="landing-h3">{item.term}</dt>
              <dd className="landing-small">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
