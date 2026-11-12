import type { CSSProperties, RefObject } from "react"
import { ArrowDown, CircleCheck, CircleDashed, FileCheck, Mail, Minus, RotateCcw } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { landingCopy } from "../model/copy"
import { HeroFragments } from "./illustrations"

const f = landingCopy.frame

const RULE_BADGE = {
  met: { variant: "success", Icon: CircleCheck },
  na: { variant: "outline", Icon: Minus },
  unverified: { variant: "warning", Icon: CircleDashed },
} as const

const i = (index: number) => ({ "--i": index }) as CSSProperties

interface HeroFrameProps {
  frameRef?: RefObject<HTMLDivElement | null>
  demoRef?: RefObject<HTMLDivElement | null>
  /** Replay renders `hidden` unless motion is allowed (AC 5.2). */
  replayHidden: boolean
  onReplay?: () => void
}

/**
 * The hero product frame (design-spec r1 4.1 to 4.7): one made-up Application
 * as page markup. The resting CSS is the end state; `data-a` names are the
 * timeline hooks. Hidden from assistive tech; the summary paragraph before it
 * tells the same story.
 */
export function HeroFrame({ frameRef, demoRef, replayHidden, onReplay }: HeroFrameProps) {
  return (
    <div ref={demoRef} className="hero-demo mx-auto w-full max-w-[960px]">
      <p className="sr-only" id="hero-demo-summary">
        {landingCopy.a11y.frameSummary}
      </p>
      <div className="hf-stage">
      <HeroFragments />
      <div ref={frameRef} className="hf" aria-hidden="true" inert data-motion="armed">
        <div className="hf-strip">
          <span>{f.label}</span>
          <svg className="hf-dots" width="30" height="6" viewBox="0 0 30 6" aria-hidden="true" focusable="false">
            <circle cx="3" cy="3" r="3" />
            <circle cx="15" cy="3" r="3" />
            <circle cx="27" cy="3" r="3" />
          </svg>
        </div>
        <div className="hf-body">
          <div className="hf-col">
            <div className="hf-block hf-posting" data-a="posting">
              <div className="hf-role">{f.role}</div>
              <div className="hf-company">
                {f.company} <code className="hf-req">{f.requisition}</code>
              </div>
              <div className="hf-meta">{f.meta}</div>
            </div>
            <div className="hf-block">
              <div className="hf-label" data-a="elig-label">
                {f.eligibilityTitle}
              </div>
              <ul className="hf-rules">
                {f.rules.map((rule) => {
                  const { variant, Icon } = RULE_BADGE[rule.tone]
                  return (
                    <li key={rule.key} className="hf-rule" data-a="rule" data-wide={rule.wide || undefined}>
                      <span>{rule.term}</span>
                      <Badge variant={variant} data-a="rule-badge">
                        <Icon aria-hidden="true" />
                        {rule.badge}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
            </div>
            <div className="hf-block">
              <Badge variant="success" data-a="match-badge">
                <CircleCheck aria-hidden="true" />
                {f.matchBadge}
              </Badge>
              <p className="hf-text" data-a="match-line">
                {f.matchLine}
              </p>
            </div>
          </div>
          <div className="hf-col">
            <div className="hf-block hf-resume">
              <div data-a="fact">
                <div className="hf-label">{f.factLabel}</div>
                <blockquote className="hf-quote">{f.fact}</blockquote>
              </div>
              <ArrowDown className="hf-arrow" data-a="arrow" width={16} height={16} aria-hidden="true" />
              <div className="hf-label" data-a="line-label">
                {f.lineLabel}
              </div>
              <p className="hf-quote">
                {f.lineChunks.map((chunk, index) => (
                  <span key={chunk}>
                    <span className="hf-chunk" data-a="chunk" style={i(index)}>
                      {chunk}
                    </span>
                    {index < f.lineChunks.length - 1 ? " " : null}
                  </span>
                ))}
              </p>
            </div>
            <div className="hf-block" data-a="status-row">
              <div className="hf-label">{f.statusLabel}</div>
              <div className="hf-badge-cell">
                <Badge variant="info" data-a="status-prev">
                  <FileCheck aria-hidden="true" />
                  {f.statusPrepared}
                </Badge>
                <Badge variant="success" data-a="status-next">
                  <CircleCheck aria-hidden="true" />
                  {f.statusConfirmed}
                </Badge>
              </div>
              <p className="hf-text" data-a="evidence">
                {f.evidence}
              </p>
            </div>
            <div className="hf-mail" data-a="mail">
              <div className="hf-mail-head">
                <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
                <span className="hf-mail-from">{f.mailFrom}</span>
                <span className="hf-mail-time">{f.mailTime}</span>
              </div>
              <div className="hf-mail-subject">{f.mailSubject}</div>
              <div className="hf-mail-pre">{f.mailPreheader}</div>
            </div>
          </div>
        </div>
      </div>
      </div>
      <div className="hero-demo-controls">
        <span className="hf-paused" aria-hidden="true">
          {f.paused}
        </span>
        <Button variant="ghost" size="sm" aria-label={landingCopy.a11y.replay} hidden={replayHidden} onClick={onReplay} className="hf-replay">
          <RotateCcw aria-hidden="true" />
          {f.replay}
        </Button>
      </div>
    </div>
  )
}
