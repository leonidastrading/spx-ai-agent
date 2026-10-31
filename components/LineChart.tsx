"use client";

import { useState } from "react";

export interface Point {
  /** label shown in the tooltip, e.g. "09:45" */
  x: string;
  y: number | null;
}

const W = 280;
const H = 120;
const PAD = { l: 34, r: 8, t: 6, b: 18 };

/** Single-series line with a zero baseline, crosshair and tooltip. Its own y-scale; no dual axes. */
export default function LineChart({ title, unit, points, digits = 2 }: { title: string; unit: string; points: Point[]; digits?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = points.map((p) => p.y).filter((y): y is number => y !== null);
  const last = vals.length ? vals[vals.length - 1] : null;
  const fmt = (v: number) => `${v.toFixed(digits)}${unit}`;

  if (vals.length < 2) {
    return (
      <div className="chart">
        <div className="chart-title"><span>{title}</span><b>{last === null ? "—" : fmt(last)}</b></div>
        <div className="muted small" style={{ height: H, display: "grid", placeItems: "center" }}>not enough data yet</div>
      </div>
    );
  }

  let lo = Math.min(...vals, 0);
  let hi = Math.max(...vals, 0);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const n = points.length;
  const xs = (i: number) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
  const ys = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  let d = "";
  points.forEach((p, i) => {
    if (p.y === null) return;
    d += `${d && points[i - 1]?.y !== null ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.y).toFixed(1)}`;
  });

  const ticks = [hi - pad, lo + pad];
  const xLabels = [0, Math.floor((n - 1) / 2), n - 1];

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((sx - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <div className="chart">
      <div className="chart-title"><span>{title}</span><b>{last === null ? "—" : fmt(last)}</b></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, latest ${last === null ? "n/a" : fmt(last)}`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={ys(t)} y2={ys(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.l - 4} y={ys(t) + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">{t.toFixed(digits)}</text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={ys(0)} y2={ys(0)} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="2 3" />
        {xLabels.map((i, k) => (
          <text key={k} x={xs(i)} y={H - 4} textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"} fontSize={9} fill="var(--text-muted)">{points[i].x}</text>
        ))}
        <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hp && hp.y !== null && (
          <g>
            <line x1={xs(hover!)} x2={xs(hover!)} y1={PAD.t} y2={H - PAD.b} stroke="var(--text-muted)" strokeWidth={1} />
            <circle cx={xs(hover!)} cy={ys(hp.y)} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
          </g>
        )}
        <rect x={PAD.l} y={0} width={W - PAD.l - PAD.r} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && hp.y !== null && (
        <div className="tip" style={{ left: `${(xs(hover!) / W) * 100}%`, top: `${(ys(hp.y) / H) * 100}%` }}>
          {hp.x} ET · <b>{fmt(hp.y)}</b>
        </div>
      )}
    </div>
  );
}
