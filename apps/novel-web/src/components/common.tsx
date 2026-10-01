import type { ReactNode } from "react";

import type { StatusLevel } from "../state/status";

export function StatusPill({
  label,
  value,
  level = "info",
  title,
}: {
  label: string;
  value: string;
  level?: StatusLevel;
  title?: string;
}) {
  const className = level === "info" ? "status-pill" : `status-pill is-${level}`;
  return (
    <span className={className} title={title}>
      <strong>{label}</strong>
      <span>{value}</span>
    </span>
  );
}

export function Banner({
  level,
  children,
  actions,
}: {
  level: "info" | "ok" | "warn" | "error";
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`banner${level === "info" ? "" : ` is-${level}`}`} role={level === "error" ? "alert" : "status"}>
      <div>{children}</div>
      {actions ? <div className="banner-actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="muted small">{children}</p>;
}
