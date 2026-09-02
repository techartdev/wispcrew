/**
 * Icons.tsx — hand-drawn, dependency-free.
 *
 * Hard rule 9 says dependencies are a security decision, and an icon set is
 * a lot of third-party code to ship into an application that runs shell
 * commands. These are a handful of paths on a 24-unit grid with one stroke
 * weight; they cost nothing to audit and nothing to load.
 *
 * They are decoration, not information: every icon here sits beside a label
 * or carries an `aria-label` from its caller, so an icon nobody recognises
 * never becomes the only way to know what a control does.
 */
import type { SVGProps } from 'react';

/** One consistent frame, so a mixed row lines up. */
function Glyph({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default. A caller that uses an icon ALONE passes its
      // own aria-label, which overrides this.
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconSend = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M4 12 20 4l-3 8 3 8Z" />
    <path d="M4 12h13" />
  </Glyph>
);

export const IconStop = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Glyph>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
);

export const IconAttach = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M20 11.5 12.5 19a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.3-7.3" />
  </Glyph>
);

/**
 * A cog, and it has to read as one.
 *
 * This was a small hub with eight thin rays radiating into empty space,
 * which is the universal drawing of BRIGHTNESS. Reported exactly that way:
 * "looks like a sun, not like a gear, makes me think that's some lightness
 * setting". Two icons a hair apart in geometry are miles apart in meaning,
 * and this one sits beside a theme toggle.
 *
 * What separates them is not the number of spokes but where they live: a
 * sun's rays are thin and detached, a cog's teeth are thick and grow out of
 * a rim. So — a rim, eight stubby teeth drawn at nearly twice the stroke
 * width and butt-capped so they read as blocks rather than pins, and a hub
 * small enough to be a bore rather than a second sun.
 */
export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2.25" />
    <path
      strokeWidth="3.25"
      strokeLinecap="butt"
      d="M12 6.2V4M12 17.8V20M6.2 12H4M17.8 12H20M7.9 7.9 6.3 6.3M16.1 16.1l1.6 1.6M16.1 7.9 17.7 6.3M7.9 16.1 6.3 17.7"
    />
  </Glyph>
);

export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Glyph>
);

export const IconSkill = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M12 3l2.4 5.3 5.6.7-4.2 3.9 1.1 5.6L12 15.8 7.1 18.5l1.1-5.6L4 9l5.6-.7Z" />
  </Glyph>
);

export const IconPlug = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M9 3v5M15 3v5" />
    <path d="M6 8h12v3a6 6 0 0 1-12 0Z" />
    <path d="M12 17v4" />
  </Glyph>
);

export const IconMachine = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Glyph>
);

export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4h4" />
    <path d="M12 7.5V12l3 1.8" />
  </Glyph>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M4 7h16M10 7V5h4v2" />
    <path d="M6 7l1 12h10l1-12" />
    <path d="M10 11v5M14 11v5" />
  </Glyph>
);

export const IconPeople = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.5a3 3 0 0 1 0 5.8M17 14.2a5.5 5.5 0 0 1 3.5 4.8" />
  </Glyph>
);

export const IconSidebar = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M14 4v16" />
  </Glyph>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </Glyph>
);

export const IconDeny = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Glyph>
);
