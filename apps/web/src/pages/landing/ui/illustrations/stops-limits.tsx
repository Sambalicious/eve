import { Illustration } from "./illustration"

const ns = { vectorEffect: "non-scaling-stroke" } as const

/** I-STOPS: the run so far, a stop octagon with pause bars, a question card and an envelope. */
export function StopsIllustration() {
  return (
    <Illustration name="stops" width={320} height={228}>
      <ellipse cx="200" cy="120" rx="124" ry="92" className="f blob" />
      <path d="M16 150h160" className="f2 track" strokeWidth={4} />
      <path d="M254 150h50" className="f2 track" strokeWidth={4} strokeDasharray="6 6" />
      <path d="M48 150h128" className="s" {...ns} />
      {[48, 112, 176].map((x) => (
        <circle key={x} cx={x} cy="150" r="6" className="sf" />
      ))}
      <path d="M232 128l15.6 6.4 6.4 15.6-6.4 15.6-15.6 6.4-15.6-6.4-6.4-15.6 6.4-15.6z" className="p s" {...ns} />
      <rect x="225" y="143" width="4" height="14" rx="1" className="sf" />
      <rect x="235" y="143" width="4" height="14" rx="1" className="sf" />
      <path d="M180 34h116a8 8 0 0 1 8 8v48a8 8 0 0 1-8 8h-56l-8 12-8-12h-44a8 8 0 0 1-8-8V42a8 8 0 0 1 8-8z" className="p s" {...ns} />
      <circle cx="196" cy="60" r="10" className="s" {...ns} />
      <path d="M193 57.5a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.7M196 65h.01" className="s" {...ns} />
      <rect x="214" y="54" width="72" height="6" rx="3" className="f2" />
      <rect x="214" y="68" width="52" height="6" rx="3" className="f2" />
      <rect x="276" y="22" width="20" height="14" rx="2" className="p sa" {...ns} />
      <path d="M276 24l10 7 10-7" className="sa" {...ns} />
    </Illustration>
  )
}

/** I-LIMITS: a control panel with a five-segment cap, a pause switch, a gauge and a shield. */
export function LimitsIllustration() {
  return (
    <Illustration name="limits" width={320} height={240}>
      <rect x="48" y="44" width="248" height="176" rx="24" className="f" />
      <rect x="36" y="32" width="248" height="176" rx="12" className="p s" {...ns} />
      <rect x="56" y="61" width="64" height="6" rx="3" className="f2" />
      {[0, 1, 2, 3, 4].map((n) => (
        <rect key={n} x={140 + n * 22} y="59" width="16" height="10" rx="3" className={n < 3 ? "sf" : "f2"} />
      ))}
      <rect x="56" y="109" width="64" height="6" rx="3" className="f2" />
      <rect x="196" y="101" width="40" height="22" rx="11" className="sf" />
      <circle cx="225" cy="112" r="8" className="pf" />
      <rect x="56" y="157" width="64" height="6" rx="3" className="f2" />
      <path d="M190 172a22 22 0 0 1 44 0" className="f2 track" strokeWidth={4} />
      <path d="M190 172a22 22 0 0 1 30.6-20.3" className="s" strokeWidth={4} />
      <path d="M212 172l9-13" className="s" {...ns} />
      <path d="M234 172h-5" className="sa" {...ns} />
      <circle cx="252" cy="36" r="24" className="f" />
      <path d="M252 20c5 3.5 9 4 14 4v11c0 9-6 14-14 17-8-3-14-8-14-17V24c5 0 9-.5 14-4z" className="p s" {...ns} />
      <path d="M246 36l4 4 8-8" className="s" {...ns} />
    </Illustration>
  )
}
