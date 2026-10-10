"use client";

import { useState } from "react";
import type { JobDto } from "../../../lib/config-api";
import { useLocale, useT } from "../../../i18n/locale-context";
import type { TranslateFn } from "../../../i18n/types";

export function isLiveJob(job: JobDto | null | undefined): boolean {
  return job?.status === "pending" || job?.status === "queued" || job?.status === "running";
}

export function jobStageMessage(job: JobDto | null | undefined): string {
  const result = job?.result;
  if (!result || typeof result !== "object") return "";
  const message = result.message;
  return typeof message === "string" ? message : "";
}

export function assertJobFinished(job: JobDto, t: TranslateFn): void {
  if (job.status === "failed") {
    throw new Error(job.error?.message || t("wiki.scanFailed"));
  }
  if (job.status === "canceled") {
    throw new Error(t("wiki.scanCanceled"));
  }
}

export function formatRelativeTime(
  iso: string | null | undefined,
  t: TranslateFn,
  locale: string,
): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const delta = Date.now() - date.getTime();
  if (delta < 45_000) return t("wiki.justNow");
  if (delta < 3_600_000) {
    return t("wiki.minutesAgo", { count: Math.max(1, Math.floor(delta / 60_000)) });
  }
  if (delta < 86_400_000) {
    return t("wiki.hoursAgo", { count: Math.max(1, Math.floor(delta / 3_600_000)) });
  }
  if (delta < 7 * 86_400_000) {
    return t("wiki.daysAgo", { count: Math.max(1, Math.floor(delta / 86_400_000)) });
  }
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function JobInlineStatus({
  job,
  updatedAt,
  onCancel,
}: {
  job?: JobDto | null;
  updatedAt?: string | null;
  onCancel?: (jobId: string) => void | Promise<void>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const live = isLiveJob(job);
  const stage = jobStageMessage(job);
  const finishedAt = job?.finished_at || updatedAt;
  const relative = formatRelativeTime(finishedAt, t, locale);

  if (live && job) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-sky-800">
        <SpinnerIcon />
        <span className="truncate">
          {t("jobs.statusProgress", {
            status: job.status === "running" ? t("common.running") : t("jobs.queued"),
            progress: job.progress,
          })}
          {stage ? ` · ${stage}` : ""}
        </span>
        {onCancel ? (
          <button
            type="button"
            disabled={busy}
            className="shrink-0 text-[11px] font-medium text-sky-700 underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onCancel(job.id)).finally(() => setBusy(false));
            }}
          >
            {t("common.cancel")}
          </button>
        ) : null}
      </span>
    );
  }

  if (job?.status === "failed") {
    return (
      <span className="truncate text-[11px] text-rose-700">
        {job.error?.message || t("wiki.scanFailed")}
      </span>
    );
  }

  if (relative) {
    return (
      <span className="truncate text-[11px] text-muted-light">
        {t("wiki.updatedAt", { time: relative })}
      </span>
    );
  }

  return null;
}

function SpinnerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 animate-spin" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="8" className="opacity-25" />
      <path d="M20 12a8 8 0 0 0-8-8" strokeLinecap="round" />
    </svg>
  );
}
