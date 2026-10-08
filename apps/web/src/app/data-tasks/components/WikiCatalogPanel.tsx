"use client";

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { configApi } from "../../../lib/config-api";
import type { WikiPageDto, WikiPageSummaryDto } from "../../../lib/config-api";
import { useT } from "../../../i18n/locale-context";
import { btnGhostClass, btnPrimaryClass, btnSecondaryClass } from "../ui-tokens";

const PAGE_TYPES = [
  "table",
  "relation",
  "value-domain",
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

const DEFAULT_FORCE_PARAMS: ForceLayoutParams = {
  massAlpha: 0.75,
  chargeScale: 900,
  chargeDistanceMax: 1000,
  linkDistance: 200,
  mutualDistance: 200,
  mutualBoost: 1.8,
  collidePad: 6,
  collideStrength: 0.5,
  centerPull: 0.02,
  seedScale: 175,
  ticks: 300,
  radiusMin: 8,
  radiusMax: 30,
  labelMode: "auto",
};

type WikiCatalogPanelProps = {
  onBack: () => void;
  onCount?: (count: number) => void;
  datasources?: Array<{ id: string; name: string }>;
  defaultDatasourceId?: string;
};

export function WikiCatalogPanel({ onBack, onCount, datasources = [], defaultDatasourceId }: WikiCatalogPanelProps) {
  const t = useT();
  const [pages, setPages] = useState<WikiPageSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<WikiPageDto | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [findings, setFindings] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [datasourceId, setDatasourceId] = useState(defaultDatasourceId || datasources[0]?.id || "");
  const [tabs, setTabs] = useState<Array<{ id: string; kind: "page" | "graph" }>>([]);
  const [listOpen, setListOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "run" | "ok" | "err"; text: string } | null>(null);
  const [runningAction, setRunningAction] = useState<"lint" | "refresh" | "save" | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [forceParams, setForceParams] = useState<ForceLayoutParams>(DEFAULT_FORCE_PARAMS);
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
    void refresh();
  }, [refresh]);

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
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (!needle) return true;
      return `${item.title} ${item.excerpt}`.toLowerCase().includes(needle);
    });
  }, [datasourceId, pages, query, typeFilter]);

  const revealInList = (id: string) => {
    const item = pages.find((entry) => entry.id === id && entry.type !== "column");
    if (!item) return;
    if (datasourceId && !(item.source_ids ?? []).includes(datasourceId)) setDatasourceId("");
    if (typeFilter !== "all" && item.type !== typeFilter) setTypeFilter("all");
    const needle = query.trim().toLowerCase();
    if (needle && !`${item.title} ${item.excerpt}`.toLowerCase().includes(needle)) setQuery("");
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
    if (!selectedId) return;
    listItemRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, visiblePages]);

  useEffect(() => {
    if (!anchor || !page) return;
    document.getElementById(`wiki-column-${anchor}`)?.scrollIntoView({ block: "start" });
  }, [anchor, page]);

  const runTracked = async (kind: "lint" | "refresh" | "save", running: string, done: string, action: () => Promise<void>) => {
    setBusy(true);
    setRunningAction(kind);
    setError(null);
    setNotice({ tone: "run", text: running });
    try {
      await action();
      setNotice({ tone: "ok", text: done });
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : t("wiki.loadFailed");
      setError(message);
      setNotice({ tone: "err", text: message });
    } finally {
      setBusy(false);
      setRunningAction(null);
    }
  };

  const runLint = async () => {
    await runTracked("lint", t("wiki.lintRunning"), t("wiki.lintDone"), async () => {
      const result = await configApi.lintWiki();
      setFindings(result.findings);
    });
  };

  const refreshMetrics = async (column?: string) => {
    if (!page) return;
    setRefreshingKey(column ?? "*");
    await runTracked(
      "refresh",
      column ? t("wiki.refreshColumnRunning", { column }) : t("wiki.refreshTableRunning"),
      column ? t("wiki.refreshColumnDone", { column }) : t("wiki.refreshTableDone"),
      async () => {
        const loaded = await configApi.refreshWikiTable(page.id, column);
        setPage(loaded);
        setDrafts(Object.fromEntries((loaded.fields ?? []).map((item) => [item.key, item.text])));
        await refresh();
      },
    );
    setRefreshingKey(null);
  };

  const saveField = async (field: string) => {
    const text = drafts[field]?.trim() ?? "";
    if (!page || !text) return;
    await runTracked("save", t("wiki.saveRunning"), t("wiki.saveDone"), async () => {
      await configApi.pinWikiPage(page.id, text, field);
      const loaded = await configApi.getWikiPage(page.id);
      setPage(loaded);
      setDrafts(Object.fromEntries((loaded.fields ?? []).map((item) => [item.key, item.text])));
      await refresh();
    });
  };

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

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4">
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
          <h2 className="truncate text-sm font-semibold text-foreground">{t("wiki.title")}</h2>
          <p className="truncate text-xs text-muted-light">{t("wiki.description")}</p>
        </div>
        <select
          value={datasourceId}
          onChange={(event) => setDatasourceId(event.target.value)}
          className="h-8 max-w-40 rounded-lg border border-border bg-surface px-2 text-xs"
          aria-label={t("wiki.datasource")}
        >
          {datasources.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
          <option value="">{t("wiki.allSources")}</option>
        </select>
        <button type="button" className={btnSecondaryClass} onClick={openGraph}>
          {t("wiki.globalGraph")}
        </button>
        <button type="button" className={btnSecondaryClass} disabled={busy} onClick={() => void runLint()}>
          {runningAction === "lint" ? (
            <span className="inline-flex items-center gap-1.5">
              <SpinnerIcon />
              {t("wiki.lintRunning")}
            </span>
          ) : t("wiki.lint")}
        </button>
      </header>

      {error ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">{error}</div>
      ) : null}
      {notice ? (
        <div className={notice.tone === "err"
          ? "border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800"
          : notice.tone === "ok"
            ? "border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800"
            : "border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800"}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {listOpen ? (
          <aside className="relative flex w-72 shrink-0 flex-col border-r border-border">
            <div className="flex h-9 shrink-0 items-center justify-end border-b border-border px-2">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-subtle hover:text-foreground"
                aria-label={t("wiki.hideList")}
                title={t("wiki.hideList")}
                onClick={() => setListOpen(false)}
              >
                <PanelCollapseIcon />
              </button>
            </div>
            <div className="space-y-2 border-b border-border p-3">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("wiki.search")}
                className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-muted-light"
              />
              <div className="flex flex-wrap gap-1">
                <FilterChip active={typeFilter === "all"} label={t("wiki.allTypes")} onClick={() => setTypeFilter("all")} />
                {PAGE_TYPES.map((type) => (
                  <FilterChip key={type} active={typeFilter === type} label={t(`wiki.types.${type}`)} onClick={() => setTypeFilter(type)} />
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? <p className="px-2 py-3 text-xs text-muted-light">{t("configPanel.loading")}</p> : null}
              {!loading && visiblePages.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-light">{t("wiki.empty")}</p>
              ) : (
                visiblePages.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    ref={(node) => {
                      if (node) listItemRefs.current.set(item.id, node);
                      else listItemRefs.current.delete(item.id);
                    }}
                    onClick={() => openPage(item.id)}
                    className={[
                      "mb-1 w-full rounded-lg px-2 py-2 text-left transition",
                      selectedId === item.id ? "bg-surface shadow-[var(--shadow-card)]" : "hover:bg-surface-subtle",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{item.title}</span>
                      <StatusBadge status={item.status} label={statusLabel(item.status, t)} />
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-light">
                      {t(`wiki.types.${item.type}`)}{item.authority ? ` · ${item.authority}` : ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
        ) : (
          <button
            type="button"
            className="flex w-8 shrink-0 items-start justify-center border-r border-border pt-2 text-muted hover:bg-surface-subtle hover:text-foreground"
            aria-label={t("wiki.showList")}
            title={t("wiki.showList")}
            onClick={() => setListOpen(true)}
          >
            <PanelExpandIcon />
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-surface-subtle px-1">
            {tabs.map((tab) => {
              const title = tab.kind === "graph"
                ? t("wiki.globalGraph")
                : pages.find((item) => item.id === tab.id)?.title ?? tab.id;
              const active = tab.id === selectedId;
              return (
                <div key={tab.id} className={active
                  ? "flex h-8 items-center gap-1 rounded-t-md border border-b-0 border-border bg-surface px-2.5"
                  : "flex h-8 items-center gap-1 rounded-t-md px-2.5 text-muted hover:bg-surface/60"}
                >
                  <button type="button" className="max-w-44 truncate text-xs" onClick={() => { setSelectedId(tab.id); if (tab.kind !== "graph") setAnchor(null); }}>{title}</button>
                  <button type="button" className="flex h-4 w-4 items-center justify-center rounded text-xs text-muted-light hover:bg-surface-subtle hover:text-foreground" aria-label={t("common.close")} onClick={() => closeTab(tab.id)}>×</button>
                </div>
              );
            })}
          </div>
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
            {findings ? (
              <div className="mb-4 rounded-lg border border-border bg-surface-subtle px-3 py-2">
                <p className="text-xs font-semibold text-foreground">{t("wiki.findings")}</p>
                {findings.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-light">{t("wiki.noFindings")}</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-xs text-muted">
                    {findings.map((finding) => <li key={finding}>{finding}</li>)}
                  </ul>
                )}
              </div>
            ) : null}
            {page ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-foreground">{page.title}</h3>
                    <p className="mt-1 text-xs text-muted-light">
                      {t(`wiki.types.${page.type}`)}
                      {page.claim_domain ? ` · ${t("wiki.domain")} ${page.claim_domain}` : ""}
                      {page.authority ? ` · ${t("wiki.authority")} ${page.authority}` : ""}
                    </p>
                  </div>
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
                </div>
                {page.type === "table" ? (
                  <TableColumns
                    page={page}
                    drafts={drafts}
                    anchor={anchor}
                    busy={busy}
                    refreshingKey={refreshingKey}
                    onDraft={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
                    onSave={(key) => void saveField(key)}
                    onRefresh={(column) => void refreshMetrics(column)}
                    onOpen={openTitle}
                  />
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
  onDraft,
  onSave,
  onRefresh,
  onOpen,
}: {
  page: WikiPageDto;
  drafts: Record<string, string>;
  anchor: string | null;
  busy: boolean;
  refreshingKey: string | null;
  onDraft: (key: string, value: string) => void;
  onSave: (key: string) => void;
  onRefresh: (column?: string) => void;
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
  return (
    <div className="space-y-2">
      {links ? <LinkedText text={links} onOpen={onOpen} /> : null}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{t("wiki.columns")}</p>
        <button type="button" className={`${btnGhostClass} inline-flex items-center gap-1.5`} disabled={busy} onClick={() => onRefresh()}>
          {busy && refreshingKey === "*" ? <><SpinnerIcon />{t("wiki.refreshTableRunning")}</> : t("wiki.refreshTable")}
        </button>
      </div>
      {columns.map((column) => {
        const expanded = open.has(column.name);
        const draft = drafts[column.name] ?? column.label;
        const dirty = draft.trim() !== column.label.trim();
        return (
          <article
            key={column.name}
            id={`wiki-column-${column.name}`}
            className={anchor === column.name ? "scroll-mt-4 rounded-lg border border-primary bg-primary/5 px-2 py-1.5" : "scroll-mt-4 rounded-lg border border-border px-2 py-1.5"}
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-foreground"
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
              <StatusBadge status={column.labelStatus} label={statusLabel(column.labelStatus, t)} />
              <input
                value={draft}
                aria-label={t("wiki.businessName")}
                placeholder={t("wiki.businessName")}
                onChange={(event) => onDraft(column.name, event.target.value)}
                className="h-7 w-28 shrink-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-muted-light"
              />
              {dirty ? (
                <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs text-white" disabled={busy} title={t("wiki.approveHuman")} aria-label={t("wiki.approveHuman")} onClick={() => onSave(column.name)}>
                  ✓
                </button>
              ) : null}
              <button type="button" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-subtle" disabled={busy} title={t("wiki.refreshColumn")} aria-label={t("wiki.refreshColumn")} onClick={() => onRefresh(column.name)}>
                {busy && refreshingKey === column.name ? <SpinnerIcon /> : <RefreshIcon />}
              </button>
            </div>
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
}: {
  pages: WikiPageSummaryDto[];
  onOpen: (id: string) => void;
  className: string;
  centerId?: string;
  showControls?: boolean;
  params: ForceLayoutParams;
  onParamsChange: (params: ForceLayoutParams) => void;
}) {
  const t = useT();
  const [panelOpen, setPanelOpen] = useState(false);
  const model = useMemo(() => settleForceModel(pages, centerId, params), [centerId, pages, params]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const active = hover ?? focus;
  const frame = graphFrame(model.nodes, size.width, size.height);
  const camera = frame.scale * zoom;
  const nodeRadius = (node: ForceNode) => nodeWorldRadius(node.degree, model.maxDegree, params.radiusMin, params.radiusMax) / (frame.scale * Math.sqrt(zoom));
  const highlighted = useMemo(() => {
    if (!active) return null;
    const ids = new Set<string>([active]);
    for (const edge of model.edges) {
      if (edge.from === active) ids.add(edge.to);
      if (edge.to === active) ids.add(edge.from);
    }
    return ids;
  }, [active, model.edges]);
  const labelLayouts = useMemo(() => {
    const candidates = highlighted
      ? model.nodes.filter((node) => highlighted.has(node.id))
      : model.nodes;
    const mode = highlighted ? "always" : params.labelMode;
    return pickLabelLayouts(candidates, model.nodes, (node) => nodeRadius(node), camera, mode);
  }, [camera, highlighted, model.nodes, params.labelMode, params.radiusMax, params.radiusMin, model.maxDegree, zoom, frame.scale]);

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
    setFocus(null);
  }, [centerId, pages]);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      setZoom((current) => Math.min(4, Math.max(0.35, current * factor)));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const changeZoom = (factor: number) => setZoom((current) => Math.min(4, Math.max(0.35, current * factor)));
  const setParam = <K extends keyof ForceLayoutParams>(key: K, value: ForceLayoutParams[K]) => {
    onParamsChange({ ...params, [key]: value });
  };
  return (
    <div ref={boxRef} className={className}>
      {showControls ? (
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <button type="button" className={btnSecondaryClass} onClick={() => changeZoom(1.2)}>{t("wiki.zoomIn")}</button>
          <button type="button" className={btnSecondaryClass} onClick={() => changeZoom(1 / 1.2)}>{t("wiki.zoomOut")}</button>
          <button type="button" className={btnSecondaryClass} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{t("wiki.resetView")}</button>
          <button type="button" className={btnSecondaryClass} onClick={() => setPanelOpen((open) => !open)}>
            {panelOpen ? t("wiki.forceHide") : t("wiki.forceSettings")}
          </button>
        </div>
      ) : null}
      {panelOpen ? (
        <div
          className="absolute right-2 top-12 z-10 w-64 max-h-[min(70%,28rem)] overflow-auto rounded-md border border-slate-200 bg-white/95 p-2 text-xs shadow-sm backdrop-blur"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium text-slate-800">{t("wiki.forcePanel")}</span>
            <button type="button" className={btnGhostClass} onClick={() => onParamsChange(DEFAULT_FORCE_PARAMS)}>{t("wiki.forceReset")}</button>
          </div>
          <div className="space-y-2 text-slate-600">
            <label className="block">
              <span className="mb-1 block">{t("wiki.forceLabelMode")}</span>
              <select
                className="h-7 w-full rounded border border-slate-200 bg-white px-1.5 text-xs text-slate-800 outline-none"
                value={params.labelMode}
                onChange={(event) => setParam("labelMode", event.target.value as ForceLayoutParams["labelMode"])}
              >
                <option value="auto">{t("wiki.forceLabelAuto")}</option>
                <option value="always">{t("wiki.forceLabelAlways")}</option>
                <option value="never">{t("wiki.forceLabelNever")}</option>
              </select>
            </label>
            <ForceSlider label={t("wiki.forceMassAlpha")} value={params.massAlpha} min={0.05} max={0.9} step={0.05} onChange={(value) => setParam("massAlpha", value)} />
            <ForceSlider label={t("wiki.forceRadiusMin")} value={params.radiusMin} min={2} max={16} step={1} onChange={(value) => setParam("radiusMin", value)} />
            <ForceSlider label={t("wiki.forceRadiusMax")} value={params.radiusMax} min={12} max={56} step={1} onChange={(value) => setParam("radiusMax", Math.max(value, params.radiusMin + 4))} />
            <ForceSlider label={t("wiki.forceCharge")} value={params.chargeScale} min={80} max={1200} step={20} onChange={(value) => setParam("chargeScale", value)} />
            <ForceSlider label={t("wiki.forceChargeMax")} value={params.chargeDistanceMax} min={200} max={1600} step={50} onChange={(value) => setParam("chargeDistanceMax", value)} />
            <ForceSlider label={t("wiki.forceLinkDistance")} value={params.linkDistance} min={80} max={400} step={10} onChange={(value) => setParam("linkDistance", value)} />
            <ForceSlider label={t("wiki.forceMutualDistance")} value={params.mutualDistance} min={60} max={320} step={10} onChange={(value) => setParam("mutualDistance", value)} />
            <ForceSlider label={t("wiki.forceMutualBoost")} value={params.mutualBoost} min={1} max={2.2} step={0.05} onChange={(value) => setParam("mutualBoost", value)} />
            <ForceSlider label={t("wiki.forceCollidePad")} value={params.collidePad} min={0} max={48} step={1} onChange={(value) => setParam("collidePad", value)} />
            <ForceSlider label={t("wiki.forceCollideStrength")} value={params.collideStrength} min={0.1} max={1} step={0.05} onChange={(value) => setParam("collideStrength", value)} />
            <ForceSlider label={t("wiki.forceCenterPull")} value={params.centerPull} min={0.02} max={0.5} step={0.02} onChange={(value) => setParam("centerPull", value)} />
            <ForceSlider label={t("wiki.forceSeedScale")} value={params.seedScale} min={80} max={280} step={5} onChange={(value) => setParam("seedScale", value)} />
            <ForceSlider label={t("wiki.forceTicks")} value={params.ticks} min={80} max={600} step={20} onChange={(value) => setParam("ticks", value)} />
          </div>
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        className="h-full w-full cursor-grab bg-[radial-gradient(circle_at_center,rgba(120,140,170,0.08),transparent_62%)] text-foreground active:cursor-grabbing"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, ox: pan.x, oy: pan.y, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (Math.hypot(dx, dy) > 3) current.moved = true;
          setPan({ x: current.ox + dx, y: current.oy + dy });
        }}
        onPointerUp={() => {
          moved.current = drag.current?.moved ?? false;
          drag.current = null;
        }}
        onClick={() => {
          if (moved.current) return;
          setFocus(null);
        }}
      >
        <g transform={`translate(${size.width / 2 + pan.x} ${size.height / 2 + pan.y}) scale(${camera}) translate(${-frame.cx} ${-frame.cy})`}>
          {model.edges.map((edge) => {
            const from = model.nodes.find((node) => node.id === edge.from);
            const to = model.nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            const hot = highlighted !== null && highlighted.has(edge.from) && highlighted.has(edge.to) && (edge.from === active || edge.to === active);
            const blockers = model.nodes.filter((node) => node.id !== from.id && node.id !== to.id).map((node) => ({
              x: node.x,
              y: node.y,
              r: nodeRadius(node) + 6 / camera,
            }));
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={routeEdge(from, to, blockers)}
                fill="none"
                stroke={hot ? "#6d28d9" : "#94a3b8"}
                strokeWidth={(hot ? 1.6 : 1) / camera}
                strokeOpacity={highlighted ? (hot ? 0.9 : 0.2) : 0.35}
                style={{ transition: "stroke-opacity 160ms ease" }}
              />
            );
          })}
          {model.nodes.map((node) => {
            const radius = nodeRadius(node);
            const hot = highlighted === null || highlighted.has(node.id);
            const selected = node.id === active;
            const label = labelLayouts.get(node.id);
            return (
              <g
                key={node.id}
                opacity={hot ? 1 : 0.2}
                style={{ transition: "opacity 160ms ease" }}
                className="cursor-pointer"
                onClick={(event) => {
                  if (moved.current) {
                    moved.current = false;
                    return;
                  }
                  event.stopPropagation();
                  onOpen(node.id);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onOpen(node.id);
                }}
                onPointerEnter={() => setHover(node.id)}
                onPointerLeave={() => setHover((current) => current === node.id ? null : current)}
              >
                <title>{node.title}</title>
                <circle cx={node.x} cy={node.y} r={radius + 3 / camera} fill="#f8fafc" />
                {selected ? <circle cx={node.x} cy={node.y} r={radius + 7 / camera} fill={graphColor(node.type)} fillOpacity="0.16" /> : null}
                <circle cx={node.x} cy={node.y} r={radius} fill={graphColor(node.type)} />
                {label ? (
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor={label.anchor}
                    fontSize={12 / camera}
                    fill="#1e293b"
                    stroke="#f8fafc"
                    strokeWidth={3 / camera}
                    paintOrder="stroke"
                  >
                    {graphLabel(node.title)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
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

function estimateLabelWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    width += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.55;
  }
  return width;
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 2,
): boolean {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}

type LabelSide = "right" | "left" | "top" | "bottom";
type LabelLayout = { x: number; y: number; anchor: "start" | "middle" | "end" };

function preferredLabelSides(node: ForceNode, cx: number, cy: number): LabelSide[] {
  const dx = node.x - cx;
  const dy = node.y - cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? ["right", "top", "bottom", "left"]
      : ["left", "top", "bottom", "right"];
  }
  return dy >= 0
    ? ["bottom", "right", "left", "top"]
    : ["top", "right", "left", "bottom"];
}

function labelPlacement(
  node: ForceNode,
  radius: number,
  side: LabelSide,
  text: string,
  fontSize: number,
  gap: number,
): { box: { x: number; y: number; w: number; h: number }; layout: LabelLayout } {
  const width = estimateLabelWidth(text, fontSize);
  const height = fontSize * 1.25;
  if (side === "left") {
    return {
      box: { x: node.x - radius - gap - width, y: node.y - height * 0.45, w: width, h: height },
      layout: { x: node.x - radius - gap, y: node.y + fontSize * 0.35, anchor: "end" },
    };
  }
  if (side === "top") {
    return {
      box: { x: node.x - width / 2, y: node.y - radius - gap - height, w: width, h: height },
      layout: { x: node.x, y: node.y - radius - gap - fontSize * 0.15, anchor: "middle" },
    };
  }
  if (side === "bottom") {
    return {
      box: { x: node.x - width / 2, y: node.y + radius + gap, w: width, h: height },
      layout: { x: node.x, y: node.y + radius + gap + fontSize * 0.85, anchor: "middle" },
    };
  }
  return {
    box: { x: node.x + radius + gap, y: node.y - height * 0.45, w: width, h: height },
    layout: { x: node.x + radius + gap, y: node.y + fontSize * 0.35, anchor: "start" },
  };
}

function pickLabelLayouts(
  candidates: ForceNode[],
  allNodes: ForceNode[],
  radiusOf: (node: ForceNode) => number,
  camera: number,
  mode: ForceLayoutParams["labelMode"],
): Map<string, LabelLayout> {
  const layouts = new Map<string, LabelLayout>();
  if (mode === "never" || candidates.length === 0) return layouts;
  const force = mode === "always";
  const fontSize = 12 / Math.max(camera, 0.01);
  const gap = 6 / Math.max(camera, 0.01);
  const cx = allNodes.reduce((sum, node) => sum + node.x, 0) / Math.max(allNodes.length, 1);
  const cy = allNodes.reduce((sum, node) => sum + node.y, 0) / Math.max(allNodes.length, 1);
  const ranked = [...candidates].sort((left, right) => {
    if (right.degree !== left.degree) return right.degree - left.degree;
    if (right.mass !== left.mass) return right.mass - left.mass;
    return left.title.localeCompare(right.title);
  });
  const occupied: Array<{ x: number; y: number; w: number; h: number; owner?: string }> = allNodes.map((node) => {
    const radius = radiusOf(node);
    return { x: node.x - radius, y: node.y - radius, w: radius * 2, h: radius * 2, owner: node.id };
  });
  for (const node of ranked) {
    const radius = radiusOf(node);
    const text = graphLabel(node.title);
    const sides = preferredLabelSides(node, cx, cy);
    let chosen: { box: { x: number; y: number; w: number; h: number }; layout: LabelLayout } | null = null;
    for (const side of sides) {
      const placement = labelPlacement(node, radius, side, text, fontSize, gap);
      const blocked = occupied.some((other) => other.owner !== node.id && boxesOverlap(placement.box, other));
      if (!blocked) {
        chosen = placement;
        break;
      }
    }
    if (!chosen && force) {
      chosen = labelPlacement(node, radius, sides[0] ?? "right", text, fontSize, gap);
    }
    if (!chosen) continue;
    occupied.push({ ...chosen.box, owner: node.id });
    layouts.set(node.id, chosen.layout);
  }
  return layouts;
}

function routeEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  blockers: Array<{ x: number; y: number; r: number }>,
): string {
  let points = [from, to];
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    const next = [points[0]];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (!start || !end) continue;
      let worst: { t: number; nx: number; ny: number; need: number } | null = null;
      for (const blocker of blockers) {
        const hit = distanceToSegment(blocker.x, blocker.y, start.x, start.y, end.x, end.y);
        if (hit.t <= 0.04 || hit.t >= 0.96 || hit.distance >= blocker.r) continue;
        const need = blocker.r - hit.distance;
        if (!worst || need > worst.need) worst = { t: hit.t, nx: hit.nx, ny: hit.ny, need };
      }
      if (worst) {
        next.push({
          x: start.x + (end.x - start.x) * worst.t - worst.nx * (worst.need + 2),
          y: start.y + (end.y - start.y) * worst.t - worst.ny * (worst.need + 2),
        });
        moved = true;
      }
      next.push(end);
    }
    points = next.filter((point): point is { x: number; y: number } => point !== undefined);
    if (!moved || points.length > 10) break;
  }
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; nx: number; ny: number; t: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / length2));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  const distance = Math.hypot(dx, dy) || 0.1;
  return { distance, nx: dx / distance, ny: dy / distance, t };
}

function graphLabel(title: string): string {
  const max = 22;
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function graphFrame(nodes: ForceNode[], width: number, height: number): { cx: number; cy: number; scale: number } {
  if (nodes.length === 0) return { cx: 0, cy: 0, scale: 1 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const spanX = Math.max(maxX - minX, 48);
  const spanY = Math.max(maxY - minY, 48);
  const scale = Math.min(Math.max(Math.min((width - 96) / spanX, (height - 96) / spanY), 0.2), 2.4);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale };
}

function graphColor(type: string): string {
  if (type === "table") return "#334155";
  if (type === "relation") return "#7c3aed";
  if (type === "value-domain") return "#0f766e";
  if (type === "concept") return "#b45309";
  if (type === "metric") return "#1d4ed8";
  if (type === "query-pattern") return "#be123c";
  return "#64748b";
}

type ForceNode = { id: string; title: string; type: string; x: number; y: number; degree: number; mass: number };
type ForceEdge = { from: string; to: string; mutual: boolean };
type ForceModel = { nodes: ForceNode[]; edges: ForceEdge[]; maxDegree: number };

function settleForceModel(pages: WikiPageSummaryDto[], centerId?: string, params: ForceLayoutParams = DEFAULT_FORCE_PARAMS): ForceModel {
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
  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree));
  seedForcePositions(nodes, adjacency, centerId, params.seedScale);
  const links = edges.map((edge) => ({ source: edge.from, target: edge.to, mutual: edge.mutual }));
  const degreeOf = new Map(nodes.map((node) => [node.id, node.degree]));
  const massOf = new Map(nodes.map((node) => [node.id, node.mass]));
  const endId = (end: unknown): string => {
    if (typeof end === "string") return end;
    if (end && typeof end === "object" && "id" in end) return String((end as { id: string }).id);
    return "";
  };
  const hubPull = Math.min(0.6, params.centerPull * 4);
  const simulation = forceSimulation(nodes)
    .force("charge", forceManyBody<ForceNode>().strength((node) => -params.chargeScale * node.mass).distanceMin(30).distanceMax(params.chargeDistanceMax).theta(0.9))
    .force("link", forceLink<ForceNode, { source: string; target: string; mutual: boolean }>(links).id((node) => node.id).distance((link) => {
      return link.mutual ? params.mutualDistance : params.linkDistance;
    }).strength((link) => {
      const sourceId = endId(link.source);
      const targetId = endId(link.target);
      const base = 1 / Math.min(degreeOf.get(sourceId) || 1, degreeOf.get(targetId) || 1);
      const massBoost = Math.sqrt((massOf.get(sourceId) || 0.1) * (massOf.get(targetId) || 0.1));
      return Math.min(0.9, base * (link.mutual ? params.mutualBoost : 1) * (0.65 + 0.2 * massBoost));
    }))
    .force("x", forceX<ForceNode>(0).strength((node) => node.id === centerId ? hubPull : params.centerPull))
    .force("y", forceY<ForceNode>(0).strength((node) => node.id === centerId ? hubPull : params.centerPull))
    .force("collide", forceCollide<ForceNode>().radius((node) => nodeWorldRadius(node.degree, maxDegree, params.radiusMin, params.radiusMax) + params.collidePad).strength(params.collideStrength).iterations(2))
    .stop();
  for (let step = 0; step < params.ticks; step += 1) simulation.tick();
  return {
    nodes: nodes.map((node) => ({ ...node, x: node.x ?? 0, y: node.y ?? 0 })),
    edges,
    maxDegree,
  };
}

function seedForcePositions(
  nodes: ForceNode[],
  adjacency: Map<string, string[]>,
  centerId?: string,
  seedScale = DEFAULT_FORCE_PARAMS.seedScale,
): void {
  const components = connectedComponents(nodes.map((node) => node.id), adjacency)
    .map((ids) => ids.map((id) => nodes.find((node) => node.id === id)).filter((node): node is ForceNode => Boolean(node)))
    .filter((group) => group.length > 0)
    .sort((left, right) => right.length - left.length);
  const radii = components.map((group) => componentSeedRadius(group.length, seedScale));
  const largest = Math.max(0, ...radii);
  const ring = components.length > 1 ? radii.reduce((sum, radius) => sum + radius, 0) / Math.PI + largest : 0;
  components.forEach((group, index) => {
    const radius = radii[index] ?? 80;
    const angle = components.length > 1 ? (Math.PI * 2 * index) / components.length : 0;
    const cx = ring * Math.cos(angle);
    const cy = ring * Math.sin(angle);
    const hub = (centerId ? group.find((node) => node.id === centerId) : undefined)
      ?? group.reduce((best, node) => node.degree > best.degree ? node : best, group[0]!);
    hub.x = cx;
    hub.y = cy;
    let leaf = 0;
    for (const node of group) {
      if (node.id === hub.id) continue;
      const golden = leaf * 2.399963229728653;
      const ringRadius = radius * Math.sqrt((leaf + 1) / Math.max(group.length, 1));
      node.x = cx + Math.cos(golden) * ringRadius;
      node.y = cy + Math.sin(golden) * ringRadius;
      leaf += 1;
    }
  });
}

function componentSeedRadius(count: number, seedScale: number): number {
  return Math.max(120, seedScale * Math.sqrt(Math.max(count, 1) / Math.PI));
}

function connectedComponents(ids: string[], adjacency: Map<string, string[]>): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
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
  const local = useMemo(() => neighborhoodPages(page, pages), [page, pages]);
  if (local.length < 2) return null;
  return (
    <WikiForceGraph
      pages={local}
      className="relative mt-2 h-72 w-full"
      centerId={page.id}
      showControls
      params={params}
      onParamsChange={onParamsChange}
      onOpen={(id) => {
        const target = local.find((item) => item.id === id);
        if (target) onOpen(target.id === page.id ? page.title : target.title);
      }}
    />
  );
}

function neighborhoodPages(page: WikiPageDto, pages: WikiPageSummaryDto[]): WikiPageSummaryDto[] {
  const wanted = new Map<string, WikiPageSummaryDto>();
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
  wanted.set(self.id, self);
  const bases = new Set((self.links ?? []).map((link) => link.split("#")[0] ?? link));
  for (const item of pages) {
    if (item.type === "column" || item.id === page.id) continue;
    const mentions = (item.links ?? []).some((link) => (link.split("#")[0] ?? link) === page.title);
    if (bases.has(item.title) || mentions) wanted.set(item.id, item);
  }
  return [...wanted.values()];
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full border px-2 py-0.5 text-[11px]",
        active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-light",
      ].join(" ")}
    >
      {label}
    </button>
  );
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
