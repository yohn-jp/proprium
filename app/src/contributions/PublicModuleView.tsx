import { useEffect, useRef, useState } from "react";
import type { ModuleId } from "@scriptorium/contracts";
import { moduleBrowserLoaders } from "../generated/browser-modules";

const MODULE_IDS = new Set<ModuleId>([
  "story",
  "diagnostics",
  "nlp",
  "semantic",
  "speaker",
  "assistant",
  "publishing",
  "mcp",
]);

export function publicModuleIdForPath(pathname: string): ModuleId | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "r" || !parts[2] || !parts[3]) return null;
  let moduleId: string;
  try {
    moduleId = decodeURIComponent(parts[1]!);
  } catch {
    return null;
  }
  return MODULE_IDS.has(moduleId as ModuleId) ? moduleId as ModuleId : null;
}

export function PublicModuleView({ moduleId }: { moduleId: ModuleId }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");

    void (async () => {
      const loader = moduleBrowserLoaders[moduleId];
      if (!loader) {
        setError("この公開ビューを表示するモジュールは、このデプロイに含まれていません。");
        setLoading(false);
        return;
      }
      try {
        const definition = await loader();
        if (cancelled) return;
        if (!definition.mountPublic) throw new Error("このモジュールには公開読書ビューがありません。");
        const element = elementRef.current;
        if (!element) throw new Error("公開ビューの表示先を準備できませんでした。");
        const request = new Request(window.location.href, {
          method: "GET",
          credentials: "omit",
          signal: controller.signal,
        });
        const cleanup = await definition.mountPublic("share", element, request);
        if (cancelled) cleanup?.();
        else dispose = cleanup;
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "公開ビューを読み込めませんでした。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      dispose?.();
    };
  }, [moduleId]);

  return (
    <main className="public-module-shell" aria-label="共有された読書ビュー">
      <header className="public-module-header">
        <span>Scriptorium</span>
        <span>公開読書ビュー</span>
      </header>
      {loading && <p className="public-module-status" role="status">公開コンテンツを読み込んでいます…</p>}
      {error && <p className="public-module-status" data-kind="error" role="alert">{error}</p>}
      <div ref={elementRef} />
    </main>
  );
}
