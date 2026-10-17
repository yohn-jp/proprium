import { useCallback, useEffect, useRef, useState } from "react";
import type { RecentActivityDeviceType, RecentActivityInput, RecentActivityItem } from "@scriptorium/contracts";
import { api } from "../api";
import {
  loadWritingResume,
  saveReadingPage,
  saveWritingResume,
  type WritingResumePosition,
} from "./continueCandidates";

const LOCAL_DEBOUNCE_MS = 400;
const SERVER_DEBOUNCE_MS = 2_000;
const REFRESH_INTERVAL_MS = 15_000;

interface Binding {
  projectId: string;
  authorScope: string;
  repositoryKey: string;
  identityKey: string;
}

interface PendingLocal {
  binding?: Binding;
  writing?: WritingResumePosition;
  reading?: { sceneId: string; pageIndex: number };
}

interface PendingServer {
  binding: Binding;
  input: RecentActivityInput;
}

export interface RecentActivityResumeState {
  items: RecentActivityItem[];
  projectKey: string;
  localWriting: WritingResumePosition | null;
  error: string;
  deviceType: RecentActivityDeviceType;
  onWritingPosition: (sceneId: string, cursorSentenceIndex: number | null, scrollTop: number) => void;
  onReadingPage: (sceneId: string, pageIndex: number) => void;
  flush: (keepalive?: boolean) => void;
}

function deviceTypeForViewport(): RecentActivityDeviceType {
  return window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";
}

/**
 * Cross-device cursor/page sync. Local resume remains separate from the
 * IndexedDB manuscript journal and only numeric positions are sent remotely.
 */
export function useRecentActivityResume({
  binding,
  enabled,
}: {
  binding: Omit<Binding, "identityKey"> | null;
  enabled: boolean;
}): RecentActivityResumeState {
  const identityKey = binding ? JSON.stringify([binding.authorScope, binding.repositoryKey, binding.projectId]) : "";
  const currentBinding: Binding | null = binding ? { ...binding, identityKey } : null;
  const bindingRef = useRef<Binding | null>(currentBinding);
  bindingRef.current = currentBinding;
  const [deviceType, setDeviceType] = useState<RecentActivityDeviceType>(deviceTypeForViewport);
  const [items, setItems] = useState<RecentActivityItem[]>([]);
  const [projectKey, setProjectKey] = useState("");
  const [localWriting, setLocalWriting] = useState<WritingResumePosition | null>(null);
  const [error, setError] = useState("");
  const pendingLocalRef = useRef<PendingLocal>({});
  const pendingServerRef = useRef<PendingServer | null>(null);
  const localTimerRef = useRef<number | null>(null);
  const serverTimerRef = useRef<number | null>(null);
  const lastWritingRef = useRef<{ bindingKey: string; position: WritingResumePosition } | null>(null);
  const latestWriteVersionRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const localFlushRef = useRef<() => void>(() => undefined);
  const serverFlushRef = useRef<(keepalive?: boolean) => void>(() => undefined);

  localFlushRef.current = () => {
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
    localTimerRef.current = null;
    const pending = pendingLocalRef.current;
    pendingLocalRef.current = {};
    const captured = pending.binding;
    if (!captured) return;
    if (pending.writing) {
      saveWritingResume(captured.authorScope, captured.repositoryKey, pending.writing);
      lastWritingRef.current = { bindingKey: captured.identityKey, position: pending.writing };
      if (bindingRef.current?.identityKey === captured.identityKey) setLocalWriting(pending.writing);
    }
    if (pending.reading) saveReadingPage(captured.authorScope, captured.repositoryKey, pending.reading.sceneId, pending.reading.pageIndex);
  };

  serverFlushRef.current = (keepalive = false) => {
    if (serverTimerRef.current !== null) window.clearTimeout(serverTimerRef.current);
    serverTimerRef.current = null;
    const pending = pendingServerRef.current;
    pendingServerRef.current = null;
    if (!pending) return;
    if (bindingRef.current?.authorScope !== pending.binding.authorScope) return;
    const version = ++latestWriteVersionRef.current;
    void api.putRecentActivity(pending.binding.projectId, pending.input, { keepalive }).then((response) => {
      const active = bindingRef.current;
      if (version === latestWriteVersionRef.current && active?.identityKey === pending.binding.identityKey &&
          active.authorScope === pending.binding.authorScope) {
        setItems(response.items);
        setProjectKey(active.identityKey);
        setError("");
      }
    }).catch((caught: unknown) => {
      const active = bindingRef.current;
      if (active?.identityKey === pending.binding.identityKey) {
        setError(caught instanceof Error ? caught.message : "再開位置を同期できませんでした。");
      }
    });
  };

  const flush = useCallback((keepalive = false) => {
    localFlushRef.current();
    serverFlushRef.current(keepalive);
  }, []);

  useEffect(() => {
    if (!binding || !enabled) {
      setItems([]);
      setProjectKey("");
      setLocalWriting(null);
      setError("");
      return;
    }
    const captured = currentBinding;
    if (!captured) return;
    const controller = new AbortController();
    let alive = true;
    setItems([]);
    setProjectKey(captured.identityKey);
    const local = loadWritingResume(captured.authorScope, captured.repositoryKey);
    lastWritingRef.current = local ? { bindingKey: captured.identityKey, position: local } : null;
    setLocalWriting(local);

    const refresh = async () => {
      const sequence = ++refreshSequenceRef.current;
      const startedAt = latestWriteVersionRef.current;
      try {
        const response = await api.recentActivity(captured.projectId, controller.signal);
        const active = bindingRef.current;
        if (alive && !controller.signal.aborted && sequence === refreshSequenceRef.current &&
            startedAt === latestWriteVersionRef.current && active?.identityKey === captured.identityKey) {
          setItems(response.items);
          setProjectKey(captured.identityKey);
          setError("");
        }
      } catch (caught) {
        if (!alive || controller.signal.aborted) return;
        if (bindingRef.current?.identityKey === captured.identityKey) {
          setError(caught instanceof Error ? caught.message : "再開位置を読み込めませんでした。");
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
      else flush(true);
    };
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onPageHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onPageHide);
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
    };
  // identityKey captures author/project/repository; enabled controls authenticated lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, enabled, flush]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setDeviceType(media.matches ? "mobile" : "desktop");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const onWritingPosition = useCallback((sceneId: string, cursorSentenceIndex: number | null, scrollTop: number) => {
    const active = bindingRef.current;
    if (!active || !enabled || !sceneId) return;
    const position: WritingResumePosition = { sceneId, cursorSentenceIndex, scrollTop: Math.max(0, scrollTop) };
    lastWritingRef.current = { bindingKey: active.identityKey, position };
    if (pendingLocalRef.current.binding && pendingLocalRef.current.binding.identityKey !== active.identityKey) localFlushRef.current();
    pendingLocalRef.current = { ...pendingLocalRef.current, binding: active, writing: position };
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
    localTimerRef.current = window.setTimeout(() => localFlushRef.current(), LOCAL_DEBOUNCE_MS);
    const input: RecentActivityInput = { sceneId, sentenceOffset: cursorSentenceIndex, deviceType };
    pendingServerRef.current = { binding: active, input };
    if (serverTimerRef.current !== null) window.clearTimeout(serverTimerRef.current);
    serverTimerRef.current = window.setTimeout(() => serverFlushRef.current(), SERVER_DEBOUNCE_MS);
  }, [enabled, deviceType]);

  const onReadingPage = useCallback((sceneId: string, pageIndex: number) => {
    const active = bindingRef.current;
    if (!active || !enabled || !sceneId || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return;
    if (pendingLocalRef.current.binding && pendingLocalRef.current.binding.identityKey !== active.identityKey) localFlushRef.current();
    pendingLocalRef.current = { ...pendingLocalRef.current, binding: active, reading: { sceneId, pageIndex } };
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
    localTimerRef.current = window.setTimeout(() => localFlushRef.current(), LOCAL_DEBOUNCE_MS);
    const localWriting = lastWritingRef.current?.bindingKey === active.identityKey
      ? lastWritingRef.current.position
      : null;
    const serverWriting = projectKey === active.identityKey
      ? items.find((item) => item.deviceType === deviceType && item.sceneId === sceneId)?.sentenceOffset
      : null;
    const writing = localWriting?.sceneId === sceneId ? localWriting.cursorSentenceIndex : serverWriting ?? null;
    const input: RecentActivityInput = {
      sceneId,
      sentenceOffset: writing,
      pageIndex,
      deviceType,
    };
    pendingServerRef.current = { binding: active, input };
    if (serverTimerRef.current !== null) window.clearTimeout(serverTimerRef.current);
    serverTimerRef.current = window.setTimeout(() => serverFlushRef.current(), SERVER_DEBOUNCE_MS);
  }, [enabled, items, projectKey, deviceType]);

  return { items, projectKey, localWriting, error, onWritingPosition, onReadingPage, flush, deviceType };
}
