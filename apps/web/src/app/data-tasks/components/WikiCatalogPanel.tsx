"use client";

import { attachMutualForces } from "./wiki-force";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { configApi } from "../../../lib/config-api";
import type { JobDto, WikiPageDto, WikiPageSummaryDto } from "../../../lib/config-api";
import { useLocale, useT } from "../../../i18n/locale-context";
import type { TranslateFn } from "../../../i18n/types";
import { btnGhostClass, btnPrimaryClass, btnSecondaryClass } from "../ui-tokens";
import {
  JobInlineStatus,
  assertJobFinished,
  formatRelativeTime,
  isLiveJob,
} from "./JobProgressBanner";

const PAGE_TYPES = [
  "table",
  "relation",
  "value-domain",
  "dictionary",
  "concept",
  "metric",
  "query-pattern",
  "contradiction",
] as const;

type ForceLayoutParams = {
  massAlpha: number;
  chargeScale: number;
  chargeDistanceMax: number;
  linkDistance: number;
  mutualDistance: number;
  mutualBoost: number;
  collidePad: number;
  collideStrength: number;
  centerPull: number;
  seedScale: number;
  ticks: number;
  radiusMin: number;
  radiusMax: number;
  labelMode: "auto" | "always" | "never";
};

const FORCE_CHARGE = 16;
const FORCE_REACH = 1600;

const DEFAULT_FORCE_PARAMS: ForceLayoutParams = {
  massAlpha: 0.75,
  chargeScale: FORCE_CHARGE,
  chargeDistanceMax: FORCE_REACH,
  linkDistance: 340,
  mutualDistance: 300,
  mutualBoost: 1.8,
  collidePad: 18,
  collideStrength: 0.65,
  centerPull: 0.005,
  seedScale: 175,
  ticks: 300,
  radiusMin: 10,
  radiusMax: 36,
  labelMode: "auto",
};

const GRAPH_LABEL_FONT = 10;
const GRAPH_LABEL_SLOT = 22;

type WikiDatasourceOption = {
  id: string;
  name: string;
  description?: string;
  type?: string;
  summary?: string;
};

type WikiCatalogPanelProps = {
  onBack: () => void;
  onCount?: (count: number) => void;
  datasources?: WikiDatasourceOption[];
  defaultDatasourceId?: string;
};

type WikiTreeNode = {
  id: string;
  title: string;
  kind: "group" | "page";
  type?: string;
  page?: WikiPageSummaryDto;
  children: WikiTreeNode[];
};

function jobResourceId(job?: JobDto | null): string {
  return job?.resource_id || job?.resourceId || "";
}

export function WikiCatalogPanel({ onBack, onCount, datasources = [], defaultDatasourceId }: WikiCatalogPanelProps) {
  const t = useT();
  const [pages, setPages] = useState<WikiPageSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<WikiPageDto | null>(null);
  const { locale } = useLocale();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [findings, setFindings] = useState<string[] | null>(null);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [datasourceId, setDatasourceId] = useState(defaultDatasourceId || datasources[0]?.id || "");
  const [tabs, setTabs] = useState<Array<{ id: string; kind: "page" | "graph" }>>([]);
  const [listOpen, setListOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [runningAction, setRunningAction] = useState<"lint" | "refresh" | "save" | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeMode, setTreeMode] = useState<"table" | "type">("type");
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [domainView, setDomainView] = useState<"list" | "cloud">("list");
  const [domainWeight, setDomainWeight] = useState<"share" | "count" | "recent">("share");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [forceParams, setForceParams] = useState<ForceLayoutParams>(DEFAULT_FORCE_PARAMS);
  const [scanJob, setScanJob] = useState<JobDto | null>(null);
  const scanStatusRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const lastFocusedId = useRef<string | null>(null);
  const listItemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await configApi.listWikiPages();
      setPages(result.pages);
      const bound = datasourceId
        ? result.pages.filter((item) => item.source_ids?.includes(datasourceId))
        : result.pages;
      onCount?.(bound.length);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("wiki.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [datasourceId, onCount, t]);

  useEffect(() => {
    if (defaultDatasourceId) setDatasourceId(defaultDatasourceId);
  }, [defaultDatasourceId]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setScanJob(null);
    scanStatusRef.current = null;
    if (!datasourceId) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await configApi.getWikiScanJob(datasourceId);
        if (cancelled) return;
        const job = result.job;
        const jobSource = job?.resource_id || job?.resourceId;
        if (job && jobSource && jobSource !== datasourceId) {
          setScanJob(null);
          return;
        }
        setScanJob(job);
        const previous = scanStatusRef.current;
        scanStatusRef.current = job?.status ?? null;
        const live = job?.status === "pending" || job?.status === "queued" || job?.status === "running";
        if (!live && previous && (previous === "pending" || previous === "queued" || previous === "running")) {
          await refresh();
          const currentId = selectedIdRef.current;
          if (currentId && currentId !== "wiki-graph") {
            const loaded = await configApi.getWikiPage(currentId);
            if (!cancelled) {
              setPage(loaded);
              setDrafts(Object.fromEntries((loaded.fields ?? []).map((field) => [field.key, field.text])));
            }
          }
        }
      } catch {
        if (!cancelled) setScanJob(null);
      }
    };
    void tick();
    timer = window.setInterval(() => {
      void tick();
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [datasourceId, refresh]);

  useEffect(() => {
    if (!selectedId || selectedId === "wiki-graph") {
      setPage(null);
      setDrafts({});
      return;
    }
    let cancelled = false;
    void configApi.getWikiPage(selectedId).then((loaded) => {
      if (cancelled) return;
      setPage(loaded);
      setDrafts(Object.fromEntries((loaded.fields ?? []).map((field) => [field.key, field.text])));
    }).catch((loadError) => {
      if (cancelled) return;
      setError(loadError instanceof Error ? loadError.message : t("wiki.loadFailed"));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, t]);

  const visiblePages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pages.filter((item) => {
      if (item.type === "column") return false;
      if (datasourceId && !(item.source_ids ?? []).includes(datasourceId)) return false;
      if (!PAGE_TYPES.includes(item.type as (typeof PAGE_TYPES)[number])) return false;
      if (!needle) return true;
      return `${item.title} ${item.excerpt}`.toLowerCase().includes(needle);
    });
  }, [datasourceId, pages, query]);

  const catalogPages = useMemo(() => {
    return pages.filter((item) => {
      if (item.type === "column") return false;
      if (datasourceId && !(item.source_ids ?? []).includes(datasourceId)) return false;
      return PAGE_TYPES.includes(item.type as (typeof PAGE_TYPES)[number]);
    });
  }, [datasourceId, pages]);

  const tree = useMemo(
    () => treeMode === "type"
      ? buildWikiTypeTree(catalogPages, query, t)
      : buildWikiTree(catalogPages, query, t),
    [catalogPages, query, t, treeMode],
  );

  const selectedSource = datasources.find((item) => item.id === datasourceId);
  const sourceTableCount = catalogPages.filter((item) => item.type === "table").length;
  const sourceScanJob = datasourceId && jobResourceId(scanJob) === datasourceId ? scanJob : null;
  const sourceUpdatedAt = useMemo(() => {
    if (sourceScanJob?.finished_at) return sourceScanJob.finished_at;
    const times = catalogPages.map((item) => Date.parse(item.updated_at)).filter((value) => Number.isFinite(value));
    if (times.length === 0) return null;
    return new Date(Math.max(...times)).toISOString();
  }, [catalogPages, sourceScanJob?.finished_at]);

  useEffect(() => {
    lastFocusedId.current = null;
    setExpanded(new Set());
  }, [datasourceId, treeMode]);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      if (query.trim()) {
        for (const id of collectExpandableIds(tree)) next.add(id);
      }
      if (selectedId && selectedId !== lastFocusedId.current) {
        const path = findTreePath(tree, selectedId);
        path?.forEach((id) => next.add(id));
      }
      return next;
    });
    lastFocusedId.current = selectedId;
  }, [selectedId, query, tree]);

  const revealInList = (id: string) => {
    const item = pages.find((entry) => entry.id === id && entry.type !== "column");
    if (!item) return;
    if (datasourceId && !(item.source_ids ?? []).includes(datasourceId)) setDatasourceId("");
    const needle = query.trim().toLowerCase();
    if (needle && !`${item.title} ${item.excerpt}`.toLowerCase().includes(needle)) setQuery("");
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openPage = (id: string, nextAnchor?: string | null) => {
    revealInList(id);
    setSelectedId(id);
    setAnchor(nextAnchor ?? null);
    setTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: "page" }]);
  };

  const openGraph = () => {
    setSelectedId("wiki-graph");
    setTabs((current) => current.some((tab) => tab.kind === "graph") ? current : [...current, { id: "wiki-graph", kind: "graph" }]);
  };

  const closeTab = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (selectedId === id) setSelectedId(next.at(-1)?.id ?? null);
      return next;
    });
  };

  const closeOtherTabs = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id === id));
    setSelectedId(id);
    setTabMenu(null);
  };

  const closeAllTabs = () => {
    setTabs([]);
    setSelectedId(null);
    setTabMenu(null);
  };

  const expandAll = () => {
    setExpanded(new Set(collectExpandableIds(tree)));
  };

  const collapseAll = () => {
    lastFocusedId.current = selectedId;
    setExpanded(new Set());
  };

  const focusCurrentInList = () => {
    if (!selectedId || selectedId === "wiki-graph") return;
    setListOpen(true);
    const path = findTreePath(tree, selectedId);
    if (path) {
      lastFocusedId.current = selectedId;
      setExpanded((current) => {
        const next = new Set(current);
        path.forEach((id) => next.add(id));
        return next;
      });
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        listItemRefs.current.get(selectedId)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
  };

  const openTabMenu = (event: MouseEvent<HTMLElement>, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.min(event.clientX, window.innerWidth - 168);
    const y = Math.min(event.clientY, window.innerHeight - 132);
    setTabMenu({ x, y, id });
  };

  const openTitle = (title: string) => {
    const hashAt = title.indexOf("#");
    const base = hashAt >= 0 ? title.slice(0, hashAt) : title;
    const hash = hashAt >= 0 ? title.slice(hashAt + 1) : null;
    const direct = pages.find((item) => item.type !== "column" && item.title === base);
    if (direct) {
      openPage(direct.id, hash);
      return;
    }
    const tableName = base.split(".")[0];
    const columnName = base.split(".").slice(1).join(".");
    const table = tableName && columnName
      ? pages.find((item) => item.type === "table" && item.title === tableName)
      : undefined;
    if (table) openPage(table.id, columnName);
  };

  useLayoutEffect(() => {
    if (!selectedId || !listOpen) return;
    listItemRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, visiblePages, expanded, listOpen]);

  useEffect(() => {
    if (!anchor || !page) return;
    document.getElementById(`wiki-column-${anchor}`)?.scrollIntoView({ block: "start" });
  }, [anchor, page]);

  const runTracked = async (kind: "lint" | "refresh" | "save", action: () => Promise<void>) => {
    setBusy(true);
    setRunningAction(kind);
    setError(null);
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("wiki.loadFailed");
      setActionError(message);
      if (kind !== "refresh" && kind !== "lint") setError(message);
    } finally {
      setBusy(false);
      setRunningAction(null);
    }
  };

  const runLint = async () => {
    await runTracked("lint", async () => {
      const result = await configApi.lintWiki();
      setFindings(result.findings);
      setFindingsOpen(true);
    });
  };

  const refreshMetrics = async (column?: string) => {
    if (!page) return;
    setRefreshingKey(column ?? "*");
    await runTracked("refresh", async () => {
      const job = await configApi.refreshWikiTable(page.id, column);
      setScanJob(job);
      let current = job;
      while (isLiveJob(current)) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        current = await configApi.getJob(job.id);
        setScanJob(current);
      }
      assertJobFinished(current, t);
      const loaded = await configApi.getWikiPage(page.id);
      setPage(loaded);
      setDrafts(Object.fromEntries((loaded.fields ?? []).map((item) => [item.key, item.text])));
      await refresh();
    });
    setRefreshingKey(null);
  };

  const adoptQuery = async () => {
    if (!page) return;
    await runTracked("save", async () => {
      await configApi.pinWikiPage(page.id, page.body, "query");
      const loaded = await configApi.getWikiPage(page.id);
      setPage(loaded);
      await refresh();
    });
  };

  const saveField = async (field: string) => {
    const text = drafts[field]?.trim() ?? "";
    if (!page || !text) return;
    await runTracked("save", async () => {
      await configApi.pinWikiPage(page.id, text, field);
      const loaded = await configApi.getWikiPage(page.id);
      setPage(loaded);
      setDrafts(Object.fromEntries((loaded.fields ?? []).map((item) => [item.key, item.text])));
      await refresh();
    });
  };

  const scanLive = isLiveJob(sourceScanJob);
  const sourceBrief = [
    selectedSource?.type,
    selectedSource?.summary || selectedSource?.description,
    datasourceId ? t("wiki.tableCount", { count: sourceTableCount }) : "",
  ].filter(Boolean).join(" · ");

  const rejectPage = async () => {
    if (!page) return;
    if (!window.confirm(t("wiki.confirmReject"))) return;
    setBusy(true);
    setError(null);
    try {
      await configApi.rejectWikiPage(page.id);
      const loaded = await configApi.getWikiPage(page.id);
      setPage(loaded);
      setDrafts(Object.fromEntries((loaded.fields ?? []).map((item) => [item.key, item.text])));
      await refresh();
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : t("wiki.rejectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const listToolbar = (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
      {!listOpen ? (
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-subtle hover:text-foreground"
          aria-label={t("wiki.showList")}
          title={t("wiki.showList")}
          onClick={() => setListOpen(true)}
        >
          <PanelExpandIcon />
        </button>
      ) : null}
      <button type="button" className={`${btnGhostClass} h-7 px-2`} onClick={openGraph}>
        {t("wiki.globalGraph")}
      </button>
      <button
        type="button"
        className={`${btnGhostClass} h-7 px-2`}
        disabled={runningAction === "lint"}
        onClick={() => void runLint()}
      >
        {runningAction === "lint" ? (
          <span className="inline-flex items-center gap-1.5">
            <SpinnerIcon />
            {t("wiki.lintRunning")}
          </span>
        ) : t("wiki.lint")}
      </button>
      {findings ? (
        <button
          type="button"
          className={`${btnGhostClass} h-7 px-2 ${findingsOpen ? "bg-surface-subtle text-foreground" : ""}`}
          onClick={() => setFindingsOpen((open) => !open)}
        >
          {t("wiki.findings")}{findings.length > 0 ? ` · ${findings.length}` : ""}
        </button>
      ) : null}
      {runningAction === "lint" && actionError ? (
        <span className="truncate text-[11px] text-rose-700">{actionError}</span>
      ) : null}
      <div className="flex-1" />
      {selectedId && selectedId !== "wiki-graph" ? (
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-subtle hover:text-foreground"
          aria-label={t("wiki.revealInList")}
          title={t("wiki.revealInList")}
          onClick={focusCurrentInList}
        >
          <LocateIcon />
        </button>
      ) : null}
      {listOpen ? (
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-subtle hover:text-foreground"
          aria-label={t("wiki.hideList")}
          title={t("wiki.hideList")}
          onClick={() => setListOpen(false)}
        >
          <PanelCollapseIcon />
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-light transition hover:bg-surface-subtle hover:text-foreground"
          aria-label={t("common.backToWorkspace")}
          title={t("common.backToWorkspace")}
        >
          <ChevronIcon />
        </button>
        <div className="min-w-0 flex-1">
          <label className="block text-[11px] font-medium text-muted-light" htmlFor="wiki-source-select">
            {t("wiki.selectSource")}
          </label>
          <select
            id="wiki-source-select"
            value={datasourceId}
            onChange={(event) => setDatasourceId(event.target.value)}
            className="h-7 max-w-full bg-transparent text-sm font-semibold text-foreground outline-none"
            aria-label={t("wiki.datasource")}
          >
            {datasources.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
            <option value="">{t("wiki.allSources")}</option>
          </select>
          <p className="truncate text-xs text-muted-light">
            {sourceBrief || t("wiki.allSources")}
            {sourceUpdatedAt ? ` · ${t("wiki.updatedAt", { time: formatRelativeTime(sourceUpdatedAt, t, locale) })}` : ""}
          </p>
        </div>
        {scanLive && sourceScanJob ? (
          <JobInlineStatus
            job={sourceScanJob}
            onCancel={(jobId) => configApi.cancelJob(jobId).then((job) => {
              const next = jobResourceId(job) === datasourceId ? job : null;
              setScanJob(next);
            })}
          />
        ) : null}
      </header>

      {error ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">{error}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {listOpen ? (
          <aside className="relative flex w-72 shrink-0 flex-col border-r border-border">
            {listToolbar}
            {findingsOpen && findings ? (
              <div className="border-b border-border bg-surface-subtle px-3 py-2">
                <p className="text-xs font-semibold text-foreground">{t("wiki.findings")}</p>
                {findings.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-light">{t("wiki.noFindings")}</p>
                ) : (
                  <ul className="mt-1 max-h-28 space-y-1 overflow-y-auto text-xs text-muted">
                    {findings.map((finding) => <li key={finding}>{finding}</li>)}
                  </ul>
                )}
              </div>
            ) : null}
            <div className="space-y-2 border-b border-border p-3">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("wiki.search")}
                className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-muted-light"
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={treeMode === "table"
                    ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                    : "rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-subtle"}
                  onClick={() => setTreeMode("table")}
                >
                  {t("wiki.treeByTable")}
                </button>
                <button
                  type="button"
                  className={treeMode === "type"
                    ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                    : "rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-subtle"}
                  onClick={() => setTreeMode("type")}
                >
                  {t("wiki.treeByType")}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-subtle hover:text-foreground"
                  onClick={expandAll}
                >
                  {t("wiki.expandAll")}
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-subtle hover:text-foreground"
                  onClick={collapseAll}
                >
                  {t("wiki.collapseAll")}
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? <p className="px-2 py-3 text-xs text-muted-light">{t("configPanel.loading")}</p> : null}
              {!loading && tree.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-light">{t("wiki.empty")}</p>
              ) : (
                <WikiTreeItems
                  nodes={tree}
                  depth={0}
                  selectedId={selectedId}
                  expanded={expanded}
                  locale={locale}
                  onToggle={toggleExpanded}
                  onOpen={openPage}
                  listItemRefs={listItemRefs}
                />
              )}
            </div>
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {!listOpen ? listToolbar : null}
          {!listOpen && findingsOpen && findings ? (
            <div className="border-b border-border bg-surface-subtle px-3 py-2">
              <p className="text-xs font-semibold text-foreground">{t("wiki.findings")}</p>
              {findings.length === 0 ? (
                <p className="mt-1 text-xs text-muted-light">{t("wiki.noFindings")}</p>
              ) : (
                <ul className="mt-1 max-h-28 space-y-1 overflow-y-auto text-xs text-muted">
                  {findings.map((finding) => <li key={finding}>{finding}</li>)}
                </ul>
              )}
            </div>
          ) : null}
          <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-surface-subtle px-1">
            {tabs.map((tab) => {
              const title = tab.kind === "graph"
                ? t("wiki.globalGraph")
                : pages.find((item) => item.id === tab.id)?.title ?? tab.id;
              const active = tab.id === selectedId;
              return (
                <div
                  key={tab.id}
                  className={active
                    ? "flex h-8 items-center gap-1 rounded-t-md border border-b-0 border-border bg-surface px-2.5"
                    : "flex h-8 items-center gap-1 rounded-t-md px-2.5 text-muted hover:bg-surface/60"}
                  onContextMenu={(event) => openTabMenu(event, tab.id)}
                >
                  <button type="button" className="max-w-44 truncate text-xs" onClick={() => { setSelectedId(tab.id); if (tab.kind !== "graph") setAnchor(null); }}>{title}</button>
                  <button type="button" className="flex h-4 w-4 items-center justify-center rounded text-xs text-muted-light hover:bg-surface-subtle hover:text-foreground" aria-label={t("common.close")} onClick={() => closeTab(tab.id)}>×</button>
                </div>
              );
            })}
          </div>
          {tabMenu ? (
            <WikiTabMenu
              x={tabMenu.x}
              y={tabMenu.y}
              closeLabel={t("common.close")}
              closeOthersLabel={t("wiki.closeOthers")}
              closeAllLabel={t("wiki.closeAll")}
              disableCloseOthers={tabs.length <= 1}
              onClose={() => {
                closeTab(tabMenu.id);
                setTabMenu(null);
              }}
              onCloseOthers={() => closeOtherTabs(tabMenu.id)}
              onCloseAll={closeAllTabs}
              onDismiss={() => setTabMenu(null)}
            />
          ) : null}
          {selectedId === "wiki-graph" ? (
            <div className="relative min-h-0 flex-1">
              <WikiForceGraph
                pages={visiblePages}
                className="absolute inset-0"
                showControls
                params={forceParams}
                onParamsChange={setForceParams}
                onOpen={(id) => openPage(id)}
              />
            </div>
          ) : (
          <div className="flex min-h-0 flex-1">
          <section className="min-w-0 flex-1 overflow-y-auto p-4">
            {page ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-foreground">{page.title}</h3>
                    <p className="mt-1 text-xs text-muted-light">
                      {t(`wiki.types.${page.type}`)}
                      {page.type !== "dictionary" && domainKindOf(page) === "dictionary" ? ` · ${t("wiki.role.dictionary")}` : ""}
                      {page.claim_domain ? ` · ${t("wiki.domain")} ${page.claim_domain}` : ""}
                      {page.authority ? ` · ${t("wiki.authority")} ${page.authority}` : ""}
                      {page.updated_at ? ` · ${t("wiki.updatedAt", { time: formatRelativeTime(page.updated_at, t, locale) })}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {page.type === "value-domain" || page.type === "dictionary" ? (
                      <>
                        <button
                          type="button"
                          className={domainView === "list"
                            ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                            : `${btnGhostClass} h-7 px-2`}
                          onClick={() => setDomainView("list")}
                        >
                          {t("wiki.viewList")}
                        </button>
                        <button
                          type="button"
                          className={domainView === "cloud"
                            ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                            : `${btnGhostClass} h-7 px-2`}
                          onClick={() => setDomainView("cloud")}
                        >
                          {t("wiki.viewCloud")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={outlineOpen
                          ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-primary bg-primary/10 text-primary"
                          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-subtle hover:text-foreground"}
                        aria-label={t("wiki.outline")}
                        title={t("wiki.outline")}
                        onClick={() => setOutlineOpen((open) => !open)}
                      >
                        <OutlineIcon />
                      </button>
                    )}
                  </div>
                </div>
                {page.type === "table" ? (
                  <TableColumns
                    page={page}
                    drafts={drafts}
                    anchor={anchor}
                    busy={busy}
                    refreshingKey={refreshingKey}
                    scanJob={runningAction === "refresh" ? scanJob : scanLive ? sourceScanJob : null}
                    actionError={runningAction === "refresh" || refreshingKey ? actionError : null}
                    onDraft={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
                    onSave={(key) => void saveField(key)}
                    onRefresh={(column) => void refreshMetrics(column)}
                    onCancelScan={(runningAction === "refresh" ? scanJob : sourceScanJob)
                      ? () => {
                        const target = runningAction === "refresh" ? scanJob : sourceScanJob;
                        if (!target) return;
                        return configApi.cancelJob(target.id).then((job) => {
                          setScanJob(jobResourceId(job) === datasourceId || runningAction === "refresh" ? job : null);
                        });
                      }
                      : undefined}
                    onOpen={openTitle}
                  />
                ) : (page.type === "value-domain" || page.type === "dictionary") && domainView === "cloud" ? (
                  <>
                    <DomainWordCloud
                      page={page}
                      weight={domainWeight}
                      onWeightChange={setDomainWeight}
                    />
                    <button type="button" className={btnSecondaryClass} disabled={busy || page.status === "rejected" || page.status === "auto-rejected"} onClick={() => void rejectPage()}>
                      {t("wiki.rejectHuman")}
                    </button>
                  </>
                ) : (page.type === "value-domain" || page.type === "dictionary") ? (
                  <>
                    <DomainValueList page={page} onOpen={openTitle} />
                    <button type="button" className={btnSecondaryClass} disabled={busy || page.status === "rejected" || page.status === "auto-rejected"} onClick={() => void rejectPage()}>
                      {t("wiki.rejectHuman")}
                    </button>
                  </>
                ) : (
                  <>
                    <LinkedText text={page.body} onOpen={openTitle} />
                    {(page.fields ?? []).filter((field) => !field.key.endsWith(":profile") && field.key !== "profile").map((field) => (
                      <label key={field.key} className="block text-xs font-medium text-muted">
                        <span className="flex items-center gap-2">
                          {fieldLabel(field.key, t)}
                          <StatusBadge status={field.status} label={statusLabel(field.status, t)} />
                        </span>
                        <input
                          value={drafts[field.key] ?? field.text}
                          onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.target.value }))}
                          className="mt-1 h-8 w-full max-w-md rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-muted-light"
                        />
                        {(drafts[field.key] ?? field.text) !== field.text ? (
                          <button type="button" className={`${btnPrimaryClass} mt-2`} disabled={busy} onClick={() => void saveField(field.key)}>
                            {t("wiki.approveHuman")}
                          </button>
                        ) : null}
                      </label>
                    ))}
                    {page.fields?.some((field) => field.key === "profile") ? (
                      <p className="text-xs text-muted-light">{t("wiki.profile")}：{page.fields.find((field) => field.key === "profile")?.text}</p>
                    ) : null}
                    {page.fields?.some((field) => field.key === "relation" && field.meta) ? (
                      <p className="text-xs text-muted-light">{page.fields.find((field) => field.key === "relation")?.meta}</p>
                    ) : null}
                    {page.type === "query-pattern" && page.status !== "human" && page.status !== "rejected" && page.status !== "auto-rejected" ? (
                      <button type="button" className={btnPrimaryClass} disabled={busy} onClick={() => void adoptQuery()}>
                        {t("wiki.adoptQuery")}
                      </button>
                    ) : null}
                    <button type="button" className={btnSecondaryClass} disabled={busy || page.status === "rejected" || page.status === "auto-rejected"} onClick={() => void rejectPage()}>
                      {t("wiki.rejectHuman")}
                    </button>
                  </>
                )}
                <Backlinks page={page} pages={pages} onOpen={openTitle} />
                <NeighborGraph page={page} pages={pages} params={forceParams} onParamsChange={setForceParams} onOpen={openTitle} />
              </div>
            ) : null}
          </section>
          {outlineOpen && page ? (
          <aside className="flex w-52 shrink-0 flex-col border-l border-border p-3">
            <p className="text-xs font-medium text-muted">{t("wiki.outline")}</p>
            <div className="mt-2 flex flex-col gap-1">
              {outlineEntries(page).map((heading) => (
                <button
                  key={heading}
                  type="button"
                  className={anchor === heading ? "truncate text-left text-xs font-semibold text-primary" : "truncate text-left text-xs text-muted"}
                  onClick={() => {
                    setAnchor(heading);
                    document.getElementById(`wiki-column-${heading}`)?.scrollIntoView({ block: "start" });
                  }}
                >
                  {heading}
                </button>
              ))}
            </div>
          </aside>
          ) : null}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TableColumns({
  page,
  drafts,
  anchor,
  busy,
  refreshingKey,
  scanJob,
  actionError,
  onDraft,
  onSave,
  onRefresh,
  onCancelScan,
  onOpen,
}: {
  page: WikiPageDto;
  drafts: Record<string, string>;
  anchor: string | null;
  busy: boolean;
  refreshingKey: string | null;
  scanJob: JobDto | null;
  actionError: string | null;
  onDraft: (key: string, value: string) => void;
  onSave: (key: string) => void;
  onRefresh: (column?: string) => void;
  onCancelScan?: () => void | Promise<void>;
  onOpen: (title: string) => void;
}) {
  const t = useT();
  const columns = columnEntries(page);
  const links = page.body.split("\n").filter((line) => line.includes("[[")).join("\n");
  const [open, setOpen] = useState<Set<string>>(() => new Set(anchor ? [anchor] : []));
  useEffect(() => {
    if (!anchor) return;
    setOpen((current) => new Set(current).add(anchor));
  }, [anchor]);
  const tableRefreshing = busy && refreshingKey === "*";
  return (
    <div className="space-y-2">
      {links ? <LinkedText text={links} onOpen={onOpen} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-muted">{t("wiki.columns")}</p>
        <JobInlineStatus
          job={tableRefreshing ? scanJob : null}
          updatedAt={page.updated_at}
          onCancel={tableRefreshing && onCancelScan ? (jobId) => {
            void jobId;
            return onCancelScan();
          } : undefined}
        />
        <div className="flex-1" />
        <button
          type="button"
          className={`${btnGhostClass} inline-flex items-center gap-1.5`}
          disabled={busy}
          onClick={() => onRefresh()}
        >
          {tableRefreshing ? <><SpinnerIcon />{t("wiki.refreshTableRunning")}</> : t("wiki.refreshTable")}
        </button>
      </div>
      {actionError && (refreshingKey === "*" || refreshingKey) ? (
        <p className="text-[11px] text-rose-700">{actionError}</p>
      ) : null}
      {columns.map((column) => {
        const expanded = open.has(column.name);
        const draft = drafts[column.name] ?? column.label;
        const dirty = draft.trim() !== column.label.trim();
        const columnRefreshing = busy && refreshingKey === column.name;
        return (
          <article
            key={column.name}
            id={`wiki-column-${column.name}`}
            className={anchor === column.name ? "scroll-mt-4 rounded-lg border border-primary bg-primary/5 px-2 py-1.5" : "scroll-mt-4 rounded-lg border border-border px-2 py-1.5"}
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="min-w-0 max-w-[34%] shrink-0 truncate text-left text-xs font-semibold text-foreground"
                title={column.name}
                onClick={() => setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(column.name)) next.delete(column.name);
                  else next.add(column.name);
                  return next;
                })}
              >
                <span className="mr-1 text-muted-light">{expanded ? "▾" : "▸"}</span>
                {column.name}
                {column.type ? <span className="ml-2 font-normal text-muted-light">{column.type}</span> : null}
                {column.role ? <span className="ml-1.5 font-normal text-muted-light">{t(`wiki.role.${column.role}`)}</span> : null}
              </button>
              <input
                value={draft}
                aria-label={t("wiki.businessName")}
                placeholder={t("wiki.businessName")}
                onChange={(event) => onDraft(column.name, event.target.value)}
                className="h-7 w-36 shrink-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-muted-light sm:w-44"
              />
              <FittedMeta parts={columnMetaParts(column, t)} />
              <StatusBadge status={column.labelStatus} label={statusLabel(column.labelStatus, t)} />
              {dirty ? (
                <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs text-white" disabled={busy} title={t("wiki.approveHuman")} aria-label={t("wiki.approveHuman")} onClick={() => onSave(column.name)}>
                  ✓
                </button>
              ) : null}
              <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-subtle" disabled={busy} title={t("wiki.refreshColumn")} aria-label={t("wiki.refreshColumn")} onClick={() => onRefresh(column.name)}>
                {columnRefreshing ? <SpinnerIcon /> : <RefreshIcon />}
              </button>
            </div>
            {columnRefreshing ? (
              <div className="mt-1">
                <JobInlineStatus
                  job={scanJob}
                  onCancel={onCancelScan ? (jobId) => {
                    void jobId;
                    return onCancelScan();
                  } : undefined}
                />
              </div>
            ) : null}
            {expanded ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] text-muted">
                <div><dt className="text-muted-light">{t("wiki.cardinality")}</dt><dd>{column.cardinality}</dd></div>
                <div><dt className="text-muted-light">{t("wiki.nullRate")}</dt><dd>{column.nullRate}</dd></div>
                {column.comment ? <div className="col-span-2"><dt className="text-muted-light">{t("wiki.comment")}</dt><dd>{column.comment}</dd></div> : null}
                {column.range ? <div><dt className="text-muted-light">{t("wiki.range")}</dt><dd>{column.range}</dd></div> : null}
                {column.maxLength ? <div><dt className="text-muted-light">{t("wiki.maxLength")}</dt><dd>{column.maxLength}</dd></div> : null}
                {column.charset ? <div><dt className="text-muted-light">{t("wiki.charset")}</dt><dd>{column.charset}</dd></div> : null}
                {column.nullable !== undefined ? <div><dt className="text-muted-light">{t("wiki.nullable")}</dt><dd>{column.nullable ? "true" : "false"}</dd></div> : null}
                {column.primaryKey ? <div><dt className="text-muted-light">{t("wiki.primaryKey")}</dt><dd>true</dd></div> : null}
                {column.frequent ? <div className="col-span-2"><dt className="text-muted-light">{t("wiki.frequent")}</dt><dd>{column.frequent}</dd></div> : null}
                {column.sentinels ? <div className="col-span-2"><dt className="text-muted-light">{t("wiki.sentinels")}</dt><dd>{column.sentinels}</dd></div> : null}
              </dl>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

type DomainTerm = {
  value: string;
  label?: string;
  count: number;
  share: number;
  index: number;
};

type DomainWeight = "share" | "count" | "recent";

const CLOUD_COLORS = ["#0f766e", "#0369a1", "#b45309", "#6d28d9", "#be123c", "#047857", "#1d4ed8", "#a16207"];
const CLOUD_TERM_LIMIT = 80;
const VALUE_ROW_HEIGHT = 36;
const VALUE_VIEWPORT_HEIGHT = 448;

let domainTermCache: { key: string; terms: DomainTerm[] } | null = null;

function cachedDomainTerms(pageId: string, raw: string): DomainTerm[] {
  const key = `${pageId}:${raw.length}`;
  if (domainTermCache?.key === key) return domainTermCache.terms;
  const terms = parseDomainTerms(raw);
  domainTermCache = { key, terms };
  return terms;
}

function useDomainTerms(page: WikiPageDto): DomainTerm[] | null {
  const [terms, setTerms] = useState<DomainTerm[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTerms(null);
    const handle = window.setTimeout(() => {
      const parsed = cachedDomainTerms(page.id, page.body);
      if (!cancelled) setTerms(parsed);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [page.id, page.body]);
  return terms;
}

function declaredCardinality(body: string, fallback: number): number {
  const match = /cardinality=(\d+)/iu.exec(body.slice(0, 240));
  return match ? Number(match[1]) : fallback;
}

function DomainWordCloud({
  page,
  weight,
  onWeightChange,
}: {
  page: WikiPageDto;
  weight: DomainWeight;
  onWeightChange: (weight: DomainWeight) => void;
}) {
  const t = useT();
  const [hover, setHover] = useState<DomainTerm | null>(null);
  const terms = useDomainTerms(page);
  const drawn = useMemo(() => {
    if (!terms) return [];
    return terms
      .map((term) => ({ term, weight: domainTermWeight(term, weight, terms.length) }))
      .sort((left, right) => right.weight - left.weight || left.term.index - right.term.index)
      .slice(0, CLOUD_TERM_LIMIT);
  }, [terms, weight]);
  const max = drawn[0] ? Math.max(...drawn.map((item) => item.weight)) : 1;
  const min = drawn[0] ? Math.min(...drawn.map((item) => item.weight)) : 1;
  const flat = max - min <= Math.max(max, 1) * 0.08;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {(["share", "count", "recent"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={weight === mode
              ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
              : "rounded-md px-2 py-1 text-[11px] text-muted hover:bg-surface-subtle"}
            onClick={() => onWeightChange(mode)}
          >
            {t(`wiki.weight${mode === "share" ? "Share" : mode === "count" ? "Count" : "Recent"}`)}
          </button>
        ))}
      </div>
      {terms === null ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-light">
          {t("wiki.domainPreparing")}
        </p>
      ) : terms.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-light">
          {t("wiki.cloudEmpty")}
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-[radial-gradient(circle_at_center,_#f8fafc,_#ffffff_70%)] px-6 py-8">
          {terms.length > drawn.length ? (
            <p className="mb-4 text-center text-[11px] text-muted-light">
              {t("wiki.cloudCapped", { shown: drawn.length, total: terms.length })}
            </p>
          ) : null}
          <div className="flex min-h-56 flex-wrap items-center justify-center gap-x-6 gap-y-4">
            {drawn.map((item, index) => {
              const norm = flat ? 0.62 : (item.weight - min) / Math.max(max - min, 1e-6);
              const fontSize = flat ? 22 + (index % 3) : 16 + Math.round(norm * 22);
              const text = item.term.label && item.term.label !== item.term.value
                ? `${item.term.value} ${item.term.label}`
                : item.term.value;
              const active = hover?.value === item.term.value;
              return (
                <button
                  key={item.term.value}
                  type="button"
                  className="cursor-default rounded-md px-1.5 py-0.5 font-semibold leading-none transition duration-150 ease-out hover:z-10 hover:scale-110 hover:bg-white hover:shadow-md"
                  style={{
                    fontSize,
                    color: CLOUD_COLORS[index % CLOUD_COLORS.length],
                    opacity: active || !hover ? 1 : 0.45,
                  }}
                  onMouseEnter={() => setHover(item.term)}
                  onMouseLeave={() => setHover((current) => current?.value === item.term.value ? null : current)}
                  onFocus={() => setHover(item.term)}
                  onBlur={() => setHover((current) => current?.value === item.term.value ? null : current)}
                >
                  {text}
                </button>
              );
            })}
          </div>
          <p className="mt-6 h-5 text-center text-xs text-slate-500">
            {hover
              ? t("wiki.cloudTip", {
                value: hover.label && hover.label !== hover.value ? `${hover.value} ${hover.label}` : hover.value,
                share: Math.round(hover.share * 100),
                count: hover.count,
              })
              : t("wiki.cloudHint")}
          </p>
        </div>
      )}
    </div>
  );
}

function DomainValueList({
  page,
  onOpen,
}: {
  page: WikiPageDto;
  onOpen: (title: string) => void;
}) {
  const t = useT();
  const terms = useDomainTerms(page);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const cardinality = declaredCardinality(page.body, terms?.length ?? 0);
  const filtered = useMemo(() => {
    if (!terms) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return terms;
    return terms.filter((term) =>
      term.value.toLowerCase().includes(needle)
      || (term.label ?? "").toLowerCase().includes(needle));
  }, [terms, query]);
  const total = useMemo(() => (terms ?? []).reduce((sum, term) => sum + term.count, 0), [terms]);
  const maxShare = filtered[0] ? Math.max(...filtered.map((term) => term.share), 0.001) : 1;
  const hasLabel = (terms ?? []).some((term) => term.label && term.label !== term.value);
  const links = useMemo(() => domainLinkLines(page.body), [page.body]);
  const start = Math.max(0, Math.floor(scrollTop / VALUE_ROW_HEIGHT) - 8);
  const visibleCount = Math.ceil(VALUE_VIEWPORT_HEIGHT / VALUE_ROW_HEIGHT) + 16;
  const slice = filtered.slice(start, start + visibleCount);
  if (terms === null) {
    return (
      <p className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs text-muted-light">
        {t("wiki.domainPreparing")}
      </p>
    );
  }
  if (terms.length === 0) return <LinkedText text={page.body} onOpen={onOpen} />;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-subtle px-3 py-2 text-xs text-muted">
        <span>{t("wiki.cardinality")} {cardinality.toLocaleString()}</span>
        <span>{t("wiki.weightCount")} {total.toLocaleString()}</span>
        <span>{t("wiki.domainShown", { shown: filtered.length.toLocaleString(), total: terms.length.toLocaleString() })}</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setScrollTop(0);
          }}
          placeholder={t("wiki.domainSearch")}
          className="ml-auto h-7 w-40 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-muted-light"
        />
      </div>
      <div className="border-b border-border bg-surface px-3 text-[11px] text-muted-light">
        <div className="flex h-8 items-center">
          <span className="min-w-0 flex-1">{t("wiki.domainValue")}</span>
          {hasLabel ? <span className="w-36 shrink-0">{t("wiki.domainMeaning")}</span> : null}
          <span className="w-16 shrink-0 text-right">{t("wiki.weightCount")}</span>
          <span className="w-36 shrink-0 pl-3">{t("wiki.weightShare")}</span>
        </div>
      </div>
      <div
        className="overflow-auto"
        style={{ height: VALUE_VIEWPORT_HEIGHT }}
        onScroll={(event) => {
          const next = event.currentTarget.scrollTop;
          setScrollTop((current) => (Math.abs(current - next) < VALUE_ROW_HEIGHT ? current : next));
        }}
      >
        <div style={{ height: filtered.length * VALUE_ROW_HEIGHT, position: "relative" }}>
          {slice.map((term, offset) => {
            const index = start + offset;
            return (
              <div
                key={`${term.index}:${term.value}`}
                className="absolute left-0 right-0 flex items-center border-b border-border/60 px-3 text-sm"
                style={{ top: index * VALUE_ROW_HEIGHT, height: VALUE_ROW_HEIGHT }}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={term.value}>{term.value || "—"}</span>
                {hasLabel ? (
                  <span className="w-36 shrink-0 truncate text-muted" title={term.label}>{term.label || ""}</span>
                ) : null}
                <span className="w-16 shrink-0 text-right tabular-nums text-muted">{term.count.toLocaleString()}</span>
                <span className="flex w-36 shrink-0 items-center gap-2 pl-3">
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-subtle">
                    <span
                      className="block h-full rounded-full bg-teal-600"
                      style={{ width: `${Math.max(6, Math.round((term.share / maxShare) * 100))}%` }}
                    />
                  </span>
                  <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-light">
                    {Math.round(term.share * 100)}%
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {links ? (
        <div className="border-t border-border px-3 py-2 text-xs text-muted">
          <LinkedText text={links} onOpen={onOpen} />
        </div>
      ) : null}
    </div>
  );
}

function domainLinkLines(body: string): string {
  const tail = body.length > 4000 ? body.slice(-4000) : body;
  return tail
    .split("\n")
    .filter((line) => /^(所属列|所属表|列|表|关联|相关)\s/u.test(line.trim()))
    .join("\n");
}

function domainKindOf(page: { body?: string; fields?: Array<{ key: string; text: string }> | undefined; excerpt?: string }): "dictionary" | "values" {
  const raw = page.fields?.find((field) => field.key === "dictionary")?.text || page.body || page.excerpt || "";
  return /^kind=dictionary\b/imu.test(raw) ? "dictionary" : "values";
}

function columnMetaParts(column: {
  comment?: string;
  range?: string;
  cardinality: string;
  nullRate: string;
  nullable?: boolean;
  charset?: string;
}, t: TranslateFn): string[] {
  return [
    column.comment ?? "",
    column.range ? `${t("wiki.range")} ${column.range}` : "",
    column.cardinality !== "-" ? `${t("wiki.cardinality")} ${column.cardinality}` : "",
    column.nullRate !== "-" ? `${t("wiki.nullRate")} ${column.nullRate}` : "",
    column.nullable !== undefined ? `${t("wiki.nullable")} ${column.nullable ? t("common.yes") : t("common.no")}` : "",
    column.charset ? `${t("wiki.charset")} ${column.charset}` : "",
  ].filter((part) => part.length > 0);
}

function FittedMeta({ parts }: { parts: string[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [count, setCount] = useState(parts.length);
  const signature = parts.join("\u0001");
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fit = () => {
      const width = node.clientWidth;
      if (width <= 8) {
        setCount(0);
        return;
      }
      const probe = document.createElement("span");
      probe.className = "pointer-events-none invisible absolute whitespace-nowrap text-[11px]";
      node.appendChild(probe);
      let shown = 0;
      let text = "";
      for (const part of parts) {
        const candidate = text ? `${text} · ${part}` : part;
        probe.textContent = candidate;
        if (probe.offsetWidth > width) break;
        text = candidate;
        shown += 1;
      }
      probe.remove();
      setCount(shown);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [parts, signature]);
  return (
    <div ref={ref} className="min-w-0 flex-1 truncate text-[11px] text-muted-light" title={parts.join(" · ")}>
      {parts.slice(0, count).join(" · ")}
    </div>
  );
}

function parseDomainTerms(raw: string): DomainTerm[] {
  const lines = raw.split("\n").map((line) => line.trim()).filter((line) => {
    if (!line || line.startsWith("#") || line.includes("[[")) return false;
    if (/^(所属列|所属表|列|表|关联|相关)\s/u.test(line)) return false;
    if (/^cardinality=/iu.test(line) || /^kind=/iu.test(line)) return false;
    return true;
  });
  const valuesLine = lines.find((line) => /^\s*values:/iu.test(line));
  if (valuesLine) {
    const labels = valuesLine.replace(/^\s*values:\s*/iu, "").split(",").map((item) => item.trim()).filter(Boolean);
    return labels.map((value, index) => ({
      value,
      count: 1,
      share: 1 / Math.max(labels.length, 1),
      index,
    }));
  }
  const terms: DomainTerm[] = [];
  for (const line of lines) {
    if (line.includes("\t")) {
      const cells = line.split("\t");
      const value = cells[0]?.trim();
      if (!value) continue;
      const labeled = cells.length >= 4 && !Number.isFinite(Number(cells[1]));
      const label = labeled ? cells[1]?.trim() : undefined;
      const count = Number(labeled ? cells[2] : cells[1]);
      const share = Number(labeled ? cells[3] : cells[2]);
      terms.push({
        value,
        ...(label ? { label } : {}),
        count: Number.isFinite(count) ? count : 1,
        share: Number.isFinite(share) ? share : 0,
        index: terms.length,
      });
      continue;
    }
    const freq = /^([^=×\n]+?)(?:\s*=\s*([^×\n]+?))?\s*×\s*([0-9.]+)(?:\s*\(([0-9.]+)\))?/u.exec(line);
    if (freq?.[1]) {
      const count = Number(freq[3]);
      const share = Number(freq[4]);
      terms.push({
        value: freq[1].trim(),
        ...(freq[2]?.trim() ? { label: freq[2].trim() } : {}),
        count: Number.isFinite(count) ? count : 1,
        share: Number.isFinite(share) ? share : 0,
        index: terms.length,
      });
    }
  }
  const total = terms.reduce((sum, term) => sum + term.count, 0);
  return terms.map((term) => ({
    ...term,
    share: term.share > 0 ? term.share : (total > 0 ? term.count / total : 0),
  }));
}

function domainTermWeight(term: DomainTerm, mode: DomainWeight, count: number): number {
  if (mode === "count") return Math.max(term.count, 0.01);
  if (mode === "recent") {
    const recency = (term.index + 1) / Math.max(count, 1);
    return Math.max(term.share, 0.01) * (0.35 + 0.65 * recency);
  }
  return Math.max(term.share, 0.01);
}

function columnEntries(page: WikiPageDto): Array<{
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  role?: string;
  comment?: string;
  label: string;
  labelStatus: string;
  cardinality: string;
  nullRate: string;
  range?: string;
  frequent?: string;
  maxLength?: string;
  charset?: string;
  sentinels?: string;
}> {
  return (page.fields ?? []).flatMap((field) => {
    if (field.key.includes(":")) return [];
    let meta: {
      type?: string;
      nullable?: boolean;
      primaryKey?: boolean;
      comment?: string;
      role?: string;
      cardinality?: number;
      nullRate?: number;
      min?: string;
      max?: string;
      maxLength?: number;
      charset?: string;
      frequencies?: Array<{ value: string; count: number; share: number }>;
      sentinels?: string[];
    } = {};
    if (field.meta) {
      try {
        meta = JSON.parse(field.meta) as typeof meta;
      } catch {
        meta = {};
      }
    }
    const frequent = (meta.frequencies ?? [])
      .slice(0, 5)
      .map((item) => `${item.value} ${item.count} (${Math.round(item.share * 100)}%)`)
      .join(", ");
    return [{
      name: field.key,
      ...(meta.type ? { type: meta.type } : {}),
      ...(meta.nullable !== undefined ? { nullable: meta.nullable } : {}),
      ...(meta.primaryKey ? { primaryKey: true } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      ...(meta.comment ? { comment: meta.comment } : {}),
      label: field.text,
      labelStatus: field.status,
      cardinality: meta.cardinality !== undefined ? String(meta.cardinality) : "-",
      nullRate: meta.nullRate !== undefined ? `${(meta.nullRate * 100).toFixed(1)}%` : "-",
      ...(meta.min !== undefined && meta.max !== undefined ? { range: `${meta.min} - ${meta.max}` } : {}),
      ...(frequent ? { frequent } : {}),
      ...(meta.maxLength !== undefined ? { maxLength: String(meta.maxLength) } : {}),
      ...(meta.charset ? { charset: meta.charset } : {}),
      ...(meta.sentinels && meta.sentinels.length > 0 ? { sentinels: meta.sentinels.join(", ") } : {}),
    }];
  });
}

function outlineEntries(page: WikiPageDto): string[] {
  if (page.type === "table") return columnEntries(page).map((column) => column.name);
  return (page.body.match(/^##\s+(.+)$/gmu) ?? []).map((heading) => heading.replace(/^##\s+/u, ""));
}

function fieldLabel(key: string, t: ReturnType<typeof useT>): string {
  const part = key.includes(":") ? key.split(":").slice(1).join(":") : key;
  const label = t(`wiki.field.${part}`);
  return label === `wiki.field.${part}` ? part : label;
}

function LinkedText({
  text,
  onOpen,
}: {
  text: string;
  onOpen: (title: string) => void;
}) {
  const parts = text.split(/(\[\[[^\]]+\]\])/u);
  return (
    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
      {parts.map((part, index) => {
        const match = /^\[\[(.+)\]\]$/u.exec(part);
        const title = match?.[1];
        if (!title) return <span key={index}>{part}</span>;
        return (
          <button key={index} type="button" className="text-primary underline" onClick={() => onOpen(title)}>
            {title.split("#").pop()}
          </button>
        );
      })}
    </p>
  );
}

function Backlinks({
  page,
  pages,
  onOpen,
}: {
  page: WikiPageDto;
  pages: WikiPageSummaryDto[];
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const incoming = pages.filter((item) => item.id !== page.id && (item.links ?? []).some((link) => (link.split("#")[0] ?? link) === page.title));
  if (incoming.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted">{t("wiki.backlinks")}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {incoming.map((item) => (
          <button key={item.id} type="button" className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground" onClick={() => onOpen(item.title)}>
            {item.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function WikiForceGraph({
  pages,
  onOpen,
  className,
  centerId,
  showControls = false,
  params,
  onParamsChange,
  depth,
  onDepthChange,
}: {
  pages: WikiPageSummaryDto[];
  onOpen: (id: string) => void;
  className: string;
  centerId?: string;
  showControls?: boolean;
  params: ForceLayoutParams;
  onParamsChange: (params: ForceLayoutParams) => void;
  depth?: number;
  onDepthChange?: (depth: number) => void;
}) {
  const t = useT();
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [typesOn, setTypesOn] = useState<Record<string, boolean>>(() => Object.fromEntries(PAGE_TYPES.map((type) => [type, true])));
  const [orphans, setOrphans] = useState(true);
  const [textFade, setTextFade] = useState(0.62);
  const [nodeScale, setNodeScale] = useState(1);
  const [linkScale, setLinkScale] = useState(1);
  const shown = useMemo(() => selectGraphPages(pages, appliedQuery, typesOn, orphans), [appliedQuery, orphans, pages, typesOn]);
  const presentTypes = useMemo(() => PAGE_TYPES.filter((type) => pages.some((page) => page.type === type)), [pages]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<ForceScene | null>(null);
  const frameRef = useRef({ cx: 0, cy: 0, scale: 1 });
  const userMoved = useRef(false);
  const paintRef = useRef<() => void>(() => {});
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const viewRef = useRef({ zoom, pan, hover, size, textFade, nodeScale, linkScale, radiusMin: params.radiusMin, radiusMax: params.radiusMax });
  viewRef.current = { zoom, pan, hover, size, textFade, nodeScale, linkScale, radiusMin: params.radiusMin, radiusMax: params.radiusMax };

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHover(null);
    userMoved.current = false;
  }, [centerId, shown]);

  useEffect(() => {
    const scene = openForceModel(shown, centerId, params);
    sceneRef.current = scene;
    let alive = true;
    let raf = 0;
    const step = () => {
      if (!alive) return;
      const alpha = scene.tick();
      paintRef.current();
      if (alpha > scene.alphaMin) raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      scene.stop();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
  }, [centerId, params, shown]);

  useEffect(() => {
    paintRef.current();
  }, [hover, linkScale, nodeScale, pan, size, textFade, zoom]);

  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      userMoved.current = true;
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      setZoom((current) => Math.min(4, Math.max(0.35, current * factor)));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const changeZoom = (factor: number) => {
    userMoved.current = true;
    setZoom((current) => Math.min(4, Math.max(0.35, current * factor)));
  };
  const setParam = <K extends keyof ForceLayoutParams>(key: K, value: ForceLayoutParams[K]) => {
    onParamsChange({ ...params, [key]: value });
  };
  paintRef.current = () => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return;
    const view = viewRef.current;
    if (!userMoved.current) frameRef.current = graphFrame(scene.nodes, view.size.width, view.size.height);
    paintForceGraph(canvas, scene, frameRef.current, view);
  };
  const nodeAt = (clientX: number, clientY: number): ForceNode | null => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return null;
    const rect = canvas.getBoundingClientRect();
    return hitForceNode(
      scene,
      frameRef.current,
      viewRef.current,
      clientX - rect.left,
      clientY - rect.top,
    );
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      {showControls ? (
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <button type="button" className={btnSecondaryClass} onClick={() => changeZoom(1.2)}>{t("wiki.zoomIn")}</button>
          <button type="button" className={btnSecondaryClass} onClick={() => changeZoom(1 / 1.2)}>{t("wiki.zoomOut")}</button>
          <button type="button" className={btnSecondaryClass} onClick={() => { userMoved.current = false; setZoom(1); setPan({ x: 0, y: 0 }); }}>{t("wiki.resetView")}</button>
          <button type="button" className={btnSecondaryClass} onClick={() => setPanelOpen((open) => !open)}>
            {panelOpen ? t("wiki.forceHide") : t("wiki.forceSettings")}
          </button>
        </div>
      ) : null}
      {panelOpen ? (
        <div
          className="absolute right-2 top-12 z-10 w-72 max-h-[min(70%,32rem)] overflow-auto rounded-md border border-slate-200 bg-white/95 p-2 text-xs shadow-sm backdrop-blur"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium text-slate-800">{t("wiki.forcePanel")}</span>
            <button type="button" className={btnGhostClass} onClick={() => onParamsChange(DEFAULT_FORCE_PARAMS)}>{t("wiki.forceReset")}</button>
          </div>
          <div className="space-y-2 text-slate-600">
            <p className="font-medium text-slate-800">{t("wiki.graphFilters")}</p>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("wiki.graphSearch")}
              className="h-7 w-full rounded border border-slate-200 bg-white px-1.5 text-xs text-slate-800 outline-none"
            />
            <div className="flex flex-wrap gap-1">
              {presentTypes.map((type) => {
                const on = typesOn[type] !== false;
                return (
                  <button
                    key={type}
                    type="button"
                    className={on ? "inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-700" : "inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-400"}
                    onClick={() => setTypesOn((current) => ({ ...current, [type]: current[type] === false }))}
                  >
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: graphColor(type) }} />
                    {t(`wiki.types.${type}`)}
                  </button>
                );
              })}
              <button
                type="button"
                className={orphans ? "rounded-full border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-700" : "rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-400"}
                onClick={() => setOrphans((current) => !current)}
              >
                {t("wiki.graphOrphans")}
              </button>
            </div>
            {onDepthChange ? (
              <ForceSlider label={t("wiki.graphDepth")} value={depth ?? 1} min={1} max={3} step={1} onChange={onDepthChange} />
            ) : null}
            <p className="pt-1 font-medium text-slate-800">{t("wiki.graphDisplay")}</p>
            <ForceSlider label={t("wiki.graphTextFade")} value={textFade} min={0} max={1} step={0.05} onChange={setTextFade} />
            <ForceSlider label={t("wiki.graphNodeSize")} value={nodeScale} min={0.4} max={2.4} step={0.1} onChange={setNodeScale} />
            <ForceSlider label={t("wiki.graphLinkThickness")} value={linkScale} min={0.4} max={3} step={0.1} onChange={setLinkScale} />
            <p className="pt-1 font-medium text-slate-800">{t("wiki.graphForces")}</p>
            <ForceSlider label={t("wiki.forceCenterPull")} value={params.centerPull} min={0} max={0.05} step={0.001} onChange={(value) => setParam("centerPull", value)} />
            <ForceSlider label={t("wiki.forceCharge")} value={params.chargeScale} min={1} max={32} step={1} onChange={(value) => setParam("chargeScale", value)} />
            <ForceSlider label={t("wiki.forceLinkDistance")} value={params.linkDistance} min={80} max={400} step={10} onChange={(value) => setParam("linkDistance", value)} />
            <ForceSlider label={t("wiki.forceMassAlpha")} value={params.massAlpha} min={0.05} max={0.9} step={0.05} onChange={(value) => setParam("massAlpha", value)} />
            <ForceSlider label={t("wiki.forceChargeMax")} value={params.chargeDistanceMax} min={200} max={1600} step={50} onChange={(value) => setParam("chargeDistanceMax", value)} />
            <ForceSlider label={t("wiki.forceMutualDistance")} value={params.mutualDistance} min={60} max={320} step={10} onChange={(value) => setParam("mutualDistance", value)} />
            <ForceSlider label={t("wiki.forceMutualBoost")} value={params.mutualBoost} min={1} max={2.2} step={0.05} onChange={(value) => setParam("mutualBoost", value)} />
            <ForceSlider label={t("wiki.forceCollidePad")} value={params.collidePad} min={0} max={48} step={1} onChange={(value) => setParam("collidePad", value)} />
            <ForceSlider label={t("wiki.forceCollideStrength")} value={params.collideStrength} min={0.1} max={1} step={0.05} onChange={(value) => setParam("collideStrength", value)} />
            <ForceSlider label={t("wiki.forceSeedScale")} value={params.seedScale} min={80} max={280} step={5} onChange={(value) => setParam("seedScale", value)} />
            <ForceSlider label={t("wiki.forceTicks")} value={params.ticks} min={80} max={600} step={20} onChange={(value) => setParam("ticks", value)} />
          </div>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className={hover ? "h-full w-full cursor-pointer bg-[radial-gradient(circle_at_center,rgba(120,140,170,0.08),transparent_62%)]" : "h-full w-full cursor-grab bg-[radial-gradient(circle_at_center,rgba(120,140,170,0.08),transparent_62%)] active:cursor-grabbing"}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, ox: pan.x, oy: pan.y, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current) {
            const dx = event.clientX - current.x;
            const dy = event.clientY - current.y;
            if (Math.hypot(dx, dy) > 3) current.moved = true;
            userMoved.current = true;
            setPan({ x: current.ox + dx, y: current.oy + dy });
            return;
          }
          const hit = nodeAt(event.clientX, event.clientY);
          const next = hit?.id ?? null;
          setHover((currentId) => currentId === next ? currentId : next);
        }}
        onPointerUp={() => {
          moved.current = drag.current?.moved ?? false;
          drag.current = null;
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => {
          if (moved.current) return;
          const hit = nodeAt(event.clientX, event.clientY);
          if (hit) onOpen(hit.id);
        }}
      />
      <div
        className="pointer-events-none absolute bottom-2 left-2 z-10 max-w-[min(100%-1rem,40rem)] text-[11px] text-slate-500"
      >
        <span>{t("wiki.graphShown", { shown: shown.length, total: pages.length })}</span>
        <span className="ml-2">{t("wiki.graphHint")}</span>
      </div>
    </div>
  );
}

function ForceSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const decimals = step < 1 ? (String(step).split(".")[1]?.length ?? 1) : 0;
  return (
    <label className="block">
      <span className="mb-0.5 flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className="tabular-nums text-slate-800">{decimals ? value.toFixed(decimals) : value}</span>
      </span>
      <input
        type="range"
        className="w-full accent-slate-700"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function nodeWorldRadius(degree: number, maxDegree: number, radiusMin: number, radiusMax: number): number {
  const lo = Math.max(2, radiusMin);
  const hi = Math.max(lo + 1, radiusMax);
  // Isolated / leaf → min; hubs at Obsidian-like degree cap → max; √ ramp in between.
  if (degree <= 1) return lo;
  const hubCap = Math.max(4, Math.ceil(Math.sqrt(Math.max(maxDegree, 1) + 1) * 2));
  if (degree >= hubCap) return hi;
  const t = (degree - 1) / Math.max(hubCap - 1, 1);
  return lo + (hi - lo) * Math.sqrt(t);
}

function graphLabel(title: string): string {
  const max = 28;
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function graphFrame(nodes: ForceNode[], width: number, height: number): GraphFrame {
  if (nodes.length === 0) return { cx: 0, cy: 0, scale: 1 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let seen = 0;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    seen += 1;
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  if (seen === 0) return { cx: 0, cy: 0, scale: 1 };
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const fit = Math.min((width - 96) / spanX, (height - 96) / spanY);
  const scale = Math.min(Number.isFinite(fit) && fit > 0 ? fit : 1, 2.4);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale };
}

function graphColor(type: string): string {
  if (type === "table") return "#334155";
  if (type === "relation") return "#7c3aed";
  if (type === "value-domain") return "#0f766e";
  if (type === "dictionary") return "#0f766e";
  if (type === "concept") return "#b45309";
  if (type === "metric") return "#1d4ed8";
  if (type === "query-pattern") return "#be123c";
  return "#64748b";
}

type ForceNode = { id: string; title: string; type: string; x: number; y: number; vx?: number; vy?: number; degree: number; mass: number };
type ForceEdge = { from: string; to: string; mutual: boolean };
type GraphFrame = { cx: number; cy: number; scale: number };
type GraphView = {
  zoom: number;
  pan: { x: number; y: number };
  hover: string | null;
  size: { width: number; height: number };
  textFade: number;
  nodeScale: number;
  linkScale: number;
  radiusMin: number;
  radiusMax: number;
};
type ForceScene = {
  nodes: ForceNode[];
  edges: ForceEdge[];
  maxDegree: number;
  neighbors: Map<string, string[]>;
  byId: Map<string, ForceNode>;
  tick: () => number;
  alphaMin: number;
  stop: () => void;
};

function openForceModel(pages: WikiPageSummaryDto[], centerId: string | undefined, params: ForceLayoutParams): ForceScene {
  const nodes: ForceNode[] = pages.map((page) => ({
    id: page.id,
    title: page.title,
    type: page.type,
    x: 0,
    y: 0,
    degree: 0,
    mass: 0.1,
  }));
  const byTitle = new Map(pages.map((page) => [page.title, page.id]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const directed = new Set<string>();
  const undirected = new Map<string, { from: string; to: string }>();
  const adjacency = new Map<string, string[]>();
  for (const page of pages) {
    for (const title of page.links ?? []) {
      const target = byTitle.get(title.split("#")[0] ?? title);
      if (!target || target === page.id) continue;
      directed.add(`${page.id}>${target}`);
      const key = page.id < target ? `${page.id}~${target}` : `${target}~${page.id}`;
      if (!undirected.has(key)) undirected.set(key, { from: page.id, to: target });
    }
  }
  const edges: ForceEdge[] = [];
  for (const edge of undirected.values()) {
    const mutual = directed.has(`${edge.from}>${edge.to}`) && directed.has(`${edge.to}>${edge.from}`);
    edges.push({ from: edge.from, to: edge.to, mutual });
    const source = byId.get(edge.from);
    const node = byId.get(edge.to);
    if (source) source.degree += 1;
    if (node) node.degree += 1;
    const left = adjacency.get(edge.from) ?? [];
    left.push(edge.to);
    adjacency.set(edge.from, left);
    const right = adjacency.get(edge.to) ?? [];
    right.push(edge.from);
    adjacency.set(edge.to, right);
  }
  for (const node of nodes) {
    const neighborMass = (adjacency.get(node.id) ?? []).reduce((sum, id) => sum + (byId.get(id)?.degree ?? 0), 0);
    node.mass = Math.max(0.1, Math.log(1 + node.degree + params.massAlpha * neighborMass));
  }
  let maxDegree = 1;
  for (const node of nodes) if (node.degree > maxDegree) maxDegree = node.degree;
  seedForcePositions(nodes, adjacency, centerId, params.seedScale);
  const links = edges.map((edge) => ({ source: edge.from, target: edge.to, mutual: edge.mutual }));
  const degreeOf = new Map(nodes.map((node) => [node.id, node.degree]));
  const simulation = attachMutualForces(nodes, links, {
    chargeScale: params.chargeScale,
    chargeDistanceMax: params.chargeDistanceMax,
    linkDistance: params.linkDistance,
    mutualDistance: params.mutualDistance,
    mutualBoost: params.mutualBoost,
    centerPull: params.centerPull,
    collideRadius: (node) => nodeWorldRadius(node.degree, maxDegree, params.radiusMin, params.radiusMax) + params.collidePad + GRAPH_LABEL_SLOT,
    collideStrength: params.collideStrength,
    collideIterations: 1,
    ticks: params.ticks,
    degreeOf,
  });
  return {
    nodes,
    edges,
    maxDegree,
    neighbors: adjacency,
    byId,
    alphaMin: simulation.alphaMin(),
    tick: () => {
      simulation.tick();
      return simulation.alpha();
    },
    stop: () => {
      simulation.stop();
    },
  };
}

function selectGraphPages(
  pages: WikiPageSummaryDto[],
  query: string,
  typesOn: Record<string, boolean>,
  orphans: boolean,
): WikiPageSummaryDto[] {
  const needle = query.trim().toLowerCase();
  const typed = pages.filter((page) => {
    if (typesOn[page.type] === false) return false;
    if (!needle) return true;
    return page.title.toLowerCase().includes(needle);
  });
  if (orphans || typed.length === 0) return typed;
  const byTitle = new Map(typed.map((page) => [page.title, page.id]));
  const degree = new Map<string, number>();
  for (const page of typed) {
    for (const link of page.links ?? []) {
      const target = byTitle.get((link.split("#")[0] ?? link).trim());
      if (!target || target === page.id) continue;
      degree.set(page.id, (degree.get(page.id) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }
  return typed.filter((page) => (degree.get(page.id) ?? 0) > 0);
}

function graphLabelAlpha(zoom: number, textFade: number): number {
  if (textFade <= 0.01) return 1;
  const start = 0.9 + textFade * 1.6;
  return Math.max(0, Math.min(1, (zoom - start) / 0.75));
}

function screenNodeRadius(node: ForceNode, camera: number, view: GraphView, maxDegree: number): number {
  const world = nodeWorldRadius(node.degree, maxDegree, view.radiusMin, view.radiusMax) * view.nodeScale;
  return Math.min(Math.max(world * camera, 1.6), 22 * view.nodeScale);
}

type ScreenGraphNode = { id: string; title: string; sx: number; sy: number; radius: number; degree: number };
type PlacedGraphLabel = {
  text: string;
  drawX: number;
  drawY: number;
  anchor: "center";
  alpha: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

function estimateLabelWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    width += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.56;
  }
  return width;
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 3,
): boolean {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}

function underNodeLabel(node: ScreenGraphNode, text: string, fontSize: number): PlacedGraphLabel {
  const width = estimateLabelWidth(text, fontSize);
  const height = fontSize + 2;
  const gap = 3;
  return {
    text,
    alpha: 1,
    anchor: "center",
    drawX: node.sx,
    drawY: node.sy + node.radius + gap + height / 2,
    x: node.sx - width / 2,
    y: node.sy + node.radius + gap,
    w: width,
    h: height,
  };
}

function layoutGraphLabels(input: {
  nodes: ScreenGraphNode[];
  hoverId: string | null;
  neighbors: string[];
  fade: number;
  width: number;
  height: number;
}): PlacedGraphLabel[] {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const hover = input.hoverId ? byId.get(input.hoverId) : undefined;
  let candidates: ScreenGraphNode[] = [];
  if (hover) {
    const neighborNodes = input.neighbors.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    });
    candidates = [hover, ...neighborNodes];
  } else if (input.fade > 0.08) {
    candidates = [...input.nodes].sort((left, right) => right.degree - left.degree || left.title.localeCompare(right.title));
  }
  if (candidates.length === 0) return [];
  const placed: PlacedGraphLabel[] = [];
  for (const node of candidates) {
    const text = graphLabel(node.title);
    const box = underNodeLabel(node, text, GRAPH_LABEL_FONT);
    const required = node.id === hover?.id;
    const outside = box.x < 2 || box.y < 2 || box.x + box.w > input.width - 2 || box.y + box.h > input.height - 2;
    if (!required && outside) continue;
    const crowded = placed.some((other) => boxesOverlap(box, other, 8)) || input.nodes.some((other) => {
      if (other.id === node.id) return false;
      if (Math.abs(other.sx - node.sx) > box.w + other.radius + 24) return false;
      if (Math.abs(other.sy - node.sy) > box.h + other.radius + node.radius + 24) return false;
      const body = { x: other.sx - other.radius, y: other.sy - other.radius, w: other.radius * 2, h: other.radius * 2 };
      return boxesOverlap(box, body, 6);
    });
    if (crowded && !required) continue;
    placed.push({ ...box, text, alpha: hover ? 1 : input.fade });
  }
  return placed;
}

function paintForceGraph(canvas: HTMLCanvasElement, scene: ForceScene, frame: GraphFrame, view: GraphView): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(view.size.width, 1);
  const height = Math.max(view.size.height, 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!Number.isFinite(frame.scale) || !Number.isFinite(frame.cx) || !Number.isFinite(frame.cy)) return;
  const camera = frame.scale * view.zoom;
  const toX = (x: number) => (x - frame.cx) * camera + width / 2 + view.pan.x;
  const toY = (y: number) => (y - frame.cy) * camera + height / 2 + view.pan.y;
  const highlighted = view.hover ? new Set<string>([view.hover, ...(scene.neighbors.get(view.hover) ?? [])]) : null;
  const hotEdge = (edge: ForceEdge) => highlighted !== null && highlighted.has(edge.from) && highlighted.has(edge.to) && (edge.from === view.hover || edge.to === view.hover);
  ctx.lineWidth = Math.max(0.6, view.linkScale);
  ctx.beginPath();
  for (const edge of scene.edges) {
    if (hotEdge(edge)) continue;
    const from = scene.byId.get(edge.from);
    const to = scene.byId.get(edge.to);
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) continue;
    ctx.moveTo(toX(from.x), toY(from.y));
    ctx.lineTo(toX(to.x), toY(to.y));
  }
  ctx.strokeStyle = highlighted ? "rgba(148,163,184,0.12)" : "rgba(148,163,184,0.38)";
  ctx.stroke();
  if (highlighted) {
    ctx.beginPath();
    for (const edge of scene.edges) {
      if (!hotEdge(edge)) continue;
      const from = scene.byId.get(edge.from);
      const to = scene.byId.get(edge.to);
      if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) continue;
      ctx.moveTo(toX(from.x), toY(from.y));
      ctx.lineTo(toX(to.x), toY(to.y));
    }
    ctx.strokeStyle = "rgba(109,40,217,0.9)";
    ctx.lineWidth = Math.max(1.2, view.linkScale * 1.4);
    ctx.stroke();
  }
  const screenNodes: ScreenGraphNode[] = [];
  for (const node of scene.nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const sx = toX(node.x);
    const sy = toY(node.y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    const radius = screenNodeRadius(node, camera, view, scene.maxDegree);
    screenNodes.push({ id: node.id, title: node.title, sx, sy, radius, degree: node.degree });
    if (sx < -30 || sy < -30 || sx > width + 30 || sy > height + 30) continue;
    const hot = highlighted === null || highlighted.has(node.id);
    ctx.globalAlpha = hot ? 1 : 0.16;
    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.fillStyle = graphColor(node.type);
    ctx.fill();
    if (node.id === view.hover) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
  const fade = graphLabelAlpha(view.zoom, view.textFade);
  const onScreen = screenNodes.filter((node) => node.sx > -40 && node.sy > -40 && node.sx < width + 40 && node.sy < height + 40);
  const labels = layoutGraphLabels({
    nodes: onScreen,
    hoverId: view.hover,
    neighbors: view.hover ? scene.neighbors.get(view.hover) ?? [] : [],
    fade,
    width,
    height,
  });
  if (labels.length === 0) return;
  ctx.globalAlpha = 1;
  ctx.font = `${GRAPH_LABEL_FONT}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const label of labels) {
    ctx.textAlign = label.anchor;
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(248,250,252,${label.alpha})`;
    ctx.strokeText(label.text, label.drawX, label.drawY);
    ctx.fillStyle = `rgba(30,41,59,${label.alpha})`;
    ctx.fillText(label.text, label.drawX, label.drawY);
  }
  ctx.textAlign = "left";
}

function hitForceNode(scene: ForceScene, frame: GraphFrame, view: GraphView, sx: number, sy: number): ForceNode | null {
  const camera = frame.scale * view.zoom;
  const wx = (sx - view.size.width / 2 - view.pan.x) / camera + frame.cx;
  const wy = (sy - view.size.height / 2 - view.pan.y) / camera + frame.cy;
  let best: ForceNode | null = null;
  let bestDistance = Infinity;
  for (const node of scene.nodes) {
    const radius = screenNodeRadius(node, camera, view, scene.maxDegree) / Math.max(camera, 0.01);
    const distance = Math.hypot(node.x - wx, node.y - wy);
    if (distance <= radius + 3 / Math.max(camera, 0.01) && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function hashUnit(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function seedForcePositions(
  nodes: ForceNode[],
  adjacency: Map<string, string[]>,
  centerId?: string,
  seedScale = DEFAULT_FORCE_PARAMS.seedScale,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const components = connectedComponents(nodes.map((node) => node.id), adjacency)
    .map((ids) => ids.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    }))
    .filter((group) => group.length > 0)
    .sort((left, right) => right.length - left.length);
  const columns = Math.max(1, Math.ceil(Math.sqrt(components.length)));
  components.forEach((group, index) => {
    const spread = componentSeedRadius(group.length, seedScale);
    const col = index % columns;
    const row = Math.floor(index / columns);
    const anchor = group.find((node) => node.id === centerId) ?? group[0];
    const jitter = spread * 0.35;
    const cx = (col - (columns - 1) / 2) * spread * 1.15 + (hashUnit(`${anchor?.id ?? index}:cx`) - 0.5) * jitter;
    const cy = (row - (Math.ceil(components.length / columns) - 1) / 2) * spread * 1.15 + (hashUnit(`${anchor?.id ?? index}:cy`) - 0.5) * jitter;
    for (const node of group) {
      const u = Math.max(1e-4, hashUnit(`${node.id}:u`));
      const v = hashUnit(`${node.id}:v`);
      const radius = Math.sqrt(-2 * Math.log(u)) * spread * 0.28;
      const angle = Math.PI * 2 * v;
      node.x = cx + Math.cos(angle) * radius;
      node.y = cy + Math.sin(angle) * radius;
      node.vx = (hashUnit(`${node.id}:vx`) - 0.5) * 12;
      node.vy = (hashUnit(`${node.id}:vy`) - 0.5) * 12;
    }
  });
}

function componentSeedRadius(count: number, seedScale: number): number {
  return Math.max(120, seedScale * Math.sqrt(Math.max(count, 1) / Math.PI));
}

function connectedComponents(ids: string[], adjacency: Map<string, string[]>): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let current = id;
    const trail: string[] = [];
    while ((parent.get(current) ?? current) !== current) {
      trail.push(current);
      current = parent.get(current) ?? current;
    }
    for (const item of trail) parent.set(item, current);
    return current;
  };
  for (const id of ids) {
    for (const next of adjacency.get(id) ?? []) {
      const left = find(id);
      const right = find(next);
      if (left !== right) parent.set(right, left);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function NeighborGraph({
  page,
  pages,
  params,
  onParamsChange,
  onOpen,
}: {
  page: WikiPageDto;
  pages: WikiPageSummaryDto[];
  params: ForceLayoutParams;
  onParamsChange: (params: ForceLayoutParams) => void;
  onOpen: (title: string) => void;
}) {
  const [depth, setDepth] = useState(1);
  const local = useMemo(() => neighborhoodPages(page, pages, depth), [depth, page, pages]);
  if (local.length < 2) return null;
  return (
    <WikiForceGraph
      pages={local}
      className="relative mt-2 h-72 w-full"
      centerId={page.id}
      showControls
      params={params}
      onParamsChange={onParamsChange}
      depth={depth}
      onDepthChange={setDepth}
      onOpen={(id) => {
        const target = local.find((item) => item.id === id);
        if (target) onOpen(target.id === page.id ? page.title : target.title);
      }}
    />
  );
}

function neighborhoodPages(page: WikiPageDto, pages: WikiPageSummaryDto[], depth = 1): WikiPageSummaryDto[] {
  const byTitle = new Map(pages.map((item) => [item.title, item]));
  const self: WikiPageSummaryDto = pages.find((item) => item.id === page.id) ?? {
    id: page.id,
    type: page.type,
    status: page.status,
    title: page.title,
    excerpt: page.body.slice(0, 180),
    links: [...page.body.matchAll(/\[\[([^\]]+)\]\]/gu)].flatMap((match) => match[1] ? [match[1]] : []),
    confidence: page.confidence,
    updated_at: page.updated_at
  };
  const wanted = new Map<string, WikiPageSummaryDto>([[self.id, self]]);
  let frontier = [self];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: WikiPageSummaryDto[] = [];
    for (const current of frontier) {
      const bases = new Set((current.links ?? []).map((link) => (link.split("#")[0] ?? link).trim()));
      for (const base of bases) {
        const target = byTitle.get(base);
        if (!target || target.type === "column" || wanted.has(target.id)) continue;
        wanted.set(target.id, target);
        next.push(target);
      }
      for (const item of pages) {
        if (item.type === "column" || wanted.has(item.id)) continue;
        const mentions = (item.links ?? []).some((link) => (link.split("#")[0] ?? link).trim() === current.title);
        if (!mentions) continue;
        wanted.set(item.id, item);
        next.push(item);
      }
    }
    frontier = next;
  }
  return [...wanted.values()];
}

function WikiTreeItems({
  nodes,
  depth,
  selectedId,
  expanded,
  locale,
  onToggle,
  onOpen,
  listItemRefs,
}: {
  nodes: WikiTreeNode[];
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  locale: string;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  listItemRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
}) {
  const t = useT();
  return (
    <>
      {nodes.map((node) => {
        const open = expanded.has(node.id);
        const hasChildren = node.children.length > 0;
        const page = node.page;
        const selected = page ? selectedId === page.id : false;
        const pad = 8 + depth * 12;
        if (node.kind === "group") {
          return (
            <div key={node.id}>
              <button
                type="button"
                style={{ paddingLeft: pad }}
                className="mb-0.5 flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[11px] font-semibold text-muted hover:bg-surface-subtle"
                onClick={() => onToggle(node.id)}
              >
                <span className="w-3 text-muted-light">{open ? "▾" : "▸"}</span>
                <span className="truncate">{node.title}</span>
                <span className="text-[10px] font-normal text-muted-light">{node.children.length}</span>
              </button>
              {open ? (
                <WikiTreeItems
                  nodes={node.children}
                  depth={depth + 1}
                  selectedId={selectedId}
                  expanded={expanded}
                  locale={locale}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  listItemRefs={listItemRefs}
                />
              ) : null}
            </div>
          );
        }
        return (
          <div key={`${depth}:${node.id}`}>
            <button
              type="button"
              ref={page ? (el) => {
                if (el) listItemRefs.current.set(page.id, el);
                else listItemRefs.current.delete(page.id);
              } : undefined}
              style={{ paddingLeft: pad }}
              onClick={() => {
                if (hasChildren) onToggle(node.id);
                if (page) onOpen(page.id);
              }}
              className={[
                "mb-0.5 flex w-full items-start gap-1 rounded-md py-1.5 pr-2 text-left transition",
                selected
                  ? "bg-primary/10 ring-1 ring-inset ring-primary/30"
                  : "hover:bg-surface-subtle",
              ].join(" ")}
            >
              <span className={["mt-0.5 w-3 shrink-0 text-[11px]", selected ? "text-primary" : "text-muted-light"].join(" ")}>
                {hasChildren ? (open ? "▾" : "▸") : "·"}
              </span>
              <span className="min-w-0 flex-1">
                <span className={["block truncate text-sm font-medium", selected ? "text-primary" : "text-foreground"].join(" ")}>
                  {node.title}
                </span>
                {page ? (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-light">
                    <span className="min-w-0 truncate">
                      {t(`wiki.types.${page.type}`)}
                      {page.updated_at ? ` · ${formatRelativeTime(page.updated_at, t, locale)}` : ""}
                    </span>
                    <StatusBadge status={page.status} label={statusLabel(page.status, t)} />
                  </span>
                ) : null}
              </span>
              {selected ? (
                <span className="mt-0.5 shrink-0 text-primary" title={t("wiki.revealInList")} aria-hidden>
                  <LocateIcon />
                </span>
              ) : null}
            </button>
            {hasChildren && open ? (
              <WikiTreeItems
                nodes={node.children}
                depth={depth + 1}
                selectedId={selectedId}
                expanded={expanded}
                locale={locale}
                onToggle={onToggle}
                onOpen={onOpen}
                listItemRefs={listItemRefs}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function buildWikiTree(pages: WikiPageSummaryDto[], query: string, t: TranslateFn): WikiTreeNode[] {
  const needle = query.trim().toLowerCase();
  const matches = (item: WikiPageSummaryDto) =>
    !needle || `${item.title} ${item.excerpt}`.toLowerCase().includes(needle);
  const tables = pages.filter((item) => item.type === "table");
  const domains = pages.filter((item) => item.type === "value-domain" || item.type === "dictionary");
  const relations = pages.filter((item) => item.type === "relation");
  const attached = new Set<string>();

  const tableNodes: WikiTreeNode[] = tables.map((table) => {
    const children: WikiTreeNode[] = [];
    for (const domain of domains) {
      if (domain.title === table.title || domain.title.startsWith(`${table.title}.`)) {
        attached.add(domain.id);
        const leaf = domain.title.startsWith(`${table.title}.`)
          ? domain.title.slice(table.title.length + 1)
          : domain.title;
        children.push(pageNode(domain, leaf));
      }
    }
    for (const relation of relations) {
      const linked = (relation.links ?? []).some((link) => (link.split("#")[0] ?? link) === table.title);
      if (linked || relation.title.includes(table.title)) {
        attached.add(relation.id);
        children.push(pageNode(relation, relation.title));
      }
    }
    children.sort((left, right) => {
      const typeOrder = ((left.page?.type === "value-domain" || left.page?.type === "dictionary") ? 0 : 1)
        - ((right.page?.type === "value-domain" || right.page?.type === "dictionary") ? 0 : 1);
      return typeOrder !== 0 ? typeOrder : left.title.localeCompare(right.title);
    });
    const tableMatch = matches(table);
    const visibleChildren = needle
      ? children.filter((child) => child.page && (tableMatch || matches(child.page)))
      : children;
    return {
      id: table.id,
      title: table.title,
      kind: "page" as const,
      type: "table",
      page: table,
      children: visibleChildren,
    };
  }).filter((node) => !needle || matches(node.page!) || node.children.length > 0);

  const tree: WikiTreeNode[] = [];
  const visibleTables = tableNodes.sort((left, right) => left.title.localeCompare(right.title));
  if (visibleTables.length > 0) {
    tree.push({
      id: "group:table",
      title: t("wiki.types.table"),
      kind: "group",
      type: "table",
      children: visibleTables,
    });
  }

  const leftoverTypes = ["relation", "value-domain", "dictionary", "concept", "metric", "query-pattern", "contradiction"] as const;
  for (const type of leftoverTypes) {
    const items = pages.filter((item) => item.type === type && !attached.has(item.id) && matches(item));
    if (items.length === 0) continue;
    tree.push({
      id: `group:${type}`,
      title: t(`wiki.types.${type}`),
      kind: "group",
      type,
      children: items
        .slice()
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((item) => pageNode(item, item.title)),
    });
  }
  return tree;
}

function buildWikiTypeTree(pages: WikiPageSummaryDto[], query: string, t: TranslateFn): WikiTreeNode[] {
  const needle = query.trim().toLowerCase();
  const matches = (item: WikiPageSummaryDto) =>
    !needle || `${item.title} ${item.excerpt}`.toLowerCase().includes(needle);
  return PAGE_TYPES.flatMap((type): WikiTreeNode[] => {
    const items = pages
      .filter((item) => item.type === type && matches(item))
      .slice()
      .sort((left, right) => left.title.localeCompare(right.title));
    if (items.length === 0) return [];
    if (type === "value-domain") {
      const dictionaries = items.filter((item) => domainKindOf(item) === "dictionary");
      const domains = items.filter((item) => domainKindOf(item) !== "dictionary");
      return [
        ...(domains.length > 0 ? [{
          id: "group:value-domain",
          title: t("wiki.types.value-domain"),
          kind: "group" as const,
          type,
          children: domains.map((item) => pageNode(item, item.title)),
        }] : []),
        ...(dictionaries.length > 0 ? [{
          id: "group:dictionary",
          title: t("wiki.role.dictionary"),
          kind: "group" as const,
          type,
          children: dictionaries.map((item) => pageNode(item, item.title)),
        }] : []),
      ];
    }
    return [{
      id: `group:${type}`,
      title: t(`wiki.types.${type}`),
      kind: "group" as const,
      type,
      children: items.map((item) => pageNode(item, item.title)),
    }];
  });
}

function pageNode(page: WikiPageSummaryDto, title: string): WikiTreeNode {
  return { id: page.id, title, kind: "page", type: page.type, page, children: [] };
}

function findTreePath(nodes: WikiTreeNode[], pageId: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    const next = [...trail, node.id];
    if (node.page?.id === pageId) return next;
    const nested = findTreePath(node.children, pageId, next);
    if (nested) return nested;
  }
  return null;
}

function collectExpandableIds(nodes: WikiTreeNode[]): string[] {
  return nodes.flatMap((node) => (
    node.children.length > 0 ? [node.id, ...collectExpandableIds(node.children)] : []
  ));
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = status === "auto"
    ? "bg-emerald-50 text-emerald-700"
    : status === "human"
      ? "bg-amber-50 text-amber-700"
      : status === "rejected" || status === "auto-rejected"
        ? "bg-rose-50 text-rose-700"
        : "bg-slate-100 text-slate-600";
  return <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] ${tone}`}>{label}</span>;
}

function statusLabel(status: string, t: ReturnType<typeof useT>): string {
  const key = `wiki.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

function WikiTabMenu({
  x,
  y,
  closeLabel,
  closeOthersLabel,
  closeAllLabel,
  disableCloseOthers,
  onClose,
  onCloseOthers,
  onCloseAll,
  onDismiss,
}: {
  x: number;
  y: number;
  closeLabel: string;
  closeOthersLabel: string;
  closeAllLabel: string;
  disableCloseOthers: boolean;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    const onPointer = (event: globalThis.MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [onDismiss]);
  const itemClass = "block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-surface-subtle disabled:cursor-default disabled:text-muted-light disabled:hover:bg-transparent";
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[80] min-w-[9rem] rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-card)]"
      style={{ left: x, top: y }}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onClose}>{closeLabel}</button>
      <button type="button" role="menuitem" className={itemClass} disabled={disableCloseOthers} onClick={onCloseOthers}>{closeOthersLabel}</button>
      <button type="button" role="menuitem" className={itemClass} onClick={onCloseAll}>{closeAllLabel}</button>
    </div>,
    document.body,
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M15 6 9 12l6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PanelCollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 5v14" />
      <path d="M7 12H5.5M7 12l-1.5-1.5M7 12l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PanelExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 5v14" />
      <path d="M5.5 12H7M5.5 12l1.5-1.5M5.5 12l1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeLinecap="round" />
    </svg>
  );
}

function OutlineIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M8 6h12M8 12h12M8 18h12" strokeLinecap="round" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M20 12a8 8 0 1 1-2.2-5.5" strokeLinecap="round" />
      <path d="M20 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="8" className="opacity-25" />
      <path d="M20 12a8 8 0 0 0-8-8" strokeLinecap="round" />
    </svg>
  );
}
