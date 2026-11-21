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
    for (const item of items) item.classList.add("is-waiting");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        for (const item of items) item.classList.remove("is-waiting");
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      for (const item of items) item.classList.remove("is-waiting");
    };
  }, []);
  return ref;
}

/**
 * Runs script-driven (Web Animations) loops only while their element is on screen.
 * Returns a cleanup function.
 */
export function runWhileVisible(el: Element, animations: Animation[]) {
  for (const animation of animations) animation.pause();
  const observer = new IntersectionObserver(([entry]) => {
    for (const animation of animations) {
      if (entry?.isIntersecting) animation.play();
      else animation.pause();
    }
  });
  observer.observe(el);
  return () => {
    observer.disconnect();
    for (const animation of animations) animation.cancel();
  };
}
