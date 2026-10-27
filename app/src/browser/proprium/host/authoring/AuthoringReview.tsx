import { useEffect, useState } from "react";
import type { BrowserAuthoringService } from "../../authoring/service.js";
import type { ProposalInspection, WriterProposalRecord } from "../../authoring/writer.js";
import { TextDiff } from "../TextDiff.js";

/** Only the active Browser Host owns review gestures and the single writer. */
export function AuthoringReview({ service, epoch, onApplied }: {
  service: BrowserAuthoringService; epoch: number; onApplied(): Promise<void>;
}) {
  const [proposals, setProposals] = useState<readonly WriterProposalRecord[]>([]);
  const [inspection, setInspection] = useState<ProposalInspection | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const refresh = () => service.listProposals().then(page => { setProposals(page.items); setNextCursor(page.next_cursor); });
  async function more() { try { const page = await service.listProposals(nextCursor ?? undefined); setProposals(items => [...items, ...page.items]); setNextCursor(page.next_cursor); } catch (e) { setError(String(e)); } }
  useEffect(() => { let active = true; void service.listProposals().then(page => { if (active) { setProposals(page.items); setNextCursor(page.next_cursor); } }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [service, epoch]);
  async function inspect(id: string) {
    setBusy(true); setError(""); setInspection(null); setContents({}); setSelected([]);
    try {
      let page = await service.inspectProposal(id); const units = [...page.units];
      while (page.next_cursor) { page = await service.inspectProposal(id, page.next_cursor); units.push(...page.units); }
      const result = { ...page, units };
      const texts: Record<string, string> = {};
      for (const unit of units) for (const op of unit.operations) for (const ref of [op.before_content_ref, op.content_ref]) {
        if (!ref) continue;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); let offset = 0; let text = "";
        while (true) { const chunk = await service.readProposalContent(id, ref, offset); text += decoder.decode(chunk.bytes, { stream: chunk.next_offset !== null }); if (chunk.next_offset === null) break; offset = chunk.next_offset; }
        texts[ref] = text;
      }
      setContents(texts); setInspection(result);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function decide(event: Event, apply: boolean) {
    if (!inspection) return;
    setBusy(true); setError("");
    try { if (apply) { await service.applyProposal(event, inspection.proposal_id, selected); await onApplied(); } else await service.rejectProposal(event, inspection.proposal_id);
      setInspection(null); await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section aria-label="Authoring proposals"><h2>変更提案</h2>{error && <p role="alert">{error}</p>}
    <ul>{proposals.map(p => <li key={p.proposal_id}><button disabled={busy} onClick={() => void inspect(p.proposal_id)}>{p.producer_plugin_id} · {p.status} · {p.proposal_id}</button></li>)}</ul>
    {nextCursor && <button disabled={busy} onClick={() => void more()}>提案をさらに表示</button>}
    {inspection && <article><h3>{inspection.title}</h3><p>{inspection.reason}</p><p>{inspection.status}</p>
      {inspection.units.map(unit => <section key={unit.id}><label><input type="checkbox" checked={selected.includes(unit.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, unit.id] : ids.filter(id => id !== unit.id))} />{unit.label}</label>
        <p>依存: {unit.depends_on.join(", ") || "なし"}</p>
        {unit.operations.map(op => <div key={op.id}><h4>{op.kind}: {op.path}</h4><TextDiff before={contents[op.before_content_ref ?? ""] ?? ""} after={contents[op.content_ref ?? ""] ?? ""} /></div>)}
      </section>)}
      {inspection.evidence.map((item, i) => <pre key={i}>{JSON.stringify(item, null, 2)}</pre>)}
      <button disabled={busy || !selected.length} onClick={e => void decide(e.nativeEvent, true)}>選択した単位をローカルへ適用</button>
      <button disabled={busy} onClick={e => void decide(e.nativeEvent, false)}>提案を却下</button>
    </article>}
  </section>;
}
