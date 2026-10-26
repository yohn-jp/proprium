import { useEffect, useMemo, useState } from "react";
import {
  PublishingSecretError,
  PublishingShareReaderAdapter,
  ReaderSecretLeaseVault,
  type ReaderRouteSecret,
  type ShareReaderMetadata,
} from "../authoring/secrets.js";

type ReaderState = "loading" | "ready" | "unavailable" | "failure";

export interface ReadonlyPublishingReaderProps {
  readonly adapter: PublishingShareReaderAdapter | null;
  readonly vault?: ReaderSecretLeaseVault;
}

/** Fixed Host route for read-only Publishing links; it never opens a workspace. */
export function ReadonlyPublishingReader({ adapter, vault = defaultVault }: ReadonlyPublishingReaderProps) {
  const [route, setRoute] = useState<ReaderRouteSecret | null>(null);
  const [metadata, setMetadata] = useState<ShareReaderMetadata | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [state, setState] = useState<ReaderState>("loading");
  const [message, setMessage] = useState("共有リンクを確認しています。");
  const sceneItems = useMemo(() => metadata?.items.filter(item => item.kind === "scene") ?? [], [metadata]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let current: ReaderRouteSecret | null = null;
    // Scrub the token from the address bar before adapter configuration/network access.
    try {
      current = adapter
        ? adapter.takeRouteFromLocation(window.location, window.history)
        : vault.takeFromLocation(window.location, window.history);
      setRoute(current);
    } catch {
      setState("unavailable"); setMessage("この共有リンクは利用できません。");
      return () => controller.abort();
    }
    const page = current;
    if (!adapter) {
      setState("unavailable"); setMessage("共有サービスを利用できません。");
      return () => { alive = false; controller.abort(); vault.clear(page); };
    }
    setState("loading");
    void adapter.metadata(page, undefined, 100, controller.signal).then(result => {
      if (!alive) return;
      setMetadata(result); setSceneId(result.items.find(item => item.kind === "scene")?.id ?? null);
      setState("ready"); setMessage("");
    }).catch(error => {
      if (!alive || controller.signal.aborted) return;
      setMetadata(null); setBody(""); setState("unavailable");
      setMessage(error instanceof PublishingSecretError && error.code === "snapshot_stale"
        ? "共有作品が更新されました。リンクを開き直してください。" : "この共有リンクは利用できません。");
    });
    return () => { alive = false; controller.abort(); adapter.clear(page); };
  }, [adapter, vault]);

  useEffect(() => {
    document.title = metadata?.label ?? "共有作品";
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!robots) { robots = document.createElement("meta"); robots.name = "robots"; document.head.append(robots); }
    robots.content = "noindex, nofollow";
    let referrer = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    if (!referrer) { referrer = document.createElement("meta"); referrer.name = "referrer"; document.head.append(referrer); }
    referrer.content = "no-referrer";
  }, [metadata]);

  useEffect(() => {
    if (!route || !adapter || !metadata || !sceneId) { setBody(""); return; }
    const controller = new AbortController();
    let alive = true;
    setBody(""); setState("loading"); setMessage("章を読み込んでいます。");
    void readVerifiedScene(adapter, route, sceneId, metadata.remote_snapshot.remote_commit, controller.signal).then(text => {
      if (!alive) return;
      setBody(text); setState("ready"); setMessage("");
    }).catch(error => {
      if (!alive || controller.signal.aborted) return;
      setBody(""); setState("unavailable");
      setMessage(error instanceof PublishingSecretError && error.code === "snapshot_stale"
        ? "共有作品が更新されました。目次を更新してください。" : "この共有リンクは利用できません。");
    });
    return () => { alive = false; controller.abort(); };
  }, [route, adapter, metadata, sceneId]);

  const selected = sceneItems.find(item => item.id === sceneId);
  return <main className="publishing-readonly-reader" aria-label="共有作品">
    <header>
      <h1>{metadata?.label ?? "共有作品"}</h1>
      {metadata && <p>有効期限: <time dateTime={metadata.expires_at}>{metadata.expires_at}</time></p>}
    </header>
    {message && <p role={state === "unavailable" || state === "failure" ? "alert" : "status"}>{message}</p>}
    {metadata && <nav aria-label="章一覧"><ol>{sceneItems.map(item => <li key={item.id}>
      <button type="button" aria-current={item.id === sceneId ? "page" : undefined} disabled={state === "loading"}
        onClick={() => setSceneId(item.id)}>{item.title}</button>
    </li>)}</ol></nav>}
    {selected && <article aria-label={selected.title}>
      <h2>{selected.title}</h2>
      <pre className="publishing-readonly-reader__body" lang="ja" aria-live="polite">{body}</pre>
    </article>}
  </main>;
}

const defaultVault = new ReaderSecretLeaseVault();

async function readVerifiedScene(adapter: PublishingShareReaderAdapter, route: ReaderRouteSecret,
  sceneId: string, remoteCommit: string, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total: number | undefined;
  let revision: string | undefined;
  while (true) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const page = await adapter.readScene(route, sceneId, remoteCommit, offset, 64 * 1024, signal);
    const scene = page.scene;
    if (scene.offset !== offset || (total !== undefined && scene.total_bytes !== total) ||
        (revision !== undefined && scene.revision !== revision) || scene.bytes.byteLength === 0 && scene.total_bytes !== 0) {
      throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    }
    total = scene.total_bytes; revision = scene.revision;
    chunks.push(scene.bytes.slice()); offset += scene.bytes.byteLength;
    if (scene.next_offset === null) break;
    if (scene.next_offset !== offset) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
  }
  const bytes = new Uint8Array(offset); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  const actual = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  if (actual !== revision || offset !== total) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable."); }
}
