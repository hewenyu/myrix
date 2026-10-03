import type { CSSProperties } from "react";

type IconName = "book" | "plus" | "arrow" | "stop" | "history" | "back" | "more" | "archive" | "spark" | "search" | "close";
const paths: Record<IconName, string> = {
  book: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2",
  plus: "M12 5v14 M5 12h14",
  arrow: "M12 19V5 M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  history: "M4 7a9 9 0 1 1-1 8 M4 3v5h5 M12 7v5l3 2",
  back: "M19 12H5 M11 6l-6 6 6 6",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  archive: "M4 9v11h16V9 M3 4h18v5H3z M9 13h6",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  close: "m6 6 12 12 M18 6 6 18",
};
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
