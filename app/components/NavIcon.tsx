import type { ReactNode } from 'react';

export type NavIconName = 'search' | 'ask' | 'home' | 'mattermost' | 'mail' | 'github' | 'compute' | 'projects' | 'daily' | 'calendar' | 'trips' | 'library' | 'meetings' | 'notes' | 'teaching' | 'journal' | 'settings';

/** Journal Club: a paper with a discussion bubble beside it (shared with the space's empty states). */
export const JOURNAL_ICON = <><path d="M3 3.2h5.4l2.4 2.4v9.8H3z" /><path d="M8.4 3.2v2.4h2.4M5.2 8.4h3.4M5.2 10.8h2.2" /><path d="M12.6 9.2h3.6a1.4 1.4 0 0 1 1.4 1.4v2.6a1.4 1.4 0 0 1-1.4 1.4h-1.1l-1.9 1.8v-1.8h-.6a1.4 1.4 0 0 1-1.4-1.4v-2.6a1.4 1.4 0 0 1 1.4-1.4z" /><path d="M14 11.9h.1M15.9 11.9h.1" /></>;

// 20×20 line drawings; each destination's tile colour lives in CSS (`nav-tile-*`).
const PATHS: Record<NavIconName, ReactNode> = {
  search: <><circle cx="8.8" cy="8.8" r="5" /><path d="m12.6 12.6 4 4" /></>,
  ask: <path d="M10 2.8 11.6 8.4 17.2 10l-5.6 1.6L10 17.2l-1.6-5.6L2.8 10l5.6-1.6zM15.6 2.8v2.6M14.3 4.1h2.6" />,
  home: <path d="M3.5 9.2 10 3.8l6.5 5.4M5.5 7.8v8.4h3.4v-4.6h2.2v4.6h3.4V7.8" />,
  mattermost: <path d="M4 5.6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.6 2.9v-2.9H6a2 2 0 0 1-2-2zM7.3 8.6h5.4" />,
  mail: <><rect x="3" y="5" width="14" height="10.5" rx="2" /><path d="m3.6 6.2 6.4 5 6.4-5" /></>,
  github: <><circle cx="6" cy="4.8" r="1.8" /><circle cx="6" cy="15.2" r="1.8" /><circle cx="14" cy="7.4" r="1.8" /><path d="M6 6.6v6.8M14 9.2c0 3-3.2 3.2-6.6 4.6" /></>,
  compute: <><rect x="3.5" y="3.5" width="13" height="5" rx="1.3" /><rect x="3.5" y="11.5" width="13" height="5" rx="1.3" /><path d="M6.5 6h.1M6.5 14h.1M10 6h3.5M10 14h3.5" /></>,
  projects: <path d="M2.8 6a1.6 1.6 0 0 1 1.6-1.6h3.7l1.8 2h5.7a1.6 1.6 0 0 1 1.6 1.6v6.8a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6z" />,
  daily: <path d="M3 14.5h14M5.6 14.5a4.4 4.4 0 0 1 8.8 0M10 4v2.4M4.3 7.3l1.6 1.6M15.7 7.3l-1.6 1.6M7.4 17.2h5.2" />,
  calendar: <><rect x="3.2" y="4.4" width="13.6" height="12.2" rx="2" /><path d="M3.2 8.4h13.6M7 2.8v3M13 2.8v3M6.8 11.6h.1M10 11.6h.1M13.2 11.6h.1M6.8 14.2h.1M10 14.2h.1" /></>,
  trips: <path d="M17 3 3.4 8.6l5.4 2.2 2.2 5.4zM8.8 10.8 17 3" />,
  library: <path d="M4 3.6h3v12.8H4zM8.6 3.6h3v12.8h-3zM13 4.6l2.8-.8 2.6 12-2.8.8z" />,
  meetings: <><circle cx="7.2" cy="7" r="2.4" /><circle cx="13.6" cy="7.8" r="2" /><path d="M2.8 16a4.4 4.4 0 0 1 8.8 0M11.8 12.6a3.6 3.6 0 0 1 5.4 3.4" /></>,
  notes: <path d="M4 3.5h12v9l-4 4H4zM12 16.5v-4h4M7 7h6M7 10h4" />,
  teaching: <path d="M2.6 7.4 10 4l7.4 3.4L10 10.8zM5.4 8.8v4.1c1.2 1.5 2.9 2.2 4.6 2.2s3.4-.7 4.6-2.2V8.8M17.4 7.4v4.4" />,
  journal: JOURNAL_ICON,
  settings: <><circle cx="10" cy="10" r="2.6" /><path d="M10 2.8v2.1M10 15.1v2.1M2.8 10h2.1M15.1 10h2.1M4.9 4.9l1.5 1.5M13.6 13.6l1.5 1.5M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5" /></>,
};

export default function NavIcon({ name }: { name: NavIconName }) {
  return (
    <span className={`nav-tile nav-tile-${name}`} aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{PATHS[name]}</svg>
    </span>
  );
}
