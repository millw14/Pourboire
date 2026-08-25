'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Fade-and-rise a section into view when it is scrolled to.
 *
 * Replaces the GSAP timelines two components used for the same effect. Beyond
 * the ~70KB saved, it fixes a real failure mode: those timelines began by
 * setting `autoAlpha: 0` on the whole section, so any error before the animation
 * ran left that section permanently invisible.
 *
 * There is deliberately no React state here. Revealing is a one-way
 * synchronisation with the DOM — exactly what an effect is for — so the observer
 * toggles a class on the node directly instead of triggering a re-render. That
 * also means the content is visible by default: if the effect never runs, or
 * IntersectionObserver is missing, the copy is still on screen.
 */

type RevealTag = 'div' | 'section' | 'li' | 'ol' | 'ul' | 'p' | 'h2' | 'h3';

interface RevealProps {
  children: ReactNode;
  /** Stagger index; multiplied by 80ms. */
  index?: number;
  as?: RevealTag;
  className?: string;
  id?: string;
}

const HIDDEN = ['opacity-0', 'translate-y-4'];

export function Reveal({ children, index = 0, as = 'div', className = '', id }: RevealProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    // Hide only now that we know we can reveal again.
    node.classList.add(...HIDDEN);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        node.classList.remove(...HIDDEN);
        observer.disconnect();
      },
      { rootMargin: '0px 0px -10% 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const props = {
    id,
    style: { transitionDelay: `${index * 80}ms` },
    className: `transition-all duration-700 ease-out motion-reduce:transition-none ${className}`,
  };

  // An explicit switch rather than createElement(as, ...): it keeps the ref
  // properly typed per element and avoids handing React a props object it has
  // to treat as `any`.
  switch (as) {
    case 'section':
      return (
        <section ref={ref as React.RefObject<HTMLElement>} {...props}>
          {children}
        </section>
      );
    case 'li':
      return (
        <li ref={ref as React.RefObject<HTMLLIElement>} {...props}>
          {children}
        </li>
      );
    case 'ol':
      return (
        <ol ref={ref as React.RefObject<HTMLOListElement>} {...props}>
          {children}
        </ol>
      );
    case 'ul':
      return (
        <ul ref={ref as React.RefObject<HTMLUListElement>} {...props}>
          {children}
        </ul>
      );
    case 'p':
      return (
        <p ref={ref as React.RefObject<HTMLParagraphElement>} {...props}>
          {children}
        </p>
      );
    case 'h2':
      return (
        <h2 ref={ref as React.RefObject<HTMLHeadingElement>} {...props}>
          {children}
        </h2>
      );
    case 'h3':
      return (
        <h3 ref={ref as React.RefObject<HTMLHeadingElement>} {...props}>
          {children}
        </h3>
      );
    default:
      return (
        <div ref={ref as React.RefObject<HTMLDivElement>} {...props}>
          {children}
        </div>
      );
  }
}
