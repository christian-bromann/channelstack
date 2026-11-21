import { useEffect, useRef, useState } from "react";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True once the element has scrolled into view. Stays true. */
export function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setInView(true);
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);
  return [ref, inView] as const;
}

/**
 * Fades in the container's `.reveal` children when it scrolls into view.
 * Content that is already on screen, or that loads without script, is never hidden.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(".reveal"));
    items.forEach((item) => item.classList.add("is-waiting"));
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        items.forEach((item) => item.classList.remove("is-waiting"));
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      items.forEach((item) => item.classList.remove("is-waiting"));
    };
  }, []);
  return ref;
}

/**
 * Runs script-driven (Web Animations) loops only while their element is on screen and the
 * footer's "Pause animations" button is not pressed. Returns a cleanup function.
 */
export function runWhileVisible(el: Element, animations: Animation[]) {
  let visible = false;
  const sync = () => {
    const run = visible && document.documentElement.getAttribute("data-motion") !== "paused";
    animations.forEach((animation) => (run ? animation.play() : animation.pause()));
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    sync();
  });
  observer.observe(el);
  document.addEventListener("motionchange", sync);
  sync();
  return () => {
    observer.disconnect();
    document.removeEventListener("motionchange", sync);
    animations.forEach((animation) => animation.cancel());
  };
}
