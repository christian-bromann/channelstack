import type { ReactNode, SVGProps } from "react";

function Icon({ size = 18, children, ...props }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement> & { size?: number };

export const ArrowRight = (p: P) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
export const Check = (p: P) => <Icon {...p}><path d="M5 12.5l4.5 4.5L19 7" /></Icon>;
export const Clipboard = (p: P) => <Icon {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.500 4h-7A2.500 2.500 0 0 0 4 6.500v7A2.500 2.500 0 0 0 6.500 16H8" /></Icon>;
export const Sun = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.500v2M12 19.500v2M2.500 12h2M19.500 12h2M5.300 5.300l1.400 1.400M17.300 17.300l1.400 1.400M5.300 18.700l1.400-1.400M17.300 6.700l1.400-1.400" /></Icon>;
export const Moon = (p: P) => <Icon {...p}><path d="M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z" /></Icon>;
export const Play = (p: P) => <Icon {...p} fill="currentColor" stroke="none"><path d="M7 4.500v15l12-7.500z" /></Icon>;
export const Pause = (p: P) => <Icon {...p} fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Icon>;
export const Replay = (p: P) => <Icon {...p}><path d="M4 12a8 8 0 1 0 2.600-5.900" /><path d="M4 4.500V9h4.500" /></Icon>;
export const External = (p: P) => <Icon {...p}><path d="M14 5h5v5M19 5l-8 8M11 7H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-4" /></Icon>;
export const Route = (p: P) => <Icon {...p}><path d="M4 12h16M14 6l6 6-6 6" /></Icon>;
export const Shield = (p: P) => <Icon {...p}><path d="M12 3l7.500 3v5.500c0 4.500-3 8-7.500 9.500-4.500-1.500-7.500-5-7.500-9.500V6z" /><path d="M8.500 12l2.500 2.500 4.500-5" /></Icon>;
export const Person = (p: P) => <Icon {...p}><circle cx="12" cy="8" r="3.500" /><path d="M5 20c1.200-3.600 4-5 7-5s5.800 1.400 7 5" /></Icon>;
export const Transcript = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="15" rx="2.500" /><path d="M7 9.500h10M7 13.500h6" /></Icon>;
