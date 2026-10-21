type Tone = "safe" | "watch" | "danger" | "offline";
const palette: Record<Tone, { ring: string; dot: string; title: string }> = {
  safe: { ring: "border-emerald-200 bg-emerald-50", dot: "bg-emerald-500", title: "All good" },
  watch: { ring: "border-amber-200 bg-amber-50", dot: "bg-amber-500", title: "Please check" },
  danger: { ring: "border-rose-200 bg-rose-50", dot: "bg-rose-600", title: "Action needed" },
  offline: { ring: "border-slate-200 bg-slate-50", dot: "bg-slate-400", title: "Waiting for camera" },
};
export default function PeopleFirstStatus({ tone, headline, explanation, action }: { tone: Tone; headline: string; explanation: string; action: string }) { const style = palette[tone]; return <section className={`rounded-2xl border p-5 shadow-sm ${style.ring}`} aria-live="polite"><div className="flex items-center gap-3"><span className={`h-3 w-3 rounded-full ${style.dot}`} /><p className="text-sm font-bold text-slate-900">{style.title}</p></div><h2 className="mt-3 text-lg font-black text-slate-900">{headline}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{explanation}</p><p className="mt-3 rounded-lg bg-white/70 p-3 text-sm font-semibold text-slate-800">What to do: {action}</p></section>; }
